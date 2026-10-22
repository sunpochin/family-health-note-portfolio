/*
檔案用途：用真的 supabase-js client 驗證血壓離線佇列的帳號層補送（issue #1125）：
  畫面停在 B 時，A 的離線血壓恢復連線就補送並通知家屬；A 的通知若沒確認送達要點名提醒、不能寫進 B 的「這筆」提示；
  被伺服器永久拒絕的那筆顯示真正原因，而不是「請確認網路」；手機自認有網路卻一直送不出去時改說「連不到伺服器」。
所在層：tests/unit；只有 fetch 由測試注入（不連網），supabase-js、insertBloodPressureRecord、佇列、殼層補送器（issue #1138）與表單 hook 都是正式程式碼。
  觸發時機（online／回前景／退避）由 usePendingWriteFlush 的測試負責，這裡直接拿 hook 交出去的「同步一輪」來跑。
主要關聯：src/features/vitals/hooks/useBloodPressureInputForm.ts、src/lib/bloodPressurePendingQueue.ts、src/lib/pendingWriteQueue.ts、
  src/features/vitals/pages/InputPage.utils.ts（queuedRejectionText、L.pendingUnreachable）、tests/unit/dataErrors.test.ts（錯誤形狀）。
*/
import { afterAll, afterEach, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { installReactHookHarness } from './helpers/reactHookHarness'
import { renderWithBloodPressureQueue } from './helpers/bloodPressureQueueHarness'

installReactHookHarness()

// ── 注入的 fetch：錯誤物件一律由 postgrest-js 自己產生，不自己捏形狀（#1116 的教訓）──────────
interface RecordedRequest { method: string; url: string; body: Record<string, unknown> | undefined }
const requests: RecordedRequest[] = []
let respond: (request: RecordedRequest) => Response | Promise<Response> = () => { throw new TypeError('Failed to fetch') }

const client = createClient('https://example.supabase.co', 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request: RecordedRequest = {
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined,
      }
      requests.push(request)
      return respond(request)
    }) as typeof fetch,
  },
})
mock.module('../../src/lib/supabase', () => ({ supabase: client }))

const goOffline = () => { respond = () => { throw new TypeError('Failed to fetch') } }
const accept = () => { respond = () => new Response(null, { status: 201 }) }
const reject = (status: number, body: Record<string, unknown>) => {
  respond = () => new Response(JSON.stringify({ details: null, hint: null, ...body }), { status, headers: { 'Content-Type': 'application/json' } })
}
const bpInserts = () => requests.filter(request => request.method === 'POST' && request.url.includes('/rest/v1/blood_pressure_records'))

// ── 佇列用的 localStorage 替身（要能列 key：補送要找出這個帳號所有病人的桶）──────────────
const originalLocalStorage = globalThis.localStorage
const stored = new Map<string, string>()

// ── 表單 hook 需要的替身：與 bloodPressureInputLimitBlocked.test.ts 相同，但寫入與佇列都用正式程式碼 ──
const actualI18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ text: (item: { zh: string }) => item.zh, locale: 'zh', setLocale: () => {} }),
}))
const actualGuard = await import('../../src/lib/pwaUpdateGuard')
mock.module('../../src/lib/pwaUpdateGuard', () => ({ ...actualGuard, usePwaUpdateGuard: () => ({ registerUnsavedInput: () => {} }) }))
mock.module('../../src/hooks/useLatestBpRecord', () => ({
  useLatestBpRecord: () => ({ record: null, loading: false, error: null, refetch: async () => {}, setOptimisticRecord: () => {} }),
}))
const actualDemoStorage = await import('../../src/lib/demoStorage')
mock.module('../../src/lib/demoStorage', () => ({ ...actualDemoStorage, isDemoMode: () => false }))

const notifyCalls: unknown[] = []
const actualTelegram = await import('../../src/lib/telegramNotification')
// 每個測試自己決定 Edge Function 回什麼（可依紀錄 id 延後回應，模擬「較新的一筆先回來」）；預設是共用群組已送達。
let notifyResponse: (request: { recordId: string; patientId: string }) => Promise<unknown> = async () => ({ ok: true, sharedTelegram: 'delivered' })
mock.module('../../src/lib/telegramNotification', () => ({
  ...actualTelegram,
  sendTelegramNotification: async (request: { recordId: string; patientId: string }) => {
    notifyCalls.push(request)
    return actualTelegram.parseTelegramNotificationResult(await notifyResponse(request))
  },
}))
const actualAnalytics = await import('../../src/lib/analytics')
mock.module('../../src/lib/analytics', () => ({ ...actualAnalytics, trackFirstRecordSaved: () => {} }))
// 用正式的 evaluator（一般成人標準）：判讀結果帶 resolved.unavailable，畫面上的佇列提醒（#1126）靠它分辨「讀不到標準」。
const actualBpEvaluator = await import('../../src/features/vitals/hooks/useBpEvaluator')
const { UNAVAILABLE_BP_STANDARD_RESOLVER } = await import('../../src/lib/bpStandards')
// 離線重開 App、讀不到這位的個別標準（與 bpOfflineSaveQueue.test.ts 同一種組法）。
const OFFLINE_EVALUATOR = actualBpEvaluator.makeBpEvaluator(UNAVAILABLE_BP_STANDARD_RESOLVER, { error: new TypeError('Failed to fetch') })
let currentEvaluator = actualBpEvaluator.GENERAL_ADULT_EVALUATOR
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  ...actualBpEvaluator,
  useBpEvaluator: () => currentEvaluator,
}))
let latestFlushParams: { hasPending: boolean; sync: () => Promise<boolean> } | null = null
mock.module('../../src/hooks/usePendingWriteFlush', () => ({
  usePendingWriteFlush: (params: { hasPending: boolean; sync: () => Promise<boolean> }) => {
    latestFlushParams = params
    return { syncing: false, lastAttemptAt: null, retryNow: async () => {} }
  },
}))

const { enqueuePendingBloodPressureRecord, readAllPendingBloodPressureRecords, readPendingBloodPressureRecords } = await import('../../src/lib/bloodPressurePendingQueue')
const { useBloodPressureInputForm } = await import('../../src/features/vitals/hooks/useBloodPressureInputForm')
// 補送器搬到 App 殼層（issue #1138）：表單 hook 經 context 讀它，測試用 renderWithBloodPressureQueue 把兩棵 hook 樹接起來。
const { useBloodPressureQueueCoordinator, PENDING_UNREACHABLE_AFTER_MS, nextPendingRejections } = await import('../../src/features/vitals/hooks/useBloodPressureQueueCoordinator')
const { BloodPressureQueueContext } = await import('../../src/features/vitals/hooks/BloodPressureQueueProvider')
const queueModules = { useBloodPressureQueueCoordinator, BloodPressureQueueContext }
const { L } = await import('../../src/features/vitals/pages/InputPage.utils')

const CAREGIVER = 'care@example.com'
const mountForm = (getPatientId: () => string, userEmail: string | undefined = CAREGIVER) => renderWithBloodPressureQueue(queueModules, getPatientId, userEmail, () => useBloodPressureInputForm({ subject: getPatientId(), patientId: getPatientId(), userEmail }))
const queue = (patientId: string, id: string, systolic = 132, diastolic = 78, extra: { family_alert?: boolean; queued_at?: string } = {}) => enqueuePendingBloodPressureRecord({
  id, systolic, diastolic, pulse: 72, measured_at: '2026-10-06T01:00:00.000Z', source: 'manual_web',
  patient_id: patientId, recorded_by: CAREGIVER, queued_at: '2026-10-06T01:01:00.000Z', ...extra,
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function renderForm(initialPatientId: string) {
  let patientId = initialPatientId
  const view = mountForm(() => patientId)
  return {
    view,
    switchTo(next: string) {
      patientId = next
      view.rerender()
    },
    async sync() {
      const result = await latestFlushParams!.sync()
      await flush()
      view.rerender()
      return result
    },
  }
}

// 讓某一筆的通知結果等到測試放行才回來，其他筆照 respondOthers 立刻回。
function holdNotification(recordId: string, held: unknown, respondOthers: unknown = { ok: true, sharedTelegram: 'delivered' }) {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  notifyResponse = async request => {
    if (request.recordId !== recordId) return respondOthers
    await gate
    return held
  }
  return () => release()
}

function setOnline(value: boolean | undefined) {
  Object.defineProperty(globalThis.navigator, 'onLine', { value, configurable: true })
}

beforeEach(() => {
  currentEvaluator = actualBpEvaluator.GENERAL_ADULT_EVALUATOR
  stored.clear()
  requests.length = 0
  notifyCalls.length = 0
  notifyResponse = async () => ({ ok: true, sharedTelegram: 'delivered' })
  latestFlushParams = null
  goOffline()
  ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => { stored.set(key, value) },
    removeItem: key => { stored.delete(key) },
    get length() { return stored.size },
    key: index => [...stored.keys()][index] ?? null,
  } as Storage
})
afterEach(() => {
  setSystemTime()
  setOnline(undefined)
})
afterAll(() => {
  if (originalLocalStorage) (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = originalLocalStorage
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

describe('queued blood pressure for a patient who is not on screen (issue #1125)', () => {
  test('A\'s alert-level reading is sent and the family is notified while B is on screen', async () => {
    queue('patient-a', 'a-danger', 185, 105)
    const form = renderForm('patient-b')

    // 還沒連上：B 的畫面只知道「別人有 1 筆在等」，看不到 A 的數值，自動重試也要繼續排。
    await form.sync()
    expect(form.view.current.pendingRecords).toEqual([])
    expect(form.view.current.pendingViewRecords).toEqual([])
    expect(form.view.current.otherPatientsPendingCount).toBe(1)
    expect(latestFlushParams!.hasPending).toBe(true)

    accept()
    expect(await form.sync()).toBe(true)

    expect(bpInserts().at(-1)?.body).toMatchObject({ id: 'a-danger', patient_id: 'patient-a', systolic: 185, diastolic: 105 })
    expect(notifyCalls).toEqual([{ recordId: 'a-danger', patientId: 'patient-a' }])
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    expect(form.view.current.otherPatientsPendingCount).toBe(0)
    // A 的通知結果不能變成 B 的「這筆」提示。
    expect(form.view.current.familyDelivery).toBe('idle')
    expect(form.view.current.otherPatientNotifyProblems).toEqual([])
    form.view.unmount()
  })

  test('sends the patient on screen first and still sends the others in the same round', async () => {
    queue('patient-a', 'a-1')
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(bpInserts().map(request => request.body?.id)).toEqual(['b-1', 'a-1'])
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    form.view.unmount()
  })

  test('an unconfirmed family notification for A names A on B\'s screen instead of disappearing', async () => {
    queue('patient-a', 'a-1', 185, 105)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    expect(form.view.current.familyDelivery).toBe('idle')
    form.view.unmount()
  })

  test('a failed notification call for A also names A and does not mark B\'s reading as failed', async () => {
    queue('patient-a', 'a-1', 185, 105)
    notifyResponse = async () => { throw new Error('Blood pressure notification failed') }
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    expect(form.view.current.notifyFailed).toBe(false)
    form.view.unmount()
  })

  test('the patient on screen still gets the usual "this reading" notice for her own re-sent reading', async () => {
    queue('patient-b', 'b-1', 185, 105)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(form.view.current.familyDelivery).toBe('not_sent')
    expect(form.view.current.otherPatientNotifyProblems).toEqual([])
    form.view.unmount()
  })

  test('a flush that started on A and ends after switching to B leaves B\'s screen with B\'s list', async () => {
    queue('patient-a', 'a-1')
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async () => {
      await gate
      throw new TypeError('Failed to fetch')
    }
    const form = renderForm('patient-a')
    const running = latestFlushParams!.sync()
    form.switchTo('patient-b')
    release()
    await running
    await flush()
    form.view.rerender()

    // 舊寫法把開始那位的剩餘清單直接寫進 state：B 的畫面會出現 A 的待同步血壓（§ 3.5）。
    expect(form.view.current.pendingRecords).toEqual([])
    expect(form.view.current.pendingViewRecords).toEqual([])
    expect(form.view.current.otherPatientsPendingCount).toBe(1)
    form.view.unmount()
  })
})

describe('the reason shown when a queued reading cannot be sent (issue #1125)', () => {
  test.each([
    ['an expired login or missing permission', 403, { code: '42501', message: 'permission denied for table blood_pressure_records' }, '重新登入'],
    ['the daily limit', 400, { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' }, '上限'],
    ['data the server will never accept', 400, { code: 'PGRST204', message: "Could not find the 'queued_at' column of 'blood_pressure_records' in the schema cache" }, '重試也不會成功'],
  ])('%s shows that reason, not "check your connection"', async (_case, status, body, expected) => {
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    reject(status, body)

    await form.sync()

    const messages = form.view.current.pendingSyncErrorTexts.map(message => message.zh)
    expect(form.view.current.pendingSyncError).toBe(true)
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain('有紀錄沒有同步成功')
    expect(messages[0]).toContain(expected)
    expect(messages.join('')).not.toContain(L.pendingSyncError.zh)
    // 永久拒絕的那筆仍留在佇列，不偷偷丟掉健康紀錄。
    expect(readPendingBloodPressureRecords('patient-b', CAREGIVER).map(record => record.id)).toEqual(['b-1'])
    form.view.unmount()
  })

  test('keeps the reason when a later round stops at a connection failure before reaching that reading', async () => {
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    reject(403, { code: '42501', message: 'permission denied' })
    await form.sync()
    // 下一輪排在 b-1 前面的是一筆更早的紀錄，它先斷線，這一輪就停下、根本沒試到 b-1。
    queue('patient-b', 'b-0', 132, 78, { queued_at: '2026-10-06T00:59:00.000Z' })
    goOffline()
    requests.length = 0

    await form.sync()

    expect(bpInserts().map(request => request.body?.id)).toEqual(['b-0'])
    const messages = form.view.current.pendingSyncErrorTexts.map(message => message.zh)
    expect(messages[0]).toContain('重新登入')
    expect(messages).toContain(L.pendingSyncError.zh)
    form.view.unmount()
  })

  test('drops the old reason when that reading itself fails on the network, and goes back to normal retries', async () => {
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    reject(400, { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' })
    expect(await form.sync()).toBe(true)
    expect(latestFlushParams!.hasPending).toBe(false)
    goOffline()

    // 舊原因（上限）已不是現況；留著會讓它被當成定局、不再排退避重試，畫面也講錯原因。
    expect(await form.sync()).toBe(false)

    expect(latestFlushParams!.hasPending).toBe(true)
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])
    form.view.unmount()
  })

  test('a permission rejection is not final: the reading keeps its normal retries', async () => {
    // 登入過期、或 token 換新剛好失敗時 supabase-js 退回 anon key 送出，都會拿到 401／42501；重新登入或下一輪就可能成功。
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    reject(403, { code: '42501', message: 'permission denied' })

    expect(await form.sync()).toBe(false)

    expect(latestFlushParams!.hasPending).toBe(true)
    expect(form.view.current.pendingSyncErrorTexts[0]?.zh).toContain('重新登入')
    form.view.unmount()
  })

  test('another patient\'s rejection reason is not shown on this patient\'s screen; only where to look', async () => {
    queue('patient-a', 'a-1')
    const form = renderForm('patient-b')
    reject(403, { code: '42501', message: 'permission denied' })

    await form.sync()

    // A 的原因（要重新登入、A 的每日上限）不在 B 的畫面上細說，只說去 A 那邊看。
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.otherPatientsRejected])
    expect(form.view.current.pendingSyncErrorTexts.map(message => message.zh).join('')).not.toContain('重新登入')
    expect(form.view.current.otherPatientsPendingCount).toBe(1)
    form.view.unmount()
  })
})

describe('online but the server cannot be reached (issue #1125)', () => {
  test('switches from "check your connection" to "the server cannot be reached" after failing online for a while', async () => {
    setOnline(true)
    setSystemTime(new Date('2026-10-06T02:00:00.000Z'))
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')

    await form.sync()
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])

    setSystemTime(new Date(Date.parse('2026-10-06T02:00:00.000Z') + PENDING_UNREACHABLE_AFTER_MS))
    await form.sync()
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingUnreachable])

    // 一送到就恢復；之後再失敗要重新計時，不能立刻又說「連不到伺服器」。
    accept()
    queue('patient-b', 'b-2')
    await form.sync()
    expect(form.view.current.pendingSyncErrorTexts).toEqual([])
    goOffline()
    queue('patient-b', 'b-3')
    await form.sync()
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])
    form.view.unmount()
  })

  test('a phone that knows it is offline never gets the "server cannot be reached" text and sends nothing', async () => {
    setSystemTime(new Date('2026-10-06T02:00:00.000Z'))
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    await form.sync()
    setSystemTime(new Date(Date.parse('2026-10-06T02:00:00.000Z') + PENDING_UNREACHABLE_AFTER_MS))
    setOnline(false)
    requests.length = 0

    expect(await form.sync()).toBe(false)

    expect(requests).toEqual([])
    expect(form.view.current.pendingSyncErrorTexts.map(message => message.zh)).not.toContain(L.pendingUnreachable.zh)
    form.view.unmount()
  })
})

describe('review follow-ups (issue #1125)', () => {
  test('a personal notification that reached the family does not raise the named "contact the family" notice', async () => {
    queue('patient-a', 'a-1', 185, 105)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed', personalDelivered: true })
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(form.view.current.otherPatientNotifyProblems).toEqual([])
    form.view.unmount()
  })

  test('the named notice clears on the next save, but stays when switching to the named person', async () => {
    queue('patient-a', 'a-1', 185, 105)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const form = renderForm('patient-b')
    accept()
    await form.sync()
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])

    // 下一次儲存一開始就清掉（與「這筆」的提示同一處）；這裡讓伺服器拒絕這次儲存，只是為了不必替成功路徑準備 DOM。
    reject(400, { code: '23514', message: 'new row violates check constraint' })
    form.view.act(() => {
      form.view.current.handleSystolicChange(120, () => {})
      form.view.current.handleDiastolicChange(80, () => {})
      form.view.current.handlePulseChange(70, () => {})
    })
    form.view.act(() => { void form.view.current.submit() })
    await flush()
    form.view.rerender()
    expect(form.view.current.status).toBe('err')
    expect(form.view.current.otherPatientNotifyProblems).toEqual([])

    queue('patient-a', 'a-2', 185, 105)
    accept()
    await form.sync()
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    // 換到被點名的那位時刻意不清：看護正是要去處理它（Sonnet 審查）。
    form.switchTo('patient-a')
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    form.view.unmount()
  })

  test('a re-sent reading for someone else does not take over the on-screen reading\'s notice', async () => {
    queue('patient-b', 'b-1', 185, 105)
    queue('patient-a', 'a-1')
    const release = holdNotification('b-1', { ok: true, sharedTelegram: 'failed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()
    release()
    await flush()
    form.view.rerender()

    // A 的通知比 B 先回來；A 不該領序號，否則 B 自己的「沒有送出」會被當成過期而改成點名提示。
    expect(form.view.current.familyDelivery).toBe('not_sent')
    expect(form.view.current.otherPatientNotifyProblems).toEqual([])
    form.view.unmount()
  })

  test('an alert-level reading with no family channel is named when a newer reading already owns the notice', async () => {
    // 離線兩次量測一起補送：第一筆危險、第二筆正常，第二筆的通知結果先回來接手「這筆」的提示。
    queue('patient-b', 'b-danger', 185, 105)
    enqueuePendingBloodPressureRecord({
      id: 'b-normal', systolic: 120, diastolic: 80, pulse: 70, measured_at: '2026-10-06T01:02:00.000Z', source: 'manual_web',
      patient_id: 'patient-b', recorded_by: CAREGIVER, queued_at: '2026-10-06T01:03:00.000Z',
    })
    const release = holdNotification('b-danger', { ok: true, sharedTelegram: 'not_subscribed' }, { ok: true, sharedTelegram: 'not_subscribed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()
    release()
    await flush()
    form.view.rerender()

    // 以前這裡什麼都不顯示：危險讀數沒有任何家屬通知，看護卻不知道。
    expect(form.view.current.familyAlertSkipped).toBe(false)
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-b'])
    form.view.unmount()
  })

  test('a failed notification call whose notice was taken over is named instead of marking the newer reading as failed', async () => {
    queue('patient-b', 'b-1', 185, 105)
    queue('patient-b', 'b-2')
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    notifyResponse = async request => {
      if (request.recordId !== 'b-1') return { ok: true, sharedTelegram: 'delivered' }
      await gate
      throw new Error('Blood pressure notification failed')
    }
    const form = renderForm('patient-b')
    accept()

    await form.sync()
    release()
    await flush()
    form.view.rerender()

    expect(form.view.current.notifyFailed).toBe(false)
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-b'])
    form.view.unmount()
  })

  test('switching to B while a round started on A sends B\'s reading and reloads B\'s daily list', async () => {
    queue('patient-b', 'b-1')
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async () => {
      await gate
      return new Response(null, { status: 201 })
    }
    const form = renderForm('patient-a')
    const before = form.view.current.dailyRecordsVersion
    const running = latestFlushParams!.sync()
    form.switchTo('patient-b')
    release()
    await running
    await flush()
    form.view.rerender()

    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    expect(form.view.current.dailyRecordsVersion).toBe(before + 1)
    form.view.unmount()
  })

  test('B\'s own waiting records and the other-people count follow the switch right away, before any sync', async () => {
    queue('patient-a', 'a-1')
    queue('patient-b', 'b-1')
    queue('patient-b', 'b-2')
    const form = renderForm('patient-a')
    expect(form.view.current.pendingRecords.map(record => record.id)).toEqual(['a-1'])
    expect(form.view.current.otherPatientsPendingCount).toBe(2)

    form.switchTo('patient-b')

    expect(form.view.current.pendingRecords.map(record => record.id)).toEqual(['b-1', 'b-2'])
    expect(form.view.current.pendingViewRecords.every(record => record.patient_id === 'patient-b')).toBe(true)
    expect(form.view.current.otherPatientsPendingCount).toBe(1)
    form.view.unmount()
  })

  test('readings the server rejected for good stop the backoff, and other screens are told where to look', async () => {
    queue('patient-a', 'a-1')
    const form = renderForm('patient-b')
    reject(400, { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' })

    // 剩下的都是被拒絕的：這一輪算清空，不再每 10 分鐘白打一次，也不擋住別人新紀錄的立即探測。
    expect(await form.sync()).toBe(true)
    expect(latestFlushParams!.hasPending).toBe(false)
    expect(form.view.current.otherPatientsPendingCount).toBe(1)
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.otherPatientsRejected])

    // B 新的離線紀錄仍然算「在等」，觸發器才會對它立刻探測。
    queue('patient-b', 'b-1')
    form.switchTo('patient-a')
    form.switchTo('patient-b')
    expect(latestFlushParams!.hasPending).toBe(true)
    form.view.unmount()
  })

  test('knowing it is offline resets the "server cannot be reached" clock', async () => {
    setOnline(true)
    const start = Date.parse('2026-10-06T02:00:00.000Z')
    setSystemTime(new Date(start))
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    await form.sync()
    setSystemTime(new Date(start + PENDING_UNREACHABLE_AFTER_MS))
    setOnline(false)
    await form.sync()
    setOnline(true)
    setSystemTime(new Date(start + PENDING_UNREACHABLE_AFTER_MS + 1_000))

    await form.sync()

    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])
    form.view.unmount()
  })

  test('a long gap between failures restarts the clock instead of jumping straight to "cannot be reached"', async () => {
    setOnline(true)
    const start = Date.parse('2026-10-06T02:00:00.000Z')
    setSystemTime(new Date(start))
    queue('patient-b', 'b-1')
    const form = renderForm('patient-b')
    await form.sync()
    // App 在背景好幾個小時，期間沒有任何嘗試；醒來後第一次失敗。
    setSystemTime(new Date(start + 6 * 60 * 60_000))

    await form.sync()

    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])
    form.view.unmount()
  })

  test('another patient\'s alert-level reading with no family channel is named, judged by the level recorded with her own standard', async () => {
    // 畫面上載入的是 B 的標準，不能拿來評 A；入佇列時用 A 自己的標準記下的 family_alert（#1126）才算數。
    queue('patient-a', 'a-1', 100, 55, { family_alert: true })
    queue('patient-a', 'a-2', 100, 55, { family_alert: false })
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'not_subscribed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(notifyCalls).toHaveLength(2)
    expect(form.view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    expect(form.view.current.familyAlertSkipped).toBe(false)
    form.view.unmount()
  })

  test('an alert-level reading the server rejected does not promise to be sent automatically', async () => {
    queue('patient-b', 'b-danger', 185, 105)
    const form = renderForm('patient-b')
    expect(form.view.current.queuedFamilyAlert).toBe('alert')

    // 權限類拒絕會再試，原本那句仍然成立。
    reject(403, { code: '42501', message: 'permission denied' })
    await form.sync()
    expect(form.view.current.queuedFamilyAlert).toBe('alert')

    // 每日上限再試也不會成功：#1126 的「連線恢復後會自動補送」對它是錯的，改講家人不會收到、請直接打電話。
    reject(400, { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' })
    await form.sync()
    expect(form.view.current.queuedFamilyAlert).toBe('rejected')
    form.view.unmount()
  })

  test('a rejected reading whose level cannot be judged still tells the caregiver to call if it is high or low', async () => {
    // 離線重開 App：讀不到個別標準、入佇列時也沒記下 family_alert。
    currentEvaluator = OFFLINE_EVALUATOR
    queue('patient-b', 'b-1', 185, 105)
    const form = renderForm('patient-b')
    expect(form.view.current.queuedFamilyAlert).toBe('unknown')
    reject(400, { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' })

    await form.sync()

    expect(form.view.current.queuedFamilyAlert).toBe('rejected_unknown')
    form.view.unmount()
  })

  test('a re-sent reading of unknown level with no family channel still gets the "will not notify the family" notice', async () => {
    // App 一開就補送時個別標準常常還讀不到；以前（staging）用一般成人門檻會講，只認確定的警示級就會漏講。
    currentEvaluator = OFFLINE_EVALUATOR
    queue('patient-b', 'b-1', 185, 105)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'not_subscribed' })
    const form = renderForm('patient-b')
    accept()

    await form.sync()

    expect(form.view.current.familyAlertSkipped).toBe(true)
    form.view.unmount()
  })

  test('a round where something got through clears "the server cannot be reached"', async () => {
    setOnline(true)
    const start = Date.parse('2026-10-06T02:00:00.000Z')
    setSystemTime(new Date(start))
    queue('patient-b', 'b-1')
    queue('patient-b', 'b-2', 132, 78, { queued_at: '2026-10-06T01:02:00.000Z' })
    const form = renderForm('patient-b')
    await form.sync()
    setSystemTime(new Date(start + PENDING_UNREACHABLE_AFTER_MS))
    await form.sync()
    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingUnreachable])
    // 第一筆送到、第二筆又斷線：伺服器顯然連得上，只是網路不穩，不能再說「被擋」。
    let calls = 0
    respond = () => {
      calls += 1
      if (calls === 1) return new Response(null, { status: 201 })
      throw new TypeError('Failed to fetch')
    }

    await form.sync()

    expect(form.view.current.pendingSyncErrorTexts).toEqual([L.pendingSyncError])
    form.view.unmount()
  })
})

describe('nextPendingRejections (issue #1125)', () => {
  const record = (id: string) => ({
    id, systolic: 132, diastolic: 78, pulse: 72, measured_at: '2026-10-06T01:00:00.000Z', source: 'manual_web',
    patient_id: 'patient-b', recorded_by: CAREGIVER, queued_at: '2026-10-06T01:01:00.000Z',
  })
  const limit = { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' }
  const permission = { code: '42501', message: 'permission denied' }
  const offline = { message: 'TypeError: Failed to fetch', code: '', status: 0 }

  test('records what each rejection says and whether retrying could still help', () => {
    const next = nextPendingRejections({}, {
      remaining: [record('limit'), record('permission')],
      failures: [
        { record: record('limit'), error: limit, retryable: false },
        { record: record('permission'), error: permission, retryable: false },
      ],
    })
    expect(next.limit?.settled).toBe(true)
    expect(next.permission?.settled).toBe(false)
    expect(next.permission?.text.zh).toContain('重新登入')
  })

  test('keeps reasons for readings not tried this round, drops them for readings that left the queue or failed on the network', () => {
    const previous = nextPendingRejections({}, {
      remaining: [record('untried'), record('sent'), record('retried')],
      failures: ['untried', 'sent', 'retried'].map(id => ({ record: record(id), error: limit, retryable: false })),
    })
    const next = nextPendingRejections(previous, {
      remaining: [record('untried'), record('retried')],
      failures: [{ record: record('retried'), error: offline, retryable: true }],
    })
    expect(Object.keys(next)).toEqual(['untried'])
  })
})
