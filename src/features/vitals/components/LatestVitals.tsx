/*
檔案用途：格式化並呈現最近一次血壓、心跳、量測時間與一分鐘重測倒數。
所在層：src/components；供輸入頁與看資料總覽共用的最新生命徵象閱讀元件。
主要關聯：使用 VitalReading 呈現固定指標色，資料由 InputPage 的 useLatestBpRecord 或 DashboardStatsCards 的摘要提供。
*/
import dayjs from 'dayjs'
import { useEffect, useState, type ReactNode } from 'react'
import 'dayjs/locale/id'
import 'dayjs/locale/zh-tw'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { BpRecord } from '../../../types/database'
import { TZ } from '../../../lib/timezone'
import { common, useI18n, type Locale } from '../../../lib/i18n'
import { VitalReading } from './VitalReading'
import { Icon } from '../../../components/ui/Icon'

dayjs.extend(utc)
dayjs.extend(timezone)

const DAYJS_LOCALE: Record<Locale, string> = { zh: 'zh-tw', id: 'id', en: 'en' }

export function formatLatestVitals(record: BpRecord, locale: Locale = 'id') {
  return {
    timestamp: dayjs(record.measured_at).tz(TZ).locale(DAYJS_LOCALE[locale]).format('ddd, D MMM HH:mm:ss'),
    values: `${record.systolic}/${record.diastolic}${record.pulse != null ? ` ♥ ${record.pulse}` : ''}`,
  }
}

export function formatMeasurementInterval(measuredAt: string, now: number, locale: Locale = 'id') {
  const elapsedSeconds = Math.max(0, Math.floor((now - Date.parse(measuredAt)) / 1_000))
  const remainingSeconds = Math.max(0, 60 - elapsedSeconds)
  const duration = `${String(Math.floor(remainingSeconds / 60)).padStart(2, '0')}:${String(remainingSeconds % 60).padStart(2, '0')}`

  if (remainingSeconds > 0) {
    return locale === 'zh' ? `再等 ${duration}` : locale === 'en' ? `Wait ${duration}` : `Tunggu ${duration}`
  }
  return locale === 'zh' ? '可再量測' : locale === 'en' ? 'Can measure again' : 'Boleh ukur lagi'
}

export function isMeasurementIntervalActive(measuredAt: string, now: number) {
  return now < Date.parse(measuredAt) + 60_000
}

export function getLatestVitalsStatus({
  record,
  loading = false,
  error = false,
  now,
  locale = 'id',
}: {
  record: BpRecord | null
  loading?: boolean
  error?: boolean
  now: number
  locale?: Locale
}) {
  if (loading) return { state: 'loading' as const }
  if (error) return { state: 'error' as const }
  if (!record) return { state: 'empty' as const }

  return {
    state: 'ready' as const,
    display: formatLatestVitals(record, locale),
    intervalText: formatMeasurementInterval(record.measured_at, now, locale),
    isActive: isMeasurementIntervalActive(record.measured_at, now),
  }
}

export function LatestVitals({
  record,
  loading = false,
  error = false,
  className = '',
  valueClassName = '',
  // 預設單位字用 slate-600（issue #1162）：這個元件常放在警示淺色底（統計卡）或品牌淺綠底（今天頁）上，
  // 原本的 gray-400 只有約 2.5:1；slate-500 在 red-100/80 上也只有 4.06:1，所以直接用 slate-600（6.47:1 以上）。
  // 它會蓋掉 VitalReading 自己的預設值，所以 VitalReading 改色（#1152）不會自動改到這裡。
  unitClassName = 'text-slate-600',
  showTimestamp = true,
  showInterval = true,
}: {
  record: BpRecord | null
  loading?: boolean
  error?: boolean
  className?: string
  valueClassName?: string
  unitClassName?: string
  showTimestamp?: boolean
  showInterval?: boolean
}) {
  const { locale, text } = useI18n()
  const [now, setNow] = useState(Date.now)
  const status = getLatestVitalsStatus({ record, loading, error, now, locale })

  useEffect(() => {
    if (!record) return

    const deadline = Date.parse(record.measured_at) + 60_000
    const start = Date.now()
    setNow(start)
    if (!isMeasurementIntervalActive(record.measured_at, start)) return

    // 繁體中文註解：倒數完成就停止更新，避免照護頁開很久時仍每秒耗電重繪。
    const timer = window.setInterval(() => {
      const next = Date.now()
      setNow(next)
      if (next >= deadline) window.clearInterval(timer)
    }, 1_000)
    return () => window.clearInterval(timer)
  }, [record])

  let content: ReactNode

  if (status.state === 'loading') {
    content = <span className="font-semibold text-emerald-700">{text(common.loading)}</span>
  } else if (status.state === 'error') {
    content = <span className="inline-flex items-center gap-1 font-semibold text-red-700"><Icon name="alert-triangle" className="h-4 w-4 shrink-0" />{text(common.error)}</span>
  } else if (status.state === 'ready' && record) {
    content = <>
      {showTimestamp && <span className="shrink-0 text-slate-600">{status.display.timestamp}</span>}
      <VitalReading
        systolic={record.systolic}
        diastolic={record.diastolic}
        pulse={record.pulse}
        className={`shrink-0 font-extrabold ${valueClassName}`}
        unitClassName={unitClassName}
      />
      {showInterval && (
        <span className="shrink-0 text-xs font-semibold text-slate-600" role="timer" aria-live="off">
          {status.intervalText}
        </span>
      )}
    </>
  } else {
    content = <span className="font-semibold text-slate-600">{text({ id: 'Belum ada', zh: '尚無資料', en: 'No User Memberships found' })}</span>
  }

  return (
    <div className={`flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 tabular-nums ${className}`}>
      {/* 繁體中文註解：寧可在窄螢幕換行，也不能用 truncate 吃掉照護者要核對的血壓或心跳。 */}
      {showTimestamp && text({ id: 'Pengukuran terakhir:', zh: '最後一次量測：', en: 'Last Measurement:' })}{content}
    </div>
  )
}
