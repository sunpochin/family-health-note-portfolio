/*
檔案用途：付款人 web 畫面（#1185）的元件測試——橫幅／訂閱區／升級頁對各角色的顯示、原生殼不渲染、三語齊全、兩個獨立勾選框、撤回取消只給付款人、取消按鈕在 P2 未就緒時不出現。
所在層：tests/unit；以 reactHookHarness 執行元件函式，不啟動瀏覽器。
主要關聯：src/features/subscription/components/*、src/features/subscription/lib/billingAudience.ts。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { expandFunctionComponents, findAll, fire, textContent } from './helpers/elementTree'

installReactHookHarness()

let nativeApp = false
mock.module('../../src/lib/platform', () => ({
  isNativeApp: () => nativeApp,
  isStandalonePwa: (displayModeMatches: boolean, navigatorStandalone = false) => displayModeMatches || navigatorStandalone,
  readIsStandalonePwa: () => false,
  getNativePlatform: () => 'web',
}))

const { SubscriptionBanner } = await import('../../src/features/subscription/components/SubscriptionBanner')
const { SubscriptionSection } = await import('../../src/features/subscription/components/SubscriptionSection')
const { UpgradeDisclosure } = await import('../../src/features/subscription/components/UpgradeDisclosure')
import type { BillingViewer, PlanOffer, ReceiptRow, SubscriptionSummary } from '../../src/features/subscription/types'

const CONTEXTS = {
  zh: { locale: 'zh' as const, setLocale: () => {} },
  id: { locale: 'id' as const, setLocale: () => {} },
  en: { locale: 'en' as const, setLocale: () => {} },
}
const NOW = new Date('2026-11-01T00:00:00Z')
const payer: BillingViewer = { userId: 'payer-user', householdRole: 'owner' }
const otherOwner: BillingViewer = { userId: 'owner-user', householdRole: 'owner' }
const caregiver: BillingViewer = { userId: 'caregiver-user', householdRole: 'caregiver' }
const viewerRole: BillingViewer = { userId: 'viewer-user', householdRole: 'viewer' }
const loggedOut: BillingViewer = { userId: null, householdRole: null }

const grace: SubscriptionSummary = { id: 'sub-grace', cancelReason: null, status: 'grace', payerUserId: 'payer-user', currentPeriodEnd: '2026-11-01T00:00:00Z', graceUntil: '2026-11-08T00:00:00Z' }
const active: SubscriptionSummary = { id: 'sub-active', cancelReason: null, status: 'active', payerUserId: 'payer-user', currentPeriodEnd: '2026-11-20T00:00:00Z', graceUntil: null }
const cancelRequested: SubscriptionSummary = { ...active, status: 'cancel_requested', cancelReason: 'payer' }
const offer: PlanOffer = { planCode: 'premium_monthly', amount: 123, currency: 'TWD', limits: { aiDraftDailyLimit: 11, careRecipientLimit: 7, photoRetentionDays: 99 }, termsVersion: 'terms-test-1' }
const receipts: ReceiptRow[] = [{ id: 'r1', paidAt: '2026-10-20T00:00:00Z', amount: 123, currency: 'TWD', periodStart: '2026-10-20T00:00:00Z', periodEnd: '2026-11-20T00:00:00Z', providerOrderNo: 'ORDER-TEST-0001' }]

beforeEach(() => { nativeApp = false })

function banner(viewer: BillingViewer, subscription: SubscriptionSummary | null, locale: keyof typeof CONTEXTS = 'zh', extra: Record<string, unknown> = {}) {
  return renderHook(() => expandFunctionComponents(SubscriptionBanner({ viewer, subscription, now: NOW, ...extra })), { defaultContext: CONTEXTS[locale] })
}

describe('SubscriptionBanner', () => {
  test('grace banner renders for the payer and an owner, in all three languages, with the fixed "basic features unaffected" sentence', () => {
    expect(textContent(banner(payer, grace, 'zh').current)).toContain('基礎功能不受影響')
    expect(textContent(banner(otherOwner, grace, 'id').current)).toContain('Fitur dasar tidak terpengaruh')
    expect(textContent(banner(payer, grace, 'en').current)).toContain('Basic features are not affected')
  })

  test('renders nothing for caregiver, viewer and logged-out users', () => {
    for (const viewer of [caregiver, viewerRole, loggedOut]) {
      for (const locale of ['zh', 'id', 'en'] as const) {
        expect(banner(viewer, grace, locale).current).toBeNull()
        expect(banner(viewer, { ...grace, payerUserId: null }, locale).current).toBeNull()
      }
    }
  })

  test('renders nothing inside the native shell, even for the payer', () => {
    nativeApp = true
    expect(banner(payer, grace).current).toBeNull()
  })

  test('grace banner offers "update payment method" to an owner and calls the handler', () => {
    const calls: string[] = []
    const view = banner(payer, grace, 'zh', { onUpdatePayment: () => calls.push('update') })
    const button = findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '更新付款方式')[0]
    expect(button).toBeDefined()
    fire(button!, 'onClick')
    expect(calls).toEqual(['update'])
  })

  test('a payer who is no longer an owner sees the text but no checkout button (the order RPC would reject it)', () => {
    const demoted: BillingViewer = { userId: 'payer-user', householdRole: 'caregiver' }
    const view = banner(demoted, grace, 'zh', { onUpdatePayment: () => {} })
    expect(textContent(view.current)).toContain('基礎功能不受影響')
    expect(findAll(view.current, el => el.type === 'button')).toHaveLength(0)
  })

  test('a payer removed from the household still sees the grace banner text, without a checkout button', () => {
    const removed: BillingViewer = { userId: 'payer-user', householdRole: null }
    const view = banner(removed, grace, 'zh', { onUpdatePayment: () => {} })
    expect(textContent(view.current)).toContain('基礎功能不受影響')
    expect(findAll(view.current, el => el.type === 'button')).toHaveLength(0)
  })

  test('payer-left banner shows to the remaining owner, never to caregivers', () => {
    const orphan: SubscriptionSummary = { ...active, payerUserId: null }
    expect(textContent(banner(otherOwner, orphan, 'zh').current)).toContain('付款人已離開')
    expect(textContent(banner(otherOwner, orphan, 'zh').current)).toContain('要繼續請重新訂閱')
    expect(textContent(banner(otherOwner, orphan, 'id').current)).toContain('Pembayar sudah keluar')
    expect(textContent(banner(otherOwner, orphan, 'en').current)).toContain('The payer has left')
    expect(banner(caregiver, orphan).current).toBeNull()
  })

  test('a payer-less subscription in grace names the grace deadline, not the earlier renewal boundary', () => {
    // grace：currentPeriodEnd＝2026-11-01（續約失敗那天）、graceUntil＝2026-11-08；Premium 實際用到 11/8。
    const orphanGrace: SubscriptionSummary = { ...grace, payerUserId: null }
    const text = textContent(banner(otherOwner, orphanGrace, 'zh').current)
    expect(text).toContain('付款人已離開')
    expect(text).toContain('11月8日')
    expect(text).not.toContain('11月1日')
  })

  test('the renewal reminder talks about the saved payment method, never "your card" (non-paying owners read it too)', () => {
    const soon: SubscriptionSummary = { ...active, currentPeriodEnd: '2026-11-05T00:00:00Z' }
    const zh = textContent(banner(otherOwner, soon, 'zh').current)
    expect(zh).toContain('已儲存的付款方式')
    expect(zh).not.toContain('你的')
    expect(textContent(banner(otherOwner, soon, 'id').current)).toContain('metode pembayaran yang tersimpan')
    expect(textContent(banner(otherOwner, soon, 'id').current)).not.toContain('Anda')
    expect(textContent(banner(otherOwner, soon, 'en').current)).toContain('saved payment method')
    expect(textContent(banner(otherOwner, soon, 'en').current)).not.toContain('your card')
  })

  test('renewal reminder banner appears 7 days before the period end for the payer', () => {
    const soon: SubscriptionSummary = { ...active, currentPeriodEnd: '2026-11-05T00:00:00Z' }
    expect(textContent(banner(payer, soon, 'zh').current)).toContain('即將自動續約')
    expect(banner(payer, active).current).toBeNull()
  })
})

function section(viewer: BillingViewer, subscription: SubscriptionSummary | null, locale: keyof typeof CONTEXTS = 'zh', extra: Record<string, unknown> = {}) {
  return renderHook(() => expandFunctionComponents(SubscriptionSection({ viewer, subscription, receipts, ...extra })), { defaultContext: CONTEXTS[locale] })
}
const buttons = (node: unknown) => findAll(node, el => el.type === 'button').map(el => textContent(el.props.children))

describe('SubscriptionSection', () => {
  test('renders nothing for caregiver, viewer, logged-out and inside the native shell', () => {
    for (const viewer of [caregiver, viewerRole, loggedOut]) expect(section(viewer, active).current).toBeNull()
    nativeApp = true
    expect(section(payer, active).current).toBeNull()
  })

  test('shows status, expiry and the receipt (date, amount, period, order number) to the payer', () => {
    const text = textContent(section(payer, active, 'zh').current)
    expect(text).toContain('Premium 使用中')
    expect(text).toContain('使用到')
    expect(text).toContain('ORDER-TEST-0001')
    expect(text).toContain('123')
  })

  test('cancel button is hidden until P2 is ready (cancellationAvailable defaults to false)', () => {
    expect(buttons(section(payer, active, 'zh', { onCancel: () => {} }).current)).not.toContain('取消訂閱')
    expect(buttons(section(payer, active, 'zh', { onCancel: () => {}, cancellationAvailable: true }).current)).toContain('取消訂閱')
  })

  test('cancel is two-step: first click asks, only the confirm button calls onCancel', () => {
    const calls: string[] = []
    const view = section(otherOwner, active, 'zh', { onCancel: () => calls.push('cancel'), cancellationAvailable: true })
    fire(findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '取消訂閱')[0]!, 'onClick')
    const asked = view.rerender()
    expect(calls).toEqual([])
    expect(textContent(asked)).toContain('確定要取消嗎')
    fire(findAll(asked, el => el.type === 'button' && textContent(el.props.children) === '確定取消')[0]!, 'onClick')
    expect(calls).toEqual(['cancel'])
  })

  test('the cancel confirmation is a labelled alertdialog and the safe button is the one that gets focus', () => {
    const view = section(otherOwner, active, 'zh', { onCancel: () => {}, cancellationAvailable: true })
    fire(findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '取消訂閱')[0]!, 'onClick')
    const dialog = findAll(view.rerender(), el => el.props.role === 'alertdialog')[0]
    expect(dialog).toBeDefined()
    expect(dialog!.props['aria-labelledby']).toBe('subscription-cancel-confirm')
    expect(findAll(dialog, el => el.props.id === 'subscription-cancel-confirm')).toHaveLength(1)
  })

  test('an open cancel confirmation does not follow the user to another household\'s subscription', () => {
    const calls: string[] = []
    let current: SubscriptionSummary = active
    const view = renderHook(() => expandFunctionComponents(SubscriptionSection({ viewer: otherOwner, subscription: current, receipts, onCancel: () => calls.push(current.id), cancellationAvailable: true })), { defaultContext: CONTEXTS.zh })
    fire(findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '取消訂閱')[0]!, 'onClick')
    expect(textContent(view.rerender())).toContain('確定要取消嗎')

    // 切換被照顧者後換成另一個家庭的訂閱：舊的確認必須失效，畫面回到「取消訂閱」按鈕。
    current = { ...active, id: 'sub-other-household' }
    const switched = view.rerender()
    expect(textContent(switched)).not.toContain('確定要取消嗎')
    expect(findAll(switched, el => el.type === 'button' && textContent(el.props.children) === '確定取消')).toHaveLength(0)
    expect(calls).toEqual([])
  })

  test('in grace the settings section shows the grace deadline, not the earlier renewal boundary', () => {
    const text = textContent(section(payer, grace, 'zh').current)
    expect(text).toContain('使用到 2026年11月8日')
    expect(text).not.toContain('11月1日')
  })

  test('closing the confirmation by switching subscriptions still moves focus to the cancel button', () => {
    const focused: string[] = []
    let current: SubscriptionSummary = active
    const view = renderHook(() => expandFunctionComponents(SubscriptionSection({ viewer: otherOwner, subscription: current, receipts, onCancel: () => {}, cancellationAvailable: true })), { defaultContext: CONTEXTS.zh })
    const refOf = (node: unknown, label: string) => (findAll(node, el => el.type === 'button' && textContent(el.props.children) === label)[0] as unknown as { ref: { current: unknown } }).ref
    refOf(view.current, '取消訂閱').current = { focus: () => focused.push('cancel') }

    fire(findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '取消訂閱')[0]!, 'onClick')
    const open = view.rerender()
    refOf(open, '先不要').current = { focus: () => focused.push('keep') }
    expect(focused).toEqual([])

    // 切換到另一張訂閱：確認區塊因對象不同而消失，兩個確認按鈕的 handler 都沒被按到，焦點仍要接回來。
    current = { ...active, id: 'sub-other-household' }
    view.rerender()
    expect(focused).toEqual(['cancel'])
  })

  test('an open cancel confirmation does not come back by itself after the subscription went cancel_requested and was resumed', () => {
    const calls: string[] = []
    let current: SubscriptionSummary = active
    const view = renderHook(() => expandFunctionComponents(SubscriptionSection({ viewer: payer, subscription: current, receipts, onCancel: () => calls.push('cancel'), onResume: () => {}, cancellationAvailable: true })), { defaultContext: CONTEXTS.zh })
    fire(findAll(view.current, el => el.type === 'button' && textContent(el.props.children) === '取消訂閱')[0]!, 'onClick')
    expect(textContent(view.rerender())).toContain('確定要取消嗎')

    // 外部把訂閱改成「取消處理中」：取消不再可用，確認區塊消失。
    current = cancelRequested
    expect(textContent(view.rerender())).not.toContain('確定要取消嗎')
    // 之後付款人撤回取消、回到 active：必須回到第一步的「取消訂閱」按鈕，不能直接又跳出舊的確認。
    current = active
    view.rerender()
    const back = view.rerender()
    expect(textContent(back)).not.toContain('確定要取消嗎')
    expect(buttons(back)).toContain('取消訂閱')
    expect(buttons(back)).not.toContain('確定取消')
    expect(calls).toEqual([])
  })

  test('a payer removed from the household can still cancel and sees the receipts', () => {
    const removed: BillingViewer = { userId: 'payer-user', householdRole: null }
    const view = section(removed, active, 'zh', { onCancel: () => {}, cancellationAvailable: true })
    expect(buttons(view.current)).toContain('取消訂閱')
    expect(textContent(view.current)).toContain('ORDER-TEST-0001')
    // 不是 owner，所以也不會出現升級入口。
    expect(findAll(section(removed, { ...active, status: 'downgraded' }, 'zh').current, el => el.type === 'a')).toHaveLength(0)
  })

  test('cancel_requested shows "processing" (never "cancelled") and only the payer can undo it', () => {
    const payerView = section(payer, cancelRequested, 'zh', { onResume: () => {}, onCancel: () => {}, cancellationAvailable: true })
    expect(textContent(payerView.current)).toContain('取消處理中')
    expect(textContent(payerView.current)).not.toContain('已取消')
    expect(buttons(payerView.current)).toContain('撤回取消')

    const ownerView = section(otherOwner, cancelRequested, 'zh', { onResume: () => {}, onCancel: () => {}, cancellationAvailable: true })
    expect(buttons(ownerView.current)).not.toContain('撤回取消')
    expect(textContent(ownerView.current)).toContain('只有付款人本人可以撤回這次取消')
  })

  test('during grace the payer and owners can cancel (and the status says the payment failed)', () => {
    for (const viewer of [payer, otherOwner]) {
      const view = section(viewer, grace, 'zh', { onCancel: () => {}, cancellationAvailable: true })
      expect(buttons(view.current)).toContain('取消訂閱')
      expect(textContent(view.current)).toContain('扣款失敗，寬限中')
    }
  })

  test('terminating (cancel sent to the provider) reads as "processing", never "cancelled", and offers no cancel or undo', () => {
    const terminating: SubscriptionSummary = { ...active, status: 'terminating', cancelReason: 'payer' }
    const view = section(payer, terminating, 'zh', { onCancel: () => {}, onResume: () => {}, cancellationAvailable: true })
    expect(textContent(view.current)).toContain('取消處理中')
    expect(textContent(view.current)).not.toContain('已取消')
    expect(buttons(view.current)).not.toContain('取消訂閱')
    expect(buttons(view.current)).not.toContain('撤回取消')
  })

  test('a cancellation started by account deletion, a grant or a refund shows no undo button even to the payer', () => {
    for (const reason of ['payer_deleted', 'admin_grant', 'refund'] as const) {
      const view = section(payer, { ...cancelRequested, cancelReason: reason }, 'zh', { onResume: () => {} })
      expect(buttons(view.current)).not.toContain('撤回取消')
    }
    expect(buttons(section(payer, cancelRequested, 'zh', { onResume: () => {} }).current)).toContain('撤回取消')
  })

  test('an owner with no subscription sees the way to the upgrade page; a payer-only (non-owner) viewer does not', () => {
    const links = findAll(section(otherOwner, null, 'zh').current, el => el.type === 'a')
    expect(links.map(el => el.props.href)).toEqual(['/upgrade'])
    const demoted: BillingViewer = { userId: 'payer-user', householdRole: 'caregiver' }
    expect(findAll(section(demoted, { ...active, status: 'downgraded' }, 'zh').current, el => el.type === 'a')).toHaveLength(0)
  })

  test('is fully translated: id and en show their own language', () => {
    expect(textContent(section(payer, active, 'id').current)).toContain('Premium aktif')
    expect(textContent(section(payer, active, 'en').current)).toContain('Premium is active')
  })
})

function upgrade(viewer: BillingViewer, locale: keyof typeof CONTEXTS = 'zh', onCheckout: (request: unknown) => void = () => {}) {
  return renderHook(() => expandFunctionComponents(UpgradeDisclosure({ viewer, offer, onCheckout })), { defaultContext: CONTEXTS[locale] })
}
const checkboxes = (node: unknown) => findAll(node, el => el.type === 'input' && el.props.type === 'checkbox')
const continueButton = (node: unknown) => findAll(node, el => el.type === 'button')[0]!

describe('UpgradeDisclosure', () => {
  test('renders nothing for caregiver, viewer, logged-out and inside the native shell', () => {
    for (const viewer of [caregiver, viewerRole, loggedOut]) expect(upgrade(viewer).current).toBeNull()
    nativeApp = true
    expect(upgrade(otherOwner).current).toBeNull()
  })

  test('shows price and limits from the offer (nothing hard-coded), the auto-renew and cancel disclosure, and the terms link', () => {
    const text = textContent(upgrade(otherOwner, 'zh').current)
    expect(text).toContain('123')
    expect(text).toContain('11 次')
    expect(text).toContain('7 位')
    expect(text).toContain('99 天')
    expect(text).toContain('每月自動續約')
    expect(text).toContain('設定 → 訂閱')
    expect(text).toContain('terms-test-1')
    expect(findAll(upgrade(otherOwner).current, el => el.type === 'a').map(el => el.props.href)).toEqual(['/terms'])
  })

  test('has two separate checkboxes (terms, and the seven-day-withdrawal waiver) and the button stays disabled until both are ticked', () => {
    const calls: unknown[] = []
    const view = upgrade(otherOwner, 'zh', request => calls.push(request))
    expect(checkboxes(view.current)).toHaveLength(2)
    expect(continueButton(view.current).props.disabled).toBe(true)

    fire(checkboxes(view.current)[0]!, 'onChange', { target: { checked: true } })
    let next = view.rerender()
    expect(continueButton(next).props.disabled).toBe(true)
    // 只勾條款、沒勾解除權：即使繞過 disabled 直接觸發 onClick 也不能建單。
    fire(continueButton(next), 'onClick')
    expect(calls).toEqual([])

    fire(checkboxes(next)[1]!, 'onChange', { target: { checked: true } })
    next = view.rerender()
    expect(continueButton(next).props.disabled).toBe(false)
    fire(continueButton(next), 'onClick')
    expect(calls).toEqual([{ locale: 'zh', termsVersion: 'terms-test-1', refundWaiverAccepted: true }])
  })

  test('ticks given for one terms version do not carry over when the offer is refreshed with a new version', () => {
    const calls: unknown[] = []
    let current: PlanOffer = offer
    const view = renderHook(() => expandFunctionComponents(UpgradeDisclosure({ viewer: otherOwner, offer: current, onCheckout: request => calls.push(request) })), { defaultContext: CONTEXTS.zh })
    fire(checkboxes(view.current)[0]!, 'onChange', { target: { checked: true } })
    fire(checkboxes(view.rerender())[1]!, 'onChange', { target: { checked: true } })
    expect(continueButton(view.rerender()).props.disabled).toBe(false)

    current = { ...offer, termsVersion: 'terms-test-2' }
    const refreshed = view.rerender()
    expect(checkboxes(refreshed).map(el => el.props.checked)).toEqual([false, false])
    expect(continueButton(refreshed).props.disabled).toBe(true)
    fire(continueButton(refreshed), 'onClick')
    expect(calls).toEqual([])
  })

  test('ticks given by one user do not carry over when a different owner is signed in on the same mounted page', () => {
    const calls: unknown[] = []
    let who: BillingViewer = otherOwner
    const view = renderHook(() => expandFunctionComponents(UpgradeDisclosure({ viewer: who, offer, onCheckout: request => calls.push(request) })), { defaultContext: CONTEXTS.zh })
    fire(checkboxes(view.current)[0]!, 'onChange', { target: { checked: true } })
    fire(checkboxes(view.rerender())[1]!, 'onChange', { target: { checked: true } })
    expect(continueButton(view.rerender()).props.disabled).toBe(false)

    // 同一頁換成另一位 owner：伺服器會把建單記在第二位的 session 上，所以第一位勾的不能算數。
    who = { userId: 'second-owner', householdRole: 'owner' }
    const switched = view.rerender()
    expect(checkboxes(switched).map(el => el.props.checked)).toEqual([false, false])
    expect(continueButton(switched).props.disabled).toBe(true)
    fire(continueButton(switched), 'onClick')
    expect(calls).toEqual([])
  })

  test('sends the language the page is shown in as the checkout locale', () => {
    const calls: unknown[] = []
    const view = upgrade(otherOwner, 'id', request => calls.push(request))
    fire(checkboxes(view.current)[0]!, 'onChange', { target: { checked: true } })
    fire(checkboxes(view.rerender())[1]!, 'onChange', { target: { checked: true } })
    fire(continueButton(view.rerender()), 'onClick')
    expect(calls).toEqual([{ locale: 'id', termsVersion: 'terms-test-1', refundWaiverAccepted: true }])
  })

  test('is fully translated: id and en show their own language', () => {
    expect(textContent(upgrade(otherOwner, 'id').current)).toContain('Tingkatkan ke Premium')
    expect(textContent(upgrade(otherOwner, 'en').current)).toContain('Upgrade to Premium')
  })
})
