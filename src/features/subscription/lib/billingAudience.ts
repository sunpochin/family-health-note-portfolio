/*
檔案用途：決定「誰看得到帳務畫面、能做什麼」的純函式——付款人／家庭 owner 才看得到，看護（caregiver）、檢視者（viewer）與未登入者永遠看不到（#1185、monetization-plan §5.1 第 3 條、ADR-012 D7d）。
所在層：src/features/subscription/lib；無 React、無網路、無 Supabase，方便用單元測試窮舉角色矩陣。
主要關聯：components/SubscriptionBanner.tsx、SubscriptionSection.tsx、UpgradeDisclosure.tsx 都只問這個檔案，不自己判斷角色；src/lib/platform.ts（原生殼守門）。
*/
import { isNativeApp } from '../../../lib/platform'
import type { BillingViewer, SubscriptionStatus, SubscriptionSummary } from '../types'

// owner 5.6.1：續約前 7 天提醒一次。信由 P1 的 cron 寄，這裡只負責 App 內橫幅。
export const RENEWAL_REMINDER_DAYS = 7
// owner 5.6.2：寬限期 7 天。只用在購買前揭露文案；實際到期日一律用後端給的 graceUntil。
export const GRACE_PERIOD_DAYS = 7

export type BillingAudience = 'payer' | 'owner' | 'none'
export type BillingBannerKind = 'payer_left' | 'grace' | 'renewal_reminder'

// 「目前這張」訂閱的狀態（ADR-012 D6 的 partial UNIQUE 範圍）；終局狀態不算。
const CURRENT_STATUSES: readonly SubscriptionStatus[] = ['active', 'grace', 'cancel_requested', 'terminating', 'cancelled']
// 付款人刪帳號後，這些狀態還在用 Premium（家庭已付的這期照用），要提醒其餘 owner。
const ENTITLED_STATUSES: readonly SubscriptionStatus[] = ['active', 'grace', 'cancel_requested', 'cancelled']

export function isCurrentSubscription(subscription: SubscriptionSummary | null): subscription is SubscriptionSummary {
  return subscription !== null && CURRENT_STATUSES.includes(subscription.status)
}

/** 原生殼內任何購買相關控制項都不渲染（ADR-012 D9）；所有帳務元件都先過這一關。 */
export function isBillingUiAvailable(): boolean {
  return !isNativeApp()
}

/**
 * 這個人在帳務畫面上的身分。
 * 為什麼 userId 要先擋 null：payerUserId 在付款人刪帳號後也是 null，
 * 若不先擋，「未登入者」會與「付款人已離開」的 null === null 誤判成付款人，看見不該看的帳務畫面。
 */
export function resolveBillingAudience(viewer: BillingViewer, subscription: SubscriptionSummary | null): BillingAudience {
  if (viewer.userId === null) return 'none'
  // 付款人優先於角色，而且不看有沒有家庭角色：付款人可能後來被降成 caregiver、甚至被移出家庭，
  // 但他的卡還在被扣，必須還找得到訂閱畫面與取消入口（Codex review）；身分依據是訂閱列上的 payer_user_id，不是目前的成員資格。
  if (subscription !== null && subscription.payerUserId === viewer.userId) return 'payer'
  if (viewer.householdRole === 'owner') return 'owner'
  return 'none'
}

/** 建單（升級、更新付款方式）只接受該家庭目前的 owner（ADR-012 D8）；付款人若已不是 owner，按了只會被後端拒絕，所以不顯示。 */
export function canStartCheckout(viewer: BillingViewer): boolean {
  return viewer.userId !== null && viewer.householdRole === 'owner'
}

/**
 * 取消：付款人或家庭 owner 都可以，狀態是 active 或 grace。
 * 為什麼 grace 也能取消：P1 的 cancel_household_subscription 明確允許 grace（並記住 status_before_cancel，反悔時回到寬限）；
 * 寬限期內藍新可能仍會重試扣款，付款人想停止就必須有入口，購買頁也承諾「隨時可以取消」（Codex review）。
 */
export function canCancelSubscription(audience: BillingAudience, subscription: SubscriptionSummary | null): boolean {
  return audience !== 'none' && subscription !== null && (subscription.status === 'active' || subscription.status === 'grace')
}

/**
 * 撤回取消：只有付款人本人，只在請求還沒送出的 cancel_requested 窗口（owner 5.6.5、Codex 第四輪），而且取消必須是付款人或 owner 發起的。
 * 刪帳號、招待、退款發起的取消不可撤回（P1 的 resume_household_subscription 會拒絕），所以不顯示按鈕。owner 只有「取消」。
 */
export function canResumeSubscription(audience: BillingAudience, subscription: SubscriptionSummary | null): boolean {
  return audience === 'payer'
    && subscription !== null
    && subscription.status === 'cancel_requested'
    && (subscription.cancelReason === 'payer' || subscription.cancelReason === 'owner')
}

/**
 * Premium 實際可用到哪一天。
 * 為什麼寬限期要用 graceUntil：grace 的 currentPeriodEnd 是「扣款失敗的那個續約邊界」，Premium 仍照常到 graceUntil，
 * 用 currentPeriodEnd 會讓畫面少報最多 7 天（Codex review）。grace 但沒有 graceUntil 時回傳 null、由文案改用不帶日期的說法，
 * 不退回 currentPeriodEnd——寧可不寫日期，也不寫一個錯的日期。
 */
export function premiumEndsAt(subscription: SubscriptionSummary): string | null {
  return subscription.status === 'grace' ? subscription.graceUntil : subscription.currentPeriodEnd
}

export interface ResolveBannerInput {
  viewer: BillingViewer
  subscription: SubscriptionSummary | null
  now: Date
}

/** 同時只顯示一條，依嚴重度排序：付款人已離開 > 寬限 > 續約提醒。 */
export function resolveBillingBanner({ viewer, subscription, now }: ResolveBannerInput): BillingBannerKind | null {
  if (subscription === null) return null
  const audience = resolveBillingAudience(viewer, subscription)
  if (audience === 'none') return null

  // 付款人已刪帳號：只有其餘 owner 看得到（付款人本人已不存在，audience 必為 owner）。
  if (subscription.payerUserId === null) {
    return audience === 'owner' && ENTITLED_STATUSES.includes(subscription.status) ? 'payer_left' : null
  }
  if (subscription.status === 'grace') return 'grace'
  if (subscription.status === 'active' && isWithinRenewalWindow(subscription.currentPeriodEnd, now)) return 'renewal_reminder'
  return null
}

function isWithinRenewalWindow(periodEnd: string | null, now: Date): boolean {
  if (periodEnd === null) return false
  const end = Date.parse(periodEnd)
  if (Number.isNaN(end)) return false
  const remaining = end - now.getTime()
  return remaining >= 0 && remaining <= RENEWAL_REMINDER_DAYS * 24 * 60 * 60 * 1000
}
