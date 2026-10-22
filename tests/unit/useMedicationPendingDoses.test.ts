/*
檔案用途：驗證服藥畫面 hook 與 App 殼層佇列協調器的整合：離線補送、撤回、同步期間鎖定、對帳、衝突提示與病人隔離（issue #822／#1228）。
所在層：tests/unit；用最小 hook 執行環境、假的 window／document 與模擬唯一索引的假 Supabase，不啟動瀏覽器、不連網。
主要關聯：src/features/medication/hooks/useMedicationPendingDoses.ts、MedicationQueueProvider.tsx、useMedicationQueueCoordinator.ts、src/hooks/usePendingWriteFlush.ts、
  src/lib/medication/medicationPendingQueue.ts。
*/
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import dayjs from 'dayjs'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { MedicationIntakeLog } from '../../src/types/database'

installReactHookHarness()

mock.module('../../src/lib/platform', () => ({ isNativeApp: () => false }))
mock.module('@capacitor/app', () => ({ App: { addListener: async () => ({ remove: async () => {} }) } }))

const { careDateKey } = await import('../../src/lib/careDay')

// ── 假伺服器：唯一索引 (patient_id, plan_id, care_date, dose_number) 與 care_date trigger ─────────
type InsertPayload = Omit<MedicationIntakeLog, 'id' | 'created_at'>
const server = {
  rows: [] as MedicationIntakeLog[],
  inserts: 0,
  deletes: 0,
  offline: false,
  // 寫入成功、但回應在回程斷掉。
  loseNextResponse: false,
  // 設定後 INSERT 會卡住直到 release()，用來重現「這一劑正在送出」的時間窗。
  gate: null as Promise<void> | null,
}
let releaseGate = () => {}

// 斷線時 supabase-js 實際回傳的錯誤形狀（不是原生 TypeError）；理由見 medicationPendingQueue.test.ts 的同名函式。
const offlineError = () => ({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' })

async function serverInsert(payload: InsertPayload) {
  server.inserts += 1
  if (server.gate) await server.gate
  if (server.offline) return { data: null, error: offlineError(), status: 0 }
  const careDate = careDateKey(dayjs(payload.taken_at))
  if (server.rows.some(row => row.patient_id === payload.patient_id && row.plan_id === payload.plan_id && row.care_date === careDate && row.dose_number === payload.dose_number)) {
    return { data: null, error: { code: '23505', message: 'duplicate key' }, status: 409 }
  }
  const row: MedicationIntakeLog = { ...payload, care_date: careDate, id: `row-${server.rows.length + 1}`, created_at: payload.taken_at }
  server.rows.push(row)
  if (server.loseNextResponse) {
    server.loseNextResponse = false
    return { data: null, error: offlineError(), status: 0 }
  }
  return { data: row, error: null, status: 201 }
}

mock.module('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (payload: InsertPayload) => ({ select: () => ({ abortSignal() { return this }, single: () => serverInsert(payload) }) }),
      delete: () => {
        const filters: Record<string, unknown> = {}
        const chain = {
          abortSignal() { return chain },
          eq(column: string, value: unknown) { filters[column] = value; return chain },
          then(resolve: (value: { error: unknown; status: number }) => void) {
            server.deletes += 1
            if (server.offline) return resolve({ error: offlineError(), status: 0 })
            server.rows = server.rows.filter(row => !Object.entries(filters).every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value))
            return resolve({ error: null, status: 204 })
          },
        }
        return chain
      },
      select: () => {
        const filters: Record<string, unknown> = {}
        const chain = {
          abortSignal() { return chain },
          eq(column: string, value: unknown) { filters[column] = value; return chain },
          single: async () => {
            const row = server.rows.find(item => Object.entries(filters).every(([column, value]) => (item as unknown as Record<string, unknown>)[column] === value))
            return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          },
        }
        return chain
      },
    }),
  },
}))

const { useMedicationPendingDoses } = await import('../../src/features/medication/hooks/useMedicationPendingDoses')
const { useMedicationQueueCoordinator } = await import('../../src/features/medication/hooks/useMedicationQueueCoordinator')
const { MedicationQueueContext } = await import('../../src/features/medication/hooks/MedicationQueueProvider')
const { pendingMedicationDoseToLog, buildPendingMedicationDose } = await import('../../src/lib/medication/medicationPendingQueue')
import type { MedicationPlanView } from '../../src/lib/medication/medications'
import type { PendingMedicationDose } from '../../src/lib/medication/medicationPendingQueue'

// ── 假 window／document／localStorage ───────────────────────────────────────
const windowListeners = new Map<string, Set<() => void>>()
const fakeWindow = {
  location: { pathname: '/' },
  addEventListener: (type: string, handler: () => void) => { if (!windowListeners.has(type)) windowListeners.set(type, new Set()); windowListeners.get(type)?.add(handler) },
  removeEventListener: (type: string, handler: () => void) => { windowListeners.get(type)?.delete(handler) },
}
const fakeDocument = { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} }
const storage = new Map<string, string>()
const fakeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  get length() { return storage.size },
  key: (index: number) => [...storage.keys()][index] ?? null,
}
const overridden = ['window', 'document', 'localStorage'] as const
const previousDescriptors = overridden.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: fakeWindow })
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: fakeDocument })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, writable: true, value: fakeStorage })
})
afterAll(() => {
  for (const [name, descriptor] of previousDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

const emitOnline = () => { for (const handler of windowListeners.get('online') ?? []) handler() }
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

const MORNING = '2026-10-06T00:00:00.000Z'
const TODAY = '2026-10-06'
const plan = (overrides: Partial<MedicationPlanView> = {}): MedicationPlanView => ({
  id: 'plan-morning', account_email: 'owner@example.com', patient_id: 'patient-a', medication_id: 'norvasc-5',
  schedule_slot: 'morning', as_needed: false, dose_amount: 1, dose_count: 2, display_order: 10, active: true,
  created_at: '2026-07-11T00:00:00.000Z', medication: { brand_name: 'Norvasc' }, ...overrides,
} as MedicationPlanView)

let props: Parameters<typeof useMedicationPendingDoses>[0]
let synced: MedicationIntakeLog[]
let withdrawnSynced: PendingMedicationDose[]
const mounted: Array<{ unmount: () => void }> = []
const mount = () => {
  const coordinator = renderHook(() => useMedicationQueueCoordinator({ patientId: props.patientId, userEmail: props.userEmail }))
  const view = renderHook(() => useMedicationPendingDoses(props), { contexts: [[MedicationQueueContext, coordinator.current]] })
  const bindCoordinator = () => {
    coordinator.rerender()
    view.provideContext(MedicationQueueContext, coordinator.current)
  }
  const hook = {
    get current() { bindCoordinator(); return view.rerender() },
    act: (action: () => void) => { view.act(action); bindCoordinator(); return view.rerender() },
    rerender: () => { bindCoordinator(); return view.rerender() },
    unmount: () => { view.unmount(); coordinator.unmount() },
  }
  mounted.push(hook)
  return hook
}

beforeEach(() => {
  storage.clear()
  windowListeners.clear()
  server.rows = []
  server.inserts = 0
  server.deletes = 0
  server.offline = false
  server.loseNextResponse = false
  server.gate = null
  synced = []
  withdrawnSynced = []
  props = {
    patientId: 'patient-a', userEmail: 'Care@Example.com', careDate: TODAY,
    onSynced: ({ recorded, withdrawn }) => { synced.push(...recorded); withdrawnSynced.push(...withdrawn) },
    onExternalQueueChange: () => {},
  }
})
afterEach(() => {
  // 卸載會清掉退避計時器，否則斷線測試排下的 30 秒重試會拖住測試程序。
  while (mounted.length) mounted.pop()?.unmount()
})

describe('useMedicationPendingDoses (issue #822)', () => {
  test('a dose queued while offline shows as taken-but-pending and syncs on the next online event', async () => {
    server.offline = true
    const hook = mount()
    await settle()

    hook.act(() => { expect(hook.current.queueDose(plan(), 1, MORNING)).toBe(true) })
    await settle()
    expect(hook.current.pendingCount).toBe(1)
    expect(hook.current.pendingLogs.map(log => [log.plan_id, log.dose_number, log.taken_at])).toEqual([['plan-morning', 1, MORNING]])

    server.offline = false
    hook.act(() => emitOnline())
    await settle()
    await settle()
    expect(server.rows).toHaveLength(1)
    expect(synced.map(log => log.id)).toEqual(['row-1'])
    expect(hook.current.pendingCount).toBe(0)
    expect(hook.current.supersededCount).toBe(0)
  })

  test('withdrawing a pending dose clears it from the screen at once and never writes it on reconnect', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()
    const attemptsWhileOffline = server.inserts

    hook.act(() => { expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('withdrawn') })
    // 藥卡立刻回到「尚未服用」；撤回本身仍算一筆等待同步，直到它送到伺服器。
    expect(hook.current.pendingLogs).toEqual([])
    expect(hook.current.withdrawnDoses.map(dose => dose.dose_number)).toEqual([1])
    expect(hook.current.pendingCount).toBe(1)
    // 同一劑重複撤回不會再動到佇列。
    expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('not-pending')

    server.offline = false
    hook.act(() => emitOnline())
    await settle()
    await settle()
    expect(server.inserts).toBe(attemptsWhileOffline)
    expect(server.rows).toEqual([])
    expect(withdrawnSynced.map(dose => dose.dose_number)).toEqual([1])
    expect(hook.current.pendingCount).toBe(0)
  })

  test('a withdrawn dose whose write had reached the server is deleted there too (issue #822 review)', async () => {
    server.loseNextResponse = true
    const hook = mount()
    await settle()
    // 回應遺失：伺服器已寫入，手機收到的是斷線錯誤，於是排進佇列。
    server.offline = true
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    server.offline = false
    server.rows.push({ ...pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 1, 'care@example.com', MORNING)), id: 'row-lost-response' })
    server.offline = true
    await settle()

    hook.act(() => { expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('withdrawn') })
    server.offline = false
    hook.act(() => emitOnline())
    await settle()
    await settle()
    expect(server.rows).toEqual([])
    expect(server.deletes).toBeGreaterThan(0)
    expect(hook.current.pendingCount).toBe(0)
  })

  test('checking a withdrawn dose in again drops the withdrawal so it cannot delete the new check-in', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    // 排進佇列會立刻觸發一次補送（離線失敗）；等它結束，否則撤回會正確地回 'syncing'。
    await settle()
    hook.act(() => { expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('withdrawn') })
    await settle()
    expect(hook.current.withdrawnDoses).toHaveLength(1)

    // 此案例用可取得的跨分頁鎖；沒有鎖的降級環境須保留撤回，另由 cross-tab 測試鎖住。
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (_name: string, _options: unknown, run: (lock: object) => Promise<boolean>) => run({}) } })
    expect(await hook.current.discardWithdrawal('plan-morning', 1, TODAY)).toBe(true)
    hook.rerender()
    expect(hook.current.withdrawnDoses).toEqual([])
    expect(hook.current.pendingCount).toBe(0)
    Reflect.deleteProperty(navigator, 'locks')
  })

  test('the dose that is being sent cannot be withdrawn until the server answers', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()

    server.offline = false
    server.gate = new Promise(resolve => { releaseGate = resolve })
    hook.act(() => emitOnline())
    await settle()
    expect(hook.current.syncingDoseKey).toBe('plan-morning:1')
    expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('syncing')

    server.gate = null
    releaseGate()
    await settle()
    await settle()
    expect(hook.current.syncingDoseKey).toBeNull()
    // 送出成功後已不在佇列：頁面要改走伺服器取消流程，而不是當成已撤回。
    expect(hook.current.cancelPendingDose('plan-morning', 1, TODAY)).toBe('not-pending')
    expect(server.rows).toHaveLength(1)
  })

  test('a dose another device recorded first is kept on the server and the caregiver is told', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()
    server.rows.push({ ...pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 1, 'family@example.com', '2026-10-06T00:10:00.000Z')), id: 'family-row' })

    server.offline = false
    hook.act(() => emitOnline())
    await settle()
    await settle()
    expect(server.rows.map(row => row.id)).toEqual(['family-row'])
    expect(synced.map(log => log.id)).toEqual(['family-row'])
    expect(hook.current.pendingCount).toBe(0)
    expect(hook.current.supersededCount).toBe(1)

    hook.act(() => hook.current.dismissSuperseded())
    expect(hook.current.supersededCount).toBe(0)
  })

  test('server reconciliation leaves an in-flight conflict for the flush to count once', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()
    const otherDeviceLog = {
      ...pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 1, 'family@example.com', '2026-10-06T00:10:00.000Z')),
      id: 'family-row',
    }
    server.rows.push(otherDeviceLog)

    server.offline = false
    server.gate = new Promise(resolve => { releaseGate = resolve })
    hook.act(() => emitOnline())
    await settle()
    expect(hook.current.syncingDoseKey).toBe('plan-morning:1')

    hook.act(() => hook.current.reconcileWithServer([otherDeviceLog], 'patient-a'))
    expect(hook.current.pendingCount).toBe(1)
    expect(hook.current.supersededCount).toBe(0)

    server.gate = null
    releaseGate()
    await settle()
    await settle()
    expect(hook.current.pendingCount).toBe(0)
    expect(hook.current.supersededCount).toBe(1)
    expect(server.rows.map(row => row.id)).toEqual(['family-row'])
  })

  test('loading the day reconciles: doses the server already has leave the queue, ones recorded elsewhere are flagged', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => {
      hook.current.queueDose(plan(), 1, MORNING)
      hook.current.queueDose(plan(), 2, MORNING)
    })
    await settle()
    expect(hook.current.pendingCount).toBe(2)

    const elsewhere = { ...pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 2, 'family@example.com', '2026-10-06T00:10:00.000Z')), id: 'family-row' }
    hook.act(() => hook.current.reconcileWithServer([elsewhere], 'patient-a'))
    expect(hook.current.pendingLogs.map(log => log.dose_number)).toEqual([1])
    expect(hook.current.supersededCount).toBe(1)
  })

  test('switching patients never shows or counts the previous patient\'s pending doses', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()
    expect(hook.current.pendingCount).toBe(1)

    props = { ...props, patientId: 'patient-b' }
    hook.rerender()
    // 切換後不能帶出上一位的待同步劑次；殼層仍持有帳號全病人的佇列，但畫面只選目前這位。
    expect(hook.current.pendingCount).toBe(0)
    expect(hook.current.pendingLogs).toEqual([])
    await settle()

    props = { ...props, patientId: 'patient-a' }
    hook.rerender()
    await settle()
    expect(hook.current.pendingCount).toBe(1)
  })

  test('switching accounts never shows the previous owner\'s local queue', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => { hook.current.queueDose(plan(), 1, MORNING) })
    await settle()
    expect(hook.current.pendingCount).toBe(1)

    props = { ...props, userEmail: 'other@example.com' }
    hook.rerender()
    expect(hook.current.pendingCount).toBe(0)
    expect(hook.current.pendingLogs).toEqual([])
  })

  test('only today\'s pending doses become card logs, but every pending dose is counted', async () => {
    server.offline = true
    const hook = mount()
    await settle()
    hook.act(() => {
      hook.current.queueDose(plan(), 1, MORNING)
      // 前一個照護日（台北 10-05 晚上）離線打卡、到今天還沒送出的那一劑。
      hook.current.queueDose(plan({ id: 'plan-evening', schedule_slot: 'evening' }), 1, '2026-10-05T12:00:00.000Z')
    })
    await settle()
    expect(hook.current.pendingCount).toBe(2)
    expect(hook.current.pendingLogs.map(log => log.plan_id)).toEqual(['plan-morning'])
  })
})
