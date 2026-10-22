/*
檔案用途：到期提醒表單「連回來源」的資料轉接與顯示文字——列出最近可連結的時間線事件／檢驗值，並依 id 查回
已連結的來源，供選擇器與提醒清單的「連結」標籤使用（照護閉環 T6，issue #956；欄位由 T2 #946 開好）。
所在層：src/lib 共用資料層；隔離 Supabase 查詢細節，標籤組字為純函式以便單元測試。
主要關聯：src/lib/careDueReminders.ts（related_entry_id／related_lab_result_id 的寫入）、
src/features/reminders/hooks/useReminderSources.ts、ReminderSourcePicker／ReminderSourceChip。
*/
import dayjs from 'dayjs'
import { supabase } from './supabase'
import { CARE_DAY_TIMEZONE } from './careDay'
import { LAB_ITEM_META, sampledDateKey } from './labItemMeta'
import type { LocalizedText } from './i18n'
import type { CareTimelineEntry } from './careTimeline'
import type { PatientLabResult } from '../types/database'

export type ReminderSourceEntry = Pick<CareTimelineEntry, 'id' | 'event_type' | 'title' | 'occurred_at' | 'visit_department'>
export type ReminderSourceLab = Pick<PatientLabResult, 'id' | 'item_code' | 'value' | 'unit' | 'sampled_at'>

export interface ReminderSources {
  entries: ReminderSourceEntry[]
  labs: ReminderSourceLab[]
}

// 選擇器預設只露出最近 10 筆（展開後最多 30 筆）：提醒是「下次回診／複驗」的備忘，來源幾乎都是最近的一兩次
// 看診或抽血，列太多只會讓看護在小螢幕上捲不到想要的那筆。
export const REMINDER_SOURCE_VISIBLE_LIMIT = 10
export const REMINDER_SOURCE_FETCH_LIMIT = 30

const ENTRY_COLUMNS = 'id, event_type, title, occurred_at, visit_department'
const LAB_COLUMNS = 'id, item_code, value, unit, sampled_at'

/**
 * 最近可連結的時間線事件與檢驗值（新到舊）。
 * 為什麼排除系統事件：調藥異動事件（medication_change／帶 medication_plan_change_log_id）是用藥系統自動寫的紀錄，
 * 不是照護者會說「這是為了那件事設的提醒」的來源；只列使用者自己記的事件（看診、醫囑、手術等）。
 */
export async function listReminderSourceCandidates(patientId: string, limit = REMINDER_SOURCE_FETCH_LIMIT): Promise<ReminderSources> {
  const [entries, labs] = await Promise.all([
    supabase.from('care_timeline_entries')
      .select(ENTRY_COLUMNS)
      .eq('patient_id', patientId)
      .neq('event_type', 'medication_change')
      .is('medication_plan_change_log_id', null)
      .order('occurred_at', { ascending: false })
      .limit(limit),
    supabase.from('patient_lab_results')
      .select(LAB_COLUMNS)
      .eq('patient_id', patientId)
      .order('sampled_at', { ascending: false })
      .limit(limit),
  ])
  if (entries.error) throw entries.error
  if (labs.error) throw labs.error
  return { entries: (entries.data ?? []) as ReminderSourceEntry[], labs: (labs.data ?? []) as ReminderSourceLab[] }
}

/**
 * 依 id 查回提醒已連結的來源——來源可能早就不在「最近 30 筆」裡，不能只靠候選清單反查。
 * 一律帶 patient_id：複合外鍵已在資料庫層保證同病人，這裡再鎖一次，避免任何殘留 id 跨病人讀到別人的資料。
 */
export async function listLinkedReminderSources(patientId: string, entryIds: string[], labIds: string[]): Promise<ReminderSources> {
  const [entries, labs] = await Promise.all([
    entryIds.length === 0
      ? Promise.resolve({ data: [] as ReminderSourceEntry[], error: null })
      : supabase.from('care_timeline_entries').select(ENTRY_COLUMNS).eq('patient_id', patientId).in('id', entryIds),
    labIds.length === 0
      ? Promise.resolve({ data: [] as ReminderSourceLab[], error: null })
      : supabase.from('patient_lab_results').select(LAB_COLUMNS).eq('patient_id', patientId).in('id', labIds),
  ])
  if (entries.error) throw entries.error
  if (labs.error) throw labs.error
  return { entries: (entries.data ?? []) as ReminderSourceEntry[], labs: (labs.data ?? []) as ReminderSourceLab[] }
}

type Translate = (value: LocalizedText) => string

/** 例如「2026-09-10 · 心臟內科 · 回診」；科別只在有填時出現。日期以照護時區顯示，與時間線其他畫面一致。 */
export function reminderSourceEntryLabel(entry: ReminderSourceEntry): string {
  const date = dayjs(entry.occurred_at).tz(CARE_DAY_TIMEZONE).format('YYYY-MM-DD')
  return [date, entry.visit_department, entry.title].filter(Boolean).join(' · ')
}

/** 例如「鉀（K） 2.8 mmol/L · 2026-09-10」。數值保留資料庫原值，不另外四捨五入或加判讀字樣。 */
export function reminderSourceLabLabel(lab: ReminderSourceLab, text: Translate): string {
  return `${text(LAB_ITEM_META[lab.item_code].label)} ${lab.value} ${lab.unit} · ${sampledDateKey(lab.sampled_at)}`
}

// 選擇器與清單標籤共用：讀不到已連結來源時兩處都要明講「無法顯示」，而不是假裝沒連結。
export const LINKED_SOURCE_UNAVAILABLE: LocalizedText = { id: 'Sumber tertaut (tidak dapat ditampilkan)', zh: '已連結的來源（暫時無法顯示）', en: 'Linked source (cannot be shown right now)' }

/**
 * 提醒清單「連結」標籤的內容；沒有連結回 null。
 * 讀不到已連結的來源（查詢失敗）時不能讓標籤憑空消失——看起來會像連結被清掉了——所以改顯示「暫時無法顯示」；
 * 來源讀成功卻不在結果裡（例如剛被刪，資料庫已把關聯欄位清空）則不顯示。
 */
export function linkedSourceLabel(
  reminder: { related_entry_id: string | null; related_lab_result_id: string | null },
  linked: ReminderSources,
  failed: boolean,
  text: Translate,
): string | null {
  if (reminder.related_entry_id) {
    const entry = linked.entries.find(item => item.id === reminder.related_entry_id)
    if (entry) return reminderSourceEntryLabel(entry)
  } else if (reminder.related_lab_result_id) {
    const lab = linked.labs.find(item => item.id === reminder.related_lab_result_id)
    if (lab) return reminderSourceLabLabel(lab, text)
  } else {
    return null
  }
  return failed ? text(LINKED_SOURCE_UNAVAILABLE) : null
}
