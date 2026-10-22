/*
檔案用途：帳務畫面的金額與日期顯示；金額一律是後端傳來的數字與幣別，前端只負責依語言格式化，不自己決定價格。
所在層：src/features/subscription/lib 純函式層。
主要關聯：components/UpgradeDisclosure.tsx、SubscriptionSection.tsx、SubscriptionBanner.tsx。
*/
import type { Locale } from '../../../lib/i18n'

const LOCALE_TAGS: Record<Locale, string> = { zh: 'zh-TW', id: 'id-ID', en: 'en-US' }

export function formatMoney(amount: number, currency: string, locale: Locale): string {
  try {
    // 金額是整數元；TWD 不顯示小數，避免出現「NT$300.00」讓付款人以為有零頭。
    return new Intl.NumberFormat(LOCALE_TAGS[locale], { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount)
  } catch {
    // 後端若傳來不合法的幣別代碼，寧可顯示「幣別 數字」也不要讓整張購買頁掛掉。
    return `${currency} ${amount}`
  }
}

/**
 * 把後端給的 ISO 時間顯示成日期。
 * 固定用 Asia/Taipei 切日：藍新的扣款日與到期日以台灣日曆為準，用裝置時區會讓海外付款人看到差一天的到期日。
 * 無法解析時回傳 null，由呼叫端改用不帶日期的文案，不顯示 "Invalid Date"。
 */
export function formatBillingDate(iso: string | null, locale: Locale): string | null {
  if (iso === null) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], { dateStyle: 'medium', timeZone: 'Asia/Taipei' }).format(parsed)
}
