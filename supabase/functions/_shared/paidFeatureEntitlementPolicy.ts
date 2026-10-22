/*
檔案用途：共用家庭 Premium 讀取點狀態與舊制帳號權益開通政策，讓管理頁和 Edge Function 使用同一份設定。
所在層：supabase/functions/_shared；由瀏覽器管理頁與 Supabase Edge Function 共用。
主要關聯：src/lib/adminHouseholds.ts、src/features/system-admin/pages/AdminPage.tsx、
         admin-set-account-entitlement、tests/unit/householdPremiumReaderLive.test.ts、
         tests/unit/adminSetAccountEntitlement.test.ts。
*/
export const PAID_FEATURES = ['medication_ai_draft', 'personal_notification_extras', 'photo_retention_180'] as const
export type PaidFeature = (typeof PAID_FEATURES)[number]

// 前端要顯示正確勾選狀態，伺服器也要擋住舊分頁送出的請求；共用這份設定才能避免兩層各自判斷而漂移。
export const HOUSEHOLD_PREMIUM_READER_LIVE: Readonly<Record<PaidFeature, boolean>> = {
  // H2 #1177 已接上：AI 草稿配額 trigger 與 medication-ai-draft Function 都改讀家庭 Premium 與 kill switch。
  medication_ai_draft: true,
  // H4 #1179 已接上：enqueue、drain 與 LINE 綁定都讀家庭 Premium，暫停也會蓋過舊旗標。
  personal_notification_extras: true,
  // H5 #1181 的首次貼圖 trigger 已接上家庭 Premium 與 kill switch，既有照片承諾不受暫停影響。
  photo_retention_180: true,
}

// 只有這兩個舊帳號旗標對應到家庭付費讀取點；目錄管理員是權限，帳號級 Premium 沒有讀取點。
export const LEGACY_ENTITLEMENT_FEATURE: Readonly<Partial<Record<string, PaidFeature>>> = {
  personal_notification_tier: 'personal_notification_extras',
  medication_ai_draft_tier: 'medication_ai_draft',
}

// 已接上的讀取點仍需保留撤銷既有 dual-read 權益的能力；只擋非 none 的新開通值。
export function isLegacyEntitlementGrantBlocked(entitlement: string, value: string): boolean {
  if (value === 'none') return false
  const feature = LEGACY_ENTITLEMENT_FEATURE[entitlement]
  return feature !== undefined && HOUSEHOLD_PREMIUM_READER_LIVE[feature]
}
