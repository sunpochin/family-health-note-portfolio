/*
檔案用途：血壓被每日防濫用上限擋下時，仍顯示「這筆沒存進去的讀數」的危險等級；危險級再加大字提示看護直接打電話給家屬（issue #1060）。
所在層：src/features/vitals/components；只負責呈現，不寫入、不通知、不暫存重送。
主要關聯：BpSaveNotices（儲存按鈕正下方的掛載點與 assertive live region 持有者，上限說明也由本元件一起呈現）、useBloodPressureInputForm（limitBlockedReading 快照）、
         VitalAlertBadge 與 useBpEvaluator（全 app 唯一一套判讀門檻）、ADR-011「影響與不變量」、docs/features/vitals.md。

為什麼需要它：被 trigger 擋下的 INSERT 不進資料庫、前端也不呼叫 notifier。原本畫面只說「已達上限」，
一筆 190/110 就這樣無聲消失（北極星鐵律 4）。上限是防濫用，被擋就是被擋——這裡刻意不提供重送，
只把等級講清楚，讓看護知道這一筆要自己打電話。
*/
import { alertTone, type AlertTone } from '../../../lib/alertPresentation'
import { useI18n } from '../../../lib/i18n'
import { L } from '../pages/InputPage.utils'
import { useBpEvaluator } from '../hooks/useBpEvaluator'
import { VitalAlertBadge } from './VitalAlertBadge'
import { VitalReading } from './VitalReading'

export interface LimitBlockedReading {
  /** 這筆讀數屬於哪位病人；hook 只在它等於目前病人時才交給畫面（AGENTS.md § 3.5，Codex review on PR #1092）。 */
  patientId: string
  systolic: number
  diastolic: number
  pulse: number
  /** 使用者按下儲存的時間；判讀要用這一刻生效的病人標準，與成功儲存時的 badge 同一個基準。 */
  measuredAt: string
}

// 「打電話給家屬」只對三個紅色階出現：與 alertPresentation 的視覺階一致，
// warning 與心跳琥珀不在此列——每一筆都叫看護打電話，會讓真正危險的那一次被忽略。
const CALL_FAMILY_TONES: ReadonlySet<AlertTone> = new Set(['danger', 'danger-low', 'critical'])

/** 這個階要不要請看護立刻打電話給家人；被上限擋下、又離開頁面的那筆在交給殼層時用它記下結論（issue #1117）。 */
export function isCallFamilyTone(tone: AlertTone): boolean {
  return CALL_FAMILY_TONES.has(tone)
}

export function BpLimitBlockedNotice({ reading, limitMessage }: { reading: LimitBlockedReading; limitMessage: string }) {
  const { text } = useI18n()
  const evaluator = useBpEvaluator()
  const tone = alertTone(evaluator.evaluateAt(reading.systolic, reading.diastolic, reading.pulse, reading.measuredAt))
  const callFamily = CALL_FAMILY_TONES.has(tone)

  return (
    // 本元件刻意不掛 role="alert"：live region 由外層 BpSaveNotices 統一持有（issue #1093），
    // 危險提示、上限說明與同時存在的家屬通知失敗才會在同一個 assertive region 裡依序唸出。
    // 各自掛 alert 時 VoiceOver／TalkBack 常只唸最後掛上的那一個，正好跟「先講危險、再講上限」相反。
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="flex flex-wrap items-center justify-center gap-1.5 text-sm font-semibold text-slate-700">
        <span>{text(L.limitBlockedLabel)}</span>
        {/* 數值走共用 VitalReading：紅／藍／紫的血壓配色與逐值的讀屏標籤（收縮壓、舒張壓、心跳）都要保留，
            危險提示裡唸成一串「185/105 · 80」反而聽不出哪個是哪個（Codex review on PR #1092）。
            單位字用 slate-500（issue #1162）：這則提示放在頁面底或白底上，對比 4.55～4.76:1，是剛好過 4.5:1 的最淡值，
            不要再調淡；若改放到警示或品牌淺色底上要換 slate-600（docs/platform/i18n-and-accessibility.md「文字對比」）。 */}
        <VitalReading systolic={reading.systolic} diastolic={reading.diastolic} pulse={reading.pulse} className="font-bold" unitClassName="text-slate-500" />
      </div>
      {/* badge 預設不換行；最高階的印尼文標籤加上行動文字比 375px 手機還寬，會撐出橫向捲動，
          所以這裡用 Tailwind v4 的 important 後綴讓它在自己這一行內換行（樣式來源仍是同一個 VitalAlertBadge）。 */}
      <VitalAlertBadge
        systolic={reading.systolic}
        diastolic={reading.diastolic}
        pulse={reading.pulse}
        measuredAt={reading.measuredAt}
        className="max-w-full flex-wrap justify-center text-center text-sm whitespace-normal!"
      />
      {callFamily && (
        <p data-call-family className="w-full rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-lg font-black leading-snug text-red-800">
          📞 {text(L.limitBlockedDanger)}
        </p>
      )}
      <p className="text-sm font-semibold text-red-600">{limitMessage}</p>
    </div>
  )
}
