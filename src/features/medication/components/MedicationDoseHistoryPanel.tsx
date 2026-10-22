/*
檔案用途：在服藥模組內呈現最近每個照護日實際完成的劑次數。
所在層：src/features/medication/components；由 MedicationPage 透過 lazy 掛載在「近期趨勢」區塊內。
主要關聯：medication_intake_logs、demoStorage、lib/trendSeries 與共用的 DailyTrendChart。

為什麼是「服用次數」而不是「遵從率」：藥單會隨醫囑調整，要算某一天的應服次數，
必須重建那一天當下的藥單版本；目前沒有保存足以正確重建的歷史快照。
硬算出來的百分比會看起來精確卻是錯的，在用藥情境下誤導比缺少更危險，
因此只呈現可從紀錄直接驗證的事實次數。原本的「變更紀錄」分頁記的是藥單被改過什麼，
回答不了「這禮拜有沒有按時吃藥」，兩者互補而非重複。
*/
import { MedicationHoldHistory } from './MedicationHoldHistory'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import { DailyTrendChart } from '../../../components/daily-care/DailyTrendChart'
import { common, useI18n } from '../../../lib/i18n'
import { careDateKey } from '../../../lib/careDay'
import { isDemoMode, readDemoMedicationDay } from '../../../lib/demoStorage'
import { supabase } from '../../../lib/supabase'
import { TZ } from '../../../lib/timezone'
import { dailyDoseCounts, trendDateKeys, type TrendPoint } from '../../../lib/trendSeries'

dayjs.extend(timezone)

export function MedicationDoseHistoryPanel({ patientId, days }: { patientId: string; days: number }) {
  const { text } = useI18n()
  const [points, setPoints] = useState<TrendPoint[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPoints(null)
    setFailed(false)
    const now = dayjs().tz(TZ)
    const careDates = trendDateKeys(days, now)
    const sinceCareDate = careDates[0] ?? careDateKey(now)

    const load = async () => {
      if (isDemoMode()) {
        // Demo 的服藥資料存在本機 overlay，只能逐個照護日讀；範圍最多 42 天且不觸網，成本可接受。
        return careDates.flatMap(date => readDemoMedicationDay(patientId, date).logs)
      }

      const { data, error } = await supabase.from('medication_intake_logs')
        .select('care_date, taken_on')
        .eq('patient_id', patientId)
        .gte('care_date', sinceCareDate)
      if (error) throw error
      return (data ?? []) as { care_date?: string | null; taken_on: string }[]
    }

    void load()
      .then(logs => { if (!cancelled) setPoints(dailyDoseCounts(logs, days, now)) })
      .catch(error => {
        console.error('[medication dose history read error]', error)
        if (!cancelled) setFailed(true)
      })

    return () => { cancelled = true }
  }, [days, patientId])

  // 載入失敗與空狀態的英文翻譯修正為標準自然英文
  if (failed) return <p role="alert" className="text-sm font-semibold text-red-700">{text({ id: 'Riwayat dosis tidak dapat dimuat.', zh: '目前無法讀取服藥次數紀錄。' ,en: 'Unable to load dose history.' })}</p>
  // 趨勢圖載入時保留固定高度與平滑載入動畫，避免資料回傳瞬間產生突兀的版面位移（CLS）
  if (!points) {
    return (
      <div role="status" className="flex h-44 w-full items-center justify-center rounded-2xl bg-slate-50 text-sm font-medium text-slate-400">
        <span className="mr-2 inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-transparent" aria-hidden="true" />
        {text(common.loading)}
      </div>
    )
  }

  // 圖線用 brand-700（#047857），與營養趨勢同色；原本的 #0369A1 是 info（sky）色值，info 只給系統訊息，
  // 而且藍系跟舒張壓識別色 #2563EB 容易混淆（設計系統 #1146、docs/product/clinical-care-ops-ui-design.md §4.1／§7）。
  return <>
    <MedicationHoldHistory key={`${patientId}:${days}`} patientId={patientId} days={days} />
    <DailyTrendChart
      points={points}
      color="#047857"
      unit={{ id: 'dosis', zh: '劑次' ,en: 'Dosage' }}
      seriesLabel={{ id: 'Dosis tercatat per hari perawatan', zh: '每個照護日已記錄的服用劑次' ,en: 'Recorded doses per day of care' }}
      emptyLabel={{ id: 'Belum ada catatan minum obat pada rentang ini.', zh: '這個區間還沒有服藥紀錄。' ,en: 'No medication records in this date range.' }}
      valueFormatter={value => value.toFixed(0)}
    />
    <p className="mt-2 text-xs text-slate-500">
      {text({
        id: 'Menampilkan jumlah dosis yang benar-benar tercatat, bukan persentase kepatuhan — daftar obat dapat berubah seiring waktu.',
        zh: '顯示的是實際記錄的服用劑次，不是遵從率百分比；藥單會隨醫囑調整，過去的應服次數無法可靠重建。',
        // 修正破碎印尼文夾雜的英文翻譯
        en: 'Shows actual recorded doses rather than adherence percentage — prescriptions change over time.',
      })}
    </p>
  </>
}
