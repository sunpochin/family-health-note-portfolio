/*
檔案用途：驗證後台血壓總表面板的「依對象篩選」防線：篩選鈕、全選只選目前顯示、切換對象時清空勾選、已選摘要點名對象。
所在層：tests/unit；用 reactHookHarness 執行無 DOM 元件，Supabase 以假的 query builder 取代、不連網。
主要關聯：src/features/system-admin/components/AdminBloodPressurePanel.tsx、hooks/useAdminBloodPressureRecords.ts。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, fire, textContent } from './helpers/elementTree'

installReactHookHarness()

// 假資料：對象名稱用假名（AGENTS.md § 3.3）；三位對象、筆數不同，才看得出篩選與全選的差別。
const ROWS = [
  { id: 'a1', systolic: 106, diastolic: 52, pulse: 69, measured_at: '2026-10-08T22:58:00Z', patient_id: 'pa', patients: { display_name: '阿嬤' } },
  { id: 'b1', systolic: 180, diastolic: 80, pulse: 80, measured_at: '2026-10-08T20:20:00Z', patient_id: 'pb', patients: { display_name: '測試甲' } },
  { id: 'b2', systolic: 120, diastolic: 80, pulse: 80, measured_at: '2026-10-08T20:19:00Z', patient_id: 'pb', patients: { display_name: '測試甲' } },
  { id: 'c1', systolic: 180, diastolic: 80, pulse: 80, measured_at: '2026-10-08T20:17:00Z', patient_id: 'pc', patients: { display_name: '測試乙' } },
]

function builder() {
  const chain = {
    select() { return chain },
    order() { return chain },
    limit() { return Promise.resolve({ data: ROWS, error: null }) },
  }
  return chain
}
mock.module('../../src/lib/supabase', () => ({ supabase: { from: () => builder() } }))

const { AdminBloodPressurePanel } = await import('../../src/features/system-admin/components/AdminBloodPressurePanel')

const ZH_CONTEXT = { locale: 'zh' as const, setLocale: () => {} }

async function renderLoadedPanel() {
  const view = renderHook(() => AdminBloodPressurePanel(), { defaultContext: ZH_CONTEXT })
  // fetchRecords 是 async：等 Promise 解開、setState 進來後再重繪一次才看得到清單。
  await Promise.resolve()
  await Promise.resolve()
  view.rerender()
  return view
}

const pressedButtons = (node: unknown) => findAll(node, el => el.type === 'button' && 'aria-pressed' in el.props)
const deleteButtons = (node: unknown) => findAll(node, el => el.type === 'button' && textContent(el) === '刪除')
const bulkDeleteButton = (node: unknown) => findAll(node, el => el.type === 'button' && textContent(el).startsWith('刪除選取'))[0]
const checkboxes = (node: unknown) => findAll(node, el => el.type === 'input' && el.props['type'] === 'checkbox')

describe('AdminBloodPressurePanel 依對象篩選', () => {
  test('載入後每位對象一顆篩選鈕（含筆數），預設「全部」被按下', async () => {
    const view = await renderLoadedPanel()
    const chips = pressedButtons(view.current)
    expect(chips.map(c => [textContent(c), c.props['aria-pressed']])).toEqual([
      ['全部（4 筆）', true],
      ['測試甲（2 筆）', false],
      ['測試乙（1 筆）', false],
      ['阿嬤（1 筆）', false],
    ])
    expect(deleteButtons(view.current)).toHaveLength(4)
    expect(textContent(view.current)).toContain('先選一位對象再刪除，才不會刪錯人。')
  })

  test('按下對象篩選鈕後只剩那位對象的紀錄，全選也只數目前顯示的筆數', async () => {
    const view = await renderLoadedPanel()
    const [, chipB] = pressedButtons(view.current)
    view.act(() => fire(chipB, 'onClick'))
    const tree = view.current
    expect(deleteButtons(tree)).toHaveLength(2)
    expect(textContent(tree)).toContain('全選目前顯示（2）')
    expect(textContent(tree)).not.toContain('阿嬤 ·')
    expect(textContent(tree)).not.toContain('先選一位對象再刪除')
    // 列上第一眼就是「誰的」：對象名稱在時間前面。
    expect(textContent(tree)).toContain('測試甲·2026-10-09 04:20')
  })

  test('切換對象篩選時清空勾選，避免看不見的勾選被一起刪掉', async () => {
    const view = await renderLoadedPanel()
    const [, rowA] = checkboxes(view.current)
    view.act(() => fire(rowA, 'onChange'))
    expect(bulkDeleteButton(view.current)).toBeDefined()
    expect(textContent(bulkDeleteButton(view.current))).toBe('刪除選取（1）')

    const [, chipB] = pressedButtons(view.current)
    view.act(() => fire(chipB, 'onClick'))
    expect(bulkDeleteButton(view.current)).toBeUndefined()
  })

  test('篩選後全選只勾那位對象，已選摘要點名對象與筆數', async () => {
    const view = await renderLoadedPanel()
    const [, chipB] = pressedButtons(view.current)
    view.act(() => fire(chipB, 'onClick'))
    const [selectAll] = checkboxes(view.current)
    view.act(() => fire(selectAll, 'onChange'))
    const tree = view.current
    expect(textContent(bulkDeleteButton(tree))).toBe('刪除選取（2）')
    expect(textContent(tree)).toContain('已選 2 筆：測試甲 2')
    expect(textContent(tree)).not.toContain('分屬')
  })

  test('在「全部」下跨對象勾選時，摘要標出分屬幾位對象', async () => {
    const view = await renderLoadedPanel()
    const [, rowA, rowB1] = checkboxes(view.current)
    view.act(() => fire(rowA, 'onChange'))
    view.act(() => fire(rowB1, 'onChange'))
    const summary = textContent(view.current)
    expect(summary).toContain('已選 2 筆：')
    expect(summary).toContain('阿嬤 1')
    expect(summary).toContain('測試甲 1')
    expect(summary).toContain('（分屬 2 位對象）')
  })
})
