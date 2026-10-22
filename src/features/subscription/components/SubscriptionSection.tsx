/*
檔案用途：設定頁的「訂閱」區——目前狀態、到期日、取消／撤回取消、收據列表（#1185）；只給付款人與家庭 owner，其他人與原生殼一律渲染 null。
所在層：src/features/subscription/components；純 props 驅動，真正呼叫 P1 的取消／恢復 RPC 由整合層傳進 onCancel／onResume。
主要關聯：lib/billingAudience.ts（誰能按什麼）、ReceiptList.tsx、lib/subscriptionCopy.ts。
*/
import { useEffect, useRef, useState } from 'react'
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { canCancelSubscription, canResumeSubscription, isBillingUiAvailable, isCurrentSubscription, premiumEndsAt, resolveBillingAudience } from '../lib/billingAudience'
import { formatBillingDate } from '../lib/billingFormat'
import { SECTION_COPY } from '../lib/subscriptionCopy'
import type { BillingViewer, ReceiptRow, SubscriptionStatus, SubscriptionSummary } from '../types'
import { ReceiptList } from './ReceiptList'

interface SubscriptionSectionProps {
  viewer: BillingViewer
  subscription: SubscriptionSummary | null
  receipts: ReceiptRow[]
  // 取消按鈕要等 P2 的 newebpay-period-alter 合併才能開放（Codex 第三輪）：否則取消會永遠停在 cancel_requested。
  // 預設 false＝fail-safe，整合層確認 P2 已部署才傳 true。
  cancellationAvailable?: boolean
  busy?: boolean
  error?: LocalizedText | null
  onCancel?: () => void
  onResume?: () => void
}

const STATUS_LABELS: Record<SubscriptionStatus, LocalizedText> = {
  active: SECTION_COPY.statusActive,
  grace: SECTION_COPY.statusGrace,
  cancel_requested: SECTION_COPY.statusCancelRequested,
  // terminating＝取消請求已送給供應商、還沒確認：對付款人仍是「處理中」，不能說已取消（ADR-012 D6）。
  terminating: SECTION_COPY.statusCancelRequested,
  cancelled: SECTION_COPY.statusCancelled,
  // 終局狀態不會以「目前這張」出現，這裡只為了型別完整；畫面走 statusNone。
  downgraded: SECTION_COPY.statusNone,
  superseded: SECTION_COPY.statusNone,
}

export function SubscriptionSection({ viewer, subscription, receipts, cancellationAvailable = false, busy = false, error = null, onCancel, onResume }: SubscriptionSectionProps) {
  const { text, locale } = useI18n()
  // 這幾個值要在 hook 之前算好：確認狀態必須依「現在還能不能取消」失效，不只依訂閱 id（Codex review）。
  const audience = resolveBillingAudience(viewer, subscription)
  const current = isCurrentSubscription(subscription) ? subscription : null
  const showCancel = isBillingUiAvailable() && audience !== 'none' && cancellationAvailable && canCancelSubscription(audience, current) && onCancel !== undefined

  // 取消前多一步確認：取消後超過 cancel_requested 窗口就只能重新訂閱（owner 5.6.5），誤觸成本比一般按鈕高。
  // 為什麼存「確認的對象」而不是布林：切換被照顧者會換到另一個家庭，元件不一定卸載；
  // 若只存 true，A 家開著的確認會讓同一顆「確定取消」去取消 B 家的訂閱。
  // 對象＝登入者＋訂閱 id，而且只有「現在還能取消」時才算在確認。
  const [confirmingCancelFor, setConfirmingCancelFor] = useState<string | null>(null)
  const confirmKey = showCancel && current ? `${viewer.userId ?? ''}:${current.id}` : null
  const confirmingCancel = confirmKey !== null && confirmingCancelFor === confirmKey

  // 失效的確認要「清掉」而不只是不顯示：訂閱若在確認開著時變成 cancel_requested、之後又被撤回成 active，
  // 留著舊值的話鑰匙又對上了，破壞性的第二步會不經重新點擊就再出現（Codex review 第三輪）。
  useEffect(() => {
    if (confirmingCancelFor !== null && !confirmingCancel) setConfirmingCancelFor(null)
  }, [confirmingCancelFor, confirmingCancel])

  const keepButtonRef = useRef<HTMLButtonElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const wasConfirmingRef = useRef(false)

  // 焦點管理：「取消訂閱」按鈕按下後會被確認區塊取代，不移焦點的話鍵盤與螢幕閱讀器使用者會失去位置、
  // 也聽不到破壞性的第二步出現了。進入確認時移到較安全的「先不要」；
  // 確認區塊「不論為什麼關掉」（按先不要、按確定、或切換到另一張訂閱而失效）都要把焦點接回來：
  // 優先回「取消訂閱」，那顆按鈕已不存在（例如取消後狀態變了）就回區塊標題，避免焦點掉到 body（Codex review）。
  useEffect(() => {
    if (confirmingCancel) {
      wasConfirmingRef.current = true
      keepButtonRef.current?.focus()
    } else if (wasConfirmingRef.current) {
      wasConfirmingRef.current = false
      ;(cancelButtonRef.current ?? headingRef.current)?.focus()
    }
  }, [confirmingCancel])

  if (!isBillingUiAvailable()) return null
  if (audience === 'none') return null

  const periodEnd = formatBillingDate(current ? premiumEndsAt(current) : null, locale)
  const showResume = canResumeSubscription(audience, current) && onResume !== undefined

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="subscription-section-title">
      <h2 id="subscription-section-title" ref={headingRef} tabIndex={-1} className="font-bold text-slate-900">{text(SECTION_COPY.title)}</h2>
      <p className="mt-2 text-base font-bold text-slate-900">{text(current ? STATUS_LABELS[current.status] : SECTION_COPY.statusNone)}</p>
      {current && <p className="mt-0.5 text-sm text-slate-700">{text(SECTION_COPY.activeUntil(periodEnd))}</p>}

      {current?.status === 'cancel_requested' && <p className="mt-2 text-sm text-slate-700">{text(SECTION_COPY.cancelRequestedNote)}</p>}
      {current?.status === 'cancel_requested' && audience !== 'payer' && <p className="mt-1 text-sm font-semibold text-slate-700">{text(SECTION_COPY.onlyPayerCanResume)}</p>}

      {showResume && (
        <button type="button" disabled={busy} onClick={onResume} className="mt-3 min-h-12 rounded-xl bg-brand-700 px-4 text-sm font-bold text-white disabled:opacity-60">
          {text(SECTION_COPY.resume)}
        </button>
      )}

      {showCancel && !confirmingCancel && (
        <button ref={cancelButtonRef} type="button" disabled={busy} onClick={() => setConfirmingCancelFor(confirmKey)} className="mt-3 min-h-12 rounded-xl border-2 border-control-border bg-white px-4 text-sm font-bold text-slate-900 disabled:opacity-60">
          {text(SECTION_COPY.cancel)}
        </button>
      )}
      {showCancel && confirmingCancel && (
        <div role="alertdialog" aria-labelledby="subscription-cancel-confirm" className="mt-3 rounded-xl bg-slate-50 p-3">
          <p id="subscription-cancel-confirm" className="text-sm font-semibold text-slate-900">{text(SECTION_COPY.cancelConfirm(periodEnd))}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => { setConfirmingCancelFor(null); onCancel?.() }} className="min-h-12 rounded-xl bg-red-700 px-4 text-sm font-bold text-white disabled:opacity-60">
              {text(SECTION_COPY.cancelYes)}
            </button>
            <button ref={keepButtonRef} type="button" onClick={() => setConfirmingCancelFor(null)} className="min-h-12 rounded-xl border-2 border-control-border bg-white px-4 text-sm font-bold text-slate-900">
              {text(SECTION_COPY.cancelKeep)}
            </button>
          </div>
        </div>
      )}

      {!current && viewer.householdRole === 'owner' && (
        <a href="/upgrade" className="mt-3 inline-flex min-h-12 items-center rounded-xl bg-brand-700 px-4 text-sm font-bold text-white">
          {text(SECTION_COPY.seePlan)}
        </a>
      )}

      {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">{text(error)}</p>}

      <h3 className="mt-5 text-sm font-bold text-slate-900">{text(SECTION_COPY.receiptsTitle)}</h3>
      <ReceiptList receipts={receipts} />
    </section>
  )
}
