/*
檔案用途：驗證到期提醒的「連回來源」選擇器——二選一互斥、可清除、預設只列 10 筆且可展開、已連結但不在候選裡的來源
仍顯示在選項中、讀取失敗與空狀態有文字，照護閉環 T6（issue #956）。
所在層：tests/unit；用 React hook harness 呼叫元件函式（不遞迴渲染巢狀元件）。
主要關聯：src/features/reminders/components/ReminderSourcePicker.tsx。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, findButton, fire, textContent } from './helpers/elementTree'

installReactHookHarness()
mock.module('../../src/lib/supabase', () => ({ supabase: {} }))

const { ReminderSourcePicker } = await import('../../src/features/reminders/components/ReminderSourcePicker')

const LOCALE = { locale: 'zh' as const, setLocale: () => {} }

function entry(index: number, department: string | null = null) {
  const day = String(index + 1).padStart(2, '0')
  return { id: `e${index}`, event_type: 'health_visit' as const, title: `看診${index}`, occurred_at: `2026-09-${day}T02:00:00.000Z`, visit_department: department }
}
const lab = (index: number) => ({ id: `l${index}`, item_code: 'K' as const, value: 2.5 + index / 10, unit: 'mmol/L', sampled_at: `2026-08-${String(index + 1).padStart(2, '0')}T02:00:00.000Z` })
const range = (count: number) => Array.from({ length: count }, (_, index) => index)

function render(overrides: Partial<Parameters<typeof ReminderSourcePicker>[0]> = {}) {
  const changes: Array<{ entryId: string; labResultId: string }> = []
  const props = {
    candidates: { entries: [entry(1, '心臟內科'), entry(2)], labs: [lab(1)] },
    linked: { entries: [], labs: [] },
    selection: { entryId: '', labResultId: '' },
    loading: false,
    failed: false,
    onChange: (next: { entryId: string; labResultId: string }) => { changes.push(next) },
    ...overrides,
  }
  const view = renderHook(() => ReminderSourcePicker(props), { defaultContext: LOCALE })
  return { view, changes }
}

const optionTexts = (tree: unknown) => findAll(tree, element => element.type === 'option').map(element => textContent(element.props.children))
const selectOf = (tree: unknown) => findAll(tree, element => element.type === 'select')[0]

describe('ReminderSourcePicker', () => {
  test('lists timeline events and lab results in separate groups, with a clear-link option first', () => {
    const { view } = render()
    expect(optionTexts(view.current)).toEqual([
      '不連結',
      '2026-09-02 · 心臟內科 · 看診1',
      '2026-09-03 · 看診2',
      '鉀（K） 2.6 mmol/L · 2026-08-02',
    ])
    expect(findAll(view.current, element => element.type === 'optgroup').map(element => element.props.label)).toEqual(['時間線事件', '檢驗值'])
    view.unmount()
  })

  test('picking an event clears any lab, picking a lab clears any event, and "no link" clears both', () => {
    const { view, changes } = render({ selection: { entryId: '', labResultId: 'l1' } })
    fire(selectOf(view.current), 'onChange', { target: { value: 'entry:e1' } })
    fire(selectOf(view.current), 'onChange', { target: { value: 'lab:l1' } })
    fire(selectOf(view.current), 'onChange', { target: { value: '' } })
    expect(changes).toEqual([
      { entryId: 'e1', labResultId: '' },
      { entryId: '', labResultId: 'l1' },
      { entryId: '', labResultId: '' },
    ])
    view.unmount()
  })

  test('the select shows the current selection', () => {
    expect(selectOf(render({ selection: { entryId: 'e2', labResultId: '' } }).view.current).props.value).toBe('entry:e2')
    expect(selectOf(render({ selection: { entryId: '', labResultId: 'l1' } }).view.current).props.value).toBe('lab:l1')
    expect(selectOf(render().view.current).props.value).toBe('')
  })

  test('shows only the 10 most recent per group until expanded', () => {
    const { view } = render({ candidates: { entries: range(25).map(index => entry(index)), labs: [] } })
    expect(optionTexts(view.current)).toHaveLength(1 + 10)
    view.act(() => fire(findButton(view.current, '顯示更多'), 'onClick'))
    expect(optionTexts(view.current)).toHaveLength(1 + 25)
    expect(findAll(view.current, element => element.type === 'button')).toHaveLength(0)
    view.unmount()
  })

  test('no "show more" button when everything already fits', () => {
    expect(findAll(render().view.current, element => element.type === 'button')).toHaveLength(0)
  })

  test('a linked event outside the visible window still appears as an option and stays selected', () => {
    const old = entry(28, '腎臟科')
    const { view } = render({
      candidates: { entries: range(25).map(index => entry(index)), labs: [] },
      linked: { entries: [old], labs: [] },
      selection: { entryId: old.id, labResultId: '' },
    })
    expect(optionTexts(view.current)).toContain('2026-09-29 · 腎臟科 · 看診28')
    expect(selectOf(view.current).props.value).toBe('entry:e28')
    view.unmount()
  })

  test('a selection whose source cannot be resolved shows an explicit placeholder instead of looking cleared', () => {
    const { view } = render({ candidates: { entries: [], labs: [] }, selection: { entryId: 'gone', labResultId: '' }, failed: true })
    expect(optionTexts(view.current)).toContain('已連結的來源（暫時無法顯示）')
    expect(selectOf(view.current).props.value).toBe('entry:gone')
    view.unmount()
  })

  test('says so when the candidate list failed to load, and when there is nothing to link', () => {
    const failed = render({ candidates: { entries: [], labs: [] }, failed: true })
    expect(textContent(failed.view.current)).toContain('來源清單讀取失敗')
    const empty = render({ candidates: { entries: [], labs: [] } })
    expect(textContent(empty.view.current)).toContain('目前沒有可連結的時間線事件或檢驗值')
    const loading = render({ candidates: { entries: [], labs: [] }, loading: true })
    expect(textContent(loading.view.current)).not.toContain('目前沒有可連結')
    expect(selectOf(loading.view.current).props.disabled).toBe(true)
  })

  test('renders every locale', () => {
    for (const locale of ['id', 'en'] as const) {
      const view = renderHook(() => ReminderSourcePicker({
        candidates: { entries: [entry(1)], labs: [lab(1)] }, linked: { entries: [], labs: [] },
        selection: { entryId: '', labResultId: '' }, loading: false, failed: false, onChange: () => {},
      }), { defaultContext: { locale, setLocale: () => {} } })
      expect(textContent(view.current)).toContain(locale === 'id' ? 'Tautkan ke' : 'Linked source')
      view.unmount()
    }
  })
})
