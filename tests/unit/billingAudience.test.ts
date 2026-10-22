/*
檔案用途：窮舉帳務畫面的「角色顯示矩陣」（#1185 完成條件 1）——付款人／owner 看得到，caregiver／viewer／未登入永遠看不到；撤回取消只給付款人；建單只給 owner；原生殼整個關閉。
所在層：tests/unit；純函式測試，不渲染元件。
主要關聯：src/features/subscription/lib/billingAudience.ts、src/features/subscription/types.ts。
*/
import { describe, expect, mock, test } from 'bun:test'

let nativeApp = false
mock.module('../../src/lib/platform', () => ({
  isNativeApp: () => nativeApp,
  isStandalonePwa: (displayModeMatches: boolean, navigatorStandalone = false) => displayModeMatches || navigatorStandalone,
  readIsStandalonePwa: () => false,
  getNativePlatform: () => 'web',
}))

const policy = await import('../../src/features/subscription/lib/billingAudience')
const { premiumEndsAt, resolveBillingAudience, resolveBillingBanner, canCancelSubscription, canResumeSubscription, canStartCheckout, isBillingUiAvailable } = policy
import type { BillingViewer, SubscriptionStatus, SubscriptionSummary } from '../../src/features/subscription/types'

const NOW = new Date('2026-11-01T00:00:00Z')
const PAYER = 'payer-user'
const OWNER = 'owner-user'
const CAREGIVER = 'caregiver-user'
const VIEWER = 'viewer-user'

const viewers: Record<string, BillingViewer> = {
  payer: { userId: PAYER, householdRole: 'owner' },
  payerDemotedToCaregiver: { userId: PAYER, householdRole: 'caregiver' },
  owner: { userId: OWNER, householdRole: 'owner' },
  caregiver: { userId: CAREGIVER, householdRole: 'caregiver' },
  viewer: { userId: VIEWER, householdRole: 'viewer' },
  loggedOut: { userId: null, householdRole: null },
  noRoleYet: { userId: OWNER, householdRole: null },
}

function subscription(status: SubscriptionStatus, overrides: Partial<SubscriptionSummary> = {}): SubscriptionSummary {
  return { id: 'sub-1', status, cancelReason: null, payerUserId: PAYER, currentPeriodEnd: '2026-11-20T00:00:00Z', graceUntil: '2026-11-08T00:00:00Z', ...overrides }
}

describe('resolveBillingAudience', () => {
  test('payer and owner are recognised; caregiver, viewer and logged-out never are', () => {
    const sub = subscription('active')
    expect(resolveBillingAudience(viewers.payer, sub)).toBe('payer')
    expect(resolveBillingAudience(viewers.owner, sub)).toBe('owner')
    expect(resolveBillingAudience(viewers.caregiver, sub)).toBe('none')
    expect(resolveBillingAudience(viewers.viewer, sub)).toBe('none')
    expect(resolveBillingAudience(viewers.loggedOut, sub)).toBe('none')
    expect(resolveBillingAudience(viewers.noRoleYet, sub)).toBe('none')
  })

  test('the payer stays the payer after being demoted to caregiver (RLS still lets them read their own row)', () => {
    expect(resolveBillingAudience(viewers.payerDemotedToCaregiver, subscription('active'))).toBe('payer')
  })

  test('a payer who was removed from the household (no role) still finds their subscription, but never becomes an owner', () => {
    // 被移出家庭的付款人卡還在扣；身分依據是訂閱列的 payer_user_id，不是目前的成員資格。
    const removedPayer: BillingViewer = { userId: PAYER, householdRole: null }
    expect(resolveBillingAudience(removedPayer, subscription('active'))).toBe('payer')
    expect(canStartCheckout(removedPayer)).toBe(false)
    expect(canCancelSubscription('payer', subscription('active'))).toBe(true)
    // 沒有角色、也不是付款人的人（例如還在載入的 owner）仍然什麼都看不到。
    expect(resolveBillingAudience({ userId: OWNER, householdRole: null }, subscription('active'))).toBe('none')
  })

  test('a deleted payer (null payerUserId) never matches a logged-out viewer (null userId)', () => {
    // null === null 是這個矩陣最容易踩的坑：未登入者不能因此被當成「付款人已離開」那一列的付款人。
    const orphan = subscription('active', { payerUserId: null })
    expect(resolveBillingAudience(viewers.loggedOut, orphan)).toBe('none')
    expect(resolveBillingAudience({ userId: null, householdRole: 'owner' }, orphan)).toBe('none')
    expect(resolveBillingAudience(viewers.owner, orphan)).toBe('owner')
  })

  test('with no subscription yet, only an owner has an audience (to reach the upgrade page)', () => {
    expect(resolveBillingAudience(viewers.owner, null)).toBe('owner')
    expect(resolveBillingAudience(viewers.caregiver, null)).toBe('none')
    expect(resolveBillingAudience(viewers.viewer, null)).toBe('none')
  })
})

describe('premiumEndsAt', () => {
  test('grace lasts until graceUntil, every other state until currentPeriodEnd', () => {
    // 寬限期的 currentPeriodEnd 是扣款失敗的續約邊界，Premium 實際用到 graceUntil（比它晚最多 7 天）。
    expect(premiumEndsAt(subscription('grace'))).toBe('2026-11-08T00:00:00Z')
    expect(premiumEndsAt(subscription('active'))).toBe('2026-11-20T00:00:00Z')
    expect(premiumEndsAt(subscription('cancelled'))).toBe('2026-11-20T00:00:00Z')
  })

  test('grace without graceUntil gives no date at all rather than the too-early period end', () => {
    expect(premiumEndsAt(subscription('grace', { graceUntil: null }))).toBeNull()
  })
})

describe('resolveBillingBanner (role × state matrix)', () => {
  const states: SubscriptionStatus[] = ['active', 'grace', 'cancel_requested', 'terminating', 'cancelled', 'downgraded', 'superseded']

  test('caregiver, viewer and logged-out never get any banner in any state', () => {
    for (const status of states) {
      for (const orphan of [false, true]) {
        const sub = subscription(status, orphan ? { payerUserId: null, currentPeriodEnd: '2026-11-03T00:00:00Z' } : { currentPeriodEnd: '2026-11-03T00:00:00Z' })
        for (const name of ['caregiver', 'viewer', 'loggedOut', 'noRoleYet'] as const) {
          expect(resolveBillingBanner({ viewer: viewers[name], subscription: sub, now: NOW })).toBeNull()
        }
      }
    }
  })

  test('grace banner shows to the payer and to owners', () => {
    const sub = subscription('grace')
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: sub, now: NOW })).toBe('grace')
    expect(resolveBillingBanner({ viewer: viewers.owner, subscription: sub, now: NOW })).toBe('grace')
    expect(resolveBillingBanner({ viewer: viewers.payerDemotedToCaregiver, subscription: sub, now: NOW })).toBe('grace')
  })

  test('payer-left banner shows to owners only, for every state that still carries Premium', () => {
    for (const status of ['active', 'grace', 'cancel_requested', 'cancelled'] as const) {
      expect(resolveBillingBanner({ viewer: viewers.owner, subscription: subscription(status, { payerUserId: null }), now: NOW })).toBe('payer_left')
    }
    for (const status of ['terminating', 'downgraded', 'superseded'] as const) {
      expect(resolveBillingBanner({ viewer: viewers.owner, subscription: subscription(status, { payerUserId: null }), now: NOW })).toBeNull()
    }
  })

  test('renewal reminder only inside the 7 days before the period end, only while active', () => {
    const inside = subscription('active', { currentPeriodEnd: '2026-11-06T00:00:00Z' })
    const outside = subscription('active', { currentPeriodEnd: '2026-11-20T00:00:00Z' })
    const past = subscription('active', { currentPeriodEnd: '2026-10-31T00:00:00Z' })
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: inside, now: NOW })).toBe('renewal_reminder')
    expect(resolveBillingBanner({ viewer: viewers.owner, subscription: inside, now: NOW })).toBe('renewal_reminder')
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: outside, now: NOW })).toBeNull()
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: past, now: NOW })).toBeNull()
    // 已要求取消或已取消的訂閱不會續約，不能再提醒「即將扣款」。
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: subscription('cancel_requested', { currentPeriodEnd: '2026-11-06T00:00:00Z' }), now: NOW })).toBeNull()
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: subscription('cancelled', { currentPeriodEnd: '2026-11-06T00:00:00Z' }), now: NOW })).toBeNull()
    expect(resolveBillingBanner({ viewer: viewers.payer, subscription: subscription('active', { currentPeriodEnd: 'not-a-date' }), now: NOW })).toBeNull()
  })

  test('no subscription means no banner', () => {
    expect(resolveBillingBanner({ viewer: viewers.owner, subscription: null, now: NOW })).toBeNull()
  })
})

describe('actions', () => {
  test('owners and the payer can cancel an active subscription; nobody else', () => {
    const sub = subscription('active')
    expect(canCancelSubscription(resolveBillingAudience(viewers.payer, sub), sub)).toBe(true)
    expect(canCancelSubscription(resolveBillingAudience(viewers.owner, sub), sub)).toBe(true)
    expect(canCancelSubscription(resolveBillingAudience(viewers.caregiver, sub), sub)).toBe(false)
    expect(canCancelSubscription(resolveBillingAudience(viewers.viewer, sub), sub)).toBe(false)
    expect(canCancelSubscription(resolveBillingAudience(viewers.loggedOut, sub), sub)).toBe(false)
    expect(canCancelSubscription('payer', subscription('cancel_requested'))).toBe(false)
  })

  test('only the payer may undo a cancellation, and only while it is still cancel_requested (owners only get "cancel")', () => {
    const requested = subscription('cancel_requested', { cancelReason: 'payer' })
    expect(canResumeSubscription(resolveBillingAudience(viewers.payer, requested), requested)).toBe(true)
    expect(canResumeSubscription(resolveBillingAudience(viewers.payerDemotedToCaregiver, requested), requested)).toBe(true)
    expect(canResumeSubscription(resolveBillingAudience(viewers.owner, requested), requested)).toBe(false)
    expect(canResumeSubscription(resolveBillingAudience(viewers.caregiver, requested), requested)).toBe(false)
    // 藍新委託已終止後無法恢復，只能重新建單（owner 5.6.5）；請求已送出（terminating）也不行。
    expect(canResumeSubscription('payer', subscription('cancelled'))).toBe(false)
    expect(canResumeSubscription('payer', subscription('terminating', { cancelReason: 'payer' }))).toBe(false)
  })

  test('a cancellation started by account deletion, a complimentary grant or a refund cannot be undone', () => {
    // P1 的 resume_household_subscription 只接受 payer／owner 發起的取消，其餘會拒絕；不顯示按鈕才不會讓付款人按了才被擋。
    for (const reason of ['payer_deleted', 'admin_grant', 'refund'] as const) {
      expect(canResumeSubscription('payer', subscription('cancel_requested', { cancelReason: reason }))).toBe(false)
    }
    expect(canResumeSubscription('payer', subscription('cancel_requested', { cancelReason: 'owner' }))).toBe(true)
    expect(canResumeSubscription('payer', subscription('cancel_requested', { cancelReason: null }))).toBe(false)
  })

  test('cancel is offered during grace too (P1 cancel_household_subscription allows active and grace)', () => {
    for (const name of ['payer', 'owner'] as const) {
      const sub = subscription('grace')
      expect(canCancelSubscription(resolveBillingAudience(viewers[name], sub), sub)).toBe(true)
    }
    const sub = subscription('grace')
    expect(canCancelSubscription(resolveBillingAudience(viewers.caregiver, sub), sub)).toBe(false)
    // 已經在取消流程裡的狀態不能再取消一次。
    expect(canCancelSubscription('payer', subscription('cancel_requested'))).toBe(false)
    expect(canCancelSubscription('payer', subscription('terminating'))).toBe(false)
  })

  test('checkout is owner-only (the order RPC rejects anyone else)', () => {
    expect(canStartCheckout(viewers.owner)).toBe(true)
    expect(canStartCheckout(viewers.payer)).toBe(true)
    expect(canStartCheckout(viewers.payerDemotedToCaregiver)).toBe(false)
    expect(canStartCheckout(viewers.caregiver)).toBe(false)
    expect(canStartCheckout(viewers.viewer)).toBe(false)
    expect(canStartCheckout(viewers.loggedOut)).toBe(false)
  })
})

describe('native shell', () => {
  test('billing UI is unavailable inside the native shell', () => {
    nativeApp = false
    expect(isBillingUiAvailable()).toBe(true)
    nativeApp = true
    expect(isBillingUiAvailable()).toBe(false)
    nativeApp = false
  })
})
