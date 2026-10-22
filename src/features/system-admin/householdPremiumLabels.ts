/*
檔案用途：後台「家庭 Premium」分頁（issue #1180，H6）的三語文案對照與時間格式化：理由、來源、稽核來源、權益名稱、
         kill switch 的三個功能名稱，以及「有效至」的台灣時間呈現。
所在層：src/features/system-admin；純資料與純函式，由 HouseholdPremiumPanel 及其子元件共用。
主要關聯：src/lib/adminHouseholds.ts（值域）、supabase/migrations/20261006102108_add_household_entitlements.sql
         （稽核 reason／source 的 CHECK 值域，這裡的 key 必須涵蓋它們，tests/unit/useHouseholdPremium.test.ts 的 labels 段鎖住）、
         src/features/system-admin/pages/AdminPage.tsx（使用者分頁沿用同一組理由譯名）。
*/
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import type { LocalizedText } from '../../lib/i18n'
import type { PaidFeature } from '../../lib/adminHouseholds'

dayjs.extend(utc)
dayjs.extend(timezone)

// 稽核表 reason 的完整值域（含只有金流／排程才會寫的理由），稽核檢視要能顯示每一種；後台可選的只有前四個。
// 前五個的譯名與使用者分頁的 ENTITLEMENT_REASON_LABELS 相同，管理者在兩個分頁看到的是同一套詞。
// 招待的印尼文用「hadiah（贈送）」而不是「undangan（邀請）」：後者和家庭邀請功能撞詞，徽章會讀成「因為被邀請所以免費」。
export const HOUSEHOLD_REASON_LABELS: Record<string, LocalizedText> = {
  complimentary: { id: 'Gratis (hadiah)', zh: '招待', en: 'Complimentary' },
  trial: { id: 'Uji coba', zh: '試用', en: 'Trial' },
  correction: { id: 'Koreksi data', zh: '更正登錄錯誤', en: 'Data correction' },
  revoked: { id: 'Dicabut', zh: '停權', en: 'Revoked' },
  paid: { id: 'Berbayar', zh: '付費', en: 'Paid' },
  payment_failed: { id: 'Pembayaran gagal', zh: '扣款失敗', en: 'Payment failed' },
  grace_expired: { id: 'Masa tenggang berakhir', zh: '寬限期結束', en: 'Grace period ended' },
  cancelled: { id: 'Langganan dibatalkan', zh: '取消訂閱', en: 'Subscription cancelled' },
  refunded: { id: 'Dana dikembalikan', zh: '退款', en: 'Refunded' },
  trial_expired: { id: 'Masa uji coba berakhir', zh: '試用到期', en: 'Trial ended' },
}

// premium_source 的值域；none 用「免費版」而不是「免費」，避免和理由「招待」（也是不收錢）混在一起。
export const HOUSEHOLD_SOURCE_LABELS: Record<string, LocalizedText> = {
  none: { id: 'Paket gratis', zh: '免費版', en: 'Free plan' },
  subscription: { id: 'Langganan', zh: '訂閱', en: 'Subscription' },
  complimentary: { id: 'Gratis (hadiah)', zh: '招待', en: 'Complimentary' },
  trial: { id: 'Uji coba', zh: '試用', en: 'Trial' },
}

// 稽核列的 source：誰觸發這次變更。
export const AUDIT_SOURCE_LABELS: Record<string, LocalizedText> = {
  admin: { id: 'Panel admin', zh: '後台', en: 'Admin panel' },
  payment_webhook: { id: 'Notifikasi pembayaran', zh: '付款通知', en: 'Payment notification' },
  cron: { id: 'Jadwal otomatis', zh: '排程', en: 'Scheduled job' },
  migration: { id: 'Migrasi basis data', zh: '資料庫遷移', en: 'Database migration' },
}

// 稽核列的 entitlement：每次開關會寫 premium_tier 一列，上限真的變了才再寫 care_recipient_limit 一列（上限由 tier 推導，後台不能改）。
export const AUDIT_ENTITLEMENT_LABELS: Record<string, LocalizedText> = {
  premium_tier: { id: 'Status Premium', zh: 'Premium 狀態', en: 'Premium status' },
  care_recipient_limit: { id: 'Batas penerima perawatan', zh: '被照顧者上限', en: 'Care recipient limit' },
}

export const PAID_FEATURE_LABELS: Record<PaidFeature, LocalizedText> = {
  medication_ai_draft: { id: 'Draf AI kantong obat', zh: 'AI 藥袋草稿', en: 'AI medication bag draft' },
  personal_notification_extras: { id: 'Tambahan notifikasi pribadi', zh: '個人化通知加值', en: 'Personal notification extras' },
  photo_retention_180: { id: 'Penyimpanan foto 180 hari', zh: '照片保存 180 天', en: '180-day photo retention' },
}

export const PREMIUM_TIER_VALUE_LABELS: Record<string, LocalizedText> = {
  premium: { id: 'Premium', zh: 'Premium', en: 'Premium' },
  none: HOUSEHOLD_SOURCE_LABELS.none,
}

export function labelOrRaw(labels: Record<string, LocalizedText>, key: string): LocalizedText {
  // 資料庫日後新增值域而前端還沒更新時，顯示原始值而不是空白：管理者至少看得到「有一筆不認得的紀錄」。
  return labels[key] ?? { id: key, zh: key, en: key }
}

export function formatTaipeiDateTime(value: string | null): string {
  if (!value) return '－'
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.tz('Asia/Taipei').format('YYYY-MM-DD HH:mm') : '－'
}

// premium_until 是「從這一刻起失效」；畫面顯示最後一個有效的分鐘，後台設的試用（隔天台灣 00:00 失效）就會顯示成當天 23:59，
// 與管理者選的「到期日（含當天）」一致，不會看起來多了一天。
// 減 1 毫秒而不是 1 分鐘（與 premiumUntilToTrialEndsOn 相同）：訂閱的到期時間不一定在整分上，
// 14:23:30 失效時最後有效的時刻在 14:23，減 1 分鐘會誤顯示成 14:22（#1196）。
export function formatPremiumValidThrough(premiumUntil: string | null): string {
  if (!premiumUntil) return '－'
  const parsed = dayjs(premiumUntil)
  return parsed.isValid() ? parsed.subtract(1, 'millisecond').tz('Asia/Taipei').format('YYYY-MM-DD HH:mm') : '－'
}

// 日期欄位的最小值：台灣的今天。Function 也會拒絕過去的日期，這裡只是讓日期挑選器一開始就不能選錯。
export function taipeiToday(now: Date = new Date()): string {
  return dayjs(now).tz('Asia/Taipei').format('YYYY-MM-DD')
}

// 日期欄位的最大值：台灣的今天＋MAX_TRIAL_DAYS 天，與 Function 的試用上限同一個數字（防手滑，超過一年請選招待）。
// 沒有這個上限時，挑太遠的日期只會拿到泛用的「無法儲存」，管理者看不出原因。
export const MAX_TRIAL_DAYS = 366
export function taipeiMaxTrialEndsOn(now: Date = new Date()): string {
  return dayjs(now).tz('Asia/Taipei').add(MAX_TRIAL_DAYS, 'day').format('YYYY-MM-DD')
}

// premium_until（從這一刻起失效）→ 後台日期欄位用的「到期日（含當天）」：最後一個有效時刻所在的台灣日期。
// 後台設的試用會還原成管理者當初選的那一天，草稿預設值與「有沒有改過」的比較都靠它。
export function premiumUntilToTrialEndsOn(premiumUntil: string): string | null {
  const parsed = dayjs(premiumUntil)
  return parsed.isValid() ? parsed.subtract(1, 'millisecond').tz('Asia/Taipei').format('YYYY-MM-DD') : null
}
