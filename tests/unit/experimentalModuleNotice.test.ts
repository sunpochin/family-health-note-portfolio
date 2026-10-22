/*
檔案用途：驗證「實驗功能」提示與徽章在三種語言下都有對應文字（issue #656），且一次只顯示目前語言。
所在層：tests/unit；用 React hook harness 呼叫元件函式，不啟動真的瀏覽器。
主要關聯：src/components/daily-care/ExperimentalModuleNotice.tsx。
*/
import { describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { textContent } from './helpers/elementTree'

installReactHookHarness()

const { ExperimentalBadge, ExperimentalModuleNotice } = await import('../../src/components/daily-care/ExperimentalModuleNotice')

const render = (locale: 'zh' | 'id' | 'en', component: () => unknown) => {
  const view = renderHook(() => component(), { defaultContext: { locale, setLocale: () => {} } })
  const content = textContent(view.current)
  view.unmount()
  return content
}

describe('ExperimentalModuleNotice', () => {
  test('tells the caregiver in every locale that the module only records for now', () => {
    expect(render('zh', ExperimentalModuleNotice)).toContain('實驗功能：目前僅提供紀錄')
    expect(render('id', ExperimentalModuleNotice)).toContain('Fitur eksperimental')
    expect(render('en', ExperimentalModuleNotice)).toContain('Experimental: records only for now')
  })

  test('shows only the current locale, never a mix', () => {
    const zh = render('zh', ExperimentalModuleNotice)
    expect(zh).not.toContain('Experimental')
    expect(zh).not.toContain('eksperimental')
  })

  test('badge has a label in every locale', () => {
    expect(render('zh', ExperimentalBadge)).toBe('實驗')
    expect(render('id', ExperimentalBadge)).toBe('Eksperimental')
    expect(render('en', ExperimentalBadge)).toBe('Experimental')
  })
})
