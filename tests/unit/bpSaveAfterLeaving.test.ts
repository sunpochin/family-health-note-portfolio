/*
檔案用途：用真的 supabase-js client 驗證 issue #1117：一次血壓寫入最多等 15 秒（逾時歸入離線佇列，不會停在「儲存中」）；
  看護離開血壓頁或換了病人之後才被拒絕的儲存，交給殼層保管、回到那位病人的輸入頁時接手顯示，殼層橫幅在任何分頁點名。
所在層：tests/unit；只有 fetch 由測試注入（不連網，且會尊重 AbortSignal），insertBloodPressureRecord、補送器、表單 hook 與橫幅都是正式程式碼。
主要關聯：src/lib/bloodPressureRecords.ts（BLOOD_PRESSURE_SAVE_TIMEOUT_MS）、src/features/vitals/hooks/useBloodPressureQueueCoordinator.ts（rejectedSaves）、
  useBloodPressureInputForm.ts（交付與接手）、src/features/vitals/components/BloodPressureSaveRejectedBanner.tsx、tests/unit/helpers/bloodPressureQueueHarness.ts。
*/
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { renderWithBloodPressureQueue } from './helpers/bloodPressureQueueHarness'
import { findAll, fire, textContent } from './helpers/elementTree'
import type { PatientIdentity } from '../../src/lib/auth'

installReactHookHarness()

// ── 注入的 fetch：記下 signal，讓「伺服器一直不回」的替身能在逾時中止時像真的 fetch 一樣以 AbortError 拒絕 ─────
interface RecordedRequest { method: string; url: string; body: Record<string, unknown> | undefined; signal: AbortSignal | null }
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
        signal: init?.signal ?? null,
      }
      requests.push(request)
      return respond(request)
    }) as typeof fetch,
  },
})
mock.module('../../src/lib/supabase', () => ({ supabase: client }))

const bpInserts = () => requests.filter(request => request.method === 'POST' && request.url.includes('/rest/v1/blood_pressure_records'))
// 伺服器永遠不回；只有呼叫端的 AbortSignal 中止時才像瀏覽器的 fetch 一樣以 AbortError 拒絕。
const hang = () => {
  respond = request => new Promise((_, reject) => {
    request.signal?.addEventListener('abort', () => reject(request.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')))
  })
}
const accept = () => { respond = () => new Response(null, { status: 201 }) }
// 回應等測試放行後才回來（模擬「寫入還在路上時看護離開」），放行後依 body 回。
function gatedReject(status: number, body: Record<string, unknown>) {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  respond = async () => {
    await gate
    return new Response(JSON.stringify({ details: null, hint: null, ...body }), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return () => release()
}
const DAILY_LIMIT = { code: 'P0001', message: 'daily_blood_pressure_limit exceeded' }

// ── localStorage 替身 ────────────────────────────────────────────────────────
const originalLocalStorage = globalThis.localStorage
const stored = new Map<string, string>()
let storageBroken = false

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
const actualTelegram = await import('../../src/lib/telegramNotification')
mock.module('../../src/lib/telegramNotification', () => ({
  ...actualTelegram,
  sendTelegramNotification: async () => actualTelegram.parseTelegramNotificationResult({ ok: true, sharedTelegram: 'delivered' }),
}))
const actualAnalytics = await import('../../src/lib/analytics')
mock.module('../../src/lib/analytics', () => ({ ...actualAnalytics, trackFirstRecordSaved: () => {} }))
const actualBpEvaluator = await import('../../src/features/vitals/hooks/useBpEvaluator')
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  ...actualBpEvaluator,
  useBpEvaluator: () => actualBpEvaluator.GENERAL_ADULT_EVALUATOR,
}))
mock.module('../../src/hooks/usePendingWriteFlush', () => ({
  usePendingWriteFlush: () => ({ syncing: false, lastAttemptAt: null, retryNow: async () => {} }),
}))
// 正式的 15 秒對測試太長：表單走的 insert 改用短逾時，其餘行為（AbortController、回讀、錯誤形狀）都是正式程式碼。
const actualRecords = await import('../../src/lib/bloodPressureRecords')
// 先把真的函式抓成區域常數：mock.module 會改寫模組的 live binding，之後再讀 actualRecords.insertBloodPressureRecord
// 拿到的是替身自己，變成無限遞迴（與 reactHookHarness 對 react 的同一個坑）。
const realInsertBloodPressureRecord = actualRecords.insertBloodPressureRecord
const { BLOOD_PRESSURE_SAVE_TIMEOUT_MS } = actualRecords
let saveTimeoutMs = 40
mock.module('../../src/lib/bloodPressureRecords', () => ({
  ...actualRecords,
  insertBloodPressureRecord: (payload: Parameters<typeof realInsertBloodPressureRecord>[0]) => realInsertBloodPressureRecord(payload, { timeoutMs: saveTimeoutMs }),
}))

const { isRetryableWriteError, readErrorFields } = await import('../../src/lib/dataErrors')
const { readPendingBloodPressureRecords } = await import('../../src/lib/bloodPressurePendingQueue')
const { useBloodPressureInputForm } = await import('../../src/features/vitals/hooks/useBloodPressureInputForm')
const { useBloodPressureQueueCoordinator } = await import('../../src/features/vitals/hooks/useBloodPressureQueueCoordinator')
const { BloodPressureQueueContext } = await import('../../src/features/vitals/hooks/BloodPressureQueueProvider')
const { BloodPressureSaveRejectedBanner, SAVE_REJECTED_BANNER_TEXT } = await import('../../src/features/vitals/components/BloodPressureSaveRejectedBanner')
const { BpLimitBlockedNotice } = await import('../../src/features/vitals/components/BpLimitBlockedNotice')
const { L, saveErrorMessage } = await import('../../src/features/vitals/pages/InputPage.utils')
const queueModules = { useBloodPressureQueueCoordinator, BloodPressureQueueContext }

const CAREGIVER = 'care@example.com'
const PATIENTS: PatientIdentity[] = [['patient-a', 'Person A'], ['patient-b', 'Person B']].map(([patientId, displayName], index) => ({
  patientId, displayName, isOwnPatient: index === 0, canManageMedication: true, careRecipientType: 'human', archivedAt: null,
}))
const flush = () => new Promise(resolve => setTimeout(resolve, 0))
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const mountForm = (getPatientId: () => string, getVisible: () => boolean = () => true) =>
  renderWithBloodPressureQueue(queueModules, getPatientId, CAREGIVER, () => useBloodPressureInputForm({ subject: getPatientId(), patientId: getPatientId(), userEmail: CAREGIVER, visible: getVisible() }))

async function submitReading(view: ReturnType<typeof mountForm>, systolic: number, diastolic: number, pulse: number) {
  view.act(() => {
    view.current.handleSystolicChange(systolic, () => {})
    view.current.handleDiastolicChange(diastolic, () => {})
    view.current.handlePulseChange(pulse, () => {})
  })
  view.act(() => { void view.current.submit() })
  await flush()
  view.rerender()
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the save to fail')
}

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, 'HTMLElement')
beforeAll(() => {
  const globals = globalThis as Record<string, unknown>
  globals.document = { activeElement: null }
  globals.HTMLElement = class {}
})
afterAll(() => {
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument)
  else Reflect.deleteProperty(globalThis, 'document')
  if (originalHTMLElement) Object.defineProperty(globalThis, 'HTMLElement', originalHTMLElement)
  else Reflect.deleteProperty(globalThis, 'HTMLElement')
  if (originalLocalStorage) (globalThis as typeof globalThis & { localStorage: Storage }).localStorage = originalLocalStorage
  else Reflect.deleteProperty(globalThis, 'localStorage')
})

beforeEach(() => {
  stored.clear()
  storageBroken = false
  requests.length = 0
  saveTimeoutMs = 40
  respond = () => { throw new TypeError('Failed to fetch') }
  ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: key => stored.get(key) ?? null,
    setItem: (key, value) => {
      if (storageBroken) throw new Error('QuotaExceededError')
      stored.set(key, value)
    },
    removeItem: key => { stored.delete(key) },
    get length() { return stored.size },
    key: index => [...stored.keys()][index] ?? null,
  } as Storage
})

describe('a blood pressure save is cut off after the timeout (issue #1117)', () => {
  const payload = {
    id: '00000000-0000-4000-8000-000000000001', systolic: 185, diastolic: 105, pulse: 80,
    measured_at: '2026-10-07T03:00:00.000Z', source: 'manual_web', patient_id: 'patient-a', recorded_by: CAREGIVER,
  }

  test('the insert is aborted and the error is retryable, so the reading can go to the queue', async () => {
    hang()
    const error = await rejectionOf(realInsertBloodPressureRecord(payload, { timeoutMs: 20 }))
    expect(bpInserts()).toHaveLength(1)
    expect(bpInserts()[0]?.signal?.aborted).toBe(true)
    expect(isRetryableWriteError(error)).toBe(true)
    expect(readErrorFields(error).status).toBe(0)
    expect(readErrorFields(error).message).toMatch(/^AbortError: /)
  })

  test('a re-send that hits the daily limit because the aborted insert had already landed reads the row back and counts as existing (PR #1219 review)', async () => {
    // 第 9 筆在逾時後其實已寫入；補送再來一次先撞 BEFORE INSERT 的上限 trigger（不排除 NEW.id），輪不到主鍵去重。
    respond = request => request.method === 'POST'
      ? new Response(JSON.stringify({ code: 'P0001', message: 'daily_blood_pressure_limit exceeded', details: null, hint: null }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify([{ id: payload.id }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    await expect(realInsertBloodPressureRecord(payload, { timeoutMs: 1000 })).resolves.toBe('already-existed')
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
  })

  test('a transient failure on the read-back after the daily limit stays retryable, so the re-send keeps going (Codex App review)', async () => {
    for (const status of [502, 429]) {
      requests.length = 0
      respond = request => request.method === 'POST'
        ? new Response(JSON.stringify({ code: 'P0001', message: 'daily_blood_pressure_limit exceeded', details: null, hint: null }), { status: 400, headers: { 'Content-Type': 'application/json' } })
        : new Response('Bad Gateway', { status, headers: { 'Content-Type': 'text/plain' } })
      const error = await rejectionOf(realInsertBloodPressureRecord(payload, { timeoutMs: 1000 }))
      expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
      expect(readErrorFields(error).status).toBe(status)
      expect(isRetryableWriteError(error)).toBe(true)
    }
  })

  test('a genuine daily-limit rejection (row not there) still surfaces as the limit error', async () => {
    respond = request => request.method === 'POST'
      ? new Response(JSON.stringify({ code: 'P0001', message: 'daily_blood_pressure_limit exceeded', details: null, hint: null }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    const error = await rejectionOf(realInsertBloodPressureRecord(payload, { timeoutMs: 1000 }))
    expect(readErrorFields(error)).toMatchObject({ code: 'P0001', status: 400 })
    expect(isRetryableWriteError(error)).toBe(false)
  })

  test('the deadline ends the whole call even when the underlying request never honours the abort signal (token refresh path; Codex App review)', async () => {
    // supabase-js 送資料請求前先 await 取得／更新 token，那一段不收 signal；這裡用一個無視 signal、永遠不回的 fetch 模擬。
    respond = () => new Promise<Response>(() => {})
    const startedAt = Date.now()
    const error = await rejectionOf(realInsertBloodPressureRecord(payload, { timeoutMs: 30 }))
    expect(Date.now() - startedAt).toBeLessThan(1000)
    expect(isRetryableWriteError(error)).toBe(true)
    expect(readErrorFields(error)).toMatchObject({ code: '', status: 0 })
    expect(readErrorFields(error).message).toMatch(/^AbortError: /)
    expect(bpInserts()[0]?.signal?.aborted).toBe(true)
  })

  test('the default timeout is the 15-second rule', () => {
    expect(BLOOD_PRESSURE_SAVE_TIMEOUT_MS).toBe(15_000)
  })

  test('a save that never gets an answer does not keep the form in "saving": it is queued for the shell re-sender', async () => {
    hang()
    const view = mountForm(() => 'patient-a')
    await submitReading(view, 185, 105, 80)
    expect(view.current.status).toBe('saving')
    await wait(saveTimeoutMs * 2)
    view.rerender()
    expect(view.current.status).toBe('queued')
    expect(view.current.pendingRecords).toHaveLength(1)
    expect(readPendingBloodPressureRecords('patient-a', CAREGIVER)[0]).toMatchObject({ systolic: 185, diastolic: 105, pulse: 80, family_alert: true })
    expect(view.coordinator.current.rejectedSaves).toEqual([])
    view.unmount()
  })
})

describe('a rejection that arrives after the caregiver left (issue #1117)', () => {
  test('after leaving the page, the rejection is kept by the shell and shown when the page comes back', async () => {
    const release = gatedReject(400, DAILY_LIMIT)
    const view = mountForm(() => 'patient-a')
    await submitReading(view, 185, 105, 80)
    expect(view.current.status).toBe('saving')
    // 看護點了別的分頁：輸入頁卸載，補送器（殼層）還在。
    view.unmountScreen()
    release()
    await flush()
    const coordinator = view.coordinator
    expect(coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80 } }])
    expect(readPendingBloodPressureRecords('patient-a', CAREGIVER)).toEqual([])

    // 回到這位病人的輸入頁：接手顯示，與當場被拒絕時同一個狀態；殼層那份清掉，橫幅跟著消失。
    const back = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    expect(back.current.status).toBe('err')
    expect(back.current.errMsg).toBe(saveErrorMessage(coordinator.current.rejectedSaves[0]?.error ?? { code: 'P0001', message: 'daily_blood_pressure_limit' }, 'zh'))
    expect(back.current.limitBlockedReading).toMatchObject({ patientId: 'patient-a', systolic: 185 })
    expect(coordinator.current.rejectedSaves).toEqual([])
    back.unmount()
    coordinator.unmount()
  })

  test('a hidden panel counts as "left": the daily-care page keeps InputPage mounted when another section is open (PR #1219 review)', async () => {
    const release = gatedReject(400, DAILY_LIMIT)
    let visible = true
    const view = mountForm(() => 'patient-a', () => visible)
    await submitReading(view, 185, 105, 80)
    // 看護切到體溫區段：面板 hidden、元件沒卸載。
    visible = false
    view.rerender()
    release()
    await flush()
    view.rerender()
    // 錯誤不能寫進看不到的面板，也不能在面板隱藏時被接手（接手等於把橫幅關掉）。
    expect(view.current.status).not.toBe('err')
    expect(view.coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: { systolic: 185 } }])
    // 切回血壓區段：接手。
    visible = true
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.limitBlockedReading).toMatchObject({ systolic: 185 })
    expect(view.coordinator.current.rejectedSaves).toEqual([])
    view.unmount()
  })

  test('after switching patient, B stays clean, the rejection waits in the shell, and A gets it back on return', async () => {
    const release = gatedReject(400, { code: '42501', message: 'new row violates row-level security policy' })
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    await submitReading(view, 150, 95, 70)
    patientId = 'patient-b'
    view.rerender()
    release()
    await flush()
    view.rerender()
    // B 的畫面不能出現 A 的錯誤（§ 3.5），但錯誤也不能消失。
    expect(view.current.status).not.toBe('err')
    expect(view.current.errMsg).toBe('')
    expect(view.coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: null }])

    patientId = 'patient-a'
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.errMsg.length).toBeGreaterThan(0)
    expect(view.current.limitBlockedReading).toBeNull()
    expect(view.coordinator.current.rejectedSaves).toEqual([])
    view.unmount()
  })

  test('a retryable failure whose local queue is unavailable is also kept after leaving', async () => {
    storageBroken = true
    const release = gatedReject(503, { message: 'upstream unavailable' })
    const view = mountForm(() => 'patient-a')
    await submitReading(view, 150, 95, 70)
    view.unmountScreen()
    release()
    await flush()
    // 結果不明：暫時性失敗代表伺服器可能已經寫入；接手時不能說「沒存進去、請重新輸入」。
    expect(view.coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: null, uncertain: true }])
    const back = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, view.coordinator.current]] })
    expect(back.current.status).toBe('err')
    expect(back.current.errMsg).toBe(L.saveOutcomeUnknown.zh)
    back.unmount()
    view.coordinator.unmount()
  })

  test('an older rejection is not adopted while a newer save on the same patient is still in flight (PR #1219 review)', async () => {
    // 第一筆：被拒絕但回應被扣住；看護離開又回來、再送第二筆（也扣住）。
    let releaseFirst: () => void = () => {}
    let releaseSecond: () => void = () => {}
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    let posts = 0
    respond = async request => {
      if (request.method !== 'POST') return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      posts += 1
      if (posts === 1) {
        await firstGate
        return new Response(JSON.stringify({ details: null, hint: null, ...DAILY_LIMIT }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      await secondGate
      return new Response(null, { status: 201 })
    }
    const first = mountForm(() => 'patient-a')
    await submitReading(first, 185, 105, 80)
    first.unmountScreen()
    const coordinator = first.coordinator
    const second = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    second.act(() => {
      second.current.handleSystolicChange(150, () => {})
      second.current.handleDiastolicChange(95, () => {})
      second.current.handlePulseChange(70, () => {})
    })
    second.act(() => { void second.current.submit() })
    await flush()
    expect(second.current.status).toBe('saving')

    releaseFirst()
    await flush()
    second.provideContext(BloodPressureQueueContext, coordinator.current)
    second.rerender()
    // 舊的拒絕回來了，但新的一筆還在送：不能把 saving 改成 err（按鈕會看起來可以按、切換器提早解鎖）。
    expect(coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a' }])
    expect(second.current.status).toBe('saving')

    releaseSecond()
    await flush()
    second.provideContext(BloodPressureQueueContext, coordinator.current)
    second.rerender()
    // 新的一筆成功：2 秒後回 idle 才接手舊的拒絕（成功的那一刻先不蓋）。
    expect(second.current.status).toBe('ok')
    expect(coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a' }])
    await wait(2100)
    second.provideContext(BloodPressureQueueContext, coordinator.current)
    second.rerender()
    expect(second.current.status).toBe('err')
    expect(second.current.limitBlockedReading).toMatchObject({ systolic: 185 })
    expect(coordinator.current.rejectedSaves).toEqual([])
    second.unmount()
    coordinator.unmount()
  })

  test('a newer rejection on the same patient is not overwritten by an older one waiting in the shell (PR #1219 review round 2)', async () => {
    // 第一筆：每日上限（185/105）回應扣住；離開再回來送第二筆（150/95），第二筆被 RLS 拒絕。
    let releaseFirst: () => void = () => {}
    let releaseSecond: () => void = () => {}
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    let posts = 0
    respond = async request => {
      if (request.method !== 'POST') return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      posts += 1
      if (posts === 1) {
        await firstGate
        return new Response(JSON.stringify({ details: null, hint: null, ...DAILY_LIMIT }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      await secondGate
      return new Response(JSON.stringify({ details: null, hint: null, code: '42501', message: 'new row violates row-level security policy' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    }
    const first = mountForm(() => 'patient-a')
    await submitReading(first, 185, 105, 80)
    first.unmountScreen()
    const coordinator = first.coordinator
    const second = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    second.act(() => {
      second.current.handleSystolicChange(150, () => {})
      second.current.handleDiastolicChange(95, () => {})
      second.current.handlePulseChange(70, () => {})
    })
    second.act(() => { void second.current.submit() })
    await flush()
    releaseFirst()
    await flush()
    releaseSecond()
    await flush()
    second.provideContext(BloodPressureQueueContext, coordinator.current)
    second.rerender()
    // 眼前這筆（150/95，RLS）照常顯示；舊的（185/105，上限）留在殼層橫幅，不覆蓋、也不丟。
    expect(second.current.status).toBe('err')
    expect(second.current.limitBlockedReading).toBeNull()
    expect(second.current.errMsg).toBe(saveErrorMessage({ code: '42501', status: 403 }, 'zh'))
    expect(coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: { systolic: 185 } }])
    second.unmount()
    coordinator.unmount()
  })

  test('two rejections that both arrive with no form visible are both kept; the form adopts the oldest and leaves the rest in the shell (PR #1219 review round 3)', async () => {
    let releaseFirst: () => void = () => {}
    let releaseSecond: () => void = () => {}
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve })
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve })
    let posts = 0
    respond = async request => {
      if (request.method !== 'POST') return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      posts += 1
      if (posts === 1) {
        await firstGate
        return new Response(JSON.stringify({ details: null, hint: null, ...DAILY_LIMIT }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
      await secondGate
      return new Response(JSON.stringify({ details: null, hint: null, code: '42501', message: 'new row violates row-level security policy' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
    }
    // 第一筆送出後離開；回來再送第二筆，又離開；兩個結果這時才回來。
    const first = mountForm(() => 'patient-a')
    await submitReading(first, 185, 105, 80)
    first.unmountScreen()
    const coordinator = first.coordinator
    const second = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    second.act(() => {
      second.current.handleSystolicChange(150, () => {})
      second.current.handleDiastolicChange(95, () => {})
      second.current.handlePulseChange(70, () => {})
    })
    second.act(() => { void second.current.submit() })
    await flush()
    second.unmount()
    releaseSecond()
    await flush()
    releaseFirst()
    await flush()
    // 後到的（第一筆、上限、危險讀數）不能把先到的擠掉；兩筆都在，依到達順序。
    expect(coordinator.current.rejectedSaves.map(rejection => rejection.limitBlockedReading?.systolic ?? null)).toEqual([null, 185])
    // 回到輸入頁：接手最早到的那筆，另一筆留在殼層橫幅。
    const back = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    expect(back.current.status).toBe('err')
    expect(back.current.limitBlockedReading).toBeNull()
    expect(coordinator.current.rejectedSaves.map(rejection => rejection.limitBlockedReading?.systolic ?? null)).toEqual([185])
    back.unmount()
    coordinator.unmount()
  })

  test('a browser tab in the background counts as "left": the rejection goes to the cross-tab shell store (Codex round 4)', async () => {
    const release = gatedReject(400, DAILY_LIMIT)
    // document 替身要有 visibilitychange 監聽：補送器靠它知道分頁回到前景。
    const globals = globalThis as Record<string, unknown>
    const previousDocument = globals.document
    const visibilityListeners = new Set<() => void>()
    const fakeDocument = {
      visibilityState: 'visible' as 'visible' | 'hidden',
      activeElement: null,
      addEventListener: (type: string, handler: () => void) => { if (type === 'visibilitychange') visibilityListeners.add(handler) },
      removeEventListener: (_type: string, handler: () => void) => { visibilityListeners.delete(handler) },
    }
    globals.document = fakeDocument
    const setTabVisibility = (state: 'visible' | 'hidden') => {
      fakeDocument.visibilityState = state
      for (const handler of visibilityListeners) handler()
    }
    try {
      const view = mountForm(() => 'patient-a')
      await submitReading(view, 185, 105, 80)
      // 看護切到另一個瀏覽器分頁：這個分頁的表單仍掛著、區段也看得到，但 document 是 hidden。
      setTabVisibility('hidden')
      release()
      await flush()
      view.rerender()
      expect(view.current.status).not.toBe('err')
      expect(view.coordinator.current.rejectedSaves).toMatchObject([{ patientId: 'patient-a', limitBlockedReading: { systolic: 185 }, callFamily: true }])
      expect([...stored.keys()].some(key => key.includes('rejected-saves.v1'))).toBe(true)
      // 回到前景：這個分頁的輸入頁接手，殼層與本機那份清掉。
      setTabVisibility('visible')
      view.rerender()
      expect(view.current.status).toBe('err')
      expect(view.current.limitBlockedReading).toMatchObject({ systolic: 185 })
      expect(view.coordinator.current.rejectedSaves).toEqual([])
      expect([...stored.keys()].some(key => key.includes('rejected-saves.v1'))).toBe(false)
      view.unmount()
    } finally {
      globals.document = previousDocument
    }
  })

  test('a rejection that comes back while the page is still open is shown in place, not handed to the shell', async () => {
    const release = gatedReject(400, DAILY_LIMIT)
    const view = mountForm(() => 'patient-a')
    await submitReading(view, 185, 105, 80)
    release()
    await flush()
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.limitBlockedReading).toMatchObject({ systolic: 185 })
    expect(view.coordinator.current.rejectedSaves).toEqual([])
    view.unmount()
  })

  test('a save that succeeds after leaving leaves nothing behind', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async () => { await gate; return new Response(null, { status: 201 }) }
    const view = mountForm(() => 'patient-a')
    await submitReading(view, 120, 80, 70)
    view.unmountScreen()
    release()
    await flush()
    expect(view.coordinator.current.rejectedSaves).toEqual([])
    view.coordinator.unmount()
  })
})

describe('the shell banner for a rejected save (issue #1117)', () => {
  const buttons = (tree: unknown) => findAll(tree, element => element.type === 'button')
  const buttonLabelled = (tree: unknown, label: string) => {
    const match = buttons(tree).find(button => textContent(button) === label)
    if (!match) throw new Error(`no button labelled ${label}`)
    return match
  }
  function mountBanner(selectedPatientId: string, switchablePatientIds: readonly string[] = ['patient-a', 'patient-b']) {
    const coordinator = renderHook(() => useBloodPressureQueueCoordinator({ patientId: selectedPatientId, userEmail: CAREGIVER }))
    const opened: number[] = []
    const switched: string[] = []
    const banner = renderHook(() => BloodPressureSaveRejectedBanner({
      selectedPatientId, patients: PATIENTS, switchablePatientIds, onOpenBloodPressure: () => { opened.push(1) }, onSwitchTo: id => { switched.push(id) },
    }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    const sync = () => { banner.provideContext(BloodPressureQueueContext, coordinator.current); return banner.rerender() }
    return { coordinator, banner, opened, switched, sync }
  }

  test('renders nothing while there is no rejected save', () => {
    const { banner, coordinator } = mountBanner('patient-a')
    expect(banner.current).toBeNull()
    banner.unmount()
    coordinator.unmount()
  })

  test('names the patient and the reason, opens the blood pressure section, and "got it" clears it', () => {
    const { coordinator, banner, opened, sync } = mountBanner('patient-a')
    const error = { code: '42501', status: 403, message: 'new row violates row-level security policy' }
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error, limitBlockedReading: null })
    const tree = sync()
    expect(textContent(tree)).toContain(SAVE_REJECTED_BANNER_TEXT.rejected('Person A', saveErrorMessage(error, 'zh')).zh)
    expect(findAll(tree, element => element.type === BpLimitBlockedNotice)).toHaveLength(0)
    fire(buttonLabelled(tree, SAVE_REJECTED_BANNER_TEXT.openBloodPressure.zh), 'onClick')
    expect(opened).toEqual([1])
    fire(buttonLabelled(tree, SAVE_REJECTED_BANNER_TEXT.dismiss.zh), 'onClick')
    expect(coordinator.current.rejectedSaves).toEqual([])
    expect(sync()).toBeNull()
    banner.unmount()
    coordinator.unmount()
  })

  test('a reading blocked by the daily limit shows its level and the limit text through BpLimitBlockedNotice', () => {
    const { coordinator, banner, sync } = mountBanner('patient-a')
    const error = { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit exceeded' }
    const reading = { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' }
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error, limitBlockedReading: reading })
    const tree = sync()
    expect(textContent(tree)).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedByLimit('Person A').zh)
    const [notice] = findAll(tree, element => element.type === BpLimitBlockedNotice)
    expect(notice?.props).toMatchObject({ reading, limitMessage: saveErrorMessage(error, 'zh') })
    banner.unmount()
    coordinator.unmount()
  })

  test('for another patient it only names her and offers to switch; no values, no reason', () => {
    const { coordinator, banner, switched, sync } = mountBanner('patient-b')
    const error = { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit exceeded' }
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error, limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' } })
    const tree = sync()
    const text = textContent(tree)
    expect(text).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhere('Person A').zh)
    expect(text).not.toContain('185')
    expect(text).not.toContain(saveErrorMessage(error, 'zh'))
    expect(findAll(tree, element => element.type === BpLimitBlockedNotice)).toHaveLength(0)
    fire(buttonLabelled(tree, SAVE_REJECTED_BANNER_TEXT.switchTo('Person A').zh), 'onClick')
    expect(switched).toEqual(['patient-a'])
    banner.unmount()
    coordinator.unmount()
  })

  test('an uncertain outcome for another patient also avoids telling the caregiver to re-enter', () => {
    const { coordinator, banner, sync } = mountBanner('patient-b')
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error: { code: '', status: 0, message: 'AbortError: The operation was aborted.' }, limitBlockedReading: null, uncertain: true })
    const text = textContent(sync())
    expect(text).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhereUncertain('Person A').zh)
    expect(text).not.toContain(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhere('Person A').zh)
    banner.unmount()
    coordinator.unmount()
  })

  test('an uncertain outcome asks the caregiver to check today\'s records before re-entering, not to re-enter', () => {
    const { coordinator, banner, sync } = mountBanner('patient-a')
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error: { code: '', status: 0, message: 'AbortError: The operation was aborted.' }, limitBlockedReading: null, uncertain: true })
    const text = textContent(sync())
    expect(text).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedUncertain('Person A').zh)
    expect(text).not.toContain(SAVE_REJECTED_BANNER_TEXT.rejected('Person A', '').zh.slice(0, 20))
    banner.unmount()
    coordinator.unmount()
  })

  test('no switch button when that patient can no longer be switched to (archived or access revoked)', () => {
    const { coordinator, banner, sync } = mountBanner('patient-b', ['patient-b'])
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'rejected-1', patientId: 'patient-a', error: { code: '42501', status: 403, message: 'rls' }, limitBlockedReading: null })
    const tree = sync()
    expect(textContent(tree)).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhere('Person A').zh)
    expect(buttons(tree).map(button => textContent(button))).toEqual([SAVE_REJECTED_BANNER_TEXT.dismiss.zh])
    banner.unmount()
    coordinator.unmount()
  })

  test('two late rejections are both kept and each dismissed on its own', () => {
    const { coordinator, banner, sync } = mountBanner('patient-a')
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'first', patientId: 'patient-a', error: { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit exceeded' }, limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' } })
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'second', patientId: 'patient-a', error: { code: '42501', status: 403, message: 'rls' }, limitBlockedReading: null })
    // 同一筆的結果只算一次。
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'second', patientId: 'patient-a', error: { code: '42501', status: 403, message: 'rls' }, limitBlockedReading: null })
    let tree = sync()
    expect(findAll(tree, element => typeof element.props?.['data-rejected-save'] === 'string').map(element => element.props['data-rejected-save'])).toEqual(['first', 'second'])
    expect(findAll(tree, element => element.type === BpLimitBlockedNotice)).toHaveLength(1)
    // 知道了第二筆：第一筆（危險讀數）還在。
    const dismissButtons = buttons(tree).filter(button => textContent(button) === SAVE_REJECTED_BANNER_TEXT.dismiss.zh)
    expect(dismissButtons).toHaveLength(2)
    fire(dismissButtons[1], 'onClick')
    tree = sync()
    expect(findAll(tree, element => typeof element.props?.['data-rejected-save'] === 'string').map(element => element.props['data-rejected-save'])).toEqual(['first'])
    banner.unmount()
    coordinator.unmount()
  })

  test('another patient\'s rejected danger reading still tells the caregiver to call, without values (Codex round 4)', () => {
    const { coordinator, banner, sync } = mountBanner('patient-b', ['patient-b'])
    coordinator.current.reportRejectedSave({ at: Date.now(), recordId: 'archived-danger', patientId: 'patient-a', error: { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit exceeded' }, limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' }, callFamily: true })
    const tree = sync()
    const text = textContent(tree)
    expect(text).toContain(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhereCallFamily('Person A').zh)
    expect(text).not.toContain('185')
    expect(findAll(tree, element => element.type === BpLimitBlockedNotice)).toHaveLength(0)
    banner.unmount()
    coordinator.unmount()
  })

  test('a rejected save is persisted for other tabs: a fresh coordinator reads it, storage events add and remove it per record, and clear keeps only unpersisted ones', () => {
    const first = renderHook(() => useBloodPressureQueueCoordinator({ patientId: 'patient-a', userEmail: CAREGIVER }))
    first.current.reportRejectedSave({ at: 1, recordId: 'persisted', patientId: 'patient-a', error: { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit exceeded' }, limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' }, callFamily: true })
    const key = [...stored.keys()].find(candidate => candidate.includes('rejected-saves.v1'))
    expect(key).toContain('record-persisted')
    // 另一個分頁（或重新整理）一掛載就讀得到，錯誤摘要與讀數都在。
    const second = renderHook(() => useBloodPressureQueueCoordinator({ patientId: 'patient-b', userEmail: CAREGIVER }))
    expect(second.current.rejectedSaves).toMatchObject([{ recordId: 'persisted', patientId: 'patient-a', limitBlockedReading: { systolic: 185 }, callFamily: true }])
    expect(saveErrorMessage(second.current.rejectedSaves[0]?.error, 'zh')).toBe(saveErrorMessage({ code: 'P0001', message: 'daily_blood_pressure_limit exceeded' }, 'zh'))
    // 第一個分頁清掉它：第二個分頁靠 storage 事件減掉。
    first.current.clearRejectedSave('persisted')
    expect(stored.has(key!)).toBe(false)
    first.unmount()
    second.unmount()
  })

  test('the banner copy exists in all three locales', () => {
    for (const locale of ['id', 'zh', 'en'] as const) {
      expect(SAVE_REJECTED_BANNER_TEXT.rejected('X', 'Y')[locale]).toContain('X')
      expect(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhere('X')[locale]).toContain('X')
      expect(SAVE_REJECTED_BANNER_TEXT.openBloodPressure[locale].length).toBeGreaterThan(3)
      expect(SAVE_REJECTED_BANNER_TEXT.dismiss[locale].length).toBeGreaterThan(2)
    }
  })
})
