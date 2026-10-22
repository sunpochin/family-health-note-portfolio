/*
檔案用途：驗證殼層提示保存契約；從協調器搬出的降級／跨分頁案例在這裡直接測模組。
所在層：tests/unit；只用合成病人、帳號與記憶體 Storage，不連資料庫或通知服務。
主要關聯：shellNoticeStore、usePerKeyStoreState、bloodPressureShellNoticeStores；bpQueueCoordinator 保留補送整合驗證。
*/
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { createNotifyProblemsStore, createRejectedSavesStore } from '../../src/features/vitals/lib/bloodPressureShellNoticeStores'
import type { RejectedBloodPressureSave } from '../../src/features/vitals/hooks/useBloodPressureQueueCoordinator'

installReactHookHarness()
const { usePerKeyStoreState } = await import('../../src/features/vitals/hooks/usePerKeyStoreState')
const OWNER = 'caregiver@example.com'
const stored = new Map<string, string>()
const listeners = new Set<(event: { key: string | null }) => void>()
const cleanups: Array<() => void> = []
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
let failWrite = false
let failList = false
let failRead = false
let failRemove = false
type Kind = 'notify' | 'rejected'
const storageKey = (kind: Kind, id: string, owner = OWNER) => kind === 'notify'
  ? `jia-jian.pending-blood-pressure.notify-problems.v2-${owner}-patient-${id}`
  : `jia-jian.pending-blood-pressure.rejected-saves.v1-${owner}-record-${id}`
const rejection = (recordId: string, at = 1): RejectedBloodPressureSave => ({
  recordId, patientId: 'patient-a', at, error: { code: 'P0001', status: 400, message: 'daily_blood_pressure_limit' },
  limitBlockedReading: { patientId: 'patient-a', systolic: 185, diastolic: 105, pulse: 80, measuredAt: '2026-10-07T03:00:00.000Z' },
  callFamily: true,
})
const emitStorage = (key: string | null) => { for (const listener of listeners) listener({ key }) }
const put = (kind: Kind, id: string, owner = OWNER) => stored.set(storageKey(kind, id, owner), kind === 'notify' ? '1' : JSON.stringify(rejection(id)))

beforeEach(() => {
  stored.clear()
  listeners.clear()
  failWrite = failList = failRead = failRemove = false
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => { if (failRead) throw new Error('blocked read'); return stored.get(key) ?? null },
    setItem: (key: string, value: string) => { if (failWrite) throw new Error('quota'); stored.set(key, value) },
    removeItem: (key: string) => { if (failRemove) throw new Error('blocked removal'); stored.delete(key) },
    get length() { return stored.size },
    key: (index: number) => { if (failList) throw new Error('blocked enumeration'); return [...stored.keys()][index] ?? null },
  } })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    addEventListener: (_type: string, listener: (event: { key: string | null }) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: { key: string | null }) => void) => listeners.delete(listener),
  } })
})
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  for (const [name, descriptor] of [['localStorage', originalStorage], ['window', originalWindow]] as const) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor)
    else Reflect.deleteProperty(globalThis, name)
  }
})

function mount(kind: Kind, owner = OWNER, enabled = true) {
  if (kind === 'notify') {
    const store = createNotifyProblemsStore(owner)
    const view = renderHook(() => usePerKeyStoreState(store, enabled, { mergeStoredOnWrite: true }))
    cleanups.push(() => view.unmount())
    return { ids: () => view.current.values, add: (id: string) => view.current.add(id), remove: (id: string) => view.current.remove(id), clear: () => view.current.clearAll() }
  }
  const store = createRejectedSavesStore(owner)
  const view = renderHook(() => usePerKeyStoreState(store, enabled, { sortOnStorageEvent: true }))
  cleanups.push(() => view.unmount())
  return { ids: () => view.current.values.map(item => item.recordId), add: (id: string) => view.current.add(rejection(id)), remove: (id: string) => view.current.remove(id), clear: () => view.current.clearAll() }
}

// 兩種 codec 都走同一套降級契約，避免下一次只修到其中一種提示。
describe.each(['notify', 'rejected'] as const)('%s per-key state', kind => {
  test('reads existing notices on the first render and isolates owners and namespaces', () => {
    put(kind, 'a')
    put(kind, 'other-owner', 'other@example.com')
    put(kind === 'notify' ? 'rejected' : 'notify', 'other-kind')
    expect(mount(kind).ids()).toEqual(['a'])
    expect(mount(kind, 'other@example.com').ids()).toEqual(['other-owner'])
  })
  test('retains old and new notices when writing fails', () => {
    const view = mount(kind)
    view.add('b')
    failWrite = true
    view.add('a')
    expect(view.ids()).toEqual(['b', 'a'])
    expect(stored.has(storageKey(kind, 'a'))).toBe(false)
  })
  test('retains notices when storage keys cannot be listed', () => {
    const view = mount(kind)
    view.add('b')
    failList = true
    view.add('a')
    expect(view.ids()).toEqual(['b', 'a'])
  })
  test('storage events add and remove only their key; unrelated and foreign-owner keys are ignored', () => {
    const view = mount(kind)
    put(kind, 'a')
    emitStorage('unrelated')
    put(kind, 'foreign', 'other@example.com')
    emitStorage(storageKey(kind, 'foreign', 'other@example.com'))
    expect(view.ids()).toEqual([])
    emitStorage(storageKey(kind, 'a'))
    expect(view.ids()).toEqual(['a'])
    stored.delete(storageKey(kind, 'a'))
    emitStorage(storageKey(kind, 'a'))
    expect(view.ids()).toEqual([])
  })
  test('unpersisted notices survive other keys and clear events, until their own successful write and removal', () => {
    const view = mount(kind)
    failWrite = true
    view.add('a')
    failWrite = false
    put(kind, 'b')
    emitStorage(storageKey(kind, 'b'))
    expect(view.ids()).toEqual(['a', 'b'])
    stored.delete(storageKey(kind, 'b'))
    emitStorage(storageKey(kind, 'b'))
    expect(view.ids()).toEqual(['a'])
    stored.clear()
    emitStorage(null)
    expect(view.ids()).toEqual(['a'])
    view.add('a')
    expect(stored.has(storageKey(kind, 'a'))).toBe(true)
    stored.delete(storageKey(kind, 'a'))
    emitStorage(storageKey(kind, 'a'))
    expect(view.ids()).toEqual([])
  })
  test('clear events remove persisted notices and retain only failed writes', () => {
    const view = mount(kind)
    view.add('persisted')
    failWrite = true
    view.add('memory')
    stored.clear()
    emitStorage(null)
    expect(view.ids()).toEqual(['memory'])
  })
  test('a storage event read failure cannot wipe the named in-memory notice', () => {
    const view = mount(kind)
    view.add('a')
    stored.delete(storageKey(kind, 'a'))
    failRead = true
    emitStorage(storageKey(kind, 'a'))
    expect(view.ids()).toEqual(['a'])
  })
  test('two writers retain both per-key notices and a fresh instance reads both', () => {
    const first = mount(kind)
    const second = mount(kind)
    first.add('a')
    second.add('b')
    expect(mount(kind).ids()).toEqual(['a', 'b'])
    put(kind, 'other', 'other@example.com')
    first.clear()
    expect(first.ids()).toEqual([])
    expect(stored.has(storageKey(kind, 'a'))).toBe(false)
    expect(stored.has(storageKey(kind, 'b'))).toBe(false)
    expect(stored.has(storageKey(kind, 'other', 'other@example.com'))).toBe(true)
  })
  test('explicit removal and clear dismiss memory notices even if local storage is unavailable', () => {
    const view = mount(kind)
    failWrite = true
    view.add('a')
    view.add('b')
    failRemove = true
    view.remove('a')
    expect(view.ids()).toEqual(['b'])
    view.clear()
    expect(view.ids()).toEqual([])
  })
  test('disabled state reads and writes no storage and subscribes to no events', () => {
    put(kind, 'stored')
    const view = mount(kind, OWNER, false)
    expect(view.ids()).toEqual([])
    expect(listeners.size).toBe(0)
    view.add('memory')
    expect(view.ids()).toEqual(['memory'])
    expect(stored.has(storageKey(kind, 'memory'))).toBe(false)
  })
})

test('store APIs keep missing, failed enumeration and failed single reads distinct', () => {
  const store = createRejectedSavesStore(OWNER)
  expect(store.read('missing')).toBeNull()
  expect(store.readAll()).toEqual([])
  put('rejected', 'a')
  failList = true
  expect(store.readAll()).toBeNull()
  failRead = true
  expect(store.read('a')).toBeUndefined()
  expect(store.isKey(storageKey('rejected', 'a'))).toBe(true)
  expect(store.keyOf(storageKey('rejected', 'a'))).toBe('a')
  expect(store.isKey(null)).toBe(false)
  expect(store.isKey(storageKey('rejected', 'a', 'other@example.com'))).toBe(false)
})

test('notify reads keep legacy key-only semantics, sort hydration, and merge other tabs on write', () => {
  stored.set(storageKey('notify', 'b'), 'legacy-value')
  stored.set(storageKey('notify', 'a'), '1')
  stored.set(storageKey('notify', ''), '1')
  failRead = true
  const view = mount('notify')
  expect(view.ids()).toEqual(['a', 'b'])
  failRead = false
  put('notify', 'c')
  view.add('d')
  expect(view.ids()).toEqual(['a', 'b', 'c', 'd'])
  expect(stored.get(storageKey('notify', 'd'))).toBe('1')
})

test('rejected codec preserves patient readings and flags but serializes only the error summary', () => {
  const store = createRejectedSavesStore(OWNER)
  const item = { ...rejection('a'), uncertain: true, error: { message: 'failed', code: 'P0001', status: 400, privateExtra: 'omit' } }
  expect(store.write('a', item)).toBe(true)
  expect(JSON.parse(stored.get(storageKey('rejected', 'a'))!)).toEqual({ ...item, error: { message: 'failed', code: 'P0001', status: 400 } })
  expect(store.read('a')).toMatchObject({ patientId: 'patient-a', limitBlockedReading: { patientId: 'patient-a', systolic: 185 }, callFamily: true, uncertain: true })
})

test('rejected hydration and storage additions sort by arrival; duplicate reports keep the first in-memory result', () => {
  const store = createRejectedSavesStore(OWNER)
  store.write('late', rejection('late', 30))
  store.write('early', rejection('early', 10))
  const view = renderHook(() => usePerKeyStoreState(store, true, { sortOnStorageEvent: true }))
  cleanups.push(() => view.unmount())
  expect(view.current.values.map(item => item.recordId)).toEqual(['early', 'late'])
  store.write('middle', rejection('middle', 20))
  emitStorage(storageKey('rejected', 'middle'))
  expect(view.current.values.map(item => item.recordId)).toEqual(['early', 'middle', 'late'])
  view.current.add(rejection('early', 40))
  expect(view.current.values[0].at).toBe(10)
})

test('malformed rejected data is skipped on hydration; a failed parse event preserves existing memory', () => {
  const store = createRejectedSavesStore(OWNER)
  store.write('valid', rejection('valid'))
  stored.set(storageKey('rejected', 'invalid-shape'), '{}')
  stored.set(storageKey('rejected', 'bad-json'), '{')
  expect(store.readAll()?.map(item => item.recordId)).toEqual(['valid'])
  const view = mount('rejected')
  stored.set(storageKey('rejected', 'valid'), '{')
  emitStorage(storageKey('rejected', 'valid'))
  expect(view.ids()).toEqual(['valid'])
})

test('unmount removes both storage listeners', () => {
  mount('notify')
  mount('rejected')
  expect(listeners.size).toBe(2)
  for (const cleanup of cleanups.splice(0)) cleanup()
  expect(listeners.size).toBe(0)
})
