/*
檔案用途：用正式 supabase-js client 與注入 fetch 驗證服藥佇列的殼層補送、帳號／病人邊界、切換帳號時停止補送、Web Locks 與跨分頁畫面更新（issue #1228）。
所在層：tests/unit；只攔截網路請求，不連線；localStorage／瀏覽器事件都是可控替身。
主要關聯：src/features/medication/hooks/useMedicationQueueCoordinator.ts、MedicationQueueProvider.tsx、lib/medication/medicationPendingQueue.ts。
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { MedicationPlanView } from '../../src/lib/medication/medications'
import type { PendingMedicationDose } from '../../src/lib/medication/medicationPendingQueue'

installReactHookHarness()

interface RecordedRequest {
  method: string
  url: string
  body: Record<string, unknown> | undefined
}

const requests: RecordedRequest[] = []
let respond: (request: RecordedRequest) => Response | Promise<Response> = request => new Response(JSON.stringify({
  id: `row-${requests.length}`,
  created_at: '2026-10-06T00:00:00.000Z',
  ...request.body,
}), { status: 201, headers: { 'Content-Type': 'application/json' } })

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
      // 真實 fetch 在 abort 時必須拒絕，即使伺服器永遠不回應；替身也要遵守這個契約。
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal
        const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
        if (signal?.aborted) { abort(); return }
        signal?.addEventListener('abort', abort, { once: true })
        Promise.resolve(respond(request)).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
      })
    }) as typeof fetch,
  },
})
mock.module('../../src/lib/supabase', () => ({ supabase: client }))
const actualDemoStorage = await import('../../src/lib/demoStorage')
mock.module('../../src/lib/demoStorage', () => ({ ...actualDemoStorage, isDemoMode: () => false }))
mock.module('../../src/lib/platform', () => ({ isNativeApp: () => false }))
mock.module('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }))

const { useMedicationQueueCoordinator, MEDICATION_QUEUE_REQUEST_TIMEOUT_MS } = await import('../../src/features/medication/hooks/useMedicationQueueCoordinator')
const {
  buildPendingMedicationDose,
  enqueuePendingMedicationDose,
  isPendingMedicationStorageKey,
  readAllPendingMedicationDoses,
  removePendingMedicationDose,
  withdrawPendingMedicationDose,
  syncPendingMedicationDose,
} = await import('../../src/lib/medication/medicationPendingQueue')

const OWNER = 'care@example.com'
const OTHER_OWNER = 'other@example.com'
const flushRequests = () => requests.filter(request => request.method === 'POST' && request.url.includes('/rest/v1/medication_intake_logs'))
const plan = (patientId: string, id = `plan-${patientId}`): MedicationPlanView => ({
  id,
  account_email: OWNER,
  patient_id: patientId,
  medication_id: `med-${patientId}`,
  schedule_slot: 'morning',
  as_needed: false,
  dose_amount: 1,
  dose_count: 1,
  display_order: 1,
  active: true,
  created_at: '2026-10-01T00:00:00.000Z',
  medication: { brand_name: `Medicine ${patientId}` },
} as MedicationPlanView)
const enqueue = (patientId: string, owner = OWNER, id = `plan-${patientId}`) => {
  const dose = buildPendingMedicationDose(plan(patientId, id), 1, owner, '2026-10-06T00:00:00.000Z')
  expect(enqueuePendingMedicationDose(dose)).toBe(true)
  return dose
}

const stored = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => { stored.set(key, value) },
  removeItem: (key: string) => { stored.delete(key) },
  get length() { return stored.size },
  key: (index: number) => [...stored.keys()][index] ?? null,
}

type FakeEvent = { key: string | null }
const listeners = new Map<string, Set<(event?: FakeEvent) => void>>()
const fakeWindow = {
  addEventListener(type: string, listener: (event?: FakeEvent) => void) {
    if (!listeners.has(type)) listeners.set(type, new Set())
    listeners.get(type)?.add(listener)
  },
  removeEventListener(type: string, listener: (event?: FakeEvent) => void) { listeners.get(type)?.delete(listener) },
  emit(type: string, event?: FakeEvent) { for (const listener of listeners.get(type) ?? []) listener(event) },
}
// 同源分頁只收到別的 BroadcastChannel 實例送出的訊息，模擬瀏覽器的跨分頁邊界。
const fakeBroadcastChannels: FakeBroadcastChannel[] = []
class FakeBroadcastChannel {
  onmessage: ((event: MessageEvent) => void) | null = null
  closed = false

  constructor(readonly name: string) {
    fakeBroadcastChannels.push(this)
  }

  postMessage(data: unknown) {
    for (const channel of fakeBroadcastChannels) {
      if (channel === this || channel.closed || channel.name !== this.name) continue
      queueMicrotask(() => {
        if (!channel.closed) channel.onmessage?.({ data } as MessageEvent)
      })
    }
  }

  close() { this.closed = true }
}
const fakeDocument = {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
}
const fakeNavigator: { onLine: boolean; locks?: LockManager } = { onLine: true }
const originalGlobals = ['window', 'document', 'localStorage', 'navigator', 'BroadcastChannel'] as const
const originalDescriptors = originalGlobals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fakeStorage })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: fakeNavigator })
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, writable: true, value: FakeBroadcastChannel })
})
afterAll(() => {
  for (const [name, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})
beforeEach(() => {
  for (const channel of fakeBroadcastChannels) channel.close()
  fakeBroadcastChannels.length = 0
  stored.clear()
  listeners.clear()
  requests.length = 0
  fakeNavigator.onLine = true
  fakeNavigator.locks = undefined
  respond = request => new Response(JSON.stringify({
    id: `row-${requests.length}`,
    created_at: '2026-10-06T00:00:00.000Z',
    ...request.body,
  }), { status: 201, headers: { 'Content-Type': 'application/json' } })
})
afterEach(() => {
  fakeNavigator.locks = undefined
  while (mounted.length) mounted.pop()?.unmount()
})

const settle = async () => {
  await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
  await Promise.resolve()
}
const mounted: Array<{ unmount: () => void }> = []
const mount = (patientId = 'patient-a', owner = OWNER) => {
  const coordinator = renderHook(() => useMedicationQueueCoordinator({ patientId, userEmail: owner }))
  mounted.push(coordinator)
  return coordinator
}

describe('Medication queue coordinator (issue #1228)', () => {
  test('the 15-second deadline aborts a stalled dose and keeps it for safe retry', async () => {
    const dose = enqueue('patient-a')
    const schedule = globalThis.setTimeout
    let expire = () => { throw new Error('deadline was not scheduled') }
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation((...args: Parameters<typeof setTimeout>) => {
      const [callback, delay, ...rest] = args
      if (delay === MEDICATION_QUEUE_REQUEST_TIMEOUT_MS) {
        expire = callback as () => void
        // 手動推進這一個 deadline，不改動觸發器退避與其他測試的事件時序。
        return schedule(() => {}, 60_000)
      }
      return schedule(callback, delay, ...rest)
    })
    respond = () => new Promise<Response>(() => {})
    const coordinator = mount()
    try {
      await settle()
      expect(MEDICATION_QUEUE_REQUEST_TIMEOUT_MS).toBe(15_000)
      expire()
      await settle()
      expect(coordinator.current.syncingDose).toBeNull()
      expect(coordinator.current.syncErrorByPatient['patient-a']).toBe(true)
      expect(readAllPendingMedicationDoses(OWNER)).toEqual([dose])
    } finally { coordinator.unmount(); timer.mockRestore() }
  })

  test('a duplicate-dose server lookup uses the same abort signal as the insert', async () => {
    const dose = enqueue('patient-a')
    respond = request => request.method === 'POST'
      ? new Response(JSON.stringify({ code: '23505', message: 'duplicate dose' }), { status: 409 })
      : new Promise<Response>(() => {})
    const controller = new AbortController()
    const request = syncPendingMedicationDose(dose, controller.signal)
    await settle()
    expect(requests.map(request => request.method)).toEqual(['POST', 'GET'])
    controller.abort()
    await expect(request).rejects.toMatchObject({ status: 0 })
  })

  test('a withdrawal request is also abortable without losing the tombstone', async () => {
    const dose = enqueue('patient-a')
    withdrawPendingMedicationDose(dose)
    respond = () => new Promise<Response>(() => {})
    const controller = new AbortController()
    const request = syncPendingMedicationDose({ ...dose, withdrawn: true }, controller.signal)
    await settle()
    expect(requests.map(request => request.method)).toEqual(['DELETE'])
    controller.abort()
    await expect(request).rejects.toMatchObject({ status: 0 })
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([{ ...dose, withdrawn: true }])
  })
  test('keeps a cross-tab withdrawal until it reaches the server after an in-flight insert', async () => {
    const dose = enqueue('patient-a')
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async request => {
      if (request.method === 'POST') {
        await gate
        return new Response(JSON.stringify({ id: 'server-row', created_at: dose.queued_at, ...request.body }), { status: 201 })
      }
      return new Response(null, { status: 204 })
    }
    const coordinator = mount()
    await settle()
    expect(withdrawPendingMedicationDose(dose)).toBe(true)
    release()
    await settle()
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([{ ...dose, withdrawn: true }])
    await coordinator.current.retryNow()
    expect(requests.some(request => request.method === 'DELETE')).toBe(true)
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  })

  test('publishes a permanent rejection before another patient request finishes', async () => {
    enqueue('patient-a'); enqueue('patient-b')
    let release = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    respond = async request => {
      if (request.body?.patient_id === 'patient-a') return new Response(JSON.stringify({ code: '42501', message: 'permission denied' }), { status: 403 })
      await gate
      return new Response(JSON.stringify({ id: 'row-b', ...request.body }), { status: 201 })
    }
    const coordinator = mount()
    await settle()
    const errorShownWhileOtherRequestWaits = coordinator.current.syncErrorByPatient['patient-a']
    release()
    await settle()
    expect(errorShownWhileOtherRequestWaits).toBe(true)
  })

  test('unmount aborts a never-returning request and releases the lock for a new account', async () => {
    enqueue('patient-a'); enqueue('patient-b', OTHER_OWNER)
    let held = false
    fakeNavigator.locks = { request: async (_name: string, _options: unknown, callback: (lock: object | null) => unknown) => {
      if (held) return callback(null)
      held = true
      try { return await callback({}) } finally { held = false }
    } } as unknown as LockManager
    respond = request => request.body?.account_email === OWNER
      ? new Promise<Response>(() => {})
      : new Response(JSON.stringify({ id: 'new-owner-row', ...request.body }), { status: 201 })
    const oldAccount = mount()
    await settle()
    expect(held).toBe(true)
    oldAccount.unmount()
    await settle()
    const newAccount = mount('patient-b', OTHER_OWNER)
    await settle()
    expect(newAccount.current.records).toEqual([])
    expect(held).toBe(false)
    expect(readAllPendingMedicationDoses(OWNER)).toHaveLength(1)
  })
  test('the signed-in owner flushes every patient queue without a medication screen, prioritizing the selected patient', async () => {
    enqueue('patient-a')
    enqueue('patient-b')
    const unrelated = enqueue('patient-private', OTHER_OWNER)
    const coordinator = mount('patient-b')

    for (let attempt = 0; attempt < 5 && flushRequests().length < 2; attempt += 1) await settle()

    expect(flushRequests().map(request => request.body?.patient_id)).toEqual(['patient-b', 'patient-a'])
    expect(flushRequests().every(request => request.body?.account_email === OWNER)).toBe(true)
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
    expect(readAllPendingMedicationDoses(OTHER_OWNER).map(dose => dose.id)).toEqual([unrelated.id])
    expect(flushRequests().some(request => request.body?.patient_id === 'patient-private')).toBe(false)
    coordinator.unmount()
  })

  test('a second tab yields its round while the first tab holds the Web Lock', async () => {
    enqueue('patient-a')
    let held = false
    let releaseResponse: () => void = () => {}
    const responseGate = new Promise<void>(resolve => { releaseResponse = resolve })
    const lockCalls: string[] = []
    fakeNavigator.locks = {
      request: async (name, options, callback) => {
        lockCalls.push(name)
        if (held) return callback(null)
        held = true
        try { return await callback({ name } as Lock) } finally { held = false }
      },
    } as LockManager
    respond = async request => {
      await responseGate
      return new Response(JSON.stringify({ id: 'row-1', created_at: '2026-10-06T00:00:00.000Z', ...request.body }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    }

    const tabA = mount()
    await settle()
    const tabB = mount()
    await settle()
    expect(lockCalls).toEqual(['jia-jian-medication-pending-flush.v1', 'jia-jian-medication-pending-flush.v1'])
    expect(flushRequests()).toHaveLength(1)

    releaseResponse()
    for (let attempt = 0; attempt < 5 && readAllPendingMedicationDoses(OWNER).length > 0; attempt += 1) await settle()
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
    expect(flushRequests()).toHaveLength(1)
    tabA.unmount()
    tabB.unmount()
  })

  test('storage events refresh the queue and tell the mounted patient screen to re-read server truth', () => {
    const coordinator = mount('patient-a')
    let serverRefreshes = 0
    coordinator.current.setScreen({
      patientId: 'patient-a',
      owner: OWNER,
      onSynced: () => {},
      onExternalQueueChange: () => { serverRefreshes += 1 },
    })
    const dose = enqueue('patient-a')
    const storageKey = fakeStorage.key(0)
    expect(isPendingMedicationStorageKey(storageKey)).toBe(true)

    fakeWindow.emit('storage', { key: storageKey })
    expect(coordinator.current.records.map(record => record.id)).toEqual([dose.id])

    removePendingMedicationDose(dose)
    fakeWindow.emit('storage', { key: storageKey })
    expect(coordinator.current.records).toEqual([])
    expect(serverRefreshes).toBe(1)

    const clearedDose = enqueue('patient-a', OWNER, 'plan-cleared')
    fakeWindow.emit('storage', { key: storageKey })
    removePendingMedicationDose(clearedDose)
    fakeWindow.emit('storage', { key: null })
    expect(serverRefreshes).toBe(2)
    coordinator.unmount()
  })

  test('publishes each completed patient before a later patient request finishes', async () => {
    const firstDose = enqueue('patient-a')
    const secondDose = enqueue('patient-b')
    let secondPatientStarted = false
    let releaseSecondPatient = () => {}
    const secondPatientGate = new Promise<void>(resolve => { releaseSecondPatient = resolve })
    respond = async request => {
      if (request.body?.patient_id === 'patient-b') {
        secondPatientStarted = true
        await secondPatientGate
      }
      return new Response(JSON.stringify({
        id: `row-${requests.length}`,
        created_at: '2026-10-06T00:00:00.000Z',
        ...request.body,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }

    const coordinator = mount('patient-a')
    const syncedPatients: string[] = []
    coordinator.current.setScreen({
      patientId: 'patient-a',
      owner: OWNER,
      onSynced: result => { syncedPatients.push(...result.recorded.map(log => log.patient_id)) },
      onExternalQueueChange: () => {},
    })
    for (let attempt = 0; attempt < 8 && !secondPatientStarted; attempt += 1) await settle()

    expect(secondPatientStarted).toBe(true)
    expect(syncedPatients).toEqual(['patient-a'])
    expect(coordinator.current.records.map(record => record.id)).toEqual([secondDose.id])
    expect(coordinator.current.records.some(record => record.id === firstDose.id)).toBe(false)

    releaseSecondPatient()
    for (let attempt = 0; attempt < 8 && coordinator.current.records.length > 0; attempt += 1) await settle()
    expect(coordinator.current.records).toEqual([])
    coordinator.unmount()
  })

  test('stops the old owner before a queued withdrawal can run under the next session', async () => {
    const firstDose = enqueue('patient-a')
    const withdrawnDose = enqueue('patient-b')
    expect(withdrawPendingMedicationDose(withdrawnDose)).toBe(true)

    let releaseFirstRequest = () => {}
    const firstRequestGate = new Promise<void>(resolve => { releaseFirstRequest = resolve })
    respond = async request => {
      if (request.method === 'POST' && request.body?.patient_id === 'patient-a') await firstRequestGate
      return new Response(JSON.stringify({
        id: `row-${requests.length}`,
        created_at: '2026-10-06T00:00:00.000Z',
        ...request.body,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }

    let activeOwner = OWNER
    const coordinator = renderHook(() => useMedicationQueueCoordinator({ patientId: 'patient-a', userEmail: activeOwner }))
    mounted.push(coordinator)
    for (let attempt = 0; attempt < 8 && flushRequests().length === 0; attempt += 1) await settle()
    expect(flushRequests().map(request => request.body?.patient_id)).toEqual(['patient-a'])

    // 讓第一筆請求等待時切換帳號，再回應；舊輪次不得碰到下一位病人的撤回標記。
    activeOwner = OTHER_OWNER
    coordinator.rerender()
    releaseFirstRequest()
    await settle()

    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
    // 中止只代表手機沒拿到確認，第一筆也留著；不能假定伺服器尚未寫入或已完成。
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([firstDose, { ...withdrawnDose, withdrawn: true }])
    expect(readAllPendingMedicationDoses(OTHER_OWNER)).toEqual([])
    coordinator.unmount()
  })

  test('stops a pending drain when the shell provider unmounts during a request', async () => {
    const firstDose = enqueue('patient-a')
    const withdrawnDose = enqueue('patient-b')
    expect(withdrawPendingMedicationDose(withdrawnDose)).toBe(true)

    let releaseFirstRequest = () => {}
    const firstRequestGate = new Promise<void>(resolve => { releaseFirstRequest = resolve })
    respond = async request => {
      if (request.method === 'POST' && request.body?.patient_id === 'patient-a') await firstRequestGate
      return new Response(JSON.stringify({
        id: `row-${requests.length}`,
        created_at: '2026-10-06T00:00:00.000Z',
        ...request.body,
      }), { status: 201, headers: { 'Content-Type': 'application/json' } })
    }

    const coordinator = mount('patient-a')
    for (let attempt = 0; attempt < 8 && flushRequests().length === 0; attempt += 1) await settle()
    expect(flushRequests().map(request => request.body?.patient_id)).toEqual(['patient-a'])

    coordinator.unmount()
    releaseFirstRequest()
    await settle()

    expect(requests.some(request => request.method === 'DELETE')).toBe(false)
    expect(readAllPendingMedicationDoses(OWNER)).toEqual([firstDose, { ...withdrawnDose, withdrawn: true }])
  })

  test('deduplicates superseded dose notices across same-owner tabs and shares dismissal', async () => {
    const tabA = mount('patient-a', OWNER)
    const tabB = mount('patient-a', OWNER)
    const otherAccount = mount('patient-a', OTHER_OWNER)

    // 兩個分頁分別由伺服器對帳與補送回應發現同一劑，穩定 dose id 只能算一次。
    tabA.current.addSuperseded('patient-a', ['dose-1', 'dose-2'])
    tabB.current.addSuperseded('patient-a', ['dose-1', 'dose-3'])
    await settle()
    expect(tabA.current.supersededCountByPatient['patient-a']).toBe(3)
    expect(tabB.current.supersededCountByPatient['patient-a']).toBe(3)
    expect(otherAccount.current.supersededCountByPatient['patient-a'] ?? 0).toBe(0)

    tabA.current.addSuperseded('patient-a', ['controlled-correction:dose-4'])
    tabB.current.addSuperseded('patient-a', ['controlled-correction:dose-4'])
    await settle()
    expect(tabA.current.controlledCorrectionCountByPatient['patient-a']).toBe(1)
    expect(tabB.current.controlledCorrectionCountByPatient['patient-a']).toBe(1)
    expect(tabA.current.supersededCountByPatient['patient-a']).toBe(4)
    expect(otherAccount.current.controlledCorrectionCountByPatient['patient-a'] ?? 0).toBe(0)

    const legacyTab = new FakeBroadcastChannel('jia-jian-medication-queue-signal.v1')
    legacyTab.postMessage({ owner: OWNER, patientId: 'patient-a', type: 'superseded', count: 2 })
    await settle()
    expect(tabA.current.supersededCountByPatient['patient-a']).toBe(6)
    expect(tabB.current.supersededCountByPatient['patient-a']).toBe(6)
    legacyTab.close()

    tabB.current.dismissSuperseded('patient-a')
    await settle()
    expect(tabA.current.supersededCountByPatient['patient-a'] ?? 0).toBe(0)
    expect(tabB.current.supersededCountByPatient['patient-a'] ?? 0).toBe(0)
    expect(tabA.current.controlledCorrectionCountByPatient['patient-a'] ?? 0).toBe(0)
    expect(tabB.current.controlledCorrectionCountByPatient['patient-a'] ?? 0).toBe(0)
    tabA.current.addSuperseded('patient-a', ['dose-1'])
    await settle()
    expect(tabA.current.supersededCountByPatient['patient-a'] ?? 0).toBe(0)
    expect(tabB.current.supersededCountByPatient['patient-a'] ?? 0).toBe(0)
    tabA.unmount()
    tabB.unmount()
    otherAccount.unmount()
  })
})
