/*
檔案用途：驗證血壓輸入 hook 遇到每日上限錯誤時的行為（issue #1060）——保留被擋讀數的快照供畫面顯示危險等級，
         但不排入離線佇列、不呼叫家屬通知；其他錯誤不留快照；下一次送出時清掉舊快照。
所在層：tests/unit；以最小 hook 執行環境跑 useBloodPressureInputForm，Supabase 寫入與通知都換成替身。
主要關聯：src/features/vitals/hooks/useBloodPressureInputForm.ts、BpLimitBlockedNotice、InputPage.utils 的 isDailyBpLimitError。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness } from './helpers/reactHookHarness'
import { renderWithBloodPressureQueue } from './helpers/bloodPressureQueueHarness'

installReactHookHarness()

const actualI18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ text: (item: { zh: string }) => item.zh, locale: 'zh', setLocale: () => {} }),
}))

const actualGuard = await import('../../src/lib/pwaUpdateGuard')
mock.module('../../src/lib/pwaUpdateGuard', () => ({ ...actualGuard, usePwaUpdateGuard: () => ({ registerUnsavedInput: () => {} }) }))

mock.module('../../src/hooks/useLatestBpRecord', () => ({
  useLatestBpRecord: () => ({ record: null, loading: false, error: null, refetch: async () => {} }),
}))

const actualDemoStorage = await import('../../src/lib/demoStorage')
mock.module('../../src/lib/demoStorage', () => ({ ...actualDemoStorage, isDemoMode: () => false }))

let insertError: unknown = null
// 設成 Promise 時，INSERT 會等它 resolve 才丟錯，用來模擬「寫入還在路上時切換病人」。
let insertGate: Promise<void> | null = null
mock.module('../../src/lib/bloodPressureRecords', () => ({
  insertBloodPressureRecord: async () => {
    if (insertGate) await insertGate
    if (insertError) throw insertError
  },
  // 殼層補送器會匯入它（舊版佇列紀錄的第一筆埋點，PR #1218）；這裡的案例不走補送，給個永遠「已有歷史」的替身即可。
  hasOtherBloodPressureRecord: async () => true,
}))

const notifyCalls: unknown[] = []
const actualTelegram = await import('../../src/lib/telegramNotification')
mock.module('../../src/lib/telegramNotification', () => ({
  ...actualTelegram,
  sendTelegramNotification: async (request: unknown) => { notifyCalls.push(request); return actualTelegram.parseTelegramNotificationResult({}) },
}))

const enqueued: unknown[] = []
let enqueueSucceeds = true
const actualQueue = await import('../../src/lib/bloodPressurePendingQueue')
mock.module('../../src/lib/bloodPressurePendingQueue', () => ({
  ...actualQueue,
  enqueuePendingBloodPressureRecord: (record: unknown) => { enqueued.push(record); return enqueueSucceeds },
  readPendingBloodPressureRecords: () => [],
}))

mock.module('../../src/hooks/usePendingWriteFlush', () => ({
  usePendingWriteFlush: () => ({ syncing: false, lastAttemptAt: null, retryNow: async () => {} }),
}))

const actualAnalytics = await import('../../src/lib/analytics')
mock.module('../../src/lib/analytics', () => ({ ...actualAnalytics, trackFirstRecordSaved: () => {} }))

// 用正式的 GENERAL_ADULT_EVALUATOR 而不是手捏 evaluateAt：正式 evaluator 的判讀一定帶 resolved
// （標準讀不讀得到），進離線佇列時要靠它決定記不記下判讀（issue #1126）；少了它這個替身就跟正式形狀不一樣。
const actualBpEvaluator = await import('../../src/features/vitals/hooks/useBpEvaluator')
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  ...actualBpEvaluator,
  useBpEvaluator: () => actualBpEvaluator.GENERAL_ADULT_EVALUATOR,
}))

const { useBloodPressureInputForm } = await import('../../src/features/vitals/hooks/useBloodPressureInputForm')
// 補送器搬到 App 殼層（issue #1138）：表單 hook 經 context 讀它，測試用 renderWithBloodPressureQueue 把兩棵 hook 樹接起來。
const { useBloodPressureQueueCoordinator } = await import('../../src/features/vitals/hooks/useBloodPressureQueueCoordinator')
const { BloodPressureQueueContext } = await import('../../src/features/vitals/hooks/BloodPressureQueueProvider')
const queueModules = { useBloodPressureQueueCoordinator, BloodPressureQueueContext }
const mountForm = (getPatientId: () => string, userEmail: string | undefined = 'caregiver@example.com') => renderWithBloodPressureQueue(queueModules, getPatientId, userEmail, () => useBloodPressureInputForm({ subject: getPatientId(), patientId: getPatientId(), userEmail }))

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function submitReading(systolic: number, diastolic: number, pulse: number) {
  const view = mountForm(() => 'patient-1')
  view.act(() => {
    view.current.handleSystolicChange(systolic, () => {})
    view.current.handleDiastolicChange(diastolic, () => {})
    view.current.handlePulseChange(pulse, () => {})
  })
  view.act(() => { void view.current.submit() })
  await flush()
  view.rerender()
  return view
}

beforeEach(() => {
  insertError = null
  insertGate = null
  notifyCalls.length = 0
  enqueueSucceeds = true
  enqueued.length = 0
})

describe('useBloodPressureInputForm daily limit (issue #1060)', () => {
  test('a validation failure on the next submit does not keep showing the old blocked reading', async () => {
    insertError = { code: 'P0001', message: 'daily_blood_pressure_limit' }
    const view = await submitReading(185, 105, 80)
    expect(view.current.limitBlockedReading).not.toBeNull()
    view.act(() => { view.current.handlePulseChange('', () => {}) })
    view.act(() => { void view.current.submit() })
    await flush()
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.errMsg).toContain('數值不合理')
    expect(view.current.limitBlockedReading).toBeNull()
    view.unmount()
  })

  test('keeps a snapshot of the rejected reading, without queueing or notifying', async () => {
    insertError = { code: 'P0001', message: 'daily_blood_pressure_limit' }
    const view = await submitReading(185, 105, 80)
    expect(view.current.status).toBe('err')
    expect(view.current.errMsg).toContain('上限')
    expect(view.current.limitBlockedReading).toMatchObject({ systolic: 185, diastolic: 105, pulse: 80 })
    expect(typeof view.current.limitBlockedReading?.measuredAt).toBe('string')
    // 上限是防濫用：被擋的那一筆不能偷偷暫存重送，也沒有通知可送。
    expect(enqueued).toHaveLength(0)
    expect(notifyCalls).toHaveLength(0)
    view.unmount()
  })

  test('a limit error that arrives after switching patient does not show the previous patient\'s reading', async () => {
    // Codex review on PR #1092：A 的寫入還在路上就切到 B，晚回來的上限錯誤不能把 A 的數值掛到 B 的畫面（AGENTS.md § 3.5）。
    insertError = { code: 'P0001', message: 'daily_blood_pressure_limit' }
    let releaseInsert = () => {}
    insertGate = new Promise<void>(resolve => { releaseInsert = resolve })
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    view.act(() => {
      view.current.handleSystolicChange(185, () => {})
      view.current.handleDiastolicChange(105, () => {})
      view.current.handlePulseChange(80, () => {})
    })
    view.act(() => { void view.current.submit() })
    patientId = 'patient-b'
    view.rerender()
    releaseInsert()
    await flush()
    view.rerender()
    expect(view.current.limitBlockedReading).toBeNull()
    // 不只數值：錯誤訊息與 status 也不能跟著換到 B 的畫面（Codex review on PR #1092 第二輪）。
    expect(view.current.status).not.toBe('err')
    expect(view.current.errMsg).toBe('')
    view.unmount()
  })

  test('a visible blocked snapshot is never handed to the next patient, not even for the first render after switching', async () => {
    // Codex review on PR #1092 第二輪：resetMeasurementFlow 在 effect 裡跑，切換病人後第一次 commit 還沒清；
    // 逐次記下每一次 render 的回傳，才看得到那一個 frame。
    insertError = { code: 'P0001', message: 'daily_blood_pressure_limit' }
    let patientId = 'patient-a'
    const seen: Array<{ patientId: string; snapshot: unknown }> = []
    const view = renderWithBloodPressureQueue(queueModules, () => patientId, 'caregiver@example.com', () => {
      const result = useBloodPressureInputForm({ subject: patientId, patientId, userEmail: 'caregiver@example.com' })
      seen.push({ patientId, snapshot: result.limitBlockedReading })
      return result
    })
    view.act(() => {
      view.current.handleSystolicChange(185, () => {})
      view.current.handleDiastolicChange(105, () => {})
      view.current.handlePulseChange(80, () => {})
    })
    view.act(() => { void view.current.submit() })
    await flush()
    view.rerender()
    expect(view.current.limitBlockedReading).toMatchObject({ patientId: 'patient-a', systolic: 185 })
    patientId = 'patient-b'
    view.rerender()
    expect(seen.filter(entry => entry.patientId === 'patient-b' && entry.snapshot !== null)).toEqual([])
    view.unmount()
  })

  // 共用：A 的寫入卡在半路時切到 B，再放行。
  async function submitThenSwitch(release: () => void, view: ReturnType<typeof mountForm>, setPatient: (id: string) => void) {
    view.act(() => {
      view.current.handleSystolicChange(185, () => {})
      view.current.handleDiastolicChange(105, () => {})
      view.current.handlePulseChange(80, () => {})
    })
    view.act(() => { void view.current.submit() })
    setPatient('patient-b')
    view.rerender()
    release()
    await flush()
    view.rerender()
  }

  test('a save that succeeds after switching patient still notifies A\'s family but leaves B\'s form untouched', async () => {
    // PR #1092 暫代審查 P2：成功路徑原本會把 A 的結果（成功狀態、量測流程、判讀橫幅）寫到 B 的畫面上。
    let release = () => {}
    insertGate = new Promise<void>(resolve => { release = resolve })
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    await submitThenSwitch(release, view, id => { patientId = id })
    // 警報鏈：A 的紀錄已存好，家屬通知一定要照送，而且是送 A 的紀錄。
    expect(notifyCalls).toEqual([expect.objectContaining({ patientId: 'patient-a' })])
    // 畫面：B 沒有任何「已儲存」、量測流程或判讀橫幅。
    expect(view.current.status).not.toBe('ok')
    expect(view.current.everSubmitted).toBe(false)
    expect(view.current.showRestPrompt).toBe(false)
    expect(view.current.displayedRule).toBeNull()
    view.unmount()
  })

  test('a queue-unavailable failure after switching patient does not show an error on the next patient', async () => {
    // PR #1092 暫代審查 P3：可重試錯誤但本機佇列寫不進去的那條路，也要比對病人。
    insertError = { status: 503, message: 'upstream unavailable' }
    enqueueSucceeds = false
    let release = () => {}
    insertGate = new Promise<void>(resolve => { release = resolve })
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    await submitThenSwitch(release, view, id => { patientId = id })
    expect(view.current.status).not.toBe('err')
    expect(view.current.errMsg).toBe('')
    view.unmount()
  })

  test('other non-retryable failures do not leave a blocked-reading snapshot', async () => {
    insertError = { code: '42501', message: 'new row violates row-level security policy' }
    const view = await submitReading(185, 105, 80)
    expect(view.current.status).toBe('err')
    expect(view.current.limitBlockedReading).toBeNull()
    view.unmount()
  })

  test('the next submit clears the previous blocked reading', async () => {
    insertError = { code: 'P0001', message: 'daily_blood_pressure_limit' }
    const view = await submitReading(185, 105, 80)
    expect(view.current.limitBlockedReading).not.toBeNull()
    insertError = { code: '42501', message: 'new row violates row-level security policy' }
    view.act(() => { view.current.handlePulseChange(81, () => {}) })
    view.act(() => { void view.current.submit() })
    await flush()
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.limitBlockedReading).toBeNull()
    view.unmount()
  })
})
