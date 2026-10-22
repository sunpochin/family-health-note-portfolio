/*
檔案用途：到期提醒頁的「連回來源」讀取 hook——表單開啟時載入最近的時間線事件／檢驗值候選，並依提醒已連結的 id
查回標籤用的來源（照護閉環 T6，issue #956）。
所在層：src/features/reminders/hooks；只管讀取與病人隔離，不管表單狀態與畫面。
主要關聯：src/lib/reminderSources.ts（查詢與標籤）、CareDueRemindersPage（呼叫端）、ReminderSourcePicker／ReminderSourceChip。
*/
import { useEffect, useMemo, useState } from 'react'
import type { CareDueReminder } from '../../../lib/careDueReminders'
import {
  listLinkedReminderSources,
  listReminderSourceCandidates,
  type ReminderSources,
} from '../../../lib/reminderSources'

const EMPTY_SOURCES: ReminderSources = { entries: [], labs: [] }

// 每份讀取結果都帶 patientId：切換病人後、新資料還沒回來的那一瞬間，不能拿上一位病人的來源渲染（AGENTS.md § 3.5）。
type Loaded = { patientId: string; data: ReminderSources }

export function useReminderSources({ patientId, reminders, formOpen, enabled }: {
  patientId: string
  reminders: CareDueReminder[]
  formOpen: boolean
  enabled: boolean
}) {
  const [candidates, setCandidates] = useState<Loaded | null>(null)
  const [candidatesFailed, setCandidatesFailed] = useState(false)
  const [linked, setLinked] = useState<Loaded | null>(null)
  const [linkedFailed, setLinkedFailed] = useState(false)

  // 只有在表單開著（而且不是展示病人）才讀候選：多數時候看護只是在看清單，不該為此多打兩個查詢；
  // 每次重新開表單都重讀，才看得到剛剛才記下的看診或檢驗值。
  useEffect(() => {
    setCandidates(null)
    setCandidatesFailed(false)
    if (!enabled || !formOpen) return
    let cancelled = false
    listReminderSourceCandidates(patientId)
      .then(data => { if (!cancelled) setCandidates({ patientId, data }) })
      .catch(error => {
        console.error('[reminder source candidates read error]', error)
        if (!cancelled) setCandidatesFailed(true)
      })
    return () => { cancelled = true }
  }, [enabled, formOpen, patientId])

  // 已連結的 id 用排序後的字串當依賴：提醒陣列每次 setState 都是新參考，直接依賴會讓查詢在每次儲存／結案後重跑。
  const entryIds = useMemo(() => uniqueSorted(reminders.map(item => item.related_entry_id)), [reminders])
  const labIds = useMemo(() => uniqueSorted(reminders.map(item => item.related_lab_result_id)), [reminders])
  const linkedKey = `${entryIds.join(',')}|${labIds.join(',')}`

  useEffect(() => {
    setLinkedFailed(false)
    if (!enabled || (entryIds.length === 0 && labIds.length === 0)) { setLinked(null); return }
    let cancelled = false
    listLinkedReminderSources(patientId, entryIds, labIds)
      .then(data => { if (!cancelled) setLinked({ patientId, data }) })
      .catch(error => {
        console.error('[reminder linked source read error]', error)
        if (!cancelled) setLinkedFailed(true)
      })
    return () => { cancelled = true }
    // entryIds／labIds 已濃縮在 linkedKey 裡，列入依賴只會讓每次 reminders 換參考就重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, linkedKey, patientId])

  return {
    candidates: candidates?.patientId === patientId ? candidates.data : EMPTY_SOURCES,
    candidatesLoading: enabled && formOpen && !candidatesFailed && candidates?.patientId !== patientId,
    candidatesFailed,
    // 只比對病人、不比對 key：儲存後 linkedKey 一變、新結果回來前若直接清空，清單 chip 會閃掉，看起來像連結沒存成功；
    // 保留同一位病人的上一份資料，新結果一到就換掉（沒有對應來源的 id 本來就不顯示 chip）。
    linked: linked?.patientId === patientId ? linked.data : EMPTY_SOURCES,
    linkedFailed,
  }
}

function uniqueSorted(ids: Array<string | null>): string[] {
  return [...new Set(ids.filter((id): id is string => Boolean(id)))].sort()
}
