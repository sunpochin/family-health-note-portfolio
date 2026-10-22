/*
檔案用途：用真的 supabase-js client 驗證血壓離線佇列的殼層補送器（issue #1138）：
  沒有血壓輸入頁掛著也會補送並通知家屬；輸入頁卸載後、換病人後、或序號被同一位病人的補送接手後才回來的通知結果，
  一律改成點名提示而不是丟掉；兩個分頁不會同時跑同一輪；另一個分頁改了佇列會立刻反映在清單上。
所在層：tests/unit；只有 fetch 由測試注入（不連網），supabase-js、insertBloodPressureRecord、佇列、補送器與表單 hook 都是正式程式碼。
  觸發時機（online／回前景／退避）由 usePendingWriteFlush 的測試負責，這裡直接拿 hook 交出去的「同步一輪」來跑。
主要關聯：src/features/vitals/hooks/useBloodPressureQueueCoordinator.ts、BloodPressureQueueProvider.tsx、useBloodPressureInputForm.ts、
  shellNoticeStore.test.ts（逐鍵保存、寫入降級與跨分頁清除）、src/lib/bloodPressurePendingQueue.ts、tests/unit/helpers/bloodPressureQueueHarness.ts、tests/unit/bpQueueAllPatients.test.ts（同一套替身）。
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { renderWithBloodPressureQueue } from './helpers/bloodPressureQueueHarness'

installReactHookHarness()

// ── 注入的 fetch：錯誤物件一律由 postgrest-js 自己產生，不自己捏形狀 ─────────────────────
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
const bpInserts = () => requests.filter(request => request.method === 'POST' && request.url.includes('/rest/v1/blood_pressure_records'))

// ── 佇列用的 localStorage 替身（要能列 key：補送要找出這個帳號所有病人的桶）──────────────
const originalLocalStorage = globalThis.localStorage
const stored = new Map<string, string>()

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

const notifyCalls: Array<{ recordId: string; patientId: string }> = []
const actualTelegram = await import('../../src/lib/telegramNotification')
let notifyResponse: (request: { recordId: string; patientId: string }) => Promise<unknown> = async () => ({ ok: true, sharedTelegram: 'delivered' })
mock.module('../../src/lib/telegramNotification', () => ({
  ...actualTelegram,
  sendTelegramNotification: async (request: { recordId: string; patientId: string }) => {
    notifyCalls.push(request)
    return actualTelegram.parseTelegramNotificationResult(await notifyResponse(request))
  },
}))
const actualAnalytics = await import('../../src/lib/analytics')
// 記下每次埋點：帳號的第一筆紀錄在沒有輸入頁的補送裡寫入時也要埋（PR #1218 Codex P2）。
const firstRecordEvents: unknown[] = []
mock.module('../../src/lib/analytics', () => ({ ...actualAnalytics, trackFirstRecordSaved: (properties: unknown) => { firstRecordEvents.push(properties) } }))
const actualBpEvaluator = await import('../../src/features/vitals/hooks/useBpEvaluator')
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  ...actualBpEvaluator,
  useBpEvaluator: () => actualBpEvaluator.GENERAL_ADULT_EVALUATOR,
}))
// 補送器每次 render 都會呼叫觸發器 hook；記下最後一次拿到的「同步一輪」，由測試決定何時跑。
let latestFlushParams: { enabled: boolean; hasPending: boolean; sync: () => Promise<boolean> } | null = null
// 第一次 render 交給觸發器的參數：hydration 要在第一次探測前就知道有沒有待送（PR #1218 Codex P2）。
let firstFlushParams: { enabled: boolean; hasPending: boolean } | null = null
mock.module('../../src/hooks/usePendingWriteFlush', () => ({
  usePendingWriteFlush: (params: { enabled: boolean; hasPending: boolean; sync: () => Promise<boolean> }) => {
    latestFlushParams = params
    firstFlushParams ??= params
    return { syncing: false, lastAttemptAt: null, retryNow: async () => {} }
  },
}))

const { enqueuePendingBloodPressureRecord, readAllPendingBloodPressureRecords } = await import('../../src/lib/bloodPressurePendingQueue')
const { useBloodPressureInputForm } = await import('../../src/features/vitals/hooks/useBloodPressureInputForm')
const { useBloodPressureQueueCoordinator } = await import('../../src/features/vitals/hooks/useBloodPressureQueueCoordinator')
const { BloodPressureQueueContext } = await import('../../src/features/vitals/hooks/BloodPressureQueueProvider')
const queueModules = { useBloodPressureQueueCoordinator, BloodPressureQueueContext }

const CAREGIVER = 'care@example.com'
const queue = (patientId: string, id: string, systolic = 132, diastolic = 78, extra: { family_alert?: boolean; first_record?: boolean } = {}) => enqueuePendingBloodPressureRecord({
  id, systolic, diastolic, pulse: 72, measured_at: '2026-10-07T01:00:00.000Z', source: 'manual_web',
  patient_id: patientId, recorded_by: CAREGIVER, queued_at: '2026-10-07T01:01:00.000Z', ...extra,
})
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const mountCoordinator = (patientId: string) =>
  renderHook(() => useBloodPressureQueueCoordinator({ patientId, userEmail: CAREGIVER }))
const mountForm = (getPatientId: () => string) =>
  renderWithBloodPressureQueue(queueModules, getPatientId, CAREGIVER, () => useBloodPressureInputForm({ subject: getPatientId(), patientId: getPatientId(), userEmail: CAREGIVER }))

// 讓某一筆的通知結果等到測試放行才回來，其他筆照 respondOthers 立刻回。recordId 傳 null 時扣住所有筆。
function holdNotification(recordId: string | null, held: unknown, respondOthers: unknown = { ok: true, sharedTelegram: 'delivered' }) {
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  notifyResponse = async request => {
    if (recordId !== null && request.recordId !== recordId) return respondOthers
    await gate
    return held
  }
  return () => release()
}

async function enterReading(view: ReturnType<typeof mountForm>, systolic: number, diastolic: number, pulse: number) {
  view.act(() => {
    view.current.handleSystolicChange(systolic, () => {})
    view.current.handleDiastolicChange(diastolic, () => {})
    view.current.handlePulseChange(pulse, () => {})
  })
  view.act(() => { void view.current.submit() })
  await flush()
  view.rerender()
}

// 線上儲存成功的那條路會碰到 document.activeElement；bun 沒有 DOM，放一個最小替身。
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
  requests.length = 0
  notifyCalls.length = 0
  notifyResponse = async () => ({ ok: true, sharedTelegram: 'delivered' })
  latestFlushParams = null
  firstFlushParams = null
  firstRecordEvents.length = 0
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
  Object.defineProperty(globalThis.navigator, 'locks', { value: undefined, configurable: true })
})

describe('the re-send runs without the blood pressure input section (issue #1138)', () => {
  test('an alert-level reading queued offline is sent and the family notified while no input page is mounted; a failed delivery is named for the next input page', async () => {
    queue('patient-a', 'a-danger', 185, 105, { family_alert: true })
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const coordinator = mountCoordinator('patient-a')
    expect(latestFlushParams!.enabled).toBe(true)
    expect(latestFlushParams!.hasPending).toBe(true)

    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()

    expect(bpInserts().map(request => request.body?.id)).toEqual(['a-danger'])
    expect(notifyCalls).toEqual([{ recordId: 'a-danger', patientId: 'patient-a' }])
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    // 沒有輸入頁可以接「這筆」的提示：家人沒收到這件事改成點名，留在補送器裡。
    expect(coordinator.current.notifyProblems).toEqual(['patient-a'])
    expect(coordinator.current.records).toEqual([])

    // 之後打開輸入頁（不論哪位病人）就看得到這句；「這筆」的提示不會被它占走。
    const form = renderHook(() => useBloodPressureInputForm({ subject: 'patient-b', patientId: 'patient-b', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    expect(form.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    expect(form.current.familyDelivery).toBe('idle')
    form.unmount()
    coordinator.unmount()
  })

  test('a reading that needs no family alert is still re-sent, and nothing is named when the delivery succeeds', async () => {
    queue('patient-a', 'a-ok', 118, 76, { family_alert: false })
    const coordinator = mountCoordinator('patient-b')
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(bpInserts().map(request => request.body?.id)).toEqual(['a-ok'])
    expect(notifyCalls).toHaveLength(1)
    expect(coordinator.current.notifyProblems).toEqual([])
    coordinator.unmount()
  })

  test('a notification result that returns after the input page unmounted is named instead of dropped', async () => {
    queue('patient-a', 'a-1', 185, 105, { family_alert: true })
    const release = holdNotification('a-1', { ok: true, sharedTelegram: 'failed' })
    const coordinator = mountCoordinator('patient-a')
    const form = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    // 送出時輸入頁還在、病人也對：它領了「這筆」的提示。
    expect(notifyCalls).toEqual([{ recordId: 'a-1', patientId: 'patient-a' }])
    expect(coordinator.current.notifyProblems).toEqual([])

    // 看護切到別的分頁，輸入頁卸載；通知結果這時才回來。
    form.unmount()
    release()
    await flush()
    expect(coordinator.current.notifyProblems).toEqual(['patient-a'])
    coordinator.unmount()
  })

  test('nothing runs and nothing is read without a signed-in caregiver', async () => {
    queue('patient-a', 'a-1')
    // 不經 mountCoordinator：它的預設參數會把 undefined 換成測試帳號。
    const coordinator = renderHook(() => useBloodPressureQueueCoordinator({ patientId: 'patient-a' }))
    expect(latestFlushParams!.enabled).toBe(false)
    expect(coordinator.current.records).toEqual([])
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    expect(bpInserts()).toEqual([])
    coordinator.unmount()
  })
})

describe('online-save notification results that lose their notice (issue #1138)', () => {
  test('a result that returns after switching patient names the patient instead of being dropped', async () => {
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    accept()
    const release = holdNotification(null, { ok: true, sharedTelegram: 'failed' })
    await enterReading(view, 185, 105, 80)
    expect(view.current.status).toBe('ok')
    expect(notifyCalls).toEqual([expect.objectContaining({ patientId: 'patient-a' })])

    patientId = 'patient-b'
    view.rerender()
    release()
    await flush()
    view.rerender()
    // 舊寫法：病人已變，整個結果丟掉。現在 B 的「這筆」提示仍乾淨，但 A 被點名。
    expect(view.current.familyDelivery).toBe('idle')
    expect(view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    view.unmount()
  })

  test('a result that returns after the input page unmounted is named', async () => {
    const view = mountForm(() => 'patient-a')
    accept()
    const release = holdNotification(null, { ok: true, sharedTelegram: 'failed' })
    await enterReading(view, 185, 105, 80)
    // 只卸載輸入頁（補送器是殼層的，還在）。
    view.unmountScreen()
    release()
    await flush()
    expect(view.coordinator.current.notifyProblems).toEqual(['patient-a'])
    view.coordinator.unmount()
  })

  test('a result whose notice was taken over by a re-send of an older queued reading for the same patient is still named', async () => {
    queue('patient-a', 'a-old', 132, 78, { family_alert: false })
    const view = mountForm(() => 'patient-a')
    accept()
    // 新的一筆線上送出、通知還沒回來；這時連線恢復，補送舊的那筆，它領走「這筆」的序號。
    const release = holdNotification(null, { ok: true, sharedTelegram: 'failed' })
    await enterReading(view, 185, 105, 80)
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'delivered' })
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    view.rerender()
    expect(notifyCalls.map(call => call.recordId)).toContain('a-old')

    release()
    await flush()
    view.rerender()
    // 舊寫法：序號已過期，新一筆的「沒送出」結果被丟掉。現在改點名。
    expect(view.current.familyDelivery).toBe('idle')
    expect(view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    view.unmount()
  })

  test('a failed notification call after switching patient is named rather than marking the new patient\'s reading as failed', async () => {
    let patientId = 'patient-a'
    const view = mountForm(() => patientId)
    accept()
    let reject: () => void = () => {}
    const gate = new Promise<void>(resolve => { reject = resolve })
    notifyResponse = async () => { await gate; throw new Error('Blood pressure notification failed') }
    await enterReading(view, 185, 105, 80)
    patientId = 'patient-b'
    view.rerender()
    reject()
    await flush()
    view.rerender()
    expect(view.current.notifyFailed).toBe(false)
    expect(view.current.otherPatientNotifyProblems).toEqual(['patient-a'])
    view.unmount()
  })
})

describe('only one round at a time (issue #1138)', () => {
  // Web Locks 替身：ifAvailable 語意與瀏覽器相同——有人持有就立刻以 null 回呼。
  function installFakeLocks() {
    const held = new Set<string>()
    const requestCalls: string[] = []
    const locks = {
      request: async (name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown) => {
        requestCalls.push(name)
        if (held.has(name)) {
          if (!options.ifAvailable) throw new Error('blocking lock requests are not simulated')
          return callback(null)
        }
        held.add(name)
        try {
          return await callback({ name })
        } finally {
          held.delete(name)
        }
      },
    }
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true })
    return { requestCalls }
  }

  test('a second tab\'s round yields while the first tab holds the flush lock, and nothing is sent twice', async () => {
    const { requestCalls } = installFakeLocks()
    queue('patient-a', 'a-1', 185, 105, { family_alert: true })
    const tabA = mountCoordinator('patient-a')
    const syncA = latestFlushParams!.sync
    const tabB = mountCoordinator('patient-a')
    const syncB = latestFlushParams!.sync

    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async () => {
      await gate
      return new Response(null, { status: 201 })
    }
    const runningA = syncA()
    await flush()
    // A 正在送（等伺服器回應）；B 這一輪拿不到鎖，直接讓給 A，回「還沒清空」讓觸發器照常排下一輪。
    expect(await syncB()).toBe(false)
    expect(bpInserts()).toHaveLength(1)
    expect(requestCalls).toHaveLength(2)

    release()
    expect(await runningA).toBe(true)
    await flush()
    expect(bpInserts()).toHaveLength(1)
    expect(notifyCalls).toHaveLength(1)
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    tabA.unmount()
    tabB.unmount()
  })

  test('a round that could not take the lock does not mark the connection as failing', async () => {
    installFakeLocks()
    queue('patient-a', 'a-1')
    const tabA = mountCoordinator('patient-a')
    const syncA = latestFlushParams!.sync
    const tabB = mountCoordinator('patient-a')
    const syncB = latestFlushParams!.sync
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async () => {
      await gate
      return new Response(null, { status: 201 })
    }
    const runningA = syncA()
    await flush()
    expect(await syncB()).toBe(false)
    expect(bpInserts()).toHaveLength(1)
    // 讓給別人不是失敗：不能讓畫面講「請確認網路」。
    expect(tabB.current.retryFailed).toBe(false)
    expect(tabB.current.unreachable).toBe(false)
    release()
    expect(await runningA).toBe(true)
    tabA.unmount()
    tabB.unmount()
  })

  test('a lock request that itself rejects (document not fully active) falls back to running the round', async () => {
    const locks = {
      request: async () => { throw new DOMException('Lock request not allowed', 'InvalidStateError') },
    }
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true })
    queue('patient-a', 'a-1', 185, 105, { family_alert: true })
    const tab = mountCoordinator('patient-a')
    accept()
    // 舊寫法：request 的 rejection 一路往外丟，觸發器這一輪沒有排下一次，危險讀數要等下一個外部事件。
    expect(await latestFlushParams!.sync()).toBe(true)
    expect(bpInserts()).toHaveLength(1)
    expect(notifyCalls).toHaveLength(1)
    tab.unmount()
  })

  test('without the Web Locks API the round still runs', async () => {
    queue('patient-a', 'a-1')
    const tab = mountCoordinator('patient-a')
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    expect(bpInserts()).toHaveLength(1)
    tab.unmount()
  })
})

describe('another tab changes the queue (issue #1138)', () => {
  test('a storage event for a queue key refreshes the pending list; other keys are ignored', () => {
    const listeners = new Map<string, Set<(event: { key: string | null }) => void>>()
    const fakeWindow = {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type)?.add(handler)
      },
      removeEventListener: (type: string, handler: (event: { key: string | null }) => void) => { listeners.get(type)?.delete(handler) },
    }
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow })
    try {
      const coordinator = mountCoordinator('patient-b')
      expect(coordinator.current.records).toEqual([])
      // 佇列與提示各自管理監聽；整合測試只要求掛載／卸載契約，不綁定內部監聽器數量。
      expect(listeners.get('storage')?.size).toBeGreaterThan(0)

      // 另一個分頁替 A 存了一筆（同一台裝置、同一個 localStorage）。
      queue('patient-a', 'a-1')
      const queueKey = [...stored.keys()][0]
      for (const handler of listeners.get('storage') ?? []) handler({ key: 'unrelated-key' })
      expect(coordinator.current.records).toEqual([])
      for (const handler of listeners.get('storage') ?? []) handler({ key: queueKey })
      expect(coordinator.current.records.map(record => record.id)).toEqual(['a-1'])

      // 另一個分頁 localStorage.clear()：事件的 key 是 null，清單要跟著清空。
      stored.clear()
      for (const handler of listeners.get('storage') ?? []) handler({ key: null })
      expect(coordinator.current.records).toEqual([])

      coordinator.unmount()
      expect(listeners.get('storage')?.size).toBe(0)
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })
})

// 跨分頁的 storage 事件需要 window；bun 沒有 DOM，只在用到的測試裡放一個最小替身。
function installFakeWindow() {
  const listeners = new Map<string, Set<(event: { key: string | null }) => void>>()
  const fakeWindow = {
    addEventListener: (type: string, handler: (event: { key: string | null }) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(handler)
    },
    removeEventListener: (type: string, handler: (event: { key: string | null }) => void) => { listeners.get(type)?.delete(handler) },
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow })
  return {
    emitStorage: (key: string | null) => { for (const handler of listeners.get('storage') ?? []) handler({ key }) },
    restore: () => {
      if (previous) Object.defineProperty(globalThis, 'window', previous)
      else Reflect.deleteProperty(globalThis, 'window')
    },
  }
}
const NOTIFY_PROBLEMS_PREFIX = `jia-jian.pending-blood-pressure.notify-problems.v2-${CAREGIVER}-patient-`
const notifyProblemKey = (patientId: string) => `${NOTIFY_PROBLEMS_PREFIX}${patientId}`

describe('Codex review on PR #1218', () => {
  test('the account\'s first record is tracked when the shell re-sends it with no input page mounted (P2)', async () => {
    queue('patient-a', 'a-first', 132, 78, { first_record: true })
    const coordinator = mountCoordinator('patient-a')
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    expect(firstRecordEvents).toEqual([{ locale: 'zh', record_type: 'blood_pressure' }])
    // 入佇列時已判定不是第一筆的紀錄不埋。
    queue('patient-a', 'a-later', 128, 80, { first_record: false })
    expect(await latestFlushParams!.sync()).toBe(true)
    expect(firstRecordEvents).toHaveLength(1)
    coordinator.unmount()
  })

  test('a legacy queued entry without the first_record marker asks the database whether history is empty (round 2 P2)', async () => {
    // 舊版 build 排進佇列的紀錄沒有 first_record；資料庫除了這筆沒有別的 → 這筆是第一筆。寫入後才問、不擋補送。
    queue('patient-a', 'a-legacy')
    const coordinator = mountCoordinator('patient-a')
    respond = request => request.method === 'GET'
      ? new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 201 })
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
    expect(decodeURIComponent(requests[1]?.url ?? '')).toContain('id=not.in.(a-legacy)')
    expect(firstRecordEvents).toHaveLength(1)

    // 已有歷史 → 不是第一筆。
    queue('patient-a', 'a-legacy-2')
    respond = request => request.method === 'GET'
      ? new Response(JSON.stringify([{ id: 'older' }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 201 })
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(firstRecordEvents).toHaveLength(1)

    // 問不到歷史：放棄埋點，但寫入與通知照常。
    queue('patient-a', 'a-legacy-3', 185, 105, { family_alert: true })
    respond = request => request.method === 'GET'
      ? new Response(JSON.stringify({ code: 'PGRST301', message: 'JWT expired', details: null, hint: null }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      : new Response(null, { status: 201 })
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(firstRecordEvents).toHaveLength(1)
    expect(notifyCalls.map(call => call.recordId)).toContain('a-legacy-3')
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    coordinator.unmount()
  })

  test('the pending list is read before the first probe, so hydration does not burn a backoff step (P2)', () => {
    queue('patient-a', 'a-1')
    const coordinator = mountCoordinator('patient-b')
    // 舊寫法：records 先是空的、effect 才讀，hasPending 在第一次探測之後才變 true，再觸發一次立即探測。
    expect(firstFlushParams!.hasPending).toBe(true)
    expect(coordinator.current.records.map(record => record.id)).toEqual(['a-1'])
    coordinator.unmount()
  })

  test('a named notice is written to local storage, survives a reload, and clears everywhere (P1)', async () => {
    queue('patient-a', 'a-1', 185, 105, { family_alert: true })
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const tabA = mountCoordinator('patient-a')
    accept()
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(tabA.current.notifyProblems).toEqual(['patient-a'])
    expect(stored.has(notifyProblemKey('patient-a'))).toBe(true)
    tabA.unmount()

    // 重新整理（或另一個分頁）：一掛載就讀得到，不必等任何事件。
    const tabB = mountCoordinator('patient-b')
    expect(tabB.current.notifyProblems).toEqual(['patient-a'])
    tabB.current.clearNotifyProblems()
    expect(tabB.current.notifyProblems).toEqual([])
    expect(stored.has(notifyProblemKey('patient-a'))).toBe(false)
    tabB.unmount()
  })

  test('the named notice is only patient ids: no reading values reach local storage', async () => {
    queue('patient-a', 'a-1', 185, 105, { family_alert: true })
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
    const coordinator = mountCoordinator('patient-a')
    accept()
    await latestFlushParams!.sync()
    await flush()
    expect([...stored.keys()].filter(key => key.startsWith(NOTIFY_PROBLEMS_PREFIX))).toEqual([notifyProblemKey('patient-a')])
    expect(stored.get(notifyProblemKey('patient-a'))).not.toContain('185')
    coordinator.unmount()
  })
})

describe('Codex review on PR #1218, round 3', () => {
  test('two legacy entries that both already landed are judged against the whole batch, so the first record is still tracked', async () => {
    queue('patient-a', 'a-legacy-1')
    queue('patient-a', 'a-legacy-2')
    const coordinator = mountCoordinator('patient-a')
    // 兩筆都已在伺服器（回應遺失）：INSERT 回 23505、回讀 id 存在；歷史查詢排除整批後沒有別的紀錄。
    respond = request => {
      if (request.method === 'POST') return new Response(JSON.stringify({ code: '23505', message: 'duplicate key', details: null, hint: null }), { status: 409, headers: { 'Content-Type': 'application/json' } })
      const url = decodeURIComponent(request.url)
      if (url.includes('id=not.in.')) {
        expect(url).toContain('id=not.in.(a-legacy-1,a-legacy-2)')
        return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      const id = url.match(/id=eq\.([^&]+)/)?.[1]
      return new Response(JSON.stringify([{ id }]), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(firstRecordEvents.length).toBeGreaterThanOrEqual(1)
    coordinator.unmount()
  })

  test('when another tab drains the queue, the mounted input screen is told to refresh its remote data', () => {
    const fakeWindow = installFakeWindow()
    try {
      queue('patient-a', 'a-1')
      const coordinator = mountCoordinator('patient-a')
      const synced: string[][] = []
      coordinator.current.setScreen({
        claimNotice: () => null, onFamilyAlertSkipped: () => {}, onFamilyDelivery: () => {}, onNotifyFailed: () => {},
        onSynced: records => { synced.push(records.map(record => record.id)) },
      })
      const queueKey = [...stored.keys()].find(key => key.includes('pending-blood-pressure.v1'))!
      // 另一個分頁拿到鎖、送走了這筆。
      stored.clear()
      fakeWindow.emitStorage(queueKey)
      expect(coordinator.current.records).toEqual([])
      expect(synced).toEqual([['a-1']])
      coordinator.unmount()
    } finally {
      fakeWindow.restore()
    }
  })
})

describe('Codex App independent review of PR #1218 (474ff896)', () => {
  test('an unavailable personal-count RPC after polling keeps the saved reading and shows an unknown-delivery warning (#1102)', async () => {
    queue('patient-a', 'a-counts-unavailable', 185, 105, { family_alert: true })
    notifyResponse = async () => ({ ok: true, sharedTelegram: 'in_progress', sharedRemainingMs: 0, personalQueued: true })
    const coordinator = mountCoordinator('patient-a')
    const form = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
    respond = request => {
      if (request.url.includes('/rest/v1/blood_pressure_notification_deliveries')) {
        return new Response(JSON.stringify({ status: 'failed_terminal' }), { headers: { 'Content-Type': 'application/json' } })
      }
      if (request.url.includes('/rest/v1/rpc/')) {
        // 舊 PWA 或部署窗口的缺少 RPC 都不能抹掉警告，也不能重排已成功儲存的血壓。
        return new Response(JSON.stringify({ code: 'PGRST202', message: 'Function unavailable' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(null, { status: 201 })
    }
    expect(await latestFlushParams!.sync()).toBe(true)
    await flush()
    expect(readAllPendingBloodPressureRecords(CAREGIVER)).toEqual([])
    expect(bpInserts()).toHaveLength(1)
    expect(form.current.familyDelivery).toBe('not_sent_personal_unknown')
    const countRequests = requests.filter(request => request.url.includes('/rest/v1/rpc/'))
    expect(countRequests).toHaveLength(1)
    expect(countRequests[0].url).toContain('/personal_notification_counts')
    expect(countRequests[0].body).toEqual({ p_record_id: 'a-counts-unavailable', p_patient_id: 'patient-a' })
    form.unmount()
    coordinator.unmount()
  })

  test('a background tab whose form is still mounted does not keep a failed delivery to itself: it is persisted for the foreground tab (P1)', async () => {
    const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: { visibilityState: 'hidden', activeElement: null } })
    try {
      queue('patient-a', 'a-1', 185, 105, { family_alert: true })
      notifyResponse = async () => ({ ok: true, sharedTelegram: 'failed' })
      const coordinator = mountCoordinator('patient-a')
      const form = renderHook(() => useBloodPressureInputForm({ subject: 'patient-a', patientId: 'patient-a', userEmail: CAREGIVER }), { contexts: [[BloodPressureQueueContext, coordinator.current]] })
      accept()
      expect(await latestFlushParams!.sync()).toBe(true)
      await flush()
      // 背景分頁的表單不獨占「這筆」的提示；結果進持久化的點名提示。
      expect(form.current.familyDelivery).toBe('idle')
      expect(coordinator.current.notifyProblems).toEqual(['patient-a'])
      expect(stored.has(notifyProblemKey('patient-a'))).toBe(true)
      form.unmount()
      coordinator.unmount()
    } finally {
      if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument)
      else Reflect.deleteProperty(globalThis, 'document')
    }
  })
})
