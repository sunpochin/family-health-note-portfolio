/*
檔案用途：到期提醒表單的「連回來源」選擇器——用單一下拉選單二選一（時間線事件或檢驗值）或不連結，並附「顯示更多」。
所在層：src/features/reminders/components；純受控元件，不讀資料、不知道提醒型別（由呼叫端決定要不要渲染）。
主要關聯：CareDueRemindersPage（表單狀態）、useReminderSources（候選與已連結來源）、src/lib/reminderSources.ts（標籤組字）。
*/
import { useState } from 'react'
import { common, useI18n, type LocalizedText } from '../../../lib/i18n'
import {
  LINKED_SOURCE_UNAVAILABLE,
  REMINDER_SOURCE_VISIBLE_LIMIT,
  reminderSourceEntryLabel,
  reminderSourceLabLabel,
  type ReminderSources,
} from '../../../lib/reminderSources'

export interface ReminderSourceSelection { entryId: string; labResultId: string }

// 為什麼用單一 <select> 而不是兩個欄位：互斥由結構保證（一次只能有一個值），不必靠事後檢查；
// 「不連結」選項就是清除，也不用另外做清除按鈕。
const NONE_VALUE = ''
const ENTRY_PREFIX = 'entry:'
const LAB_PREFIX = 'lab:'

const COPY = {
  label: { id: 'Tautkan ke', zh: '連回來源', en: 'Linked source' },
  hint: { id: 'Pilih salah satu: kejadian di linimasa atau hasil lab.', zh: '二選一：時間線事件或檢驗值。', en: 'Pick one: a timeline event or a lab result.' },
  none: { id: 'Tidak ditautkan', zh: '不連結', en: 'No link' },
  entries: { id: 'Kejadian di linimasa', zh: '時間線事件', en: 'Timeline events' },
  labs: { id: 'Hasil lab', zh: '檢驗值', en: 'Lab results' },
  empty: { id: 'Belum ada kejadian atau hasil lab yang bisa ditautkan.', zh: '目前沒有可連結的時間線事件或檢驗值。', en: 'No timeline events or lab results to link yet.' },
  failed: { id: 'Daftar sumber tidak dapat dimuat. Pengingat tetap bisa disimpan tanpa tautan baru.', zh: '來源清單讀取失敗，仍可儲存，只是無法新增連結。', en: 'The source list could not be loaded. You can still save, but cannot add a new link.' },
  showMore: { id: 'Tampilkan lebih banyak', zh: '顯示更多', en: 'Show more' },
} satisfies Record<string, LocalizedText>

export function ReminderSourcePicker({ candidates, linked, selection, loading, failed, onChange }: {
  candidates: ReminderSources
  // 已連結的來源可能早已不在最近 30 筆候選裡，另外帶進來才能在下拉選單裡顯示目前的選擇。
  linked: ReminderSources
  selection: ReminderSourceSelection
  loading: boolean
  failed: boolean
  onChange: (next: ReminderSourceSelection) => void
}) {
  const { text } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const limit = expanded ? candidates.entries.length + candidates.labs.length : REMINDER_SOURCE_VISIBLE_LIMIT

  // 目前選到的那筆一定要出現在選項裡，即使它不在前 10 筆：否則下拉選單會顯示成「不連結」，
  // 看護以為連結被清掉了，這是畫面誤導資料狀態。
  const entries = candidates.entries.slice(0, limit)
  const selectedEntry = [...candidates.entries, ...linked.entries].find(item => item.id === selection.entryId)
  if (selectedEntry && !entries.some(item => item.id === selectedEntry.id)) entries.unshift(selectedEntry)
  const labs = candidates.labs.slice(0, limit)
  const selectedLab = [...candidates.labs, ...linked.labs].find(item => item.id === selection.labResultId)
  if (selectedLab && !labs.some(item => item.id === selectedLab.id)) labs.unshift(selectedLab)

  const value = selection.entryId ? `${ENTRY_PREFIX}${selection.entryId}` : selection.labResultId ? `${LAB_PREFIX}${selection.labResultId}` : NONE_VALUE
  const selectedButUnresolved = (selection.entryId && !selectedEntry) || (selection.labResultId && !selectedLab)
  const hasMore = !expanded && (candidates.entries.length > REMINDER_SOURCE_VISIBLE_LIMIT || candidates.labs.length > REMINDER_SOURCE_VISIBLE_LIMIT)
  const nothingToLink = !loading && !failed && entries.length === 0 && labs.length === 0 && !selectedButUnresolved

  const handleChange = (next: string) => {
    if (next.startsWith(ENTRY_PREFIX)) onChange({ entryId: next.slice(ENTRY_PREFIX.length), labResultId: '' })
    else if (next.startsWith(LAB_PREFIX)) onChange({ entryId: '', labResultId: next.slice(LAB_PREFIX.length) })
    else onChange({ entryId: '', labResultId: '' })
  }

  return (
    <div className="block">
      <label className="block">
        <span className="mb-1 block text-sm font-bold text-slate-800">{text(COPY.label)}</span>
        <select
          value={value}
          disabled={loading}
          onChange={event => handleChange(event.target.value)}
          className="min-h-11 w-full rounded-xl border-2 border-control-border bg-white px-3 text-base font-semibold text-slate-900 disabled:opacity-60"
        >
          <option value={NONE_VALUE}>{loading ? text(common.loading) : text(COPY.none)}</option>
          {selectedButUnresolved && <option value={value}>{text(LINKED_SOURCE_UNAVAILABLE)}</option>}
          {entries.length > 0 && <optgroup label={text(COPY.entries)}>
            {entries.map(entry => <option key={entry.id} value={`${ENTRY_PREFIX}${entry.id}`}>{reminderSourceEntryLabel(entry)}</option>)}
          </optgroup>}
          {labs.length > 0 && <optgroup label={text(COPY.labs)}>
            {labs.map(lab => <option key={lab.id} value={`${LAB_PREFIX}${lab.id}`}>{reminderSourceLabLabel(lab, text)}</option>)}
          </optgroup>}
        </select>
      </label>
      <span className="mt-1 block text-xs font-semibold text-slate-600">{text(COPY.hint)}</span>
      {failed && <span role="alert" className="mt-1 block text-xs font-semibold text-red-700">{text(COPY.failed)}</span>}
      {nothingToLink && <span className="mt-1 block text-xs font-semibold text-slate-600">{text(COPY.empty)}</span>}
      {/* 文字連結也是可點控制，高度同樣要 44px（#1198）。 */}
      {hasMore && <button type="button" onClick={() => setExpanded(true)} className="mt-1 min-h-11 text-sm font-bold text-brand-700 underline decoration-brand-200 underline-offset-4">{text(COPY.showMore)}</button>}
    </div>
  )
}
