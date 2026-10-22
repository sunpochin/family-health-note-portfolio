/*
檔案用途：/upgrade 的購買前揭露與付款入口（#1185）：方案內容、價格、週期、自動續約與取消方式、寬限與降級效果、付費條款與七日解除權例外「兩個獨立勾選框」，兩個都勾才能前往付款。
所在層：src/features/subscription/components；純 props 驅動，價格與配額由 PlanOffer 傳入（不硬編碼），按下後只呼叫 onCheckout，建單 RPC 由整合層（P2 合併後）接。
主要關聯：lib/subscriptionCopy.ts（UPGRADE_COPY）、lib/billingAudience.ts（只有 owner 能建單）、docs/product/monetization-plan.md §6.1、§6.2、ADR-012 D8。
*/
import { useState } from 'react'
import { Icon } from '../../../components/ui/Icon'
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { canStartCheckout, isBillingUiAvailable } from '../lib/billingAudience'
import { formatMoney } from '../lib/billingFormat'
import { UPGRADE_COPY } from '../lib/subscriptionCopy'
import type { BillingViewer, CheckoutRequest, PlanOffer } from '../types'

interface UpgradeDisclosureProps {
  viewer: BillingViewer
  offer: PlanOffer
  busy?: boolean
  error?: LocalizedText | null
  onCheckout: (request: CheckoutRequest) => void
}

export function UpgradeDisclosure({ viewer, offer, busy = false, error = null, onCheckout }: UpgradeDisclosureProps) {
  const { text, locale } = useI18n()
  // 兩個勾選框刻意是兩份獨立 state：七日解除權例外必須是獨立、明確的同意動作，不得與條款勾選合併（owner 6.5.2）。
  // 勾選記的是「誰在哪一個條款版本上勾的」而不是布林：
  // (1) 方案資料重新整理後 termsVersion 若變了，舊的勾選自動失效，否則會變成「聲稱同意了使用者從沒看過的版本」；
  // (2) 畫面不卸載而登入者換人時，第二位 owner 不能沿用第一位的勾選送出——伺服器會把這筆建單記在第二位的 session 上（Codex review）。
  const consentKey = `${viewer.userId ?? ''}|${offer.termsVersion}`
  const [termsAcceptedFor, setTermsAcceptedFor] = useState<string | null>(null)
  const [waiverAcceptedFor, setWaiverAcceptedFor] = useState<string | null>(null)
  const termsAccepted = termsAcceptedFor === consentKey
  const waiverAccepted = waiverAcceptedFor === consentKey

  // 原生殼與非 owner（看護、檢視者、未登入）都不渲染：建單 RPC 只接受 owner，看護畫面也不得出現任何帳務元素。
  if (!isBillingUiAvailable() || !canStartCheckout(viewer)) return null

  const ready = termsAccepted && waiverAccepted
  const submit = () => {
    // disabled 之外再擋一次：任何繞過 disabled 的呼叫（鍵盤、測試、雙擊）都不能在沒勾選時建單。
    if (!ready || busy) return
    onCheckout({ locale, termsVersion: offer.termsVersion, refundWaiverAccepted: true })
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-6" aria-labelledby="upgrade-title">
      <h1 id="upgrade-title" className="flex items-center gap-2 text-2xl font-black text-slate-900">
        <Icon name="sparkles" className="h-6 w-6" />
        {text(UPGRADE_COPY.title)}
      </h1>
      <p className="mt-3 text-base leading-7 text-slate-800">{text(UPGRADE_COPY.intro)}</p>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="upgrade-includes-title">
        <h2 id="upgrade-includes-title" className="font-bold text-slate-900">{text(UPGRADE_COPY.includesTitle)}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-800">
          <li>{text(UPGRADE_COPY.featureAi(offer.limits.aiDraftDailyLimit))}</li>
          <li>{text(UPGRADE_COPY.featureNotifications)}</li>
          <li>{text(UPGRADE_COPY.featurePhotos(offer.limits.photoRetentionDays))}</li>
          <li>{text(UPGRADE_COPY.featureRecipients(offer.limits.careRecipientLimit))}</li>
        </ul>
        <p className="mt-3 text-xl font-black text-slate-900">{text(UPGRADE_COPY.pricePerMonth(formatMoney(offer.amount, offer.currency, locale)))}</p>
      </section>

      <section className="mt-4 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="upgrade-terms-title">
        <h2 id="upgrade-terms-title" className="font-bold text-slate-900">{text(UPGRADE_COPY.termsTitle)}</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-slate-800">
          <li>{text(UPGRADE_COPY.autoRenew)}</li>
          <li>{text(UPGRADE_COPY.cancelHow)}</li>
          <li>{text(UPGRADE_COPY.graceAndDowngrade())}</li>
          <li>{text(UPGRADE_COPY.payOnProviderPage)}</li>
        </ul>
        <a href="/terms" target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex min-h-11 items-center text-sm font-bold text-brand-700 underline">
          {text(UPGRADE_COPY.termsLink)}
        </a>

        <label className="mt-3 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-900">
          <input type="checkbox" checked={termsAccepted} onChange={event => setTermsAcceptedFor(event.target.checked ? consentKey : null)} className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600" />
          <span>{text(UPGRADE_COPY.termsCheckbox(offer.termsVersion))}</span>
        </label>
        <label className="mt-2 flex min-h-12 cursor-pointer items-start gap-3 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-900">
          <input type="checkbox" checked={waiverAccepted} onChange={event => setWaiverAcceptedFor(event.target.checked ? consentKey : null)} className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600" />
          <span>{text(UPGRADE_COPY.waiverCheckbox)}</span>
        </label>
      </section>

      {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{text(error)}</p>}

      <button type="button" disabled={!ready || busy} onClick={submit} className="mt-4 min-h-14 w-full rounded-xl bg-brand-700 px-4 text-base font-bold text-white disabled:opacity-50">
        {text(UPGRADE_COPY.continue)}
      </button>
      {!ready && <p className="mt-2 text-center text-xs text-slate-600">{text(UPGRADE_COPY.tickBoth)}</p>}
    </main>
  )
}
