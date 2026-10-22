/*
檔案用途：鎖住 Siri 捷徑語音喚起（issue #868）在 Web 端的契約：網址白名單只認兩個固定網址、冷啟動暫存與過期、一次性投遞、
getLaunchUrl 不重放，以及多位照護對象時不替使用者決定是誰。
所在層：tests/unit；只測純函式與記憶體內的訂閱機制，不啟動 WebView 或模擬器。
主要關聯：src/lib/nativeShortcuts.ts、ios/App/App/SiriShortcutRouter.swift（網址常數的另一端，由 siriShortcuts.test.ts 對照）。
*/
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  NATIVE_SHORTCUT_PENDING_TTL_MS,
  NATIVE_SHORTCUT_URLS,
  handleNativeShortcutUrl,
  parseNativeShortcutLink,
  publishNativeShortcut,
  resetNativeShortcutsForTests,
  resolveNativeShortcutAction,
  subscribeNativeShortcut,
  type NativeShortcutTarget,
} from '../../src/lib/nativeShortcuts'

beforeEach(() => resetNativeShortcutsForTests())

const collect = () => {
  const received: NativeShortcutTarget[] = []
  return { received, listener: (target: NativeShortcutTarget) => { received.push(target) } }
}

describe('parseNativeShortcutLink', () => {
  test('accepts exactly the two fixed shortcut URLs', () => {
    expect(parseNativeShortcutLink('jia-jian-log://record/blood-pressure')).toBe('bloodPressure')
    expect(parseNativeShortcutLink('jia-jian-log://record/medication')).toBe('medication')
    expect(parseNativeShortcutLink(NATIVE_SHORTCUT_URLS.bloodPressure)).toBe('bloodPressure')
    expect(parseNativeShortcutLink(NATIVE_SHORTCUT_URLS.medication)).toBe('medication')
  })

  test('rejects anything that carries extra data: query, fragment, credentials, port, path, trailing slash', () => {
    // 這個入口任何 App／網頁都能呼叫，所以任何夾帶資料的形狀都必須整筆被擋，不能「忽略多餘部分後照收」。
    for (const url of [
      'jia-jian-log://record/blood-pressure?patient=00000000-0000-4000-8000-000000000001',
      'jia-jian-log://record/blood-pressure?',
      'jia-jian-log://record/blood-pressure#',
      'jia-jian-log://record/blood-pressure#token=abc',
      'jia-jian-log://user:pass@record/blood-pressure',
      'jia-jian-log://record:8080/blood-pressure',
      'jia-jian-log://record/blood-pressure/',
      'jia-jian-log://record/blood-pressure/extra',
      'jia-jian-log://record/blood-pressure%2F..%2Fadmin',
      'jia-jian-log://record/',
      'jia-jian-log://record',
    ]) {
      expect(parseNativeShortcutLink(url)).toBeNull()
    }
  })

  test('rejects other hosts, other schemes, OAuth callbacks, https links, and malformed input', () => {
    for (const url of [
      'jia-jian-log://auth/callback?code=abc',
      'jia-jian-log://join#token=abc',
      'jia-jian-log://records/blood-pressure',
      'jia-jian-log://record/temperature',
      'jia-jian-log://record/__proto__',
      'other-app://record/blood-pressure',
      'https://demo.careapp.local/record/blood-pressure',
      'record/blood-pressure',
      '',
      'not a url',
    ]) {
      expect(parseNativeShortcutLink(url)).toBeNull()
    }
  })
})

describe('shortcut delivery', () => {
  test('hands a request to a live subscriber immediately and exactly once', () => {
    const { received, listener } = collect()
    subscribeNativeShortcut(listener)
    publishNativeShortcut('bloodPressure')
    publishNativeShortcut('medication')
    expect(received).toEqual(['bloodPressure', 'medication'])
  })

  test('keeps a cold-start request until the shell subscribes, then delivers it once', () => {
    publishNativeShortcut('medication', 1_000)
    const first = collect()
    subscribeNativeShortcut(first.listener, 1_000 + 5_000)
    expect(first.received).toEqual(['medication'])
    // 已交付就不能再被第二個訂閱者（例如 StrictMode 重新掛載、重新訂閱）重放。
    const second = collect()
    subscribeNativeShortcut(second.listener, 1_000 + 6_000)
    expect(second.received).toEqual([])
  })

  test('drops a pending request that outlived the TTL instead of surprising the user later', () => {
    publishNativeShortcut('bloodPressure', 0)
    const { received, listener } = collect()
    subscribeNativeShortcut(listener, NATIVE_SHORTCUT_PENDING_TTL_MS + 1)
    expect(received).toEqual([])
  })

  test('still delivers a pending request right at the TTL boundary', () => {
    publishNativeShortcut('bloodPressure', 0)
    const { received, listener } = collect()
    subscribeNativeShortcut(listener, NATIVE_SHORTCUT_PENDING_TTL_MS)
    expect(received).toEqual(['bloodPressure'])
  })

  test('keeps only the latest pending request when the user triggers twice before the shell is ready', () => {
    publishNativeShortcut('bloodPressure', 0)
    publishNativeShortcut('medication', 1_000)
    const { received, listener } = collect()
    subscribeNativeShortcut(listener, 2_000)
    expect(received).toEqual(['medication'])
  })

  test('stops delivering after unsubscribe and queues again for the next subscriber', () => {
    const { received, listener } = collect()
    const unsubscribe = subscribeNativeShortcut(listener)
    unsubscribe()
    publishNativeShortcut('bloodPressure', 0)
    expect(received).toEqual([])
    const next = collect()
    subscribeNativeShortcut(next.listener, 10)
    expect(next.received).toEqual(['bloodPressure'])
  })
})

describe('handleNativeShortcutUrl', () => {
  test('claims and delivers a shortcut URL that arrives as an appUrlOpen event', () => {
    const { received, listener } = collect()
    subscribeNativeShortcut(listener)
    expect(handleNativeShortcutUrl(NATIVE_SHORTCUT_URLS.bloodPressure)).toBe(true)
    expect(received).toEqual(['bloodPressure'])
  })

  test('claims but never replays a shortcut URL that comes back through getLaunchUrl', () => {
    // iOS 的 getLaunchUrl 在 WebView reload 後會再回傳同一個網址；一次性的手勢不能因此在 reload 後重跑。
    const live = collect()
    const unsubscribe = subscribeNativeShortcut(live.listener)
    expect(handleNativeShortcutUrl(NATIVE_SHORTCUT_URLS.medication, { fromLaunch: true })).toBe(true)
    expect(live.received).toEqual([])
    unsubscribe()
    // 也不能偷偷留成暫存：沒人在聽時重放的請求，會在下一個訂閱者出現時被交付。
    expect(handleNativeShortcutUrl(NATIVE_SHORTCUT_URLS.medication, { fromLaunch: true })).toBe(true)
    const late = collect()
    subscribeNativeShortcut(late.listener)
    expect(late.received).toEqual([])
  })

  test('does not claim URLs that are not shortcuts, so OAuth and app links keep their own paths', () => {
    const { received, listener } = collect()
    subscribeNativeShortcut(listener)
    expect(handleNativeShortcutUrl('jia-jian-log://auth/callback?code=abc')).toBe(false)
    expect(handleNativeShortcutUrl('https://demo.careapp.local/join#token=abc')).toBe(false)
    expect(handleNativeShortcutUrl('jia-jian-log://record/blood-pressure?x=1')).toBe(false)
    expect(received).toEqual([])
  })
})

describe('resolveNativeShortcutAction', () => {
  test('opens the requested module directly when there is a single care recipient', () => {
    for (const onCareTab of [false, true]) {
      expect(resolveNativeShortcutAction('bloodPressure', { hasMultipleSubjects: false, onCareTab })).toEqual({ kind: 'openModule', moduleId: 'bloodPressure' })
      expect(resolveNativeShortcutAction('medication', { hasMultipleSubjects: false, onCareTab })).toEqual({ kind: 'openModule', moduleId: 'medication' })
    }
  })

  test('never guesses a recipient: with more than one it stops at the choice screen for both targets', () => {
    // AGENTS.md § 3.5：語音沒有指名對象，多位時不能靠「上次用的是誰」就帶進某個人的輸入畫面。
    expect(resolveNativeShortcutAction('bloodPressure', { hasMultipleSubjects: true, onCareTab: false })).toEqual({ kind: 'chooseSubject', goToToday: true })
    expect(resolveNativeShortcutAction('medication', { hasMultipleSubjects: true, onCareTab: false })).toEqual({ kind: 'chooseSubject', goToToday: true })
  })

  test('already on the care page it stays put, because the input forms there have no persisted draft', () => {
    // 離開照護頁會丟掉打到一半的血壓；照護頁自己有對象選擇器，留在原地加提示即可。
    expect(resolveNativeShortcutAction('bloodPressure', { hasMultipleSubjects: true, onCareTab: true })).toEqual({ kind: 'chooseSubject', goToToday: false })
  })
})
