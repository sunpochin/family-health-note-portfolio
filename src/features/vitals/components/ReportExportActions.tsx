/*
檔案用途：血壓報告的輸出工具列——複製 GPT 摘要、下載 CSV、列印／存 PDF，以及對應的隱私提醒與操作結果。
所在層：src/features/vitals/components；由 BloodPressureReportPanel 放在「近期趨勢」面板最上方，不負責讀取資料。
主要關聯：lib/recordReport 的 buildGptReportText／buildRecordCsv 產生輸出內容；RecordReport 只負責畫面與列印版面。

為什麼從 RecordReport 拆出來：按鈕原本在「結構化報告」卡片裡，排在趨勢圖、統計卡與逐日明細之後，
紀錄一多就要捲很久才按得到「複製摘要」。家屬打開這一段最常做的事就是複製給醫師或 GPT，
所以輸出動作提到面板頂端，報告內容本身維持原順序。
*/
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { BpRecord } from '../../../types/database'
import { Icon } from '../../../components/ui/Icon'
import { useBpEvaluator } from '../hooks/useBpEvaluator'
import { buildGptReportText, buildRecordCsv, REPORT_TIMEZONE } from '../../../lib/recordReport'
import { useI18n } from '../../../lib/i18n'
import type { TrajectoryEvent } from '../../../lib/medicalTrajectory'
import type { PreVisitSourceStatuses } from '../../../lib/preVisitSources'
import type { PreVisitBriefItem } from '../../../lib/preVisitBrief'

// 元件會被 lazy-load 單獨載入，不能依賴 recordReport 的副作用先註冊 .tz()。
dayjs.extend(utc)
dayjs.extend(timezone)

export function ReportExportActions({ records, subjectLabel, selectedDays, canExport, isOfflineData, cacheUpdatedAt, trajectoryEvents, trajectorySourceStatus, preVisitBriefItems }: {
  records: BpRecord[]
  subjectLabel: string
  selectedDays: number
  canExport: boolean
  isOfflineData: boolean
  cacheUpdatedAt: string | null
  trajectoryEvents: TrajectoryEvent[]
  trajectorySourceStatus: PreVisitSourceStatuses
  preVisitBriefItems: PreVisitBriefItem[] | null
}) {
  const { text } = useI18n()
  const evaluator = useBpEvaluator()
  const [actionStatus, setActionStatus] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  const exportContext = { selectedDays, isOfflineData, cacheUpdatedAt, standardResolver: evaluator.resolver }

  useEffect(() => {
    // 切換對象、區間或資料來源後，舊的「已複製」訊息已不再可信，必須清掉。
    setActionStatus(null)
  }, [records, subjectLabel, selectedDays, isOfflineData, cacheUpdatedAt])

  const copyForGpt = async () => {
    // 部分 WebView/非 HTTPS 環境沒有 Clipboard API，先判斷避免點擊按鈕直接拋錯。
    if (!navigator.clipboard) {
      setActionStatus({ kind: 'error', text: text({ id: 'Browser tidak mendukung API clipboard.', zh: '瀏覽器不支援剪貼簿 API。', en: 'The browser does not support the Clipboard API.' }) })
      return
    }
    try {
      await navigator.clipboard.writeText(buildGptReportText(records, exportContext, { events: trajectoryEvents, sourceStatus: trajectorySourceStatus }, preVisitBriefItems ?? undefined))
      setActionStatus({ kind: 'success', text: text({ id: 'Ringkasan disalin; siap ditempel ke GPT.', zh: '摘要已複製，可貼給 GPT。', en: 'The summary has been copied and can be pasted into GPT.' }) })
    } catch {
      setActionStatus({ kind: 'error', text: text({ id: 'Tidak dapat menyalin. Periksa izin browser.', zh: '無法複製，請確認瀏覽器權限。', en: 'Unable to copy, please confirm your browser permissions.' }) })
    }
  }

  const downloadCsv = () => {
    const csv = buildRecordCsv(records, subjectLabel, exportContext)
    const link = document.createElement('a')
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    // 取最早／最晚量測當檔名起訖日；用 min/max 而不依賴傳入順序（離線快取不保證排序），也不必再建一次報告模型。
    const times = records.map(record => dayjs(record.measured_at).valueOf())
    const start = times.length > 0 ? dayjs(Math.min(...times)).tz(REPORT_TIMEZONE).format('YYYY-MM-DD') : 'empty'
    const end = times.length > 0 ? dayjs(Math.max(...times)).tz(REPORT_TIMEZONE).format('YYYY-MM-DD') : 'empty'
    link.href = url
    // 檔名不放姓名，避免下載檔留在共用裝置時直接暴露健康資料屬於誰。
    link.download = `blood-pressure-${start}-${end}.csv`
    document.body.append(link)
    link.click()
    link.remove()
    // 某些瀏覽器尚未排入下載就撤銷 Blob URL 會產生空檔，因此延後釋放資源。
    setTimeout(() => URL.revokeObjectURL(url), 100)
    setActionStatus({ kind: 'success', text: text({ id: 'CSV berhasil diunduh.', zh: 'CSV 已下載。', en: 'CSV downloaded.' }) })
  }

  const actionsDisabled = records.length === 0 || !canExport
  // 圖示與文字同一列（inline-flex），按鈕高度不再被上下堆疊撐高；至少 44px 高，手機單手也點得到。
  // 375px 寬時兩顆次要按鈕各約 130px，印尼文「Unduh CSV」用 px-3／gap-2 會折成兩行，所以收窄內距並禁止換行；
  // 英文「Download CSV」在這個寬度放不下，改用較短的「Save CSV」。
  const actionClass = 'inline-flex min-h-11 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border px-2 py-2 text-sm font-bold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-45'

  return (
    <section className="print-hidden rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_8px_30px_rgba(15,23,42,0.06)]" aria-labelledby="report-export-title">
      <h2 id="report-export-title" className="text-base font-extrabold tracking-tight text-slate-950">{text({ id: 'Untuk dokter & GPT', zh: '給醫師與 GPT', en: 'For doctor & GPT' })}</h2>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {/* 複製摘要是這一段的主要動作：唯一的實心按鈕、手機上獨佔一整列；其餘兩個是次要的外框按鈕。 */}
        {/* 共用 Icon 維持筆畫與 aria-hidden 一致；動作名稱仍由按鈕旁的三語文字表達。 */}
        <button type="button" disabled={actionsDisabled} onClick={copyForGpt} className={`${actionClass} col-span-2 min-h-12 border-brand-700 bg-brand-700 text-white sm:col-span-1`}>
          <Icon name="copy" className="h-[18px] w-[18px] shrink-0" />
          {text({ id: 'Salin untuk GPT', zh: '複製摘要', en: 'Copy for GPT' })}
        </button>
        <button type="button" disabled={actionsDisabled} onClick={downloadCsv} className={`${actionClass} border-slate-200 bg-white text-slate-800`}>
          <Icon name="download" className="h-[18px] w-[18px] shrink-0" />
          {text({ id: 'Unduh CSV', zh: '下載 CSV', en: 'Save CSV' })}
        </button>
        <button type="button" disabled={actionsDisabled} onClick={() => window.print()} className={`${actionClass} border-slate-200 bg-white text-slate-800`}>
          <Icon name="printer" className="h-[18px] w-[18px] shrink-0" />
          {text({ id: 'Cetak / PDF', zh: '列印 / PDF', en: 'Print / PDF' })}
        </button>
      </div>
      <p className={`mt-2 min-h-4 text-xs font-semibold ${actionStatus?.kind === 'error' ? 'text-red-700' : 'text-emerald-700'}`} role="status" aria-live="polite">
        {actionStatus?.text ?? ''}
      </p>
      {!canExport && (
        <p className="mt-1 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {text({ id: 'Masuk untuk memakai tombol ekspor', zh: '登入後可使用輸出按鈕', en: 'Log in to use the Output button' })}
        </p>
      )}
      {canExport && (
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          {text({ id: 'Paket GPT tidak memuat nama, tetapi berisi semua nilai kesehatan per catatan. Periksa sebelum membagikannya.', zh: 'GPT 摘要不含姓名，但包含所有逐筆健康數值，貼出前請確認。', en: 'The GPT summary does not contain the name, but contains all health values on a case-by-case basis. Please confirm before posting.' })}
        </p>
      )}
    </section>
  )
}
