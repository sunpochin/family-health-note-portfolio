/*
檔案用途：帳務橫幅——扣款失敗寬限、付款人已離開、續約前 7 天提醒；只給付款人與家庭 owner 看，看護／檢視者／未登入者永遠渲染 null（#1185）。
所在層：src/features/subscription/components；純 props 驅動，不查資料、不呼叫 RPC。
主要關聯：lib/billingAudience.ts（顯示矩陣唯一來源）、lib/subscriptionCopy.ts（三語文案）；整合到 App 殼層是 P1／P2 合併後的下一步。
*/
import { Icon } from '../../../components/ui/Icon'
import { useI18n } from '../../../lib/i18n'
import { canStartCheckout, isBillingUiAvailable, premiumEndsAt, resolveBillingBanner } from '../lib/billingAudience'
import { formatBillingDate } from '../lib/billingFormat'
import { BANNER_COPY } from '../lib/subscriptionCopy'
import type { BillingViewer, SubscriptionSummary } from '../types'

interface SubscriptionBannerProps {
  viewer: BillingViewer
  subscription: SubscriptionSummary | null
  // 注入現在時間，續約提醒的 7 天窗口才測得準；正式使用不用傳。
  now?: Date
  // 「更新付款方式」與「重新訂閱」都走 P2 的 checkout；由整合層決定怎麼開（p_replaces_subscription_id 等）。
  onUpdatePayment?: () => void
  onResubscribe?: () => void
}

export function SubscriptionBanner({ viewer, subscription, now, onUpdatePayment, onResubscribe }: SubscriptionBannerProps) {
  const { text, locale } = useI18n()
  // 原生殼整個不渲染（ADR-012 D9）；必須放在最前面，連矩陣都不用算。
  if (!isBillingUiAvailable()) return null

  const kind = resolveBillingBanner({ viewer, subscription, now: now ?? new Date() })
  if (kind === null || subscription === null) return null

  // 建單只接受 owner；付款人若已不是 owner，按鈕顯示出來只會被後端拒絕，所以不渲染按鈕、文字仍保留。
  const showCheckoutAction = canStartCheckout(viewer)
  const periodEnd = formatBillingDate(premiumEndsAt(subscription), locale)

  if (kind === 'grace') {
    return (
      <BannerShell tone="warning" title={text(BANNER_COPY.graceTitle)} body={text(BANNER_COPY.graceBody(formatBillingDate(subscription.graceUntil, locale)))}>
        {showCheckoutAction && onUpdatePayment && <BannerButton label={text(BANNER_COPY.updatePayment)} onClick={onUpdatePayment} />}
      </BannerShell>
    )
  }
  if (kind === 'payer_left') {
    return (
      <BannerShell tone="warning" title={text(BANNER_COPY.payerLeftTitle)} body={text(BANNER_COPY.payerLeftBody(periodEnd))}>
        {showCheckoutAction && onResubscribe && <BannerButton label={text(BANNER_COPY.resubscribe)} onClick={onResubscribe} />}
      </BannerShell>
    )
  }
  return <BannerShell tone="info" title={text(BANNER_COPY.renewalTitle)} body={text(BANNER_COPY.renewalBody(periodEnd))} />
}

function BannerShell({ tone, title, body, children }: { tone: 'warning' | 'info'; title: string; body: string; children?: React.ReactNode }) {
  const palette = tone === 'warning' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-slate-200 bg-slate-50 text-slate-900'
  return (
    // role=status：給螢幕閱讀器溫和地唸出，不是 alert——帳務訊息不是需要「現在行動」的警報（鐵律 3）。
    <section role="status" className={`mx-4 mt-3 flex items-start gap-3 rounded-2xl border p-4 ${palette}`}>
      <Icon name="info" className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-bold leading-snug">{title}</p>
        <p className="mt-1 text-sm leading-6">{body}</p>
        {children && <div className="mt-3">{children}</div>}
      </div>
    </section>
  )
}

function BannerButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="min-h-12 rounded-xl bg-brand-700 px-4 text-sm font-bold text-white">
      {label}
    </button>
  )
}
