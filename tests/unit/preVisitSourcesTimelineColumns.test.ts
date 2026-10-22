/*
檔案用途：鎖住醫師版報告讀取照護時間線時的 select 欄位清單，確保 S3 的 visit_kind／visit_department／visit_institution
一定有被讀回來（issue #1035：欄位漏讀時真實資料永遠是 undefined，只有 demo 模式看起來正常）。
所在層：tests/unit；以假的 Supabase 查詢鏈記錄實際送出的 select 字串，不連線。
主要關聯：src/lib/preVisitSources.ts 的 readPreVisitSources／TIMELINE_ENTRY_COLUMNS、src/features/vitals/components/TrajectorySection.tsx。
*/
import { afterAll, describe, expect, mock, test } from 'bun:test'

const selects: string[] = []
const row = { id: 'visit-1', visit_kind: 'outpatient', visit_department: '心臟內科', visit_institution: '示範醫院' }
const chain: Record<string, unknown> = {
  select: (columns: string) => { selects.push(columns); return chain },
  eq: () => chain,
  gte: () => chain,
  lte: () => chain,
  order: async () => ({ data: [row], error: null }),
}
mock.module('../../src/lib/supabase', () => ({ supabase: { from: () => chain } }))

// 其餘三個來源在這個假鏈上會失敗並 console.error（預期內，已由各自的 try/catch 轉成 unavailable），靜音避免洗版。
const originalConsoleError = console.error
console.error = () => {}
// 還原：bun test tests/unit 的檔案共用同一個行程，不還原會讓後面檔案看不到診斷輸出（Codex review PR #1040）。
afterAll(() => { console.error = originalConsoleError })

const sources = await import('../../src/lib/preVisitSources')

describe('pre-visit timeline query columns (#1035)', () => {
  test('the timeline select requests all three S3 visit_* columns', () => {
    for (const column of ['visit_kind', 'visit_department', 'visit_institution']) {
      expect(sources.TIMELINE_ENTRY_COLUMNS.split(', ')).toContain(column)
    }
  })

  test('the real query sends that exact column list and returns the visit_* values to the caller', async () => {
    selects.length = 0
    const result = await sources.readPreVisitSources('patient-real', '2026-07-01T00:00:00.000Z', '2026-07-15T00:00:00.000Z')
    expect(selects).toContain(sources.TIMELINE_ENTRY_COLUMNS)
    expect(result.timelineEntries.data[0]).toMatchObject({ visit_kind: 'outpatient', visit_department: '心臟內科', visit_institution: '示範醫院' })
  })
})
