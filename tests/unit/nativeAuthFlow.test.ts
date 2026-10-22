/*
檔案用途：驗證 Capacitor OAuth 的原生 listener、冷啟動、瀏覽器關閉與 PKCE 交換流程。
所在層：tests/unit；以可控 plugin mock 模擬 iOS／Android callback，不啟動真實系統瀏覽器或 Supabase。
主要關聯：src/lib/nativeAuth.ts、src/lib/nativeAppLinks.ts（非 OAuth 的 https app link 分流，issue #820）、src/lib/nativeShortcuts.ts（Siri 捷徑網址分流，issue #868）、useAuth、GoogleSignInButton 與原生 deep-link 設定。
*/
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let nativePlatform = true
let launchUrl: { url: string } | undefined
let browserOpenError: Error | null = null
let browserCloseError: Error | null = null
let exchangeError: unknown = null
let exchangeThrows: Error | null = null
let signInError: unknown = null
let signInUrl: string | null = 'https://accounts.example.test/oauth'
let openedUrl: string | null = null
let exchangedCode: string | null = null
let appUrlOpenHandler: ((event: { url: string }) => void) | null = null
let browserFinishedHandler: (() => void) | null = null

const App = {
  addListener: async (eventName: string, handler: (event: { url: string }) => void) => {
    if (eventName === 'appUrlOpen') appUrlOpenHandler = handler
    return { remove: async () => undefined }
  },
  getLaunchUrl: async () => launchUrl,
}

const Browser = {
  addListener: async (eventName: string, handler: () => void) => {
    if (eventName === 'browserFinished') browserFinishedHandler = handler
    return { remove: async () => undefined }
  },
  open: async ({ url }: { url: string }) => {
    openedUrl = url
    if (browserOpenError) throw browserOpenError
  },
  close: async () => {
    if (browserCloseError) throw browserCloseError
  },
}

const Capacitor = { isNativePlatform: () => nativePlatform }
const supabase = {
  auth: {
    signInWithOAuth: async () => ({ data: signInUrl === null ? null : { url: signInUrl }, error: signInError }),
    exchangeCodeForSession: async (code: string) => {
      exchangedCode = code
      if (exchangeThrows) throw exchangeThrows
      return { error: exchangeError }
    },
  },
}

mock.module('@capacitor/app', () => ({ App }))
mock.module('@capacitor/browser', () => ({ Browser }))
mock.module('@capacitor/core', () => ({ Capacitor }))
mock.module('../../src/lib/supabase', () => ({ supabase }))

const {
  NATIVE_AUTH_CALLBACK_URL,
  initializeNativeAuth,
  isNativeApp,
  startNativeGoogleOAuth,
} = await import('../../src/lib/nativeAuth')

const { resetNativeAppLinkDispatchForTests } = await import('../../src/lib/nativeAppLinks')
const { NATIVE_SHORTCUT_URLS, resetNativeShortcutsForTests, subscribeNativeShortcut } = await import('../../src/lib/nativeShortcuts')

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

// app link 的指紋用 crypto.subtle 算，會跨過好幾個 microtask，而且 digest 本身在 runtime 裡是另一條非同步工作，
// 不保證在「下一個 macrotask」之前完成。只等一個 setTimeout(0) 時，第一個 app link 測試會在導向落地前就斷言
// （看到空陣列），晚到的導向再漏進下一個測試的 navigations（看到多一筆 /join）——單獨跑這個檔案時每次都重現，
// 整套一起跑時偶發（CI 在 PR #1013 的 8f092f5 踩到）。改成連續讓出多個 macrotask，給 digest 足夠的輪次落地；
// 這只是等待，不改任何被測邏輯，期待「不會導向」的測試也因此等得更久、更不容易漏判。
const settle = async () => {
  for (let round = 0; round < 10; round += 1) await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  nativePlatform = true
  launchUrl = undefined
  browserOpenError = null
  browserCloseError = null
  exchangeError = null
  exchangeThrows = null
  signInError = null
  signInUrl = 'https://accounts.example.test/oauth'
  openedUrl = null
  exchangedCode = null
})

afterEach(async () => {
  // 未完成的 attempt 要先結束，否則下一個測試會被「already in progress」污染。
  browserFinishedHandler?.()
  await flush()
})

describe('native auth flow', () => {
  test('reports the platform boundary and keeps web initialization a no-op', async () => {
    nativePlatform = false
    expect(isNativeApp()).toBe(false)
    const cleanup = await initializeNativeAuth()
    await cleanup()
    expect(openedUrl).toBeNull()

    nativePlatform = true
    expect(isNativeApp()).toBe(true)
  })

  test('registers listeners once and consumes a cold-start callback', async () => {
    launchUrl = { url: `${NATIVE_AUTH_CALLBACK_URL}?code=cold-start-code` }
    const cleanup = await initializeNativeAuth()
    await flush()
    expect(exchangedCode).toBe('cold-start-code')
    // listener 跟 App 同壽命，回傳的 cleanup 本身刻意是 no-op；呼叫它不應拆掉 listener 或拋出例外。
    await expect(cleanup()).resolves.toBeUndefined()
  })

  test('opens the provider URL and exchanges an app callback code', async () => {
    await initializeNativeAuth()
    const pending = startNativeGoogleOAuth()
    await flush()
    expect(openedUrl).toBe('https://accounts.example.test/oauth')

    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=one-time-code` })
    await expect(pending).resolves.toBeUndefined()
    expect(exchangedCode).toBe('one-time-code')
  })

  test('rejects web, duplicate, provider-error, malformed, and missing-url starts', async () => {
    nativePlatform = false
    await expect(startNativeGoogleOAuth()).rejects.toThrow('unavailable')

    nativePlatform = true
    signInUrl = ''
    await expect(startNativeGoogleOAuth()).rejects.toThrow('did not return')

    signInUrl = 'https://accounts.example.test/oauth'
    const first = startNativeGoogleOAuth()
    await flush()
    await expect(startNativeGoogleOAuth()).rejects.toThrow('already in progress')

    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?error=access_denied` })
    await expect(first).rejects.toThrow('callback was rejected')

    const malformed = startNativeGoogleOAuth()
    await flush()
    appUrlOpenHandler?.({ url: 'https://untrusted.example.test/callback?code=ignored' })
    browserFinishedHandler?.()
    await expect(malformed).rejects.toThrow('dismissed')
  })

  test('rejects when the system browser is dismissed before callback', async () => {
    const pending = startNativeGoogleOAuth()
    await flush()
    browserFinishedHandler?.()
    await expect(pending).rejects.toThrow('dismissed')
  })

  test('clears an attempt when Browser.open fails', async () => {
    browserOpenError = new Error('browser unavailable')
    await expect(startNativeGoogleOAuth()).rejects.toThrow('browser unavailable')

    browserOpenError = null
    const pending = startNativeGoogleOAuth()
    await flush()
    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=retry-code` })
    await expect(pending).resolves.toBeUndefined()
  })

  test('closes the browser even when close rejects and reports code exchange failures', async () => {
    browserCloseError = new Error('already closed')
    exchangeError = new Error('invalid code')
    const pending = startNativeGoogleOAuth()
    await flush()
    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=bad-code` })
    await expect(pending).rejects.toThrow('code exchange failed')

    browserCloseError = null
    exchangeError = null
    exchangeThrows = new Error('network exploded')
    const thrown = startNativeGoogleOAuth()
    await flush()
    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=throws-code` })
    await expect(thrown).rejects.toThrow('callback handling failed')
  })
})

describe('native app link dispatch (issue #820)', () => {
  const APP_LINK_TOKEN = 'b'.repeat(64)
  const navigations: string[] = []
  const sessionValues = new Map<string, string>()
  const previousWindow = (globalThis as { window?: unknown }).window
  // 真實 Capacitor（Android Plugin.addEventListener、iOS notifyListeners retainUntilConsumed）會在 listener 註冊當下
  // 重送先前保留的 appUrlOpen；getLaunchUrl 又回傳同一個 URL。這裡用 pendingAppUrlOpen 模擬那個重送。
  let pendingAppUrlOpen: string | null = null
  // true：重送在 getLaunchUrl 回應之前到（listener 註冊當下 flush）；false：getLaunchUrl 先回、重送晚一步到。
  let replayBeforeLaunchUrl = true
  const originalGetLaunchUrl = App.getLaunchUrl

  beforeEach(() => {
    navigations.length = 0
    sessionValues.clear()
    pendingAppUrlOpen = null
    resetNativeAppLinkDispatchForTests()
    replayBeforeLaunchUrl = true
    App.getLaunchUrl = async () => {
      const replay = pendingAppUrlOpen
      pendingAppUrlOpen = null
      if (replay && replayBeforeLaunchUrl) appUrlOpenHandler?.({ url: replay })
      if (replay && !replayBeforeLaunchUrl) setTimeout(() => appUrlOpenHandler?.({ url: replay }), 0)
      return launchUrl
    }
    // 測試環境沒有 DOM；只提供 openNativeAppLink 會用到的 location 與 sessionStorage。
    ;(globalThis as { window?: unknown }).window = {
      location: {
        pathname: '/',
        assign: (url: string) => { navigations.push(url) },
        reload: () => { navigations.push('reload') },
      },
      sessionStorage: {
        getItem: (key: string) => sessionValues.get(key) ?? null,
        setItem: (key: string, value: string) => { sessionValues.set(key, value) },
      },
    }
  })

  afterEach(() => {
    App.getLaunchUrl = originalGetLaunchUrl
    ;(globalThis as { window?: unknown }).window = previousWindow
  })

  test('routes an https invitation link without touching the OAuth exchange', async () => {
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: `https://demo.careapp.local/join#token=${APP_LINK_TOKEN}` })
    await settle()
    expect(navigations).toEqual([`/join#token=${APP_LINK_TOKEN}`])
    expect(exchangedCode).toBeNull()
  })

  test('keeps OAuth callbacks on the OAuth path and ignores unknown URLs', async () => {
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=oauth-first` })
    appUrlOpenHandler?.({ url: `jia-jian-log://join#token=${APP_LINK_TOKEN}` })
    appUrlOpenHandler?.({ url: `https://demo.careapp.local/admin#token=${APP_LINK_TOKEN}` })
    await settle()
    expect(exchangedCode).toBe('oauth-first')
    expect(navigations).toEqual([])
  })

  for (const replayFirst of [true, false]) {
    test(`routes a cold-start link once although Capacitor delivers it twice and again after reload (replay ${replayFirst ? 'before' : 'after'} getLaunchUrl)`, async () => {
      const url = `https://demo.careapp.local/share#token=${APP_LINK_TOKEN}`
      launchUrl = { url }
      pendingAppUrlOpen = url
      replayBeforeLaunchUrl = replayFirst
      await initializeNativeAuth()
      await settle()
      await settle()
      // 模擬導向後 WebView reload：記憶體清空、useAuth 再初始化，getLaunchUrl 仍回傳同一個網址。
      resetNativeAppLinkDispatchForTests()
      await initializeNativeAuth()
      await settle()
      expect(navigations).toEqual([`/share#token=${APP_LINK_TOKEN}`])
      expect(exchangedCode).toBeNull()
    })
  }
})

describe('Siri shortcut URL dispatch (issue #868)', () => {
  const received: string[] = []
  let unsubscribe = () => {}

  beforeEach(() => {
    received.length = 0
    resetNativeShortcutsForTests()
    unsubscribe = subscribeNativeShortcut(target => { received.push(target) })
  })

  afterEach(() => {
    unsubscribe()
    resetNativeShortcutsForTests()
  })

  test('routes appUrlOpen shortcut URLs to the shortcut subscriber without touching OAuth', async () => {
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: NATIVE_SHORTCUT_URLS.bloodPressure })
    appUrlOpenHandler?.({ url: NATIVE_SHORTCUT_URLS.medication })
    await settle()
    expect(received).toEqual(['bloodPressure', 'medication'])
    expect(exchangedCode).toBeNull()
  })

  test('keeps OAuth callbacks on the OAuth path while a shortcut subscriber is listening', async () => {
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: `${NATIVE_AUTH_CALLBACK_URL}?code=oauth-with-shortcut-listener` })
    await settle()
    expect(exchangedCode).toBe('oauth-with-shortcut-listener')
    expect(received).toEqual([])
  })

  test('does not replay a shortcut that getLaunchUrl hands back after a WebView reload', async () => {
    launchUrl = { url: NATIVE_SHORTCUT_URLS.bloodPressure }
    await initializeNativeAuth()
    await settle()
    expect(received).toEqual([])
    expect(exchangedCode).toBeNull()
  })

  test('ignores look-alike URLs that carry a patient id or extra path', async () => {
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: `${NATIVE_SHORTCUT_URLS.bloodPressure}?patient=00000000-0000-4000-8000-000000000001` })
    appUrlOpenHandler?.({ url: `${NATIVE_SHORTCUT_URLS.medication}/extra` })
    appUrlOpenHandler?.({ url: 'jia-jian-log://record/temperature' })
    await settle()
    expect(received).toEqual([])
    expect(exchangedCode).toBeNull()
  })

  test('queues a cold-start shortcut until the app shell subscribes', async () => {
    unsubscribe()
    await initializeNativeAuth()
    appUrlOpenHandler?.({ url: NATIVE_SHORTCUT_URLS.medication })
    await settle()
    expect(received).toEqual([])
    unsubscribe = subscribeNativeShortcut(target => { received.push(target) })
    expect(received).toEqual(['medication'])
  })
})
