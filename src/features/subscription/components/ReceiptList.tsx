/*
檔案用途：收據列表——付款日期、金額、方案、期間、藍新訂單號（monetization-plan §3.3：消保法線上交易的基本揭露，不等於發票）。
所在層：src/features/subscription/components；純 props 驅動。
主要關聯：SubscriptionSection.tsx（唯一使用者）、lib/billingFormat.ts。
*/
import { useI18n } from '../../../lib/i18n'
import { formatBillingDate, formatMoney } from '../lib/billingFormat'
import { SECTION_COPY } from '../lib/subscriptionCopy'
import type { ReceiptRow } from '../types'

export function ReceiptList({ receipts }: { receipts: ReceiptRow[] }) {
  const { text, locale } = useI18n()
  if (receipts.length === 0) {
    return <p className="mt-2 text-sm text-slate-600">{text(SECTION_COPY.receiptsEmpty)}</p>
  }
  return (
    <ul className="mt-2 divide-y divide-slate-100 rounded-xl border border-slate-200">
      {receipts.map(receipt => {
        const start = formatBillingDate(receipt.periodStart, locale)
        const end = formatBillingDate(receipt.periodEnd, locale)
        return (
          <li key={receipt.id} className="p-3 text-sm text-slate-700">
            <p className="font-bold text-slate-900">
              {formatBillingDate(receipt.paidAt, locale) ?? ''} · {formatMoney(receipt.amount, receipt.currency, locale)}
            </p>
            <p className="mt-0.5">{text(SECTION_COPY.receiptPlan)}</p>
            {start && end && <p>{text(SECTION_COPY.receiptPeriod)}: {start} – {end}</p>}
            <p className="break-all text-slate-600">{text(SECTION_COPY.receiptOrderNo)}: {receipt.providerOrderNo}</p>
          </li>
        )
      })}
    </ul>
  )
}
