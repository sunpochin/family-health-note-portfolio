/*
檔案用途：驗證到期提醒「連回來源」的查詢條件（病人隔離、排除系統調藥事件、筆數上限）與標籤組字（科別、三語、
讀取失敗時的退路），照護閉環 T6（issue #956）。
所在層：tests/unit；以可追蹤的 Supabase chain mock 檢查查詢，其餘為純函式。
主要關聯：src/lib/reminderSources.ts、useReminderSources、ReminderSourcePicker。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Call = { table: string; method: string; args: unknown[] }
const calls: Call[] = []
let results: Record<string, { data: unknown; error: unknown }> = {}

const supabase = {
  from(table: string) {
    calls.push({ table, method: 'from', args: [table] })
    const chain: Record<string, unknown> = {}
    for (const method of ['select', 'eq', 'neq', 'is', 'in', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => { calls.push({ table, method, args }); return chain }
    }
    // chain 本身可 await，與正式 Supabase query builder 的契約一致。
    chain.then = (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(onFulfilled, onRejected)
    return chain
  },
}

mock.module('../../src/lib/supabase', () => ({ supabase }))

const {
  linkedSourceLabel,
  listLinkedReminderSources,
  listReminderSourceCandidates,
  reminderSourceEntryLabel,
  reminderSourceLabLabel,
} = await import('../../src/lib/reminderSources')

const zh = (value: { zh: string }) => value.zh
const id = (value: { id: string }) => value.id

const visit = { id: 'e1', event_type: 'health_visit' as const, title: '回診', occurred_at: '2026-09-10T02:00:00.000Z', visit_department: '心臟內科' }
const note = { id: 'e2', event_type: 'doctor_instruction' as const, title: '醫囑：少鹽', occurred_at: '2026-09-11T02:00:00.000Z', visit_department: null }
const potassium = { id: 'l1', item_code: 'K' as const, value: 2.8, unit: 'mmol/L', sampled_at: '2026-09-10T02:00:00.000Z' }

beforeEach(() => {
  calls.length = 0
  results = {}
})

describe('reminder source queries', () => {
  test('candidates are scoped to the patient, newest first, and skip system medication-change events', async () => {
    results = {
      care_timeline_entries: { data: [visit], error: null },
      patient_lab_results: { data: [potassium], error: null },
    }
    await expect(listReminderSourceCandidates('p1', 30)).resolves.toEqual({ entries: [visit], labs: [potassium] })
    const timeline = calls.filter(call => call.table === 'care_timeline_entries')
    expect(timeline).toContainEqual({ table: 'care_timeline_entries', method: 'eq', args: ['patient_id', 'p1'] })
    expect(timeline).toContainEqual({ table: 'care_timeline_entries', method: 'neq', args: ['event_type', 'medication_change'] })
    expect(timeline).toContainEqual({ table: 'care_timeline_entries', method: 'is', args: ['medication_plan_change_log_id', null] })
    expect(timeline).toContainEqual({ table: 'care_timeline_entries', method: 'order', args: ['occurred_at', { ascending: false }] })
    expect(timeline).toContainEqual({ table: 'care_timeline_entries', method: 'limit', args: [30] })
    const labs = calls.filter(call => call.table === 'patient_lab_results')
    expect(labs).toContainEqual({ table: 'patient_lab_results', method: 'eq', args: ['patient_id', 'p1'] })
    expect(labs).toContainEqual({ table: 'patient_lab_results', method: 'order', args: ['sampled_at', { ascending: false }] })
  })

  test('candidate read failures reject so the form can say the list is unavailable', async () => {
    results = { patient_lab_results: { data: null, error: new Error('boom') } }
    await expect(listReminderSourceCandidates('p1')).rejects.toThrow('boom')
  })

  test('linked lookup filters by id and patient, and skips a table with no ids', async () => {
    results = { care_timeline_entries: { data: [visit], error: null } }
    await expect(listLinkedReminderSources('p1', ['e1'], [])).resolves.toEqual({ entries: [visit], labs: [] })
    expect(calls.some(call => call.table === 'patient_lab_results')).toBe(false)
    expect(calls).toContainEqual({ table: 'care_timeline_entries', method: 'eq', args: ['patient_id', 'p1'] })
    expect(calls).toContainEqual({ table: 'care_timeline_entries', method: 'in', args: ['id', ['e1']] })
  })

  test('linked lookup with nothing linked makes no request at all', async () => {
    await expect(listLinkedReminderSources('p1', [], [])).resolves.toEqual({ entries: [], labs: [] })
    expect(calls).toEqual([])
  })
})

describe('reminder source labels', () => {
  test('entry label shows date, optional department and title in the care timezone', () => {
    expect(reminderSourceEntryLabel(visit)).toBe('2026-09-10 · 心臟內科 · 回診')
    expect(reminderSourceEntryLabel(note)).toBe('2026-09-11 · 醫囑：少鹽')
  })

  test('lab label shows the localized item, stored value, unit and sample date', () => {
    expect(reminderSourceLabLabel(potassium, zh)).toBe('鉀（K） 2.8 mmol/L · 2026-09-10')
    expect(reminderSourceLabLabel(potassium, id)).toBe('Kalium (K) 2.8 mmol/L · 2026-09-10')
  })
})

describe('linkedSourceLabel', () => {
  const linked = { entries: [visit], labs: [potassium] }

  test('resolves an entry link, a lab link, and no link', () => {
    expect(linkedSourceLabel({ related_entry_id: 'e1', related_lab_result_id: null }, linked, false, zh)).toBe('2026-09-10 · 心臟內科 · 回診')
    expect(linkedSourceLabel({ related_entry_id: null, related_lab_result_id: 'l1' }, linked, false, zh)).toBe('鉀（K） 2.8 mmol/L · 2026-09-10')
    expect(linkedSourceLabel({ related_entry_id: null, related_lab_result_id: null }, linked, false, zh)).toBeNull()
  })

  test('a failed lookup says the source cannot be shown instead of silently dropping the link', () => {
    expect(linkedSourceLabel({ related_entry_id: 'gone', related_lab_result_id: null }, { entries: [], labs: [] }, true, zh)).toBe('已連結的來源（暫時無法顯示）')
  })

  test('a successful lookup that no longer finds the source shows nothing', () => {
    expect(linkedSourceLabel({ related_entry_id: 'gone', related_lab_result_id: null }, { entries: [], labs: [] }, false, zh)).toBeNull()
  })
})
