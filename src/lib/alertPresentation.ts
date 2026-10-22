/*
檔案用途：把一筆判讀結果換成**全 app 唯一一份**的視覺規格——chip 樣式、左側色條、圖示、
        按鈕底色。issue #898 §4.3 要收斂的四個 class map 全部從這裡取值。
所在層：src/lib 展示規則層；純資料與純函式，不 import React、不碰 Supabase，可直接單元測試。
主要關聯：VitalAlertBadge、RecordReport、DashboardChart、DashboardStatsCards、InputPage、ShareSummaryBloodPressureSection、
        src/components/ui/Icon.tsx（ALERT_ICON 的圖示名稱）、
        docs/product/blood-pressure-standard-templates.md §4.2／§4.3。

為什麼要有這一份：同一組等級原本散在四個檔案各自維護，新增 off-target／below-target 時
只要漏改一處，同一筆讀數就會「總覽紅、清單綠」。收斂之後每個表都是 Record<AlertTone, …>，
少一個 tone 直接編譯失敗，不會靜默沿用舊配色。
*/
import type { IconName } from '../components/ui/Icon'
import type { AlertLevel, BpRule } from '../types/database/bpStandard'
import type { LocalizedText } from './i18n'

/**
 * 視覺階（§4.2）。刻意比 AlertLevel 多兩階，因為顏色要分辨的事情比判讀等級多兩件：
 *
 * - `critical` vs `danger`：兩者的 webAlertLevel 都是 'danger'，但 180/120 是「現在就打電話」、
 *   165/95 是「今天內回報醫師」。用同一個紅講這兩件事正是 §4.1 要避免的警報疲乏。
 * - `on-target` vs `normal`：兩者的 webAlertLevel 都是 'normal'，但「在目標內」是對著醫囑目標
 *   說的正向回饋，「正常」只是沒有落在任何警示帶。目標制模板要看得出醫囑有被達成。
 * - `pulse-warning`：血壓本身沒到警示級、只是心跳 >120 時，用心跳自己的琥珀，不借用血壓的紅。
 *   「紅＝血壓」是全 app 一致的語彙（AGENTS.md 規定收縮壓數字永遠紅），讓心跳快也變紅
 *   會讓照護者以為血壓出事。
 */
export type AlertTone =
  | 'on-target'
  | 'normal'
  | 'below-target'
  | 'warning-low'
  | 'danger-low'
  | 'off-target'
  | 'pulse-warning'
  | 'warning'
  | 'danger'
  | 'critical'

/** 判讀結果中決定視覺階所需的最小欄位；刻意不收整個 ReadingEvaluation，方便測試直接餵字面值。 */
export interface TonedEvaluation {
  level: AlertLevel
  bpRule: Pick<BpRule, 'key' | 'webAlertLevel'>
  pulseWarning: boolean
}

export function alertTone(evaluation: TonedEvaluation): AlertTone {
  const bpLevel = evaluation.bpRule.webAlertLevel as AlertLevel
  // hard floor 的最高階單獨一個視覺階；它是唯一標籤自帶行動文字的一級（見檔尾說明）。
  if (evaluation.bpRule.key === 'danger_high') return 'critical'
  // evaluateReading 在血壓未達危險級時會被心跳 >120 推上 'warning'。
  // 這時 level 與血壓自己的等級不一致，紅色的理由不成立，改用心跳自己的階。
  if (evaluation.level !== bpLevel) return 'pulse-warning'
  if (bpLevel === 'normal') return evaluation.bpRule.key === 'on_target' ? 'on-target' : 'normal'
  return bpLevel as AlertTone
}

/**
 * 只拿得到 AlertLevel（沒有規則 key）的呼叫點用的退化版本。
 *
 * 它分不出 critical 與 danger、也分不出 on-target 與 normal——**這正是不該用它的理由**。
 * 新的呼叫點請傳完整的判讀結果給 alertTone()；這裡保留是為了統計卡那種「先分桶再上色」
 * 的既有資料流（DashboardSummary.alertCounts 的 key 就是 AlertLevel）。
 */
export function alertToneFromLevel(level: AlertLevel): AlertTone {
  return level === 'normal' ? 'normal' : (level as AlertTone)
}

// ---------------------------------------------------------------------------
// §4.2 規格表
// ---------------------------------------------------------------------------
// 視覺階梯的讀法：外框 → 實心 → 實心＋色條 → 深實心＋色條＋行動文字。
// 灰階（或紅綠色盲）下靠填充面積與色條仍能分辨四階，不靠顏色單獨傳達。
// 顏色全部取自 src/index.css 的 @theme 語意 token（brand／danger／warn）與 Tailwind 內建
// red-200 #FECACA／amber-200 #FDE68A／red-800 #991B1B——後三者的色值與規格表逐字相同，
// 所以不需要為了外框與色條新增第七個紅（§4.2「不新增色票」）。

/** 狀態 chip（badge、圖表 tooltip、報告列共用的主要載體）。 */
export const ALERT_CHIP_CLASS: Record<AlertTone, string> = {
  'on-target': 'bg-brand-50 text-brand-700 border border-brand-200',
  normal: 'bg-emerald-700 text-white border border-transparent',
  'below-target': 'bg-warn-50 text-warn-700 border border-amber-200',
  'warning-low': 'bg-orange-700 text-white border border-transparent',
  'danger-low': 'bg-red-600 text-white border border-transparent',
  'off-target': 'bg-danger-50 text-danger-700 border border-red-200',
  'pulse-warning': 'bg-orange-700 text-white border border-transparent',
  warning: 'bg-danger-700 text-white border border-transparent',
  danger: 'bg-danger-700 text-white border border-transparent',
  critical: 'bg-red-800 text-white border border-transparent',
}

/**
 * 危險級的左側 4px 色條（clinical-care-ops-ui-design.md §4.4）。
 *
 * 這是 danger 與 warning 在灰階下唯一的差別——兩者底色同為 `--color-danger-700`，
 * 色條是第二個可疊加訊號。沒有色條的階回傳空字串而不是 undefined，
 * 讓呼叫端可以無條件串進 className。
 *
 * 為什麼一併帶 `rounded-l-none`：chip 本身是 rounded-md／rounded-full，只有左邊框時瀏覽器會把
 * 4px 沿著圓角彎成一道上下尖、中間粗的彎月形，照護者看起來像顏色溢出的 bug，而不是刻意的色條。
 * 左側兩角改直角後色條才是一條直線；右側圓角維持不動。放在這裡而不是各呼叫端，
 * 是因為三個呼叫端（VitalAlertBadge、RecordReport、DashboardChart）都有同樣的問題，漏改一處就會回來。
 */
const DANGER_BAR = 'border-l-4 border-l-red-800 rounded-l-none'

export const ALERT_BAR_CLASS: Record<AlertTone, string> = {
  'on-target': '',
  normal: '',
  'below-target': '',
  'warning-low': '',
  'danger-low': DANGER_BAR,
  'off-target': '',
  'pulse-warning': '',
  warning: '',
  danger: DANGER_BAR,
  critical: DANGER_BAR,
}

/**
 * 列印／淺底版本。報告要印在紙上，實心深紅會吃墨而且多數家用印表機會糊成一塊黑，
 * 所以紙本走淺底，但**保留同一組色條**，四階的階梯在灰階列印下仍然成立。
 */
export const ALERT_SOFT_CHIP_CLASS: Record<AlertTone, string> = {
  'on-target': 'bg-brand-50 text-brand-700',
  normal: 'bg-emerald-100 text-emerald-800',
  'below-target': 'bg-warn-50 text-warn-700',
  'warning-low': 'bg-orange-100 text-orange-800',
  'danger-low': 'bg-red-100 text-red-800',
  'off-target': 'bg-danger-50 text-danger-700',
  'pulse-warning': 'bg-orange-100 text-orange-800',
  warning: 'bg-red-100 text-red-800',
  danger: 'bg-red-100 text-red-800',
  critical: 'bg-red-200 text-red-900',
}

/**
 * 輸入當下的即時回饋：送出按鈕的底色。
 *
 * 刻意與 chip 分開維護（issue #898 handoff）：按鈕是動作、chip 是狀態。
 * 為了統一而讓送出按鈕變成一條警示色條，會讓照護者不知道那裡還能不能按。
 * 收斂的是「同一個 tone 對應同一個嚴重度」，不是「所有地方長得一樣」。
 */
export const ALERT_BUTTON_CLASS: Record<AlertTone, string> = {
  'on-target': 'bg-brand-700 active:bg-emerald-800',
  // issue #1153：原本 green-600 白字只有 3.30:1，按鈕字 18px 粗體還差一點才算大字，不能靠例外過關。
  // green-700 白字 4.95:1（Tailwind v4 實際渲染 #008236，不是 issue 引用的 v3 #15803D）。它與 on-target 的 brand-700（#047857）都是深綠、明度相近，
  // 但兩者不會出現在同一位病人身上：normal 只來自一般成人九級表，on-target 只來自目標制模板
  // （tests/unit/alertPresentation.test.ts 鎖住這件事）。真正要分開的「在目標內 vs 正常」靠 chip 的外框／實心。
  normal: 'bg-green-700 active:bg-green-800',
  'below-target': 'bg-warn-700 active:bg-amber-800',
  // orange-600 白字只有 3.56:1，與 green-600 同一個缺陷（驗收寫的是「送出鈕白字 ≥4.5:1」，不只 normal 一階）；
  // 改成與 chip 同一個 orange-700（v4 #CA3500，5.22:1）。測試逐階算對比，新加的階也會被檢查。
  'warning-low': 'bg-orange-700 active:bg-orange-800',
  'danger-low': 'bg-red-600 active:bg-red-700',
  'off-target': 'bg-danger-700 active:bg-red-800',
  'pulse-warning': 'bg-orange-700 active:bg-orange-800',
  warning: 'bg-danger-700 active:bg-red-800',
  danger: 'bg-danger-700 active:bg-red-800',
  critical: 'bg-red-800 active:bg-red-900',
}

/**
 * 統計卡的容器底色（DashboardStatsCards 的「最新」與「平均」卡）。
 *
 * 也收進這一份，是因為它原本只認得 danger／warning／normal 三個分支，其餘一律落到白底：
 * 新的 off-target 會讓總覽卡維持白色、旁邊的 chip 卻是紅的，正是 §4.3 要消滅的「總覽綠、清單紅」。
 * 容器是大面積，所以用最淡的一階；強度仍由卡片裡的 chip 表達。
 */
export const ALERT_CARD_CLASS: Record<AlertTone, string> = {
  'on-target': 'bg-brand-50/40 border-brand-200',
  normal: 'bg-emerald-50/30 border-emerald-100',
  'below-target': 'bg-warn-50/60 border-amber-200',
  'warning-low': 'bg-orange-50/70 border-orange-200',
  'danger-low': 'bg-red-50/75 border-red-200',
  'off-target': 'bg-danger-50/70 border-red-200',
  'pulse-warning': 'bg-orange-50/70 border-orange-200',
  warning: 'bg-danger-50/70 border-red-200',
  danger: 'bg-red-50/75 border-red-200',
  critical: 'bg-red-100/80 border-red-300',
}

/**
 * chip、輸入頁摘要列與報告手機欄位用的 SVG 圖示名稱（§4.4「chip 一律圖示＋文字」）。
 *
 * issue #1153 從 emoji 換成 `<Icon name />`：emoji 在 iOS／Android／Windows 長得不一樣，也無法用 token 控對比。
 * 一對一沿用舊 emoji 的語意，不藉機重排：上／下箭頭（原 🔺🔻）在灰階與紅綠色盲下仍能指出「往哪邊偏」；
 * 八角形（原 🔴）只給兩個危險級，與三角驚嘆號（原 ⚠️）在灰階下靠外形分開。
 * 這裡只存名稱字串，不 import React 元件，本檔維持純資料、可直接單元測試。
 */
export const ALERT_ICON: Record<AlertTone, IconName> = {
  'on-target': 'target',
  normal: 'check-circle',
  'below-target': 'arrow-down-circle',
  'warning-low': 'alert-triangle',
  'danger-low': 'alert-octagon',
  'off-target': 'arrow-up-circle',
  'pulse-warning': 'heart-pulse',
  warning: 'alert-triangle',
  danger: 'alert-triangle',
  critical: 'alert-octagon',
}

// Extended_Pictographic 涵蓋 🔴⚠✅🟡🎯🔺🔻 等；後面可能跟著 VS16（U+FE0F）與空白，一起吃掉才不會留下孤立的變體選擇符或雙空白。
const LABEL_EMOJI = /\p{Extended_Pictographic}️?\s*/gu

/**
 * 把 bp-levels.json／心跳警示標籤裡的 emoji 拿掉，只留文字，給**畫面**用。
 *
 * 為什麼不直接改 bp-levels.json（issue #1153 的決定）：同一份標籤會經 scripts/sync-bp-rules-to-edge.ts
 * 同步到 Edge Function，成為 Telegram 推播文字；純文字通道畫不出 SVG，emoji 是那裡唯一的視覺分級。
 * 改 JSON 等於動血壓警報鏈，還要重新部署 blood-pressure-notifier 並在 staging 實收驗證，
 * 這張票只處理畫面，所以推播原樣保留，畫面在顯示時剝除並改由 ALERT_ICON 的 SVG 補上圖示。
 * 文字匯出（recordReport.ts 的 formatRecordStatus）同屬純文字通道，也刻意不剝。
 */
export function alertLabelText(labels: LocalizedText): LocalizedText {
  const strip = (value: string) => value.replace(LABEL_EMOJI, '').trim()
  return { zh: strip(labels.zh), id: strip(labels.id), en: strip(labels.en) }
}

// 只有最高階附行動文字（§4.2）。行動文字就寫在 bp-levels.json danger_high 的標籤裡
// （「需立即複測／ukur ulang segera／measure again immediately」），這裡**刻意不再**另存一份常數：
// 舊版的 CRITICAL_ACTION_TEXT 被 VitalAlertBadge 接在標籤後面，同一句指示顯示兩遍（issue #1096）。
// 每一階都掛一句「請這樣做」會讓照護者整頁都是指示、反而不讀；
// 其餘各階的建議由 bp-levels.json 的 recommendations 在報告與詳情處提供，不擠進 chip。
