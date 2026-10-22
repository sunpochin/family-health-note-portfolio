/*
檔案用途：鎖住跨分頁撤回與重新打卡、補送後畫面交棒的健康正確性回歸（issue #1228、PR #1271）。
所在層：tests/unit；使用正式 hooks 與 supabase-js，fetch／Web Locks／storage 全部為可控替身，僅含假資料。
主要關聯：useMedicationQueueCoordinator、useMedicationPendingDoses、medicationPendingQueue、MedicationPage。
*/
import { afterAll, afterEach, beforeAll, beforeEach, expect, mock, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { MedicationIntakeLog } from '../../src/types/database'
import type { MedicationPlanView } from '../../src/lib/medication/medications'
import type { MedicationSyncResult } from '../../src/features/medication/hooks/useMedicationQueueCoordinator'

installReactHookHarness()
const OWNER = 'care@example.com'
const PATIENT = 'patient-a'
const DATE = '2026-10-06'
const OLD_TIME = '2026-10-06T00:00:00.000Z'
const NEW_TIME = '2026-10-06T00:10:00.000Z'
const PLAN = { id: 'plan-a', patient_id: PATIENT, medication_id: 'med-a', medication: { brand_name: 'Example medicine' } } as MedicationPlanView
const stored = new Map<string, string>()
const listeners = new Map<string, Set<(event: { key: string | null }) => void>>()
let held = false
let storageFails = false
let release = () => {}
let gate: Promise<void> | null = null
let gatedMethod = 'DELETE'
type IntakeRow = MedicationIntakeLog & { hold_event_id?: string | null }
let rows: IntakeRow[] = []
let deleteFailure: { code: string; message: string } | null = null
let proofResponse: (() => Response) | null = null
const requestDetails: Array<{ method: string; url: URL; signal?: AbortSignal | null }> = []
const requests: string[] = []
const lockWaiters = new Set<() => void>()
const unlock = () => { held = false; for (const wake of lockWaiters) wake(); lockWaiters.clear() }
const locks = { request: async (_name: string, options: { ifAvailable?: boolean }, run: (lock: object | null) => Promise<unknown>) => {
  if (held && options.ifAvailable) return run(null)
  while (held) await new Promise<void>(resolve => { lockWaiters.add(resolve) })
  held = true
  try { return await run({}) } finally { unlock() }
} }

const nav: { onLine: boolean; locks?: unknown } = { onLine: true, locks }
const globals = ['window', 'document', 'localStorage', 'navigator', 'BroadcastChannel'] as const
const descriptors = globals.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const client = createClient('https://example.supabase.co', 'test-anon-key', {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    requests.push(method)
    const url = new URL(String(input))
    requestDetails.push({ method, url, signal: init?.signal })
    // 跟真實 fetch 一樣，即使回讀永不回應，登出也要立即 abort 並釋放共同鎖。
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal
      const abort = () => reject(new DOMException('Request aborted', 'AbortError'))
      if (signal?.aborted) { abort(); return }
      signal?.addEventListener('abort', abort, { once: true })
      const respond = async () => {
        if (method === gatedMethod && gate) await gate
        if (signal?.aborted) throw new DOMException('Request aborted', 'AbortError')
        const matches = (row: IntakeRow) => [...url.searchParams].every(([key, value]) =>
          value === 'not.is.null' ? row[key as keyof IntakeRow] != null :
          !value.startsWith('eq.') || String(row[key as keyof IntakeRow]) === value.slice(3))
        if (method === 'DELETE' && deleteFailure) return json(deleteFailure, 400)
        if (method === 'DELETE') { rows = rows.filter(row => !matches(row)); return new Response(null, { status: 204 }) }
        if (method === 'POST') {
          const payload = JSON.parse(String(init?.body)) as MedicationIntakeLog
          if (rows.some(row => row.patient_id === payload.patient_id && row.plan_id === payload.plan_id && row.care_date === payload.care_date && row.dose_number === payload.dose_number)) {
            return json({ code: '23505', message: 'duplicate dose' }, 409)
          }
          const row = { ...payload, id: 'new-row', created_at: payload.taken_at }
          rows.push(row)
          return json(row, 201)
        }
        if (proofResponse) return proofResponse()
        const found = rows.filter(matches)
        return json(new Headers(init?.headers).get('accept')?.includes('vnd.pgrst.object') ? found[0] ?? null : found)
      }
      respond().then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort))
    })
  }) as typeof fetch },
})
mock.module('../../src/lib/supabase', () => ({ supabase: client }))
const demo = await import('../../src/lib/demoStorage')
mock.module('../../src/lib/demoStorage', () => ({ ...demo, isDemoMode: () => false }))
mock.module('../../src/lib/platform', () => ({ isNativeApp: () => false }))
const { buildPendingMedicationDose, enqueuePendingMedicationDose, withdrawPendingMedicationDose, pendingMedicationDoseToLog, readAllPendingMedicationDoses } = await import('../../src/lib/medication/medicationPendingQueue')
const { mergeMedicationDayLogs } = await import('../../src/lib/medication/medicationPendingQueue')
const { useMedicationQueueCoordinator } = await import('../../src/features/medication/hooks/useMedicationQueueCoordinator')
const { MedicationQueueContext } = await import('../../src/features/medication/hooks/MedicationQueueProvider')
const { useMedicationPendingDoses } = await import('../../src/features/medication/hooks/useMedicationPendingDoses')
const mounted: Array<{ unmount: () => void }> = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const pause = (method: string) => { gatedMethod = method; gate = new Promise<void>(resolve => { release = () => { gate = null; resolve() } }) }
const dose = () => buildPendingMedicationDose(PLAN, 1, OWNER, OLD_TIME)
const emitStorage = () => { for (const listener of listeners.get('storage') ?? []) listener({ key: null }) }
const coordinator = () => {
  const handle = renderHook(() => useMedicationQueueCoordinator({ patientId: PATIENT, userEmail: OWNER }))
  mounted.push(handle)
  return handle
}
const screen = (shell: ReturnType<typeof coordinator>, onExternalQueueChange = () => {}, onSynced: (result: MedicationSyncResult) => void = () => {}) => {
  const props = { patientId: PATIENT, userEmail: OWNER, careDate: DATE, onSynced, onExternalQueueChange }
  const handle = renderHook(() => useMedicationPendingDoses(props), { contexts: [[MedicationQueueContext, shell.current]] })
  mounted.push(handle)
  const refresh = () => { shell.rerender(); handle.provideContext(MedicationQueueContext, shell.current); return handle.rerender() }
  return { handle, props, refresh }
}
beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (type: string, listener: (event: { key: string | null }) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set())
      listeners.get(type)?.add(listener)
    },
    removeEventListener: (type: string, listener: (event: { key: string | null }) => void) => listeners.get(type)?.delete(listener),
  } })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible', addEventListener: () => {}, removeEventListener: () => {} } })
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => { if (storageFails) throw new Error('storage unavailable'); stored.set(key, value) },
    removeItem: (key: string) => { if (storageFails) throw new Error('storage unavailable'); stored.delete(key) },
    get length() { return stored.size }, key: (index: number) => [...stored.keys()][index] ?? null,
  } })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav })
  Object.defineProperty(globalThis, 'BroadcastChannel', { configurable: true, value: undefined })
})
afterAll(() => { for (const [name, descriptor] of descriptors) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else Reflect.deleteProperty(globalThis, name)
} })
beforeEach(() => { stored.clear(); listeners.clear(); rows = []; requests.length = 0; requestDetails.length = 0; deleteFailure = null; proofResponse = null; held = false; lockWaiters.clear(); storageFails = false; gate = null; nav.onLine = true; nav.locks = locks })
afterEach(async () => { release(); unlock(); await settle(); while (mounted.length) mounted.pop()?.unmount() })

test('a re-check-in cannot discard the tombstone while another tab awaits DELETE', async () => {
  const pending = dose()
  enqueuePendingMedicationDose(pending); withdrawPendingMedicationDose(pending)
  rows = [{ ...pendingMedicationDoseToLog(pending), id: 'old-row' }]
  pause('DELETE')
  const peer = coordinator(); await settle()
  const foreground = coordinator(); const view = screen(foreground); await settle()
  expect(view.refresh().syncingDoseKey).toBeNull()
  expect(await view.handle.current.prepareRecheck(PLAN, 1, NEW_TIME)).toBe('blocked')
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
  expect(requests).toEqual(['DELETE'])
  release(); await settle()
  expect(await view.refresh().prepareRecheck(PLAN, 1, NEW_TIME)).toBe('queued')
  await settle()
  expect(rows[0].taken_at).toBe(NEW_TIME)
  expect(rows).toHaveLength(1)
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  expect(requests).toEqual(['DELETE', 'POST'])
  peer.rerender()
})

test.each(['missing', 'rejected', 'storage'] as const)('unusable %s keeps the withdrawal for safe retry', async mode => {
  nav.onLine = false
  const pending = dose(); enqueuePendingMedicationDose(pending); withdrawPendingMedicationDose(pending)
  const shell = coordinator(); const view = screen(shell); await settle()
  if (mode === 'missing') nav.locks = undefined
  if (mode === 'rejected') nav.locks = { request: async () => { throw new Error('locks unavailable') } }
  if (mode === 'storage') storageFails = true
  expect(await view.refresh().prepareRecheck(PLAN, 1, NEW_TIME)).toBe(mode === 'storage' ? 'storage-error' : 'blocked')
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
  expect(requests).toEqual([])
})

test('peer success preserves taken display until the full day read succeeds, even through a failed read', async () => {
  const pending = dose(); enqueuePendingMedicationDose(pending); pause('POST')
  coordinator(); await settle()
  const foreground = coordinator()
  let reloads = 0
  const view = screen(foreground, () => { reloads += 1 }); await settle()
  expect(view.refresh().pendingLogs).toHaveLength(1)
  release(); await settle(); emitStorage()
  let current = view.refresh()
  expect(rows).toHaveLength(1)
  expect(current.pendingCount).toBe(0)
  expect(mergeMedicationDayLogs([], current.pendingLogs, current.withdrawnDoses)).toHaveLength(1)
  expect(current.refreshingDoseKeys.has('plan-a:1')).toBe(true)
  expect(reloads).toBe(1)
  // 讀取失敗沒有 authoritative result；重試前的 render／storage 事件不能抹掉已知服藥事實。
  emitStorage(); current = view.refresh()
  expect(current.pendingLogs).toHaveLength(1)
  current.confirmExternalRefresh(PATIENT, DATE, 'other@example.com')
  expect(view.refresh().pendingLogs).toHaveLength(1)
  current.confirmExternalRefresh(PATIENT, DATE, OWNER)
  current = view.refresh()
  expect(current.pendingLogs).toEqual([])
  expect(current.refreshingDoseKeys.size).toBe(0)
  expect(mergeMedicationDayLogs(rows, current.pendingLogs, current.withdrawnDoses)).toHaveLength(1)
})

test('a drained withdrawal still hides the stale own server row while the day is being refreshed', async () => {
  const pending = dose(); enqueuePendingMedicationDose(pending); withdrawPendingMedicationDose(pending)
  const oldLog = { ...pendingMedicationDoseToLog(pending), id: 'old-row' }
  rows = [oldLog]; pause('DELETE'); coordinator(); await settle()
  const foreground = coordinator(); const view = screen(foreground); await settle()
  release(); await settle(); emitStorage()
  const current = view.refresh()
  expect(current.withdrawnDoses).toHaveLength(1)
  expect(mergeMedicationDayLogs([oldLog], current.pendingLogs, current.withdrawnDoses)).toEqual([])
  view.props.patientId = 'patient-b'
  expect(view.refresh().withdrawnDoses).toEqual([])
  expect(view.refresh().refreshingDoseKeys.size).toBe(0)
})

test('foreground refresh before its storage event still preserves projection and requests a reload', async () => {
  enqueuePendingMedicationDose(dose()); pause('POST'); coordinator(); await settle()
  const foreground = coordinator(); let reloads = 0
  const view = screen(foreground, () => { reloads += 1 }); await settle()
  release(); await settle()
  // 真實瀏覽器可能先送 pageshow／online，晚一個 task 才送 storage；先刷新不能吃掉交棒訊號。
  foreground.current.refresh()
  expect(view.refresh().pendingLogs).toHaveLength(1)
  expect(reloads).toBe(1)
  emitStorage()
  expect(view.refresh().pendingLogs).toHaveLength(1)
  expect(reloads).toBe(1)
})

test('confirming one dose does not swallow a peer-drained second dose discovered during reconcile', async () => {
  nav.onLine = false
  const first = dose()
  const second = buildPendingMedicationDose({ ...PLAN, id: 'plan-b' }, 1, OWNER, OLD_TIME)
  enqueuePendingMedicationDose(first); enqueuePendingMedicationDose(second)
  const foreground = coordinator(); let reloads = 0
  const view = screen(foreground, () => { reloads += 1 }); await settle()
  const firstLog = { ...pendingMedicationDoseToLog(first), id: 'server-first' }
  // 先查到 firstLog 的當日結果，另一頁接著成功送走 second；其 storage 事件仍在等待派送。
  const { removePendingMedicationDose } = await import('../../src/lib/medication/medicationPendingQueue')
  removePendingMedicationDose(second)
  view.handle.current.confirmExternalRefresh(PATIENT, DATE, OWNER)
  view.handle.current.reconcileWithServer([firstLog], PATIENT)
  const current = view.refresh()
  expect(current.pendingCount).toBe(0)
  expect(current.pendingLogs.map(log => log.plan_id)).toEqual(['plan-b'])
  expect(current.refreshingDoseKeys.has('plan-b:1')).toBe(true)
  expect(reloads).toBe(1)
})

test('local success still retains an unrelated peer-reconciled dose before storage delivery', async () => {
  const first = dose(), second = buildPendingMedicationDose({ ...PLAN, id: 'plan-b' }, 1, OWNER, OLD_TIME)
  enqueuePendingMedicationDose(first); enqueuePendingMedicationDose(second)
  rows = [{ ...pendingMedicationDoseToLog(second), id: 'server-second' }]
  pause('POST')
  const foreground = coordinator(); let reloads = 0
  const view = screen(foreground, () => { reloads += 1 }); await settle()
  const { removePendingMedicationDose } = await import('../../src/lib/medication/medicationPendingQueue')
  removePendingMedicationDose(second)
  release(); await settle()
  const current = view.refresh()
  expect(rows).toHaveLength(2)
  expect(current.pendingLogs.map(log => log.plan_id)).toEqual(['plan-b'])
  expect(current.refreshingDoseKeys.has('plan-b:1')).toBe(true)
  expect(reloads).toBe(1)
})

test('peer empty-day read cannot erase a re-check intent while its actual POST is stalled', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  const foreground = coordinator(), peer = coordinator()
  const view = screen(foreground), peerView = screen(peer); await settle()
  pause('POST'); nav.onLine = true
  expect(await view.refresh().prepareRecheck(PLAN, 1, NEW_TIME)).toBe('queued')
  await settle(); emitStorage()
  const currentPeer = peerView.refresh()
  currentPeer.confirmExternalRefresh(PATIENT, DATE, OWNER)
  currentPeer.reconcileWithServer([], PATIENT)
  expect(peerView.refresh().pendingLogs).toHaveLength(1)
  expect(readAllPendingMedicationDoses(OWNER)).toHaveLength(1)
  expect(rows).toHaveLength(0)
  expect(requests).toEqual(['POST'])
  release(); await settle()
  expect(rows).toHaveLength(1)
  expect(rows[0].taken_at).toBe(NEW_TIME)
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
})

test('confirmed hold cleanup waits for a peer lock and survives leaving the medication screen', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  rows = [{ ...pendingMedicationDoseToLog(original), id: 'controlled-fact' }]
  const foreground = coordinator(), view = screen(foreground); await settle()
  held = true
  let finished = false
  const cleanup = view.handle.current.discardWithdrawal(PLAN.id, 1, DATE).then(result => { finished = true; return result })
  await settle(); expect(finished).toBe(false)
  view.handle.unmount()
  unlock()
  expect(await cleanup).toBe(true)
  foreground.rerender()
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  nav.onLine = true; await foreground.current.retryNow()
  expect(rows).toHaveLength(1)
  expect(foreground.rerender().cleanupErrorByPatient[PATIENT]).not.toBe(true)
  expect(requests).toEqual([])
})

test('post-RPC cleanup preserves a newer intent written while it waits for the lock', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  const foreground = coordinator(), view = screen(foreground); await settle()
  held = true
  const cleanup = view.handle.current.discardWithdrawal(PLAN.id, 1, DATE)
  await settle()
  enqueuePendingMedicationDose(buildPendingMedicationDose(PLAN, 1, OWNER, NEW_TIME))
  unlock(); expect(await cleanup).toBe(true)
  const latest = readAllPendingMedicationDoses(OWNER)
  expect(latest).toHaveLength(1)
  expect(latest[0].taken_at).toBe(NEW_TIME)
  expect(latest[0].withdrawn).not.toBe(true)
})

test('the shell retry entry clears a confirmed old marker after storage recovers, without another DELETE', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  rows = [{ ...pendingMedicationDoseToLog(original), id: 'controlled-fact' }]
  const foreground = coordinator(), view = screen(foreground); await settle()
  storageFails = true
  expect(await view.handle.current.discardWithdrawal(PLAN.id, 1, DATE)).toBe(false)
  expect(view.refresh().cleanupError).toBe(true)
  view.handle.unmount(); storageFails = false; nav.onLine = true
  await foreground.current.retryNow()
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  expect(rows).toHaveLength(1)
  expect(foreground.rerender().cleanupErrorByPatient[PATIENT]).not.toBe(true)
  expect(requests).toEqual([])
})

test('an old confirmed cleanup cannot resume after the account changes A to B to A', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  let currentOwner = OWNER
  const foreground = renderHook(() => useMedicationQueueCoordinator({ patientId: PATIENT, userEmail: currentOwner }))
  mounted.push(foreground); await settle()
  held = true
  const cleanup = foreground.current.confirmWithdrawal({ ...original, withdrawn: true })
  await settle()
  currentOwner = 'other@example.com'; foreground.rerender()
  currentOwner = OWNER; foreground.rerender()
  unlock()
  expect(await cleanup).toBe(false)
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
  expect(requests).toEqual([])
})

const guardedFact = () => ({ ...pendingMedicationDoseToLog(dose()), id: 'controlled-fact', created_at: OLD_TIME, hold_event_id: 'taken-event' })
const rejectControlledDelete = () => { deleteFailure = { code: 'P0001', message: 'medication_hold_confirmation_required' } }

test('remount after failed controlled cleanup recovers the exact protected fact and clears only its old withdrawal', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  rows = [guardedFact()]; rejectControlledDelete()
  const oldShell = coordinator(), oldView = screen(oldShell); await settle()
  storageFails = true
  expect(await oldView.handle.current.discardWithdrawal(PLAN.id, 1, DATE)).toBe(false)
  oldView.handle.unmount(); oldShell.unmount()
  storageFails = false
  const restarted = coordinator()
  const synced: MedicationSyncResult[] = []
  const view = screen(restarted, () => {}, result => synced.push(result)); await settle()
  nav.onLine = true; await restarted.current.retryNow()
  expect(requests).toEqual(['DELETE', 'GET'])
  expect(rows).toEqual([guardedFact()])
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  expect(synced).toEqual([{ recorded: [guardedFact()], withdrawn: [] }])
  expect(view.refresh().controlledCorrectionCount).toBe(1)
  expect(view.refresh().syncError).toBe(false)
  const get = requestDetails[1]
  const filter = get.url.searchParams
  expect(Object.fromEntries(['patient_id', 'plan_id', 'care_date', 'dose_number', 'account_email', 'taken_at'].map(key => [key, filter.get(key)]))).toEqual({
    patient_id: `eq.${PATIENT}`, plan_id: `eq.${PLAN.id}`, care_date: `eq.${DATE}`, dose_number: 'eq.1', account_email: `eq.${OWNER}`, taken_at: `eq.${OLD_TIME}`,
  })
  expect(filter.get('hold_event_id')).toBe('not.is.null')
  expect(get.signal).toBe(requestDetails[0].signal)
})

test.each([
  ['empty', null], ['missing-link', { hold_event_id: undefined }], ['null-link', { hold_event_id: null }], ['empty-link', { hold_event_id: '' }],
  ['patient', { patient_id: 'patient-b' }], ['plan', { plan_id: 'plan-b' }], ['date', { care_date: '2026-10-07' }],
  ['dose', { dose_number: 2 }], ['owner', { account_email: 'other@example.com' }], ['time', { taken_at: NEW_TIME }],
] as const)('unproven %s controlled fact keeps the original withdrawal and reports sync failure', async (_kind, changed) => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  rows = [guardedFact()]; rejectControlledDelete()
  // 也驗證錯誤或過期回應的欄位，不能只憑 hold_event_id 就接納一筆不相干的事實。
  proofResponse = () => json(changed === null ? [] : [{ ...guardedFact(), ...changed }])
  const shell = coordinator(); await settle(); nav.onLine = true; await shell.current.retryNow()
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([{ ...original, withdrawn: true }])
  expect(shell.current.syncErrorByPatient[PATIENT]).toBe(true)
  expect(shell.current.controlledCorrectionCountByPatient[PATIENT] ?? 0).toBe(0)
  expect(rows).toEqual([guardedFact()])
})

test('another P0001 guard is not treated as confirmation and never starts a proof read', async () => {
  nav.onLine = false
  const original = dose(); enqueuePendingMedicationDose(original); withdrawPendingMedicationDose(original)
  deleteFailure = { code: 'P0001', message: 'different_guard' }; rows = [guardedFact()]
  const shell = coordinator(); await settle(); nav.onLine = true; await shell.current.retryNow()
  expect(requests).toEqual(['DELETE'])
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
})

test.each(['forbidden', 'network'] as const)('a %s proof read preserves the tombstone', async mode => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rejectControlledDelete(); rows = [guardedFact()]
  proofResponse = () => { if (mode === 'network') throw new TypeError('Failed to fetch'); return json({ code: '42501', message: 'permission denied' }, 403) }
  const shell = coordinator(); await settle(); nav.onLine = true; await shell.current.retryNow()
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
  expect(shell.current.syncErrorByPatient[PATIENT]).toBe(true)
  expect(shell.current.controlledCorrectionCountByPatient[PATIENT] ?? 0).toBe(0)
}, 20_000)

test('provider unmount aborts a stalled proof read with the same signal and releases its lock', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rejectControlledDelete(); rows = [guardedFact()]
  const shell = coordinator(); await settle(); pause('GET'); nav.onLine = true
  const retry = shell.current.retryNow(); await settle()
  expect(requests).toEqual(['DELETE', 'GET']); expect(held).toBe(true)
  shell.unmount(); await retry
  expect(requestDetails[1].signal?.aborted).toBe(true)
  expect(requestDetails[1].signal).toBe(requestDetails[0].signal)
  expect(held).toBe(false)
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
})

test('a newer replacement survives a protected proof read already in flight', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rejectControlledDelete(); rows = [guardedFact()]
  const shell = coordinator(); await settle(); pause('GET'); nav.onLine = true
  const retry = shell.current.retryNow(); await settle()
  const replacement = buildPendingMedicationDose(PLAN, 1, OWNER, NEW_TIME)
  enqueuePendingMedicationDose(replacement)
  release(); await retry
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([replacement])
  expect(shell.current.cleanupErrorByPatient[PATIENT]).not.toBe(true)
  expect(rows).toEqual([guardedFact()])
})

test('known cleanup storage failure stops retry before DELETE or proof GET', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]
  const shell = coordinator(), view = screen(shell); await settle(); storageFails = true
  expect(await view.handle.current.discardWithdrawal(PLAN.id, 1, DATE)).toBe(false)
  nav.onLine = true; await shell.current.retryNow()
  expect(requests).toEqual([])
  expect(view.refresh().cleanupError).toBe(true)
  expect(readAllPendingMedicationDoses(OWNER)[0].withdrawn).toBe(true)
})

test('a proven intake stays taken with stale ordinary plan metadata while storage cleanup fails', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]; rejectControlledDelete()
  const shell = coordinator(), view = screen(shell); await settle(); storageFails = true; nav.onLine = true
  await shell.current.retryNow()
  const current = view.refresh()
  // 另一頁才建立 hold rule：本頁仍是普通藥卡，也不能讓已知事實變成可再給藥的未服用。
  expect(PLAN.holdContext).toBeUndefined()
  expect(current.withdrawnDoses).toEqual([])
  expect(current.pendingLogs).toEqual([guardedFact()])
  expect(mergeMedicationDayLogs([], current.pendingLogs, current.withdrawnDoses)).toEqual([guardedFact()])
  expect(current.cleanupError).toBe(true)
  const replacement = buildPendingMedicationDose(PLAN, 1, OWNER, NEW_TIME)
  storageFails = false; enqueuePendingMedicationDose(replacement); withdrawPendingMedicationDose(replacement); shell.current.refresh()
  expect(view.refresh().pendingLogs).toEqual([])
  expect(view.refresh().withdrawnDoses).toEqual([{ ...replacement, withdrawn: true }])
  view.props.patientId = 'patient-b'
  expect(view.refresh().pendingLogs).toEqual([])
  view.props.patientId = PATIENT; view.props.userEmail = 'other@example.com'
  expect(view.refresh().pendingLogs).toEqual([])
})

test('recovered proof with failed storage is retained for local-only cleanup on the next retry', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]; rejectControlledDelete()
  const shell = coordinator(); await settle(); storageFails = true; nav.onLine = true
  await shell.current.retryNow()
  expect(requests).toEqual(['DELETE', 'GET'])
  expect(shell.current.cleanupErrorByPatient[PATIENT]).toBe(true)
  await shell.current.retryNow()
  expect(requests).toEqual(['DELETE', 'GET'])
  storageFails = false; await shell.current.retryNow()
  expect(requests).toEqual(['DELETE', 'GET'])
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  expect(shell.current.cleanupErrorByPatient[PATIENT]).not.toBe(true)
})

test('a screen mounted during a cleanup failure receives the known fact before the shell clears its projection', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]; rejectControlledDelete()
  const shell = coordinator(); await settle(); storageFails = true; nav.onLine = true
  await shell.current.retryNow()
  let serverLogs: MedicationIntakeLog[] = []
  const view = screen(shell, () => {}, result => { serverLogs = result.recorded })
  expect(view.refresh().pendingLogs).toEqual([guardedFact()])
  // 此新畫面的日讀取失敗：本機清理成功仍要交棒權威事實，不能隨 projection 消失而翻成未服用。
  storageFails = false; await shell.current.retryNow()
  const current = view.refresh()
  expect(current.pendingLogs).toEqual([])
  expect(serverLogs).toEqual([guardedFact()])
  expect(mergeMedicationDayLogs(serverLogs, current.pendingLogs, current.withdrawnDoses)).toEqual([guardedFact()])
})

test('peer cleanup hands off a proven intake as taken until the full-day read finishes', async () => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]; rejectControlledDelete()
  const shell = coordinator(); await settle(); storageFails = true; nav.onLine = true
  await shell.current.retryNow()
  const view = screen(shell); expect(view.refresh().pendingLogs).toEqual([guardedFact()])
  storageFails = false
  const { removePendingMedicationDose } = await import('../../src/lib/medication/medicationPendingQueue')
  removePendingMedicationDose(dose()); shell.current.refresh()
  const current = view.refresh()
  expect(current.pendingCount).toBe(0)
  expect(current.withdrawnDoses).toEqual([])
  expect(mergeMedicationDayLogs([], current.pendingLogs, current.withdrawnDoses)).toHaveLength(1)
  expect(current.refreshingDoseKeys.has('plan-a:1')).toBe(true)
  current.confirmExternalRefresh(PATIENT, DATE, OWNER)
  expect(view.refresh().pendingLogs).toEqual([])
})

test.each(['shared-marker-removed', 'marker-still-local'] as const)('a later successful day read supersedes old proof with %s and cleanup cannot resurrect it', async mode => {
  nav.onLine = false
  enqueuePendingMedicationDose(dose()); withdrawPendingMedicationDose(dose()); rows = [guardedFact()]; rejectControlledDelete()
  const shell = coordinator(); await settle(); storageFails = true; nav.onLine = true
  await shell.current.retryNow()
  const synced: MedicationSyncResult[] = []
  const view = screen(shell, () => {}, result => synced.push(result))
  expect(view.refresh().pendingLogs).toEqual([guardedFact()])
  // 別裝置透過受控更正移除事實；後來成功的完整讀取是新權威，不能被舊 proof 蓋掉。
  rows = []
  if (mode === 'shared-marker-removed') {
    storageFails = false
    const { removePendingMedicationDose } = await import('../../src/lib/medication/medicationPendingQueue')
    removePendingMedicationDose(dose()); shell.current.refresh()
  }
  const before = view.refresh()
  before.confirmExternalRefresh('patient-b', DATE, OWNER)
  before.confirmExternalRefresh(PATIENT, '2026-10-07', OWNER)
  before.confirmExternalRefresh(PATIENT, DATE, 'other@example.com')
  expect(view.refresh().pendingLogs).toHaveLength(1)
  before.confirmExternalRefresh(PATIENT, DATE, OWNER)
  const fresh = view.refresh()
  expect(mergeMedicationDayLogs([], fresh.pendingLogs, fresh.withdrawnDoses)).toEqual([])
  storageFails = false; await shell.current.retryNow()
  const cleared = view.refresh()
  expect(synced).toEqual([])
  expect(mergeMedicationDayLogs([], cleared.pendingLogs, cleared.withdrawnDoses)).toEqual([])
  expect(readAllPendingMedicationDoses(OWNER)).toEqual([])
  expect(requests).toEqual(['DELETE', 'GET'])
})
