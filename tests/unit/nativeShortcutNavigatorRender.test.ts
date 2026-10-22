/*
檔案用途：驗證外殼的 Siri 捷徑接收元件（NativeShortcutNavigator，issue #868）：偏好讀完才處理請求、只有一位照護對象時直接開對應區塊，
多位時不猜對象、改停在對象選擇並顯示三語提示（已在照護頁就不離開）；冷啟動暫存的請求在就緒時交付；
提示只跟著發起的那一頁、換對象後收起；卸載後不再收到請求。
所在層：tests/unit；用 React hook harness 呼叫元件函式（見 nextVisitPageRender.test.ts 慣例），不啟動 WebView 或模擬器。
主要關聯：src/components/system/NativeShortcutNavigator.tsx、src/lib/nativeShortcuts.ts、App.tsx 的 openDailyCareModule。
*/
import { beforeEach, describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findButton, fire, textContent } from './helpers/elementTree'

installReactHookHarness()

const { NativeShortcutNavigator, NativeShortcutSubjectNotice } = await import('../../src/components/system/NativeShortcutNavigator')
const { publishNativeShortcut, resetNativeShortcutsForTests } = await import('../../src/lib/nativeShortcuts')

const LOCALE_CONTEXT_VALUE = { locale: 'zh' as const, setLocale: () => {} }

type NavigatorProps = Parameters<typeof NativeShortcutNavigator>[0]

let opened: string[]
let chooseCount: number
let props: NavigatorProps

beforeEach(() => {
  resetNativeShortcutsForTests()
  opened = []
  chooseCount = 0
  props = {
    ready: true,
    tab: 'today',
    hasMultipleSubjects: false,
    activePatientId: 'patient-a',
    onOpenModule: moduleId => { opened.push(moduleId) },
    // App 的 changeTab('today')：父層真的會把分頁切過去，下一次 render 的 tab 就是 today。
    onChooseSubject: () => { chooseCount += 1; props = { ...props, tab: 'today' } },
  }
})

const mount = () => renderHook(() => NativeShortcutNavigator(props), { defaultContext: LOCALE_CONTEXT_VALUE })

describe('NativeShortcutNavigator', () => {
  test('with a single care recipient it opens the requested module directly and shows no notice', () => {
    const view = mount()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(opened).toEqual(['bloodPressure'])
    expect(chooseCount).toBe(0)
    expect(view.current).toBeNull()
    view.unmount()
  })

  test('with more than one care recipient it never opens a module: it goes to the Today page and explains why', () => {
    // AGENTS.md § 3.5 與 issue 驗收：語音沒有指名對象，多位時不猜。
    props = { ...props, tab: 'events', hasMultipleSubjects: true }
    const view = mount()
    publishNativeShortcut('medication')
    view.rerender()
    expect(opened).toEqual([])
    expect(chooseCount).toBe(1)
    expect(view.current).not.toBeNull()
    view.unmount()
  })

  test('already on the care page it stays there (no tab change) and shows the notice on that page', () => {
    // 照護頁的輸入沒有草稿保存，切走會丟掉打到一半的數字。
    props = { ...props, tab: 'dailyCare', hasMultipleSubjects: true }
    const view = mount()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(chooseCount).toBe(0)
    expect(opened).toEqual([])
    expect(view.current).not.toBeNull()
    view.unmount()
  })

  test('the notice follows the page it was raised on: leaving that page clears it for good', () => {
    props = { ...props, tab: 'dailyCare', hasMultipleSubjects: true }
    const view = mount()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(view.current).not.toBeNull()
    // 使用者離開照護頁（例如去今天頁按了別的東西）。
    props = { ...props, tab: 'today' }
    view.rerender()
    expect(view.current).toBeNull()
    // 回到原本那一頁也不會復活：它已經不適用了。
    props = { ...props, tab: 'dailyCare' }
    view.rerender()
    expect(view.current).toBeNull()
    view.unmount()
  })

  test('does not act on a request until the daily care preference has loaded, then delivers it once', () => {
    // 冷啟動時偏好還是預設值（全部可見）；現在判斷模組可見性，會先開到病人已關掉的模組，讀完後又被靜默切走。
    props = { ...props, ready: false }
    const view = mount()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(opened).toEqual([])
    expect(chooseCount).toBe(0)

    props = { ...props, ready: true }
    view.rerender()
    expect(opened).toEqual(['bloodPressure'])
    view.rerender()
    expect(opened).toEqual(['bloodPressure'])
    view.unmount()
  })

  test('goes quiet again while the next care recipient\'s preference loads, and still delivers what arrived meanwhile', () => {
    const view = mount()
    props = { ...props, ready: false, activePatientId: 'patient-b' }
    view.rerender()
    publishNativeShortcut('medication')
    view.rerender()
    expect(opened).toEqual([])
    props = { ...props, ready: true }
    view.rerender()
    expect(opened).toEqual(['medication'])
    view.unmount()
  })

  test('delivers a cold-start request that was queued before the shell mounted', () => {
    publishNativeShortcut('medication')
    const view = mount()
    expect(opened).toEqual(['medication'])
    view.unmount()
  })

  test('keeps the notice that a queued request raised during mount (mount must not clear it)', () => {
    props = { ...props, hasMultipleSubjects: true }
    publishNativeShortcut('bloodPressure')
    const view = mount()
    expect(chooseCount).toBe(1)
    expect(view.current).not.toBeNull()
    view.unmount()
  })

  test('hides the notice once the user actually picks a different care recipient, not on an ordinary re-render', () => {
    props = { ...props, hasMultipleSubjects: true }
    const view = mount()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(view.current).not.toBeNull()
    view.rerender()
    expect(view.current).not.toBeNull()
    props = { ...props, activePatientId: 'patient-b' }
    view.rerender()
    expect(view.current).toBeNull()
    view.unmount()
  })

  test('uses the latest callbacks and subject count, not the ones captured when it subscribed', () => {
    const view = mount()
    const laterOpened: string[] = []
    props = { ...props, hasMultipleSubjects: true, onOpenModule: moduleId => { laterOpened.push(moduleId) } }
    view.rerender()
    publishNativeShortcut('bloodPressure')
    view.rerender()
    expect(opened).toEqual([])
    expect(laterOpened).toEqual([])
    expect(chooseCount).toBe(1)

    props = { ...props, hasMultipleSubjects: false }
    view.rerender()
    publishNativeShortcut('medication')
    view.rerender()
    expect(opened).toEqual([])
    expect(laterOpened).toEqual(['medication'])
    view.unmount()
  })

  test('stops listening after unmount and queues the next request for whoever mounts next', () => {
    const view = mount()
    view.unmount()
    publishNativeShortcut('bloodPressure')
    expect(opened).toEqual([])
    const next = mount()
    expect(opened).toEqual(['bloodPressure'])
    next.unmount()
  })
})

describe('NativeShortcutSubjectNotice', () => {
  const render = (locale: 'zh' | 'id' | 'en', onDismiss = () => {}) => renderHook(
    () => NativeShortcutSubjectNotice({ onDismiss }),
    { defaultContext: { locale, setLocale: () => {} } },
  )

  test('shows one language at a time, with no patient name or value in it', () => {
    const zh = textContent(render('zh').current)
    const id = textContent(render('id').current)
    const en = textContent(render('en').current)
    expect(zh).toContain('請先選擇要記錄的對象')
    expect(id).toContain('Pilih dulu siapa yang akan dicatat')
    expect(en).toContain('Choose who to record for first')
    expect(zh).not.toContain('Pilih')
    expect(id).not.toContain('請先')
    expect(en).not.toContain('Pilih')
    for (const copy of [zh, id, en]) expect(copy).not.toMatch(/\d/)
  })

  test('the dismiss button calls back', () => {
    let dismissed = 0
    const view = render('zh', () => { dismissed += 1 })
    view.act(() => fire(findButton(view.current, '關閉'), 'onClick'))
    expect(dismissed).toBe(1)
  })
})
