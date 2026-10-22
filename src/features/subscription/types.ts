/*
檔案用途：付款人 web 畫面（#1185，P3）用到的 view model 型別；刻意與資料庫欄位名脫鉤，由日後的資料層（P1／P2 合併後）負責把 RPC／表格列轉成這些形狀。
所在層：src/features/subscription 的型別層；只有型別，沒有執行期程式碼。
主要關聯：lib/billingAudience.ts（誰看得到什麼）、components/*（畫面）、docs/product/monetization-plan.md §5.2（狀態機）、docs/adr/012-household-entitlement-and-subscription-lifecycle.md D6。
*/
import type { HouseholdRole } from '../../lib/tenant'

// 與 P1 migration（20261006183520）的 household_subscriptions.status CHECK 逐字對齊（#1182）：
// 待付款不是訂閱狀態（訂單在 payment_orders），也沒有 expired；多一個 terminating＝取消請求已送出、等供應商確認。
// 終局狀態（downgraded／superseded）也要列，因為「目前這張」與「歷史列」會用同一個型別傳進來，畫面要能分辨。
export type SubscriptionStatus =
  | 'active'
  | 'grace'
  | 'cancel_requested'
  | 'terminating'
  | 'cancelled'
  | 'downgraded'
  | 'superseded'

// 誰發起的取消（P1 的 cancel_reason）：只有 payer／owner 發起的取消才能撤回，刪帳號、招待、退款發起的不行。
export type CancelReason = 'payer' | 'owner' | 'payer_deleted' | 'admin_grant' | 'refund'

export interface SubscriptionSummary {
  // 訂閱列 id：取消確認等「綁在某一張訂閱上」的畫面狀態要用它判斷對象是否換了。
  id: string
  status: SubscriptionStatus
  // null＝付款人已刪帳號（FK ON DELETE SET NULL）；不是「未知」，畫面要據此顯示「付款人已離開」。
  payerUserId: string | null
  currentPeriodEnd: string | null
  graceUntil: string | null
  // 非取消中的訂閱是 null。
  cancelReason: CancelReason | null
}

export interface BillingViewer {
  // null＝未登入，不得被當成付款人或 owner；householdRole 為 null＝不屬於這個家庭（例如付款人被移出）或尚未讀到，
  // 只有訂閱列的 payerUserId 吻合時才仍視為付款人，不會因此變成 owner。
  userId: string | null
  householdRole: HouseholdRole | null
}

export interface ReceiptRow {
  id: string
  paidAt: string
  amount: number
  currency: string
  periodStart: string | null
  periodEnd: string | null
  // 藍新訂單號；收據上要有它，付款人才能拿去跟藍新或客服對帳（monetization-plan §3.3）。
  providerOrderNo: string
}

// 方案內容由後端常數經 RPC 回傳（ticket：價格不硬編碼在前端或條款）；
// 配額數字也走同一條路，避免畫面上寫的「5 位」和 trigger 實際擋的上限日後漂移。
export interface PlanOffer {
  // 建單 RPC 要帶回去的方案代碼（premium_plan_offer 回傳的 plan_code）。
  planCode: string
  amount: number
  currency: string
  limits: {
    aiDraftDailyLimit: number
    careRecipientLimit: number
    photoRetentionDays: number
  }
  // 購買時使用者實際看到的條款版本，會寫進 payment_orders.terms_version。
  termsVersion: string
}

export interface CheckoutRequest {
  locale: 'zh' | 'id' | 'en'
  termsVersion: string
  // 型別寫死 true：沒有勾選七日解除權例外的獨立勾選框就不可能呼叫到這裡（owner 6.5.2）。
  refundWaiverAccepted: true
}
