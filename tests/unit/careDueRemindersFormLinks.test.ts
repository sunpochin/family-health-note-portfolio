/*
檔案用途：驗證到期提醒頁的表單能連回時間線事件／檢驗值並填科別（照護閉環 T6，issue #956 驗收條件）：
新增看診提醒連事件＋科別、抽血提醒連檢驗值、兩者互斥、藥量倒數不顯示這三欄、編輯只改到期日不會清掉連結、
提醒清單顯示「連結」標籤。
所在層：tests/unit；用 React hook harness 執行頁面本體（巢狀元件不遞迴渲染，改由元素 props 檢查與觸發），
Supabase 以依資料表回應並記錄寫入內容的 mock 取代。
主要關聯：src/features/reminders/pages/CareDueRemindersPage.tsx、useReminderSources、ReminderSourcePicker。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, findButton, fire, textContent } from './helpers/elementTree'

installReactHookHarness()

type Write = { table: string; method: 'insert' | 'update'; payload: Record<string, unknown> }
const writes: Write[] = []
let reminderRows: Array<Record<string, unknown>> = []

const visit = { id: 'e1', event_type: 'health_visit', title: '回診', occurred_at: '2026-09-10T02:00:00.000Z', visit_department: '心臟內科' }
const potassium = { id: 'l1', item_code: 'K', value: 2.8, unit: 'mmol/L', sampled_at: '2026-09-10T02:00:00.000Z' }

const supabase = {
  from(table: string) {
    let write: Write | null = null
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit']) chain[method] = () => chain
    for (const method of ['insert', 'update'] as const) {
      chain[method] = (payload: Record<string, unknown>) => { write = { table, method, payload }; writes.push(write); return chain }
    }
    const rows = () => {
      if (table === 'care_timeline_entries') return [visit]
      if (table === 'patient_lab_results') return [potassium]
      return reminderRows
    }
    chain.single = () => Promise.resolve({
      data: { id: 'saved', patient_id: 'p1', status: 'active', created_at: '', updated_at: '', completed_at: null, created_by_user_id: null, related_entry_id: null, related_lab_result_id: null, visit_department: null, medication_plan_id: null, days_supply: null, ...write?.payload },
      error: null,
    })
    chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: rows(), error: null }).then(onFulfilled, onRejected)
    return chain
  },
}
mock.module('../../src/lib/supabase', () => ({ supabase }))

const { CareDueRemindersPage } = await import('../../src/features/reminders/pages/CareDueRemindersPage')

const LOCALE = { locale: 'zh' as const, setLocale: () => {} }
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function reminder(overrides: Record<string, unknown>) {
  return {
    id: 'r1', patient_id: 'p1', reminder_type: 'follow_up_visit', medication_plan_id: null, days_supply: null,
    start_date: '2026-09-01', due_date: '2026-10-20', threshold_days: 7, status: 'active', completed_at: null,
    created_by_user_id: null, created_at: '', updated_at: '', related_entry_id: null, related_lab_result_id: null, visit_department: null,
    ...overrides,
  }
}

async function renderPage() {
  const view = renderHook(() => CareDueRemindersPage({ patientId: 'p1', canManage: true }), { defaultContext: LOCALE })
  await flush()
  view.rerender()
  return view
}

const named = (tree: unknown, name: string) => findAll(tree, element => typeof element.type === 'function' && (element.type as { name?: string }).name === name)
const selectType = (view: ReturnType<typeof renderHook>, value: string) => {
  const select = findAll(view.current, element => element.type === 'select')[0]
  view.act(() => fire(select, 'onChange', { target: { value } }))
}
const departmentInput = (tree: unknown) => findAll(tree, element => element.type === 'input' && element.props.maxLength === 40)[0]
const dueDateInput = (tree: unknown) => findAll(tree, element => element.type === 'input' && element.props.type === 'date')[1]

beforeEach(() => {
  writes.length = 0
  reminderRows = []
})

describe('CareDueRemindersPage clinical links', () => {
  test('a follow-up reminder can link a timeline event and record a department', async () => {
    const view = await renderPage()
    view.act(() => fire(findButton(view.current, '＋ 新增提醒'), 'onClick'))
    await flush()
    selectType(view, 'follow_up_visit')
    view.act(() => fire(dueDateInput(view.current), 'onChange', { target: { value: '2026-10-20' } }))
    view.act(() => fire(departmentInput(view.current), 'onChange', { target: { value: ' 心臟內科 ' } }))
    expect(named(view.current, 'ReminderSourcePicker')).toHaveLength(1)
    view.act(() => fire(named(view.current, 'ReminderSourcePicker')[0], 'onChange', { entryId: 'e1', labResultId: '' }))
    view.act(() => fire(findButton(view.current, '儲存'), 'onClick'))
    await flush()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ table: 'care_due_reminders', method: 'insert' })
    expect(writes[0].payload).toMatchObject({ reminder_type: 'follow_up_visit', related_entry_id: 'e1', related_lab_result_id: null, visit_department: '心臟內科' })
    view.unmount()
  })

  test('a blood-draw reminder can link a lab result instead, and the form cannot hold both links', async () => {
    const view = await renderPage()
    view.act(() => fire(findButton(view.current, '＋ 新增提醒'), 'onClick'))
    await flush()
    selectType(view, 'blood_draw')
    view.act(() => fire(dueDateInput(view.current), 'onChange', { target: { value: '2026-10-20' } }))
    const picker = () => named(view.current, 'ReminderSourcePicker')[0]
    view.act(() => fire(picker(), 'onChange', { entryId: 'e1', labResultId: '' }))
    view.act(() => fire(picker(), 'onChange', { entryId: '', labResultId: 'l1' }))
    expect(picker().props.selection).toEqual({ entryId: '', labResultId: 'l1' })
    view.act(() => fire(findButton(view.current, '儲存'), 'onClick'))
    await flush()
    expect(writes[0].payload).toMatchObject({ reminder_type: 'blood_draw', related_entry_id: null, related_lab_result_id: 'l1', visit_department: null })
    view.unmount()
  })

  test('medication refill reminders show neither the department nor the source picker', async () => {
    const view = await renderPage()
    view.act(() => fire(findButton(view.current, '＋ 新增提醒'), 'onClick'))
    await flush()
    expect(named(view.current, 'ReminderSourcePicker')).toHaveLength(0)
    expect(departmentInput(view.current)).toBeUndefined()
    selectType(view, 'follow_up_visit')
    expect(named(view.current, 'ReminderSourcePicker')).toHaveLength(1)
    expect(departmentInput(view.current)).toBeDefined()
    selectType(view, 'medication_refill')
    expect(named(view.current, 'ReminderSourcePicker')).toHaveLength(0)
    view.unmount()
  })

  test('editing only the due date keeps the existing link and department', async () => {
    reminderRows = [reminder({ related_entry_id: 'e1', visit_department: '心臟內科' })]
    const view = await renderPage()
    const item = named(view.current, 'AttentionItem')[0]
    view.act(() => fire(findButton(item.props.actions, '編輯'), 'onClick'))
    await flush()
    expect(named(view.current, 'ReminderSourcePicker')[0].props.selection).toEqual({ entryId: 'e1', labResultId: '' })
    expect(departmentInput(view.current).props.value).toBe('心臟內科')
    view.act(() => fire(dueDateInput(view.current), 'onChange', { target: { value: '2026-11-01' } }))
    view.act(() => fire(findButton(view.current, '儲存'), 'onClick'))
    await flush()
    expect(writes[0]).toMatchObject({ method: 'update' })
    expect(writes[0].payload).toMatchObject({ due_date: '2026-11-01', related_entry_id: 'e1', related_lab_result_id: null, visit_department: '心臟內科' })
    view.unmount()
  })

  test('the source picker can clear an existing link on edit', async () => {
    reminderRows = [reminder({ related_lab_result_id: 'l1', reminder_type: 'blood_draw' })]
    const view = await renderPage()
    view.act(() => fire(findButton(named(view.current, 'AttentionItem')[0].props.actions, '編輯'), 'onClick'))
    await flush()
    view.act(() => fire(named(view.current, 'ReminderSourcePicker')[0], 'onChange', { entryId: '', labResultId: '' }))
    view.act(() => fire(findButton(view.current, '儲存'), 'onClick'))
    await flush()
    expect(writes[0].payload).toMatchObject({ related_entry_id: null, related_lab_result_id: null })
    view.unmount()
  })

  test('the reminder list shows a linked-source chip and the department', async () => {
    reminderRows = [
      reminder({ id: 'r1', related_entry_id: 'e1', visit_department: '心臟內科' }),
      reminder({ id: 'r2', reminder_type: 'blood_draw', related_lab_result_id: 'l1', due_date: '2026-10-25' }),
      reminder({ id: 'r3', due_date: '2026-10-30' }),
    ]
    const view = await renderPage()
    const items = named(view.current, 'AttentionItem')
    expect(items).toHaveLength(3)
    const chipLabel = (item: (typeof items)[number]) => (item.props.meta as { props?: { label?: string } } | undefined)?.props?.label
    expect(chipLabel(items[0])).toBe('2026-09-10 · 心臟內科 · 回診')
    expect(chipLabel(items[1])).toBe('鉀（K） 2.8 mmol/L · 2026-09-10')
    expect(chipLabel(items[2])).toBeUndefined()
    expect(items[0].props.description).toContain('心臟內科')
    expect(textContent(view.current)).not.toContain('已連結的來源（暫時無法顯示）')
    view.unmount()
  })
})
