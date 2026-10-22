/*
檔案用途：後台「血壓總表」分頁的畫面：依對象篩選列、勾選與批次刪除工具列、逐筆列表與刪除鈕。
所在層：src/features/system-admin/components；由 pages/AdminPage.tsx 在管理員模式下掛載。
主要關聯：hooks/useAdminBloodPressureRecords.ts（所有狀態與 Supabase 讀寫）、adminBloodPressureSelection.ts（篩選與確認訊息）、
         features/vitals/components/VitalReading（血壓讀值固定識別色）、hooks/useConfirm（對話框由 hook 回傳、在這裡渲染）。
*/
import { useCallback } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { useI18n } from '../../../lib/i18n'
import { VitalReading } from '../../vitals/components/VitalReading'
import { useAdminBloodPressureRecords } from '../hooks/useAdminBloodPressureRecords'

// 延伸 dayjs 以支援時區與 UTC 轉換，確保時間不論管理員本地裝置時區為何，均統一以台北時區呈現
dayjs.extend(utc)
dayjs.extend(timezone)

// 統一以台北時區呈現，以防管理人員因裝置時區不同而看到不一致的時間紀錄
const formatMeasuredAt = (measuredAt: string) => dayjs(measuredAt).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')

// 篩選鈕群組的底色是 slate-100，未選中字用 slate-600（約 6.9:1）而非 slate-500（4.35:1，低於 AA）；與 RecordReport 的篩選列同一套。
const FILTER_CHIP_BASE = 'min-h-11 rounded-lg px-3 text-sm font-bold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-700'
const FILTER_CHIP_ACTIVE = 'bg-white text-slate-950 shadow-sm'
const FILTER_CHIP_INACTIVE = 'text-slate-600 hover:bg-white/60'

export function AdminBloodPressurePanel() {
  const { text, locale } = useI18n()
  const {
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
  } = useAdminBloodPressureRecords(formatMeasuredAt)

  // 「已選 3 筆：媽媽 2、demo-xq7 1」：中文用頓號、印尼文與英文用逗號分隔，三語各自自然。
  const joinSummary = useCallback(
    () => selectionSummary.map(item => `${item.name} ${item.count}`).join(locale === 'zh' ? '、' : ', '),
    [selectionSummary, locale],
  )
  const spansMultiplePatients = selectionSummary.length > 1
  const selectedIsEmpty = selectedIds.length === 0

  return (
    <>
      {confirmDialog}
      {loading && <p className="text-sm text-slate-500">{text({ id: 'Memuat…', zh: '載入中…', en: 'Loading…' })}</p>}
      {error && <p className="text-sm text-red-700 bg-red-50 p-3 rounded">{text(error)}</p>}

      {!loading && !error && records.length === 0 && (
        <p className="text-sm text-slate-500">{text({ id: 'Belum ada data.', zh: '目前沒有任何資料。', en: 'No data yet.' })}</p>
      )}

      {/* 依對象篩選：刪錯人的主要防線。先把清單縮到一位對象，「全選」與批次刪除就只會碰到那位對象。 */}
      {!loading && !error && records.length > 0 && (
        <section aria-labelledby="admin-bp-filter-title" className="mb-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <h2 id="admin-bp-filter-title" className="text-sm font-bold text-slate-900">{text({ id: 'Saring menurut penerima perawatan', zh: '依對象篩選', en: 'Filter by care recipient' })}</h2>
          <div role="group" aria-label={text({ id: 'Saring menurut penerima perawatan', zh: '依對象篩選', en: 'Filter by care recipient' })} className="mt-2 flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
            <button
              type="button"
              aria-pressed={patientFilter === 'all'}
              onClick={() => setPatientFilter('all')}
              className={`${FILTER_CHIP_BASE} ${patientFilter === 'all' ? FILTER_CHIP_ACTIVE : FILTER_CHIP_INACTIVE}`}
            >
              {text({ id: `Semua (${records.length} catatan)`, zh: `全部（${records.length} 筆）`, en: `All (${records.length} records)` })}
            </button>
            {filterOptions.map(option => (
              <button
                key={option.patientId}
                type="button"
                aria-pressed={patientFilter === option.patientId}
                onClick={() => setPatientFilter(option.patientId)}
                className={`${FILTER_CHIP_BASE} ${patientFilter === option.patientId ? FILTER_CHIP_ACTIVE : FILTER_CHIP_INACTIVE}`}
              >
                {text({ id: `${option.name} (${option.count} catatan)`, zh: `${option.name}（${option.count} 筆）`, en: `${option.name} (${option.count} records)` })}
              </button>
            ))}
          </div>
          {/* 只在「全部」且超過一位對象時提醒：清單只有一位對象時沒有刪錯人的風險，不必多一行字。 */}
          {patientFilter === 'all' && filterOptions.length > 1 && (
            <p className="mt-2 text-xs text-slate-600">
              {text({ id: 'Pilih satu penerima perawatan dulu sebelum menghapus agar tidak salah orang.', zh: '先選一位對象再刪除，才不會刪錯人。', en: 'Pick one care recipient before deleting so the wrong person is never affected.' })}
            </p>
          )}
        </section>
      )}

      {/* 批次操作工具列：全選只作用在目前顯示的紀錄；已選摘要逐位列出對象與筆數，橫跨多位時用琥珀色加文字一起提醒。 */}
      {!loading && !error && visible.length > 0 && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-semibold text-slate-700">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAllVisible}
              className="h-5 w-5 cursor-pointer rounded border-slate-300 accent-brand-700 focus-visible:ring-brand-700"
            />
            {text({ id: `Pilih semua yang ditampilkan (${visible.length})`, zh: `全選目前顯示（${visible.length}）`, en: `Select all shown (${visible.length})` })}
          </label>
          {!selectedIsEmpty && (
            <div className="flex flex-wrap items-center gap-2">
              <p aria-live="polite" className={`text-xs font-semibold ${spansMultiplePatients ? 'text-amber-900' : 'text-slate-600'}`}>
                {selectionSummary.length > 0
                  ? text({ id: `Dipilih ${selectedIds.length}: ${joinSummary()}`, zh: `已選 ${selectedIds.length} 筆：${joinSummary()}`, en: `Selected ${selectedIds.length}: ${joinSummary()}` })
                  : text({ id: `Dipilih ${selectedIds.length}`, zh: `已選 ${selectedIds.length} 筆`, en: `Selected ${selectedIds.length}` })}
                {spansMultiplePatients && (
                  <>
                    {' '}
                    {text({ id: `(${selectionSummary.length} penerima perawatan)`, zh: `（分屬 ${selectionSummary.length} 位對象）`, en: `(${selectionSummary.length} care recipients)` })}
                  </>
                )}
              </p>
              <button
                type="button"
                onClick={deleteSelected}
                className="min-h-11 cursor-pointer rounded-lg bg-red-600 px-3 text-sm font-semibold text-white transition hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
              >
                {text({ id: `Hapus yang dipilih (${selectedIds.length})`, zh: `刪除選取（${selectedIds.length}）`, en: `Delete selected (${selectedIds.length})` })}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        {visible.map(record => {
          const selected = selectedIds.includes(record.id)
          const name = patientLabels.get(record.patient_id) ?? ''
          return (
            // 勾選列以 brand-50 底加 brand-700 邊框標示；對象名稱放在第一行最前面，刪除前第一眼看到的就是「誰的」。
            <div key={record.id} className={`flex items-center justify-between gap-3 rounded-lg border bg-white p-3 shadow-sm transition ${selected ? 'border-brand-700 bg-brand-50' : 'border-slate-200'}`}>
              <label className="flex min-h-11 flex-1 cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={selected}
                  onChange={() => toggleSelect(record.id)}
                  className="h-5 w-5 shrink-0 cursor-pointer rounded border-slate-300 accent-brand-700 focus-visible:ring-brand-700"
                />
                <div>
                  <div className="text-sm text-slate-900">
                    <span className="font-bold">{name}</span>
                    <span className="mx-1.5 text-slate-400" aria-hidden="true">·</span>
                    <span className="font-semibold tabular-nums">{formatMeasuredAt(record.measured_at)}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-600">
                    <VitalReading systolic={record.systolic} diastolic={record.diastolic} pulse={record.pulse} className="font-bold text-slate-900" />
                  </div>
                </div>
              </label>
              <button
                type="button"
                onClick={() => deleteRecord(record)}
                aria-label={text({ id: `Hapus catatan ${name} ${formatMeasuredAt(record.measured_at)}`, zh: `刪除 ${name} ${formatMeasuredAt(record.measured_at)} 的紀錄`, en: `Delete the ${name} ${formatMeasuredAt(record.measured_at)} record` })}
                className="min-h-11 shrink-0 cursor-pointer rounded-lg bg-red-50 px-3 text-sm font-semibold text-red-700 transition hover:bg-red-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
              >
                {text({ id: 'Hapus', zh: '刪除', en: 'Delete' })}
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}
