/*
檔案用途：繪製歷史血壓與心跳趨勢圖表，依視覺規範區分數據線型與標記形狀（實心圓/菱形/虛線）。
所在層：src/components；血壓模組近期趨勢與封存對象唯讀歷史頁共用的主要圖表元件。
主要關聯：由 BloodPressureReportPanel 載入，使用 recharts 繪圖套件與 vitalPresentation 的指標顏色。
*/
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, ReferenceLine
} from 'recharts'
import type { BpRecord } from '../../../types/database'
import { Icon } from '../../../components/ui/Icon'
import { ALERT_BAR_CLASS, ALERT_ICON, ALERT_SOFT_CHIP_CLASS, alertLabelText, alertTone } from '../../../lib/alertPresentation'
import { useBpEvaluator, type BpEvaluator } from '../hooks/useBpEvaluator'
import { VITAL_COLORS } from '../../../lib/vitalPresentation'
import { TZ } from '../../../lib/timezone'
import { SESSION_LABELS, sessionFromMeasuredAt } from '../../../lib/dashboardStats'
import { PulseReading, VitalValue } from './VitalReading'
import { common, localized, useI18n, type Locale } from '../../../lib/i18n'
import { formatMedicationDisplayName, type MedicationPlanChangeLogView } from '../../../lib/medication/medications'

dayjs.extend(utc)
dayjs.extend(timezone)

// 調藥標線的顏色（issue #1153）。Recharts 吃不到 Tailwind class，只能寫 hex，要手動跟 src/index.css 的 @theme 同步。
// 原本停藥用 #ef4444（白底 3.76:1）、其他用 #10b981（2.54:1），10px 標籤都沒到 AA，而且紅色在這個 app
// 專指收縮壓與危險——停藥標線用紅，照護者會以為那一天血壓出事。
// - 加藥／改藥：brand-700 #047857（白底 5.48:1），§4.1 裡服藥圖線本來就走 brand。
// - 停藥：ink-muted #475569（slate-600，白底 7.58:1），中性色表示「拿掉了」，不借警示色。
// 兩者的區分本來就靠文字（← 停／改／加＋藥名）；顏色與虛線疏密只是第二層提示，不是唯一訊號。
const MED_MARKER_COLOR = { add: '#047857', stop: '#475569' } as const
const MED_MARKER_DASH = { add: '3 3', stop: '6 3' } as const

// 數字色只負責指出指標種類；真正異常由 Badge 顯示，避免正常收縮壓被誤讀成紅色警報。
const CustomBpDot = (props: any) => {
  const { cx, cy, payload, type, color } = props
  if (cx == null || cy == null || !payload) return null

  if (type === 'diastolic') {
    return <path d={`M ${cx} ${cy - 5} L ${cx + 5} ${cy} L ${cx} ${cy + 5} L ${cx - 5} ${cy} Z`} fill={color} stroke="#ffffff" strokeWidth={1.5} />
  }

  return (
    <circle
      cx={cx}
      cy={cy}
      r={4.5}
      fill={color}
      stroke="#ffffff"
      strokeWidth={1.5}
    />
  )
}

function PulseDot({ cx, cy, color }: { cx?: number; cy?: number; color: string }) {
  if (cx == null || cy == null) return null
  return <rect x={cx - 3} y={cy - 3} width={6} height={6} rx={1} fill={color} />
}

// 自訂中印雙語 Tooltip，提供更易讀的高對比提示資訊，避免 Recharts 預設 Tooltip 將陣列直接印出的粗糙感
// evaluator 由 DashboardChart 以 prop 傳入、不在這裡呼叫 hook：Recharts 會 clone 這個元素並在
// 自己的渲染流程裡使用，把 hook 綁在它的生命週期上比較脆弱；判讀標準是必要輸入，不能靠運氣取得。
const CustomTooltip = ({ active, payload, locale, evaluator }: { active?: boolean; payload?: any[]; locale: Locale; evaluator: BpEvaluator }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload
    const systolic = data.systolic
    const diastolic = data.diastolic
    const pulse = data.pulse
    const time = data.time
    const sessionName = data.sessionName

    // 用該點自己的量測時間解析標準，與清單、報告逐筆一致；否則同一筆讀數在圖上與清單上會是兩種顏色。
    const reading = evaluator.evaluateAt(systolic, diastolic, pulse, new Date(data.timestamp))
    const tone = alertTone(reading)

    // 標籤 emoji 留給推播，tooltip 用 SVG 圖示＋純文字（issue #1153）。
    const statusText = localized(alertLabelText(reading.labels), locale)
    const statusBg = `${ALERT_SOFT_CHIP_CLASS[tone]} ${ALERT_BAR_CLASS[tone]}`

    return (
      <div className="min-w-[200px] space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm shadow-lg ring-1 ring-black/5">
        <div className="font-semibold text-slate-900 border-b border-slate-100 pb-1.5 flex justify-between items-center">
          <span>{time}</span>
          <span className="text-xs font-normal text-slate-500">{sessionName}</span>
        </div>
        <div className="space-y-1.5 pt-0.5">
          <div className="flex justify-between items-center text-slate-700">
            <span>{localized({ id: 'Sistolik:', zh: '收縮壓：', en: 'Systolic' }, locale)}</span>
            <VitalValue kind="systolic" value={systolic} className="font-bold text-slate-950" />
          </div>
          <div className="flex justify-between items-center text-slate-700">
            <span>{localized({ id: 'Diastolik:', zh: '舒張壓：', en: 'Diastolic:' }, locale)}</span>
            <VitalValue kind="diastolic" value={diastolic} className="font-bold text-slate-950" />
          </div>
          {pulse != null && (
            <div className="flex justify-between items-center text-slate-700 font-semibold">
              <span>{localized({ id: 'Jantung:', zh: '心跳：', en: 'Heart rate' }, locale)}</span>
              <PulseReading pulse={pulse} className="font-bold" />
            </div>
          )}
        </div>
        <div className={`mt-2 flex items-center justify-center gap-1 rounded-lg border px-1.5 py-1 text-center text-xs font-bold ${statusBg}`}>
          <Icon name={ALERT_ICON[tone]} className="h-3.5 w-3.5 shrink-0" />
          {statusText}
        </div>
      </div>
    )
  }
  return null
}

// 將 Dashboard 的 Recharts 趨勢圖獨立為專屬元件，負責呈現歷史波形、Y 軸範圍保護與中印雙語 Tooltip。
export function DashboardChart({
  records,
  days,
  subjectLabel,
  isOfflineData,
  medicationChanges = [],
}: {
  records: BpRecord[]
  days: number
  subjectLabel: string
  isOfflineData: boolean
  medicationChanges?: MedicationPlanChangeLogView[]
}) {
  const { locale, text } = useI18n()
  const evaluator = useBpEvaluator()

  // 繁體中文註解：圖表畫在白卡上，所以一律用亮色識別值，不跟著 OS 深色模式換（issue #1152）。
  // 暗色值（VITAL_COLORS.dark）在白底只有 2.5～2.8:1；等 app 真的有暗色表面再依表面切換。
  const chartColors = { systolic: VITAL_COLORS.systolic.light, diastolic: VITAL_COLORS.diastolic.light, pulse: VITAL_COLORS.pulse.light }

  const chartData = [...records]
    .reverse()
    .map(r => {
      const session = sessionFromMeasuredAt(r.measured_at)
      const sessionDisplay = SESSION_LABELS[session]
      const sessionEmoji = session === 'pagi' ? '☀️' : session === 'siang' ? '🌤️' : '🌙'
      return {
        time: dayjs(r.measured_at).tz(TZ).format('MM/DD HH:mm'),
        shortTime: `${dayjs(r.measured_at).tz(TZ).format('MM/DD')} ${sessionEmoji}`,
        sessionName: text(sessionDisplay),
        systolic: r.systolic,
        diastolic: r.diastolic,
        pulse: r.pulse ?? undefined,
        bpRange: [r.diastolic, r.systolic],
        timestamp: new Date(r.measured_at).getTime(),
      }
    })

  // 將藥物變更記錄對應到最接近的血壓記錄時間點，以產生圖表標示線。
  const annotations = (medicationChanges || []).map(change => {
    const changeTime = new Date(change.effective_at || change.recorded_at || change.created_at).getTime()
    let closestRecord = chartData[0]
    let minDiff = Infinity
    for (const r of chartData) {
      const diff = Math.abs(r.timestamp - changeTime)
      if (diff < minDiff) {
        minDiff = diff
        closestRecord = r
      }
    }
    
    // 如果最近的紀錄差異太大（例如圖表範圍外的舊紀錄），則不標示。
    if (!closestRecord || minDiff > 14 * 24 * 60 * 60 * 1000) return null

    const snapshot = (change.action === 'deactivate' ? change.before_snapshot : change.after_snapshot) || {}
    const brandName = (locale === 'zh' ? snapshot.brand_name_zh || snapshot.brand_name : snapshot.brand_name || snapshot.brand_name_zh) || formatMedicationDisplayName(change.medication, locale)
    const isStop = change.action === 'deactivate'
    const labelText = isStop 
      ? `← ${text({ id: 'Berhenti', zh: '停', en: 'Stop' })} ${brandName}`
      : change.action === 'update'
        ? `← ${text({id: 'Ubah', zh: '改', en: 'Change'})} ${brandName}`
        : `← ${text({id: 'Tambah', zh: '加', en: 'Addition'})} ${brandName}`

    return {
      x: closestRecord.shortTime,
      label: labelText,
      isStop,
      id: change.id
    }
  }).filter((a): a is NonNullable<typeof a> => Boolean(a))

  // 處理同一時間點的多個標籤避免重疊（簡單去重或堆疊顯示）
  const uniqueAnnotations = annotations.reduce((acc, current) => {
    const existing = acc.find(a => a.x === current.x)
    if (existing) {
      existing.label += ` / ${current.label.replace('← ', '')}`
    } else {
      acc.push({ ...current })
    }
    return acc
  }, [] as typeof annotations)

  return (
    <section className="print-report-chart rounded-3xl border border-slate-200 bg-white p-4 shadow-[0_8px_30px_rgba(15,23,42,0.06)]" aria-labelledby="trend-chart-title">
      <div className="record-report-print-only mb-3 hidden border-b border-slate-200 pb-2 text-xs text-slate-600">
        <p className="font-bold text-slate-900">{text({ id: 'Catatan tekanan darah rumah', zh: '居家血壓趨勢', en: 'Home Blood Pressure Trends' })}</p>
        <p>{subjectLabel} · {text(common.days(days))} · {TZ} (UTC+8)</p>
      </div>
      <div className="mb-4 flex items-center justify-between">
        <h2 id="trend-chart-title" className="text-base font-semibold tracking-tight text-slate-900">
          {text({ id: 'Grafik', zh: '圖表', en: 'Charts' })}
        </h2>
        <div className="inline-flex items-center rounded-full bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-500 ring-1 ring-inset ring-slate-200">
          {text({ id: `${records.length} catatan`, zh: `${records.length} 筆`, en: `${records.length} records` })}
        </div>
      </div>
      {isOfflineData && <p className="mb-2 text-xs font-bold text-amber-700">{text({ id: 'Data cache offline', zh: '離線快取資料', en: 'Offline cached data' })}</p>}
      <p id="trend-chart-description" className="mb-2 text-xs text-slate-500">{text({ id: 'Garis lurus menghubungkan waktu ukur; tabel lengkap tersedia di bawah.', zh: '直線連接各量測時間；下方提供完整表格。', en: 'Straight lines connect measurement times; a full table is provided below.' })}</p>
      <div role="img" aria-labelledby="trend-chart-title" aria-describedby="trend-chart-description">
        <ResponsiveContainer width="100%" height={260}>
          <ComposedChart data={chartData} margin={{ top: 10, right: 5, left: -10, bottom: 0 }}>
            {/* 繁體中文註解：Recharts 吃不到 Tailwind class，中性色只能寫 hex，所以要手動跟設計系統同步（issue #1147）：
                網格 #e2e8f0＝slate-200（原 #e5e7eb 是 gray-200）；兩條軸的單位標籤 #64748b＝slate-500，
                白底對比 4.76:1（原 #9ca3af 只有 2.54:1）。下方調藥標線的顏色見檔頭 MED_MARKER_COLOR（#1153）。 */}
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
            {/* 繁體中文註解：保留首尾日期並提高字級，靠最小間距減少中間刻度，避免窄螢幕日期互相覆蓋。 */}
            <XAxis dataKey="shortTime" tick={{ fontSize: 10 }} interval="preserveStartEnd" minTickGap={24} tickMargin={6} />
            <YAxis
              yAxisId="left"
              domain={[(minimum: number) => (Number.isFinite(minimum) ? Math.min(40, minimum - 10) : 40), (maximum: number) => (Number.isFinite(maximum) ? Math.max(180, maximum + 10) : 180)]}
              tick={{ fontSize: 10 }}
              width={35}
              label={{ value: 'mmHg', angle: -90, position: 'insideLeft', offset: 10, style: { fontSize: 9, fill: '#64748b' } }}
            />
            <YAxis
              yAxisId="right"
              orientation="right"
              domain={[(minimum: number) => (Number.isFinite(minimum) ? Math.min(40, minimum - 10) : 40), (maximum: number) => (Number.isFinite(maximum) ? Math.max(120, maximum + 10) : 120)]}
              tick={{ fontSize: 10 }}
              width={35}
              label={{ value: 'bpm', angle: 90, position: 'insideRight', offset: 10, style: { fontSize: 9, fill: '#64748b' } }}
            />
            {uniqueAnnotations.map(anno => (
              <ReferenceLine
                key={anno.id}
                yAxisId="left"
                x={anno.x}
                stroke={anno.isStop ? MED_MARKER_COLOR.stop : MED_MARKER_COLOR.add}
                strokeOpacity={0.6}
                strokeDasharray={anno.isStop ? MED_MARKER_DASH.stop : MED_MARKER_DASH.add}
                // 標籤用不透明的實色：對比 ≥4.5:1 是對文字算的，線可以淡，字不行。
                label={{
                  position: 'insideTopLeft',
                  value: anno.label,
                  fill: anno.isStop ? MED_MARKER_COLOR.stop : MED_MARKER_COLOR.add,
                  fontSize: 10,
                  fontWeight: 600,
                }}
              />
            ))}
            <Tooltip content={<CustomTooltip locale={locale} evaluator={evaluator} />} />
            <Legend iconSize={10} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
            <Area
              yAxisId="left"
              type="linear"
              dataKey="bpRange"
              stroke="none"
              fill="#f1f5f9"
              fillOpacity={0.5}
              name={text({ id: 'Rentang', zh: '區間', en: 'Interval' })}
            />
            <Line
              yAxisId="left"
              type="linear"
              dataKey="systolic"
              name={text({ id: 'Sistolik', zh: '高壓', en: 'Systolic' })}
              stroke={chartColors.systolic}
              strokeWidth={2.5}
              dot={<CustomBpDot type="systolic" color={chartColors.systolic} />}
              activeDot={{ r: 6 }}
            />
            <Line
              yAxisId="left"
              type="linear"
              dataKey="diastolic"
              name={text({ id: 'Diastolik', zh: '低壓', en: 'Diastolic' })}
              stroke={chartColors.diastolic}
              strokeWidth={2.5}
              dot={<CustomBpDot type="diastolic" color={chartColors.diastolic} />}
              activeDot={{ r: 6 }}
            />
            <Line
              yAxisId="right"
              type="linear"
              dataKey="pulse"
              name={text({ id: 'Jantung', zh: '心跳', en: 'Heart rate' })}
              stroke={chartColors.pulse}
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={<PulseDot color={chartColors.pulse} />}
              activeDot={{ r: 4 }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}
