/*
檔案用途：鎖住 NativeUpdatePrompt 的守門分支——Web／PWA 完全不渲染、不查詢 /version.json（issue #817）；
         Android 目前也不渲染，因為 /version.json 不代表 Play 商店已發布該版本（見元件內註解與
         docs/operations/native-release.md §3.10 第 3 點）。原生殼既有的更新流程已由 PwaUpdatePrompt
         的 native shell gating 測試鎖住。
所在層：tests/unit；不啟動真的瀏覽器，只驗證早期 return 分支在第一次 render 就提早返回、完全不呼叫 fetch。
主要關聯：src/components/system/NativeUpdatePrompt.tsx、src/lib/platform.ts。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'

installReactHookHarness()

// 模擬 Vite 建置期注入的全域變數；appInfo.ts 在 import 時就會讀取 __APP_VERSION__（同 appInfo.test.ts 的作法）。
if (typeof (globalThis as any).__APP_VERSION__ === 'undefined') {
  ;(globalThis as any).__APP_VERSION__ = '1.1.1'
  ;(globalThis as any).__APP_RELEASE_DATE__ = '2026-08-13'
  ;(globalThis as any).__APP_GIT_SHA__ = 'test-sha'
  ;(globalThis as any).__APP_ENVIRONMENT__ = 'test'
  ;(globalThis as any).__APP_BUILD_TIME__ = '2026-08-13T00:00:00.000Z'
}

let nativeApp = false
let nativePlatform: 'ios' | 'android' | 'web' = 'web'
let fetchCalls = 0

mock.module('../../src/lib/platform', () => ({
  isNativeApp: () => nativeApp,
  isStandalonePwa: (displayModeMatches: boolean, navigatorStandalone = false) => displayModeMatches || navigatorStandalone,
  readIsStandalonePwa: () => false,
  getNativePlatform: () => nativePlatform,
}))

const originalFetch = globalThis.fetch
globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
  fetchCalls += 1
  return originalFetch(...args)
}) as typeof fetch

const { NativeUpdatePrompt } = await import('../../src/components/system/NativeUpdatePrompt')

describe('NativeUpdatePrompt gating', () => {
  beforeEach(() => {
    nativeApp = false
    nativePlatform = 'web'
    fetchCalls = 0
  })

  test('renders nothing and never fetches /version.json outside the native shell', () => {
    nativeApp = false
    nativePlatform = 'web'
    const view = renderHook(() => NativeUpdatePrompt())
    expect(view.current).toBeNull()
    expect(fetchCalls).toBe(0)
    view.unmount()
  })

  test('renders nothing on Android: /version.json cannot tell whether Play has actually published it', () => {
    nativeApp = true
    nativePlatform = 'android'
    const view = renderHook(() => NativeUpdatePrompt())
    expect(view.current).toBeNull()
    expect(fetchCalls).toBe(0)
    view.unmount()
  })
})
