/*
檔案用途：依血壓與心跳計算警示等級，輸出共用的彩色徽章（§4.2 的四階分級紅＋在目標內／低於目標）。
所在層：src/features/vitals/components；供 DashboardStatsCards「最新」列與 DailyBloodPressureRecords 每筆量測共用，
避免兩處各自維護一份等級判斷與樣式，導致「總覽」顯示偏高觀察，本照護日清單卻看不出同一筆量測的風險。
主要關聯：useBpEvaluator（取得這位病人在**量測當時**生效的標準）、
src/lib/alertPresentation.ts（全 app 唯一一份 chip 配色）、src/config/bp-levels.json（各級標籤文字）。
*/
import { Icon } from '../../../components/ui/Icon'
import { ALERT_BAR_CLASS, ALERT_CHIP_CLASS, ALERT_ICON, alertLabelText, alertTone } from '../../../lib/alertPresentation'
import { useI18n } from '../../../lib/i18n'
import { useBpEvaluator } from '../hooks/useBpEvaluator'

/**
 * `measuredAt` 是必填的：判讀要用**量測當時**生效的標準，不是「現在」的。
 * 少了它就只能用現在的標準重漆歷史，那正是 issue #897 的生效日期化要防止的事。
 */
export function VitalAlertBadge({
  systolic,
  diastolic,
  pulse,
  measuredAt,
  className = '',
}: {
  systolic: number
  diastolic: number
  pulse?: number | null
  measuredAt: string | Date
  className?: string
}) {
  const { text } = useI18n()
  const evaluator = useBpEvaluator()
  const evaluation = evaluator.evaluateAt(systolic, diastolic, pulse, measuredAt)
  const tone = alertTone(evaluation)
  // 為什麼預設可換行（issue #1096）：最高階的印尼文標籤在 375px 手機上單行就有 ~460px，
  // 原本的 whitespace-nowrap 讓整個 <main> 出現橫向捲動，照護者要左右滑才看得到最危急的那一句。
  // 兩個呼叫端都把徽章放在 flex-wrap 列裡，所以改在元件預設處理，不讓每個呼叫端各自覆寫。
  // rounded-2xl 而不是 rounded-full：單行時（高約 22px）圓角被夾到高度一半，看起來仍是膠囊；
  // 換成兩、三行時 rounded-full 會變成兩端半圓，把行首行尾的字切到底色外面。
  //
  // 最高階不再另外接 CRITICAL_ACTION_TEXT：critical 只會來自 hardFloorRule 的 danger_high，
  // 而它在 bp-levels.json 的標籤本身就以「需立即複測／ukur ulang segera／measure again immediately」結尾，
  // 再接一次就變成同一句指示講兩遍（§4.2 要的是「危險圖示＋立即複測」，不是兩次）。
  //
  // issue #1153：標籤裡的 emoji 留給推播，畫面上剝掉、改用 SVG 圖示（§4.4 chip 14px）。
  // 圖示 aria-hidden，意義由旁邊的文字承擔；shrink-0 讓長標籤換行時圖示不被壓扁。
  return (
    <span className={`inline-flex max-w-full items-center gap-1 rounded-2xl px-2.5 py-0.5 text-xs font-bold whitespace-normal ${ALERT_CHIP_CLASS[tone]} ${ALERT_BAR_CLASS[tone]} ${className}`}>
      <Icon name={ALERT_ICON[tone]} className="h-3.5 w-3.5 shrink-0" />
      {text(alertLabelText(evaluation.labels))}
    </span>
  )
}
