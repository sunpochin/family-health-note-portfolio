/*
檔案用途：白名單檢驗值（K／NA／CR／EGFR／HBA1C／GLU／HB）的 Supabase 讀寫資料轉接層。
所在層：src/lib 共用資料層；隔離 Supabase RLS 細節，供 LabResultsPage 與 preVisitBrief 的 R5 規則使用。
中繼資料（LAB_ITEM_META 等）已拆到 labItemMeta.ts（純函式，不 import supabase），本檔 re-export
以維持既有呼叫端的 import 路徑不變。
主要關聯：patient_lab_results migration、src/lib/labItemMeta.ts、src/lib/preVisitBrief.ts（R5）、LabResultsPage。
*/
import { supabase } from './supabase'
import type { LabItemCode, LabResultSource, PatientLabResult } from '../types/database'
import { LAB_ITEM_META } from './labItemMeta'

export type { LabItemCode, LabResultSource, PatientLabResult } from '../types/database'
export type { LabRangeStatus } from './labItemMeta'
export { LAB_ITEM_META, LAB_ITEM_CODES, labRangeStatus, sampledAtFromDateKey, sampledDateKey } from './labItemMeta'

export interface CreateLabResultInput {
  patientId: string
  itemCode: LabItemCode
  value: number
  sampledAt: string
  referenceLow?: number | null
  referenceHigh?: number | null
  institution?: string | null
  notes?: string | null
}

// source／source_fingerprint 刻意不開放呼叫端傳入：手動輸入路徑只能是 'manual' + null，
// 這裡在應用層再鎖一次，跟資料庫 RLS 的 WITH CHECK 互為雙重保險，不是取代它。
function toRow(input: CreateLabResultInput) {
  return {
    patient_id: input.patientId,
    item_code: input.itemCode,
    value: input.value,
    unit: LAB_ITEM_META[input.itemCode].unit,
    reference_low: input.referenceLow ?? null,
    reference_high: input.referenceHigh ?? null,
    sampled_at: input.sampledAt,
    institution: input.institution ?? null,
    notes: input.notes ?? null,
    source: 'manual' as const satisfies LabResultSource,
  }
}

export async function listLabResults(patientId: string): Promise<PatientLabResult[]> {
  const { data, error } = await supabase
    .from('patient_lab_results')
    .select('*')
    .eq('patient_id', patientId)
    .order('sampled_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as PatientLabResult[]
}

// R5 規則只需要落在報告視窗內的檢驗值；獨立於 listLabResults（畫面清單一律顯示全部歷史）。
export async function listLabResultsInRange(patientId: string, sinceIso: string, untilIso: string): Promise<PatientLabResult[]> {
  const { data, error } = await supabase
    .from('patient_lab_results')
    .select('*')
    .eq('patient_id', patientId)
    .gte('sampled_at', sinceIso)
    .lte('sampled_at', untilIso)
    .order('sampled_at', { ascending: true })
  if (error) throw error
  return (data ?? []) as PatientLabResult[]
}

// recorded_by 只在新增時送：資料庫 INSERT policy 要求它等於登入 email、欄位 NOT NULL 又沒有預設值，
// 漏送就是每一筆都被擋（issue #1034）。刻意不放進 toRow()：UPDATE 由觸發器鎖住 recorded_by 不可改，
// 編輯時根本不該碰這個欄位。recorded_by 只代表「誰操作」，數值歸屬一律看 patient_id（AGENTS.md § 3.5）。
export async function createLabResult(input: CreateLabResultInput, recordedByEmail: string): Promise<PatientLabResult> {
  const recordedBy = recordedByEmail.trim().toLowerCase()
  // 沒有登入 email 時在送出前就失敗，而不是讓 RLS 回一個看不出原因的拒絕。
  if (!recordedBy) throw new Error('lab_result_missing_recorder')
  const { data, error } = await supabase
    .from('patient_lab_results')
    .insert({ ...toRow(input), recorded_by: recordedBy })
    .select('*')
    .single()
  if (error) throw error
  return data as PatientLabResult
}

// UPDATE policy 的 WITH CHECK 要求 recorded_by 等於目前登入者，而 recorded_by 不可改，
// 所以只有原登錄者能編輯；其他照護者的 UPDATE 會通過 USING 選到該列，但新列過不了 WITH CHECK，
// 資料庫回 42501（不是「影響 0 列」）。這裡跟資料庫用同一條規則（不分大小寫），
// 讓畫面不要給別人一個注定失敗的「編輯」按鈕。這不是授權本身，授權仍由 RLS 決定。
export function canEditLabResult(result: Pick<PatientLabResult, 'recorded_by'>, userEmail: string | null | undefined): boolean {
  const email = userEmail?.trim().toLowerCase()
  return Boolean(email) && result.recorded_by.trim().toLowerCase() === email
}

// 編輯失敗時「這筆改不了」的兩條實際路徑：
// - 42501：非原登錄者，UPDATE 的 WITH CHECK 拒絕新列（recorded_by 不可改）。
// - PGRST116：`.single()` 收到 0 列，代表這筆已被刪除，或 USING 本身不通過（沒有 can_record）。
// 兩者共用同一則「只有登錄者能編輯，或已被刪除」的訊息。
export function isLabResultNotEditableError(error: unknown): boolean {
  const code = (error as { code?: string } | null | undefined)?.code
  return code === '42501' || code === 'PGRST116'
}

export async function updateLabResult(id: string, input: CreateLabResultInput): Promise<PatientLabResult> {
  const { data, error } = await supabase
    .from('patient_lab_results')
    .update(toRow(input))
    .eq('id', id)
    .eq('patient_id', input.patientId)
    .select('*')
    .single()
  if (error) throw error
  return data as PatientLabResult
}

export async function deleteLabResult(id: string): Promise<void> {
  const { error } = await supabase.from('patient_lab_results').delete().eq('id', id)
  if (error) throw error
}
