/*
檔案用途：後台「血壓總表」的狀態容器 hook（AGENTS.md Rule A）：讀取最新紀錄、依對象篩選、勾選、單筆與批次刪除。
所在層：src/features/system-admin/hooks；只被 components/AdminBloodPressurePanel.tsx 使用。
主要關聯：Supabase blood_pressure_records（DELETE 受 RLS 的管理者 policy 限制，見 docs/architecture/auth-and-rls.md）、
         adminBloodPressureSelection.ts（篩選與確認訊息的純函式）、hooks/useConfirm（畫面內二次確認）。
*/
import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { type LocalizedText, useI18n } from '../../../lib/i18n'
import { useConfirm } from '../../../hooks/useConfirm'
import {
  type AdminBloodPressureRecord,
  type AdminPatientFilter,
  buildBulkDeleteConfirmMessage,
  buildSingleDeleteConfirmMessage,
  patientFilterOptions,
  patientLabelsById,
  summarizeSelectionByPatient,
  visibleRecords,
} from '../adminBloodPressureSelection'

export function useAdminBloodPressureRecords(formatMeasuredAt: (measuredAt: string) => string) {
  const { text } = useI18n()
  const { confirm, dialog: confirmDialog } = useConfirm()
  // 使用選取的 ID 陣列來追蹤被勾選的資料行，不選用 Set 是因為陣列配合 React 狀態操作與轉移到 Supabase .in() 更直覺
  const [records, setRecords] = useState<AdminBloodPressureRecord[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [patientFilter, setPatientFilterState] = useState<AdminPatientFilter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<LocalizedText | null>(null)

  const fetchRecords = useCallback(async () => {
    setLoading(true)
    setError(null)
    const { data, error } = await supabase
      .from('blood_pressure_records')
      .select('id, systolic, diastolic, pulse, measured_at, patient_id, patients(display_name)')
      .order('measured_at', { ascending: false })
      .limit(100)

    if (error) {
      console.error('[admin blood pressure read error]', error)
      setError({ id: 'Catatan sementara tidak dapat dimuat. Periksa internet lalu coba lagi.', zh: '暫時無法讀取紀錄，請確認網路後重試。', en: 'There was an error reading the log, please check your network and try again.' })
    } else if (data) {
      setRecords(data)
    }
    setLoading(false)
    setSelectedIds([])
  }, [])

  useEffect(() => {
    fetchRecords()
  }, [fetchRecords])

  const filterOptions = useMemo(() => patientFilterOptions(records, text), [records, text])
  // 同名對象加辨識碼的顯示標籤；列、單筆確認框都從這裡拿，不各自算。
  const patientLabels = useMemo(() => patientLabelsById(records, text), [records, text])
  const visible = useMemo(() => visibleRecords(records, patientFilter), [records, patientFilter])
  const selectionSummary = useMemo(() => summarizeSelectionByPatient(records, selectedIds, text), [records, selectedIds, text])

  // 切換對象篩選時一律清空勾選：若保留，被篩掉而看不見的勾選仍會隨「刪除選取」一起送出，
  // 管理者以為只刪了畫面上這位對象，其實連帶刪掉別人的紀錄。這正是這個篩選要防的事。
  const setPatientFilter = useCallback((filter: AdminPatientFilter) => {
    setPatientFilterState(filter)
    setSelectedIds([])
  }, [])

  // 重新載入後某位對象可能已沒有紀錄；篩選值指向不存在的對象時退回「全部」，不留空畫面。
  useEffect(() => {
    if (patientFilter !== 'all' && !loading && !filterOptions.some(option => option.patientId === patientFilter)) {
      setPatientFilterState('all')
    }
  }, [patientFilter, loading, filterOptions])

  const deleteRecord = useCallback(async (record: AdminBloodPressureRecord) => {
    // 改用畫面內對話框（useConfirm）取代 window.confirm：原生對話框在部分行動瀏覽器連續
    // 彈出多次後會被封鎖或拋例外，導致刪除流程無聲中斷，管理者會看到「按了沒反應」。
    // 第一層確認點名對象、時間與數值，讓「按到隔壁那列」在這裡就被看見。
    if (!(await confirm(buildSingleDeleteConfirmMessage(record, patientLabels.get(record.patient_id) ?? '', formatMeasuredAt(record.measured_at), text), { danger: true }))) return

    // 健康紀錄不能再靠舊角色判斷風險；所有病人的刪除都需要第二次明確確認。
    // 確認視窗的訊息是純字串、放不進 SVG，所以三個語系都拿掉開頭的 ⚠️（issue #1150）。注意 danger: true 只會把確認鈕變紅，
    // 並不會替訊息加警示標記；這則與其餘所有 danger 確認（刪除體溫、撤銷邀請…）一致，都靠文字本身說明「永久刪除」，不靠顏色或符號。
    if (!(await confirm(text({ id: 'Tindakan ini menghapus catatan kesehatan secara permanen. Lanjutkan?', zh: '此操作會永久刪除健康紀錄，確定繼續嗎？', en: 'This will permanently delete the health record, are you sure you want to continue?' }), { danger: true }))) return

    // { count: 'exact' } 是為了拿到實際刪除筆數：RLS 擋下的 DELETE 對 PostgREST 而言是「成功、0 筆」，
    // 不是 error，若只看 error 會讓管理者以為刪除成功，但資料庫其實什麼都沒刪（issue #738 fail-closed 視窗）。
    const { error, count } = await supabase
      .from('blood_pressure_records')
      .delete({ count: 'exact' })
      .eq('id', record.id)

    if (error) {
      console.error('[admin blood pressure delete error]', error)
      alert(text({ id: 'Penghapusan gagal. Periksa internet lalu coba lagi.', zh: '刪除失敗，請確認網路後重試。', en: 'Deletion failed, please check your network and try again.' }))
    } else if (!count) {
      console.error('[admin blood pressure delete blocked]', { id: record.id })
      alert(text({ id: 'Penghapusan diblokir oleh izin. Tidak ada yang dihapus.', zh: '刪除被權限擋下，沒有任何紀錄被刪除。', en: 'Deletion was blocked by permissions; nothing was deleted.' }))
    } else {
      // 使用函數式更新以確保狀態讀取最新，防止連續操作時的 stale state 競態條件
      setRecords(prev => prev.filter(r => r.id !== record.id))
      setSelectedIds(prev => prev.filter(x => x !== record.id))
    }
  }, [confirm, formatMeasuredAt, patientLabels, text])

  const deleteSelected = useCallback(async () => {
    if (selectedIds.length === 0) return

    // 第一層確認逐位列出對象與筆數：橫跨多位對象時管理者在按下確定前就看得到夾帶了誰的紀錄。
    if (!(await confirm(buildBulkDeleteConfirmMessage(selectionSummary, selectedIds.length, text), { danger: true }))) return

    // 批次刪除的影響更大，統一保護全部病人，避免 UUID 架構下重新引入特定成員例外。
    if (!(await confirm(text({ id: 'Tindakan ini menghapus catatan kesehatan yang dipilih secara permanen. Lanjutkan?', zh: '此操作會永久刪除選取的健康紀錄，確定繼續嗎？', en: 'This will permanently delete the selected health records, are you sure you want to continue?' }), { danger: true }))) return

    // 採用 Supabase 的 .in 進行一次性多列刪除，避免多個非同步單筆請求造成 DB 負擔與寫入競爭
    // .select('id') 拿回「實際被刪除」的 id 清單：批次選取的病人可能分屬不同 care_access（例如
    // 管理者尚未同步時，部分病人仍受 20260730060000 的照護者 policy 放行、部分被擋下），
    // 只看 count 差一步就會把「刪了一部分」誤判成全部成功而整批從畫面上消失（PR #742 review）。
    const { data: deleted, error } = await supabase
      .from('blood_pressure_records')
      .delete()
      .in('id', selectedIds)
      .select('id')

    const deletedIds = new Set((deleted ?? []).map(r => r.id))

    if (error) {
      console.error('[admin blood pressure bulk delete error]', error)
      alert(text({ id: 'Penghapusan gagal. Periksa internet lalu coba lagi.', zh: '刪除失敗，請確認網路後重試。', en: 'Deletion failed, please check your network and try again.' }))
    } else if (deletedIds.size === 0) {
      console.error('[admin blood pressure bulk delete blocked]', { selectedIds })
      alert(text({ id: 'Penghapusan diblokir oleh izin. Tidak ada yang dihapus.', zh: '刪除被權限擋下，沒有任何紀錄被刪除。', en: 'Deletion was blocked by permissions; nothing was deleted.' }))
    } else {
      if (deletedIds.size < selectedIds.length) {
        console.error('[admin blood pressure bulk delete partial]', { requested: selectedIds.length, deleted: deletedIds.size })
        alert(text({
          id: `${deletedIds.size} dari ${selectedIds.length} catatan berhasil dihapus. Sisanya diblokir oleh izin.`,
          zh: `${selectedIds.length} 筆中僅刪除 ${deletedIds.size} 筆，其餘被權限擋下。`,
          en: `Deleted ${deletedIds.size} of ${selectedIds.length} records; the rest were blocked by permissions.`,
        }))
      }
      // 只從畫面移除真正被刪除的那幾筆，被擋下的紀錄留在列表上，不能讓管理者誤以為它們也不見了。
      setRecords(prev => prev.filter(r => !deletedIds.has(r.id)))
      setSelectedIds(prev => prev.filter(id => !deletedIds.has(id)))
    }
  }, [confirm, selectedIds, selectionSummary, text])

  const toggleSelect = useCallback((id: string) => {
    // 使用函數式更新確保狀態讀取最新，防止使用者連續點擊切換時發生競態條件
    setSelectedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]))
  }, [])

  // 「全選」只選目前畫面上看得到的紀錄（套用篩選後），不是資料庫撈回來的全部 100 筆。
  const allVisibleSelected = visible.length > 0 && visible.every(record => selectedIds.includes(record.id))
  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds(allVisibleSelected ? [] : visible.map(record => record.id))
  }, [allVisibleSelected, visible])

  return {
    records,
    visible,
    loading,
    error,
    confirmDialog,
    patientFilter,
    setPatientFilter,
    filterOptions,
    patientLabels,
    selectedIds,
    selectionSummary,
    allVisibleSelected,
    toggleSelect,
    toggleSelectAllVisible,
    deleteRecord,
    deleteSelected,
  }
}
