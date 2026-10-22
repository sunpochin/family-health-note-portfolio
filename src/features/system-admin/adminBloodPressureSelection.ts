/*
檔案用途：後台「血壓總表」刪除流程的純函式：依對象篩選、把勾選的紀錄依對象彙總、產生會點名對象的確認訊息。
所在層：src/features/system-admin；純資料邏輯，不碰 React 與 Supabase，讓單元測試不必啟動畫面就能驗證「刪錯人」的防線。
主要關聯：被 hooks/useAdminBloodPressureRecords.ts 與 components/AdminBloodPressurePanel.tsx 使用；型別對應 blood_pressure_records 連同 patients(display_name) 的查詢結果。
*/
import type { LocalizedText } from '../../lib/i18n'

export type AdminBloodPressureRecord = {
  id: string
  systolic: number
  diastolic: number
  pulse: number | null
  measured_at: string
  patient_id: string
  patients: { display_name: string } | { display_name: string }[] | null
}

/** 篩選值：'all' 顯示所有對象，否則是某個 patient_id。 */
export type AdminPatientFilter = 'all' | string

export type PatientFilterOption = {
  patientId: string
  name: string
  count: number
}

export type PatientSelectionSummary = {
  patientId: string
  name: string
  count: number
}

type Translate = (value: LocalizedText) => string

// 關聯資料可能是物件或陣列；只使用病人欄位，絕不能從紀錄者（recorded_by）猜病人身分（AGENTS.md § 3.5）。
export function patientNameOf(record: AdminBloodPressureRecord, text: Translate): string {
  const patient = Array.isArray(record.patients) ? record.patients[0] : record.patients
  return patient?.display_name?.trim() || text({ id: 'Penerima perawatan tanpa nama', zh: '未命名對象', en: 'Unnamed care recipient' })
}

/**
 * 每個 patient_id 在這個畫面上的顯示標籤。這張總表橫跨所有家庭，不同家庭的長輩很可能同名（兩個「媽媽」），
 * 名字撞到時 chip、列、已選摘要與確認框會長得一模一樣，管理者仍可能選錯人整批刪掉（Codex review on #1254 P1）。
 * 所以同名時在每個顯示名字的地方都加上 patient_id 末 6 碼當辨識碼；沒撞名維持原樣，不多噪音。
 * 辨識碼只在管理者後台出現，不是個資，也不會流到任何通知或分享畫面。
 */
export function patientLabelsById(records: AdminBloodPressureRecord[], text: Translate): Map<string, string> {
  const nameById = new Map<string, string>()
  for (const record of records) {
    if (!nameById.has(record.patient_id)) nameById.set(record.patient_id, patientNameOf(record, text))
  }
  const idsByName = new Map<string, number>()
  for (const name of nameById.values()) idsByName.set(name, (idsByName.get(name) ?? 0) + 1)
  const labels = new Map<string, string>()
  for (const [patientId, name] of nameById) {
    labels.set(patientId, (idsByName.get(name) ?? 0) > 1 ? `${name} #${patientId.slice(-6)}` : name)
  }
  return labels
}

/**
 * 從目前載入的紀錄推出篩選列的對象清單（含各自筆數）。
 * 為什麼不另外查 patients 表：後台總表只拿最新 100 筆，篩選列只需要「這 100 筆裡出現過的對象」；
 * 另查一次全站病人會多一支跨家庭查詢，而且會列出根本沒有紀錄可刪的對象，讓管理者空按。
 * 排序：筆數多的在前（通常就是要清的測試資料），同筆數再依名稱，讓順序在重新載入後穩定。
 */
export function patientFilterOptions(records: AdminBloodPressureRecord[], text: Translate): PatientFilterOption[] {
  const labels = patientLabelsById(records, text)
  const byPatient = new Map<string, PatientFilterOption>()
  for (const record of records) {
    const existing = byPatient.get(record.patient_id)
    if (existing) existing.count += 1
    else byPatient.set(record.patient_id, { patientId: record.patient_id, name: labels.get(record.patient_id) ?? patientNameOf(record, text), count: 1 })
  }
  return [...byPatient.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

export function visibleRecords(records: AdminBloodPressureRecord[], filter: AdminPatientFilter): AdminBloodPressureRecord[] {
  return filter === 'all' ? records : records.filter(record => record.patient_id === filter)
}

/**
 * 把勾選中的紀錄依對象彙總：回傳每位對象的名稱與筆數，供批次工具列的「已選 N 筆：媽媽 2、demo-xq7 1」
 * 與批次刪除確認訊息使用。只看 selectedIds 裡「目前 records 還找得到」的紀錄；
 * 已被刪掉或篩選後不存在的 id 不計入，避免確認訊息的筆數和實際會送出的筆數對不上。
 */
export function summarizeSelectionByPatient(
  records: AdminBloodPressureRecord[],
  selectedIds: readonly string[],
  text: Translate,
): PatientSelectionSummary[] {
  // 以 records 為準掃一次（而不是以 selectedIds 為準），自然略過已不存在的 id；
  // 排序與 patientFilterOptions 一致（筆數多的在前、同筆數依名稱），確認訊息逐字呈現這個順序，重繪後不會跳動。
  // 標籤用整份 records 算（不是只用勾選的那些）：同名辨識碼要和篩選列、列上看到的一致。
  const labels = patientLabelsById(records, text)
  const selected = new Set(selectedIds)
  const byPatient = new Map<string, PatientSelectionSummary>()
  for (const record of records) {
    if (!selected.has(record.id)) continue
    const existing = byPatient.get(record.patient_id)
    if (existing) existing.count += 1
    else byPatient.set(record.patient_id, { patientId: record.patient_id, name: labels.get(record.patient_id) ?? patientNameOf(record, text), count: 1 })
  }
  return [...byPatient.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

function formatReading(record: AdminBloodPressureRecord): string {
  const base = `${record.systolic}/${record.diastolic} mmHg`
  return record.pulse === null ? base : `${base}, ${record.pulse} bpm`
}

/**
 * 單筆刪除的第一層確認：點名對象、時間與數值。管理者「刪錯人」最常發生在手指滑到相鄰那列，
 * 原本的「確定要刪除這筆紀錄嗎？」什麼都沒說，按下去才發現是媽媽不是測試帳號。
 */
export function buildSingleDeleteConfirmMessage(
  record: AdminBloodPressureRecord,
  // 呼叫端傳 patientLabelsById 算出的標籤（同名時含辨識碼），確認框和列上看到的字一致。
  patientLabel: string,
  measuredAtLabel: string,
  text: Translate,
): string {
  const name = patientLabel
  const reading = formatReading(record)
  return text({
    id: `Hapus catatan tekanan darah "${name}" pada ${measuredAtLabel} (${reading})?`,
    zh: `確定要刪除「${name}」${measuredAtLabel} 的血壓紀錄（${reading}）嗎？`,
    en: `Delete the blood pressure record for "${name}" at ${measuredAtLabel} (${reading})?`,
  })
}

/**
 * 批次刪除的第一層確認。只有一位對象時點名那位對象；橫跨多位對象時逐位列出筆數，
 * 讓「全選」之後夾帶到別人紀錄的情況在按下確定前就看得到，而不是只看到一個總數。
 * summary 為空（勾選的 id 全都已不在清單上）時退回只報總數，不讓確認流程壞掉。
 */
export function buildBulkDeleteConfirmMessage(
  summary: PatientSelectionSummary[],
  totalCount: number,
  text: Translate,
): string {
  if (summary.length === 1) {
    const [only] = summary
    return text({
      id: `Yakin ingin menghapus ${only.count} catatan tekanan darah milik "${only.name}"?`,
      zh: `確定要刪除「${only.name}」的 ${only.count} 筆血壓紀錄嗎？`,
      en: `Delete ${only.count} blood pressure records belonging to "${only.name}"?`,
    })
  }
  if (summary.length > 1) {
    const breakdown = summary.map(item => `${item.name} ${item.count}`).join(', ')
    return text({
      id: `${totalCount} catatan ini milik ${summary.length} penerima perawatan: ${breakdown}. Yakin ingin menghapus semuanya?`,
      zh: `這 ${totalCount} 筆紀錄分屬 ${summary.length} 位對象：${breakdown}。確定全部刪除嗎？`,
      en: `These ${totalCount} records belong to ${summary.length} care recipients: ${breakdown}. Delete all of them?`,
    })
  }
  return text({
    id: `Yakin ingin menghapus ${totalCount} catatan ini?`,
    zh: `確定要刪除這 ${totalCount} 筆紀錄嗎？`,
    en: `Are you sure you want to delete these ${totalCount} records?`,
  })
}
