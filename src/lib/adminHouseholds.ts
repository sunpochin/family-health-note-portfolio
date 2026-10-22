/*
檔案用途：呼叫 admin-list-households／admin-set-household-entitlement Edge Function 並驗證回傳形狀（issue #1180，H6），
         供後台「家庭 Premium」分頁列出家庭、讀單一家庭稽核、開關家庭 Premium（含 #1202「招待並終止訂閱」與 409 衝突辨識）與切換全域 kill switch。
所在層：src/lib；純資料轉接層，不保存畫面狀態。
主要關聯：supabase/functions/admin-list-households、supabase/functions/admin-set-household-entitlement
         （白名單常數必須與兩支 Function 一致，tests/unit/adminHouseholdsAdapter.test.ts 鎖住）、
         supabase/functions/_shared/paidFeatureEntitlementPolicy.ts（前後端共用讀取點狀態）、
         src/features/system-admin/hooks/useHouseholdPremium.ts、src/lib/adminUsers.ts（同一種錯誤 status 保留寫法）。
*/
import { supabase } from './supabase'
import { HOUSEHOLD_PREMIUM_READER_LIVE, PAID_FEATURES, type PaidFeature } from '../../supabase/functions/_shared/paidFeatureEntitlementPolicy.ts'
// 保留既有 adapter 匯出介面，避免呼叫端改動；讀取點狀態本身則集中在前後端共用政策檔。
export { HOUSEHOLD_PREMIUM_READER_LIVE, PAID_FEATURES }
export type { PaidFeature }

// 與 Function 的白名單一致；前端這份只用來組請求與決定下拉選項，實際邊界仍在 Function 與 RPC 內。
export const HOUSEHOLD_ENTITLEMENT_REASONS = ['complimentary', 'trial', 'correction', 'revoked'] as const
export type HouseholdEntitlementReason = (typeof HOUSEHOLD_ENTITLEMENT_REASONS)[number]
// 開啟只能配這三個理由、關閉只能配這兩個；選單依目標狀態只列相容的理由，避免送出一定被 Function 拒絕的組合。
export const HOUSEHOLD_GRANT_REASONS: readonly HouseholdEntitlementReason[] = ['complimentary', 'trial', 'correction']
export const HOUSEHOLD_REVOKE_REASONS: readonly HouseholdEntitlementReason[] = ['revoked', 'correction']

export type AdminHousehold = {
  householdId: string
  name: string
  createdAt: string | null
  ownerEmails: string[]
  memberCount: number
  activePatientCount: number
  archivedPatientCount: number
  premiumTier: string
  premiumSource: string
  premiumUntil: string | null
  premiumEffective: boolean
  entitlementUpdatedAt: string | null
}

export type PaidFeatureSuspension = { feature: PaidFeature; suspendedAt: string | null }

export type AdminHouseholdsResponse = {
  households: AdminHousehold[]
  totalCount: number
  suspensions: PaidFeatureSuspension[]
}

export type HouseholdEntitlementChange = {
  id: string
  createdAt: string
  source: string
  actorEmail: string | null
  entitlement: string
  oldValue: string | null
  newValue: string
  reason: string
  newPremiumSource: string | null
  newPremiumUntil: string | null
}

export type HouseholdEntitlementChangesResponse = {
  householdId: string
  changes: HouseholdEntitlementChange[]
  truncated: boolean
}

export type SetHouseholdPremiumParams = {
  householdId: string
  premiumTier: 'premium' | 'none'
  reason: HouseholdEntitlementReason
  // 台灣日期 YYYY-MM-DD，當天整天有效；只有試用（或附日期的更正）才帶。
  trialEndsOn: string | null
  // 「招待並終止訂閱」（issue #1202）：只在管理者看過「此家庭有進行中的訂閱」並明確選擇後才是 true。
  cancelSubscription?: boolean
}

// Function 對「家庭有進行中的訂閱」回 409（issue #1202）；拋出的錯誤帶這個 code，畫面據此提供「招待並終止訂閱」。
export const SUBSCRIPTION_IN_PROGRESS = 'subscription_in_progress'

export function isSubscriptionInProgressError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === SUBSCRIPTION_IN_PROGRESS
}

// 「招待並終止訂閱」給的試用比已付費的期間先到期：Function 回 422（Codex review on PR #1210 P1）。
export const TRIAL_ENDS_BEFORE_PAID_PERIOD = 'trial_ends_before_paid_period'

export function isTrialEndsBeforePaidPeriodError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === TRIAL_ENDS_BEFORE_PAID_PERIOD
}

// 保留 HTTP status（例如 Function 回的 403）在拋出的錯誤上，讓 lib/dataErrors 的 isPermissionError
// 分辨得出「沒有權限」與一般失敗；FunctionsHttpError 的 status 只存在 error.context.status。
function functionError(message: string, error: unknown): Error {
  const status = typeof (error as { context?: { status?: unknown } })?.context?.status === 'number'
    ? (error as { context: { status: number } }).context.status
    : undefined
  return Object.assign(new Error(message), status !== undefined ? { status } : {})
}

export async function fetchAdminHouseholds(signal?: AbortSignal): Promise<AdminHouseholdsResponse> {
  const { data, error } = await supabase.functions.invoke('admin-list-households', { body: {}, signal })
  if (error) throw functionError('admin list households request failed', error)
  return parseAdminHouseholdsResponse(data)
}

export async function fetchHouseholdEntitlementChanges(householdId: string, signal?: AbortSignal): Promise<HouseholdEntitlementChangesResponse> {
  const { data, error } = await supabase.functions.invoke('admin-list-households', { body: { householdId }, signal })
  if (error) throw functionError('admin household changes request failed', error)
  return parseHouseholdEntitlementChangesResponse(data)
}

export async function setHouseholdPremium(params: SetHouseholdPremiumParams): Promise<void> {
  // trialEndsOn 為 null 時不送這個鍵：Function 對「關閉」與「招待」會拒絕任何到期日，送 null 雖然也接受，但少一個值就少一種誤解。
  const body: Record<string, unknown> = { action: 'set_household_entitlement', householdId: params.householdId, premiumTier: params.premiumTier, reason: params.reason }
  if (params.trialEndsOn) body.trialEndsOn = params.trialEndsOn
  // 只有 true 才送：終止訂閱不可復原，預設請求裡連這個鍵都不出現，Function 就一定走會預設拒絕的那條路。
  if (params.cancelSubscription === true) body.cancelSubscription = true
  const { error } = await supabase.functions.invoke('admin-set-household-entitlement', { body })
  if (error) {
    const failure = functionError('admin set household premium request failed', error)
    // 409 只有一個成因（Function 的 subscription_in_progress）；用 status 判斷，不必再非同步讀錯誤 body。
    // 這個假設由 tests/unit/adminSetHouseholdEntitlement.test.ts 鎖住：Function 原始碼裡只能有一處回 409。
    if ((failure as { status?: number }).status === 409) throw Object.assign(failure, { code: SUBSCRIPTION_IN_PROGRESS })
    // 422 同理只有一個成因（同一支測試鎖住）。
    if ((failure as { status?: number }).status === 422) throw Object.assign(failure, { code: TRIAL_ENDS_BEFORE_PAID_PERIOD })
    throw failure
  }
}

// 回傳寫入後「所有被暫停的功能」，畫面以它為準，不信任按下當下的樂觀狀態。
export async function setPaidFeatureSuspension(feature: PaidFeature, suspended: boolean): Promise<PaidFeature[]> {
  const { data, error } = await supabase.functions.invoke('admin-set-household-entitlement', {
    body: { action: 'set_paid_feature_suspension', feature, suspended },
  })
  if (error) throw functionError('admin set paid feature suspension request failed', error)
  const response = data as { suspendedFeatures?: unknown } | null
  if (!response || !Array.isArray(response.suspendedFeatures)) throw new Error('paid feature suspension response is invalid')
  return response.suspendedFeatures.filter(isPaidFeature)
}

export function isPaidFeature(value: unknown): value is PaidFeature {
  return typeof value === 'string' && (PAID_FEATURES as readonly string[]).includes(value)
}

// 為什麼即使是管理者專用畫面也要驗證形狀：Function 與前端各自部署，回應可能因版本落差或錯誤回應而變形；
// 這個畫面會據此開關付費權限，寧可整頁顯示「無法載入」，也不要把 undefined 畫成「免費」誤導管理者。
export function parseAdminHouseholdsResponse(value: unknown): AdminHouseholdsResponse {
  if (!value || typeof value !== 'object') throw new Error('admin households response is invalid')
  const response = value as { households?: unknown; totalCount?: unknown; suspensions?: unknown }
  if (!Array.isArray(response.households)) throw new Error('admin households list is invalid')
  if (typeof response.totalCount !== 'number') throw new Error('admin households total count is invalid')
  if (!Array.isArray(response.suspensions)) throw new Error('paid feature suspensions are invalid')
  return {
    households: response.households.map(parseAdminHousehold),
    totalCount: response.totalCount,
    // 未知的功能名稱直接丟掉而不是整頁失敗：kill switch 面板只畫已知的三個開關。
    suspensions: response.suspensions.flatMap(row => {
      const suspension = row as { feature?: unknown; suspendedAt?: unknown }
      if (!isPaidFeature(suspension.feature)) return []
      return [{ feature: suspension.feature, suspendedAt: typeof suspension.suspendedAt === 'string' ? suspension.suspendedAt : null }]
    }),
  }
}

function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string') throw new Error(`${field} is invalid`)
  return value
}

function parseAdminHousehold(value: unknown): AdminHousehold {
  if (!value || typeof value !== 'object') throw new Error('admin household row is invalid')
  const row = value as Record<string, unknown>
  if (typeof row.householdId !== 'string' || typeof row.name !== 'string') throw new Error('admin household row is invalid')
  if (!Array.isArray(row.ownerEmails) || !row.ownerEmails.every(email => typeof email === 'string')) throw new Error('admin household owners are invalid')
  for (const field of ['memberCount', 'activePatientCount', 'archivedPatientCount'] as const) {
    if (typeof row[field] !== 'number') throw new Error(`admin household ${field} is invalid`)
  }
  if (typeof row.premiumTier !== 'string' || typeof row.premiumSource !== 'string') throw new Error('admin household tier is invalid')
  if (typeof row.premiumEffective !== 'boolean') throw new Error('admin household premium effective flag is invalid')
  return {
    householdId: row.householdId,
    name: row.name,
    createdAt: nullableString(row.createdAt, 'admin household createdAt'),
    ownerEmails: row.ownerEmails as string[],
    memberCount: row.memberCount as number,
    activePatientCount: row.activePatientCount as number,
    archivedPatientCount: row.archivedPatientCount as number,
    premiumTier: row.premiumTier,
    premiumSource: row.premiumSource,
    premiumUntil: nullableString(row.premiumUntil, 'admin household premiumUntil'),
    premiumEffective: row.premiumEffective,
    entitlementUpdatedAt: nullableString(row.entitlementUpdatedAt, 'admin household entitlementUpdatedAt'),
  }
}

export function parseHouseholdEntitlementChangesResponse(value: unknown): HouseholdEntitlementChangesResponse {
  if (!value || typeof value !== 'object') throw new Error('household changes response is invalid')
  const response = value as { householdId?: unknown; changes?: unknown; truncated?: unknown }
  if (typeof response.householdId !== 'string' || !Array.isArray(response.changes) || typeof response.truncated !== 'boolean') {
    throw new Error('household changes response is invalid')
  }
  return {
    householdId: response.householdId,
    truncated: response.truncated,
    changes: response.changes.map(item => {
      if (!item || typeof item !== 'object') throw new Error('household change row is invalid')
      const row = item as Record<string, unknown>
      for (const field of ['id', 'createdAt', 'source', 'entitlement', 'newValue', 'reason'] as const) {
        if (typeof row[field] !== 'string') throw new Error(`household change ${field} is invalid`)
      }
      return {
        id: row.id as string,
        createdAt: row.createdAt as string,
        source: row.source as string,
        actorEmail: nullableString(row.actorEmail, 'household change actorEmail'),
        entitlement: row.entitlement as string,
        oldValue: nullableString(row.oldValue, 'household change oldValue'),
        newValue: row.newValue as string,
        reason: row.reason as string,
        newPremiumSource: nullableString(row.newPremiumSource, 'household change newPremiumSource'),
        newPremiumUntil: nullableString(row.newPremiumUntil, 'household change newPremiumUntil'),
      }
    }),
  }
}
