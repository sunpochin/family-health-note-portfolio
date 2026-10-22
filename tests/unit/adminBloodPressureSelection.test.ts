/*
檔案用途：驗證後台血壓總表「刪錯人」防線的純函式：依對象篩選、勾選彙總、確認訊息必須點名對象與筆數。
所在層：tests/unit；不啟動畫面，直接測 adminBloodPressureSelection.ts。
主要關聯：src/features/system-admin/adminBloodPressureSelection.ts、hooks/useAdminBloodPressureRecords.ts。
*/
import { describe, expect, test } from 'bun:test'
import type { LocalizedText } from '../../src/lib/i18n'
import {
  type AdminBloodPressureRecord,
  buildBulkDeleteConfirmMessage,
  buildSingleDeleteConfirmMessage,
  patientFilterOptions,
  patientLabelsById,
  summarizeSelectionByPatient,
  visibleRecords,
} from '../../src/features/system-admin/adminBloodPressureSelection'

const zh = (value: LocalizedText) => value.zh
const id = (value: LocalizedText) => value.id
const en = (value: LocalizedText) => value.en

// 假資料：三位對象、對象名稱用假名，不用真實家人（AGENTS.md § 3.3）。
function record(overrides: Partial<AdminBloodPressureRecord> & { id: string; patient_id: string; name?: string | null }): AdminBloodPressureRecord {
  const { name = '對象', ...rest } = overrides
  return {
    systolic: 120,
    diastolic: 80,
    pulse: 70,
    measured_at: '2026-10-09T01:00:00Z',
    patients: name === null ? null : { display_name: name },
    ...rest,
  }
}

const RECORDS: AdminBloodPressureRecord[] = [
  record({ id: 'a1', patient_id: 'pa', name: '阿嬤' }),
  record({ id: 'b1', patient_id: 'pb', name: '測試甲' }),
  record({ id: 'b2', patient_id: 'pb', name: '測試甲' }),
  record({ id: 'b3', patient_id: 'pb', name: '測試甲' }),
  record({ id: 'c1', patient_id: 'pc', name: '測試乙' }),
  record({ id: 'c2', patient_id: 'pc', name: '測試乙' }),
]

describe('patientFilterOptions', () => {
  test('每位對象一顆篩選鈕，筆數多的在前，同筆數依名稱', () => {
    const options = patientFilterOptions(RECORDS, zh)
    expect(options.map(o => [o.patientId, o.name, o.count])).toEqual([
      ['pb', '測試甲', 3],
      ['pc', '測試乙', 2],
      ['pa', '阿嬤', 1],
    ])
  })

  test('患者關聯為陣列或缺名時仍能分組，缺名用三語的「未命名對象」', () => {
    const options = patientFilterOptions([
      record({ id: 'x1', patient_id: 'px', patients: [{ display_name: '  陣列名  ' }] }),
      record({ id: 'y1', patient_id: 'py', name: null }),
      record({ id: 'y2', patient_id: 'py', name: '   ' }),
    ], en)
    expect(options.map(o => [o.name, o.count])).toEqual([['Unnamed care recipient', 2], ['陣列名', 1]])
  })
})

describe('patientLabelsById（同名對象加辨識碼）', () => {
  const twoMoms = [
    record({ id: 'm1', patient_id: '11111111-1111-1111-1111-aaaaaa111111', name: '媽媽' }),
    record({ id: 'm2', patient_id: '22222222-2222-2222-2222-bbbbbb222222', name: '媽媽' }),
    record({ id: 'k1', patient_id: '33333333-3333-3333-3333-cccccc333333', name: '小乖' }),
  ]

  test('不同家庭的同名對象各自帶 patient_id 末 6 碼，沒撞名的維持原樣', () => {
    const labels = patientLabelsById(twoMoms, zh)
    expect(labels.get('11111111-1111-1111-1111-aaaaaa111111')).toBe('媽媽 #111111')
    expect(labels.get('22222222-2222-2222-2222-bbbbbb222222')).toBe('媽媽 #222222')
    expect(labels.get('33333333-3333-3333-3333-cccccc333333')).toBe('小乖')
  })

  test('篩選列、勾選摘要與確認訊息用同一套帶辨識碼的標籤', () => {
    expect(patientFilterOptions(twoMoms, zh).map(o => o.name)).toEqual(['媽媽 #111111', '媽媽 #222222', '小乖'])
    const summary = summarizeSelectionByPatient(twoMoms, ['m1', 'm2'], zh)
    expect(buildBulkDeleteConfirmMessage(summary, 2, zh)).toBe('這 2 筆紀錄分屬 2 位對象：媽媽 #111111 1, 媽媽 #222222 1。確定全部刪除嗎？')
  })
})

describe('visibleRecords', () => {
  test("'all' 回傳全部，指定 patient_id 只留該對象", () => {
    expect(visibleRecords(RECORDS, 'all')).toHaveLength(6)
    expect(visibleRecords(RECORDS, 'pc').map(r => r.id)).toEqual(['c1', 'c2'])
    expect(visibleRecords(RECORDS, 'nobody')).toEqual([])
  })
})

describe('summarizeSelectionByPatient', () => {
  test('依對象彙總勾選筆數，不計入已不存在的 id', () => {
    const summary = summarizeSelectionByPatient(RECORDS, ['b1', 'c1', 'b2', 'gone'], zh)
    expect(summary.map(s => [s.patientId, s.name, s.count])).toEqual([
      ['pb', '測試甲', 2],
      ['pc', '測試乙', 1],
    ])
  })

  test('沒有勾選時回傳空陣列', () => {
    expect(summarizeSelectionByPatient(RECORDS, [], zh)).toEqual([])
  })
})

describe('buildSingleDeleteConfirmMessage', () => {
  const target = record({ id: 'a1', patient_id: 'pa', name: '阿嬤', systolic: 106, diastolic: 52, pulse: 69 })

  test('三語都點名對象、時間與數值', () => {
    expect(buildSingleDeleteConfirmMessage(target, '阿嬤', '2026-10-09 06:58', zh)).toBe('確定要刪除「阿嬤」2026-10-09 06:58 的血壓紀錄（106/52 mmHg, 69 bpm）嗎？')
    expect(buildSingleDeleteConfirmMessage(target, '阿嬤', '2026-10-09 06:58', id)).toContain('"阿嬤" pada 2026-10-09 06:58 (106/52 mmHg, 69 bpm)')
    expect(buildSingleDeleteConfirmMessage(target, '阿嬤', '2026-10-09 06:58', en)).toContain('for "阿嬤" at 2026-10-09 06:58 (106/52 mmHg, 69 bpm)')
  })

  test('沒有脈搏時不顯示 bpm', () => {
    expect(buildSingleDeleteConfirmMessage({ ...target, pulse: null }, '阿嬤', '2026-10-09 06:58', zh)).toContain('（106/52 mmHg）')
  })
})

describe('buildBulkDeleteConfirmMessage', () => {
  test('單一對象時點名那位對象與筆數', () => {
    const message = buildBulkDeleteConfirmMessage([{ patientId: 'pb', name: '測試甲', count: 3 }], 3, zh)
    expect(message).toBe('確定要刪除「測試甲」的 3 筆血壓紀錄嗎？')
  })

  test('橫跨多位對象時逐位列出，讓夾帶到別人的紀錄在確認前就看得到', () => {
    const summary = [
      { patientId: 'pb', name: '測試甲', count: 2 },
      { patientId: 'pa', name: '阿嬤', count: 1 },
    ]
    expect(buildBulkDeleteConfirmMessage(summary, 3, zh)).toBe('這 3 筆紀錄分屬 2 位對象：測試甲 2, 阿嬤 1。確定全部刪除嗎？')
    expect(buildBulkDeleteConfirmMessage(summary, 3, id)).toContain('2 penerima perawatan: 測試甲 2, 阿嬤 1')
    expect(buildBulkDeleteConfirmMessage(summary, 3, en)).toContain('2 care recipients: 測試甲 2, 阿嬤 1')
  })

  test('彙總為空時退回只報總數，確認流程不會壞掉', () => {
    expect(buildBulkDeleteConfirmMessage([], 4, zh)).toBe('確定要刪除這 4 筆紀錄嗎？')
  })
})
