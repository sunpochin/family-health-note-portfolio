/*
檔案用途：驗證 iOS 鎖屏血壓倒數（issue #865）跟 App 內 banner 用同一個 session 同步：出現就開、消失（量完、換病人、登出）就關、
  換語言重建、載入中不動、非 iOS 平台完全不呼叫原生，以及冷啟動時一定先清掉上一個 process 留下的 Activity。
所在層：tests/unit；用假的平台判定與假的原生 bridge，不啟動模擬器。
主要關聯：src/hooks/useBloodPressureLiveActivity.ts、src/lib/nativeBloodPressureLiveActivity.ts（此處 mock）。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { BloodPressureLiveActivityPayload } from '../../src/lib/bloodPressureLiveActivity'
import type { BloodPressureMeasurementSession } from '../../src/lib/bloodPressureMeasurementSession'
import type { Locale } from '../../src/lib/i18n'

installReactHookHarness()

let platform: 'ios' | 'android' | 'web' = 'ios'
mock.module('../../src/lib/platform', () => ({
  getNativePlatform: () => platform,
  isNativeApp: () => platform !== 'web',
}))

type Call = { kind: 'start'; payload: BloodPressureLiveActivityPayload } | { kind: 'end' }
const calls: Call[] = []
// 模擬 ActivityKit 只允許前景 request：設成 false 代表這次原生端沒開成（例如存完第一筆就立刻鎖屏）。
let nextStartResult = true
mock.module('../../src/lib/nativeBloodPressureLiveActivity', () => ({
  startBloodPressureLiveActivity: async (payload: BloodPressureLiveActivityPayload) => { calls.push({ kind: 'start', payload }); return nextStartResult },
  endBloodPressureLiveActivity: async () => { calls.push({ kind: 'end' }) },
}))

type AppStateHandler = (state: { isActive: boolean }) => void
let appStateHandler: AppStateHandler | undefined
mock.module('@capacitor/app', () => ({
  App: {
    addListener: async (_event: string, handler: AppStateHandler) => {
      appStateHandler = handler
      return { remove: async () => { if (appStateHandler === handler) appStateHandler = undefined } }
    },
  },
}))

// start 的結果是非同步回來的；等 microtask 跑完，hook 才會知道要不要重試。
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

const { useBloodPressureLiveActivity } = await import('../../src/hooks/useBloodPressureLiveActivity')

const session: BloodPressureMeasurementSession = {
  patientId: '00000000-0000-4000-8000-000000000001',
  sessionKey: '2026-09-29-morning-00000000-0000-4000-8000-000000000001',
  deadline: Date.now() + 60_000,
  firstRecord: { systolic: 120, diastolic: 80, pulse: 70 },
}

function setup(initial: { session: BloodPressureMeasurementSession | null; locale?: Locale; loading?: boolean }) {
  const state = { locale: 'zh' as Locale, loading: false, ...initial }
  const handle = renderHook(() => useBloodPressureLiveActivity(state))
  return {
    update(next: Partial<typeof state>) {
      Object.assign(state, next)
      handle.rerender()
    },
    foreground() {
      handle.act(() => appStateHandler?.({ isActive: true }))
      handle.rerender()
    },
  }
}

beforeEach(() => {
  calls.length = 0
  platform = 'ios'
  nextStartResult = true
  appStateHandler = undefined
})

describe('useBloodPressureLiveActivity', () => {
  test('clears leftovers from a previous process on the first sync even with no countdown', () => {
    setup({ session: null })
    expect(calls).toEqual([{ kind: 'end' }])
  })

  test('starts when the banner countdown appears and ends when it disappears', () => {
    const view = setup({ session: null })
    view.update({ session })
    expect(calls.at(-1)).toMatchObject({ kind: 'start', payload: { deadline: session.deadline, countingTitle: '血壓複測倒數中' } })

    // 量完第二次、換病人、登出都會讓 useBloodPressureSession 把 currentMeasurementSession 變成 null。
    view.update({ session: null })
    expect(calls.at(-1)).toEqual({ kind: 'end' })
  })

  test('does not rebuild the Activity on unrelated re-renders of the same session', () => {
    const view = setup({ session })
    view.update({ session: { ...session } })
    view.update({})
    expect(calls.filter(call => call.kind === 'start')).toHaveLength(1)
  })

  test('rebuilds with translated copy when the in-app language changes', () => {
    const view = setup({ session })
    view.update({ locale: 'id' })
    const starts = calls.filter(call => call.kind === 'start')
    expect(starts).toHaveLength(2)
    expect(starts[1]).toMatchObject({ payload: { readyTitle: 'Sekarang boleh ukur lagi' } })
  })

  test('starts a fresh Activity for a new measurement round', () => {
    const view = setup({ session })
    view.update({ session: { ...session, deadline: session.deadline + 120_000 } })
    expect(calls.filter(call => call.kind === 'start')).toHaveLength(2)
  })

  test('does nothing while auth is still loading, so a transient null does not flash the lock screen', () => {
    const view = setup({ session, loading: false })
    calls.length = 0
    view.update({ session: null, loading: true })
    view.update({ session, loading: false })
    expect(calls).toEqual([])
  })

  test('never touches the native bridge outside the iOS shell', () => {
    for (const other of ['web', 'android'] as const) {
      platform = other
      const view = setup({ session: null })
      view.update({ session })
      view.update({ session: null })
    }
    expect(calls).toEqual([])
  })

  test('never forwards patient identity to the native bridge', () => {
    setup({ session })
    const serialized = JSON.stringify(calls)
    expect(serialized).not.toContain(session.patientId)
    expect(serialized).not.toContain('"systolic"')
  })

  test('retries a start that failed because the app was not in the foreground, on the next foreground', async () => {
    nextStartResult = false
    const view = setup({ session })
    await flush()
    expect(calls.filter(call => call.kind === 'start')).toHaveLength(1)

    nextStartResult = true
    view.foreground()
    await flush()
    expect(calls.filter(call => call.kind === 'start')).toHaveLength(2)

    // 開成之後再回前景不應重建，否則每次解鎖倒數都會閃一下。
    view.foreground()
    await flush()
    expect(calls.filter(call => call.kind === 'start')).toHaveLength(2)
  })

  test('does not resurrect a failed start once the session has already moved on', async () => {
    nextStartResult = false
    const view = setup({ session })
    view.update({ session: null })
    await flush()
    view.foreground()
    await flush()
    expect(calls.map(call => call.kind)).toEqual(['start', 'end'])
  })
})
