/*
檔案用途：後台「家庭 Premium」分頁的單一家庭卡片（issue #1180，H6）：家庭名稱、owner、成員與被照顧者數、目前 tier／來源／有效期，
         一個 Premium 開關＋理由下拉＋試用到期日＋套用按鈕，以及可展開的稽核列表；送出撞到進行中訂閱時多一塊說明區（issue #1202）。
所在層：src/features/system-admin/components；純呈現元件，草稿、送出與稽核狀態由 useHouseholdPremium 提供。
主要關聯：HouseholdPremiumPanel.tsx（唯一呼叫端）、HouseholdEntitlementAuditList.tsx、HouseholdSubscriptionConflictNotice.tsx、householdPremiumLabels.ts、
         src/lib/adminHouseholds.ts（理由值域）。後台刻意沒有「上限」或「配額數字」欄位（票文停止點）。
*/
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { type AdminHousehold, HOUSEHOLD_GRANT_REASONS, HOUSEHOLD_REVOKE_REASONS } from '../../../lib/adminHouseholds'
import { type HouseholdAuditState, type HouseholdDraft, type HouseholdSubscriptionConflict, isPremiumNow } from '../hooks/useHouseholdPremium'
import { HouseholdEntitlementAuditList } from './HouseholdEntitlementAuditList'
import { HouseholdSubscriptionConflictNotice } from './HouseholdSubscriptionConflictNotice'
import {
  HOUSEHOLD_REASON_LABELS,
  HOUSEHOLD_SOURCE_LABELS,
  formatPremiumValidThrough,
  formatTaipeiDateTime,
  labelOrRaw,
  taipeiMaxTrialEndsOn,
  taipeiToday,
} from '../householdPremiumLabels'

export interface HouseholdPremiumCardProps {
  household: AdminHousehold
  draft: HouseholdDraft
  // 由 useHouseholdPremium.canApply 決定：表單真的改過、而且送出後會和現在不一樣才是 true。
  canApply: boolean
  saving: boolean
  saved: boolean
  saveError: LocalizedText | null
  audit: HouseholdAuditState | undefined
  // issue #1202：上次送出撞到「家庭有進行中的訂閱」；null＝沒有撞到。
  subscriptionConflict?: HouseholdSubscriptionConflict | null
  // 上次成功的寫入走的是「招待並終止訂閱」：「已儲存」提示要多講訂閱已標記終止。
  cancelRequested?: boolean
  onDraftChange: (patch: Partial<HouseholdDraft>) => void
  onApply: () => void
  onGrantAndCancel?: () => void
  onToggleAudit: () => void
}

// 英文的單複數：其他兩種語言沒有這個問題（中文用量詞、印尼文不變化）。
function englishCount(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function HouseholdPremiumCard({
  household, draft, canApply, saving, saved, saveError, audit, subscriptionConflict = null, cancelRequested = false,
  onDraftChange, onApply, onGrantAndCancel = () => {}, onToggleAudit,
}: HouseholdPremiumCardProps) {
  const { text } = useI18n()
  const premiumNow = isPremiumNow(household)
  const expired = household.premiumTier === 'premium' && !household.premiumEffective
  const reasons = draft.premium ? HOUSEHOLD_GRANT_REASONS : HOUSEHOLD_REVOKE_REASONS
  // 試用一定要日期；開啟時的「更正」可選填日期（填了＝還原成試用，留空＝還原成招待）。招待與關閉都不帶日期。
  const showDate = draft.premium && (draft.reason === 'trial' || draft.reason === 'correction')
  const sourceLabel = text(labelOrRaw(HOUSEHOLD_SOURCE_LABELS, household.premiumSource))

  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-slate-900 break-words">{household.name}</h3>
          {/* 家庭名稱會重複（好幾家都叫「我家」），owner email 是管理者確認「沒開錯家庭」的依據。 */}
          <p className="text-xs text-slate-600 break-all">
            {text({ id: 'Pemilik', zh: '擁有者', en: 'Owner' })}：
            {household.ownerEmails.length > 0 ? household.ownerEmails.join(', ') : text({ id: '(tidak ada)', zh: '（無）', en: '(none)' })}
          </p>
          <p className="mt-0.5 text-xs text-slate-600">
            {text({
              id: `${household.memberCount} anggota · ${household.activePatientCount} penerima perawatan aktif · ${household.archivedPatientCount} diarsipkan`,
              zh: `成員 ${household.memberCount} 位・使用中被照顧者 ${household.activePatientCount} 位・已封存 ${household.archivedPatientCount} 位`,
              en: `${englishCount(household.memberCount, 'member', 'members')} · ${englishCount(household.activePatientCount, 'active care recipient', 'active care recipients')} · ${household.archivedPatientCount} archived`,
            })}
          </p>
        </div>
        <span className={`shrink-0 rounded px-2 py-1 text-xs font-bold ${premiumNow ? 'bg-brand-50 text-brand-700' : expired ? 'bg-amber-50 text-amber-900' : 'bg-slate-100 text-slate-700'}`}>
          {premiumNow
            ? `Premium · ${sourceLabel}`
            : expired
              ? text({ id: 'Premium kedaluwarsa', zh: 'Premium 已過期', en: 'Premium expired' })
              : text(HOUSEHOLD_SOURCE_LABELS.none)}
        </span>
      </div>

      {household.premiumTier === 'premium' && (
        <p className={`mt-1 text-xs ${expired ? 'text-amber-900' : 'text-slate-600'}`}>
          {household.premiumUntil
            ? text({
              id: `${sourceLabel} · berlaku sampai ${formatPremiumValidThrough(household.premiumUntil)}`,
              zh: `${sourceLabel}・有效至 ${formatPremiumValidThrough(household.premiumUntil)}`,
              en: `${sourceLabel} · valid through ${formatPremiumValidThrough(household.premiumUntil)}`,
            })
            : text({ id: `${sourceLabel} · tanpa batas waktu`, zh: `${sourceLabel}・不到期`, en: `${sourceLabel} · no expiry` })}
        </p>
      )}
      {household.entitlementUpdatedAt && (
        <p className="text-xs text-slate-500">
          {text({ id: 'Terakhir diubah', zh: '最後變更', en: 'Last changed' })}：{formatTaipeiDateTime(household.entitlementUpdatedAt)}
        </p>
      )}

      <div className="mt-3 space-y-2 border-t border-slate-100 pt-3">
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-900">
          <input
            type="checkbox"
            role="switch"
            checked={draft.premium}
            aria-checked={draft.premium}
            disabled={saving}
            onChange={event => onDraftChange({ premium: event.target.checked })}
            className="h-5 w-5"
          />
          {text({ id: 'Premium untuk keluarga ini', zh: '這個家庭開通 Premium', en: 'Premium for this household' })}
        </label>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-slate-700">
            <span>{text({ id: 'Alasan perubahan', zh: '變更理由', en: 'Change reason' })}</span>
            <select
              value={draft.reason}
              disabled={saving}
              onChange={event => onDraftChange({ reason: event.target.value as HouseholdDraft['reason'] })}
              className="min-h-[44px] rounded border-2 border-control-border px-2 text-sm"
            >
              {reasons.map(reason => (
                <option key={reason} value={reason}>{text(HOUSEHOLD_REASON_LABELS[reason])}</option>
              ))}
            </select>
          </label>

          {showDate && (
            <label className="flex flex-col gap-1 text-xs text-slate-700">
              <span>
                {draft.reason === 'trial'
                  ? text({ id: 'Tanggal berakhir uji coba (hari itu masih berlaku)', zh: '試用到期日（當天仍有效）', en: 'Trial end date (still valid that day)' })
                  : text({ id: 'Tanggal berakhir (kosongkan jika tanpa batas)', zh: '到期日（留空＝不到期）', en: 'End date (leave empty for no expiry)' })}
              </span>
              <input
                type="date"
                value={draft.trialEndsOn}
                min={taipeiToday()}
                max={taipeiMaxTrialEndsOn()}
                disabled={saving}
                onChange={event => onDraftChange({ trialEndsOn: event.target.value })}
                className="min-h-[44px] rounded border-2 border-control-border px-2 text-sm"
              />
            </label>
          )}

          <button
            type="button"
            disabled={saving || !canApply}
            onClick={onApply}
            className="min-h-[44px] rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:opacity-50"
          >
            {saving ? text({ id: 'Menyimpan…', zh: '儲存中…', en: 'Saving…' }) : text({ id: 'Terapkan', zh: '套用', en: 'Apply' })}
          </button>
        </div>
        {saveError && <p className="text-xs text-red-700" role="alert">{text(saveError)}</p>}
        {subscriptionConflict && (
          <HouseholdSubscriptionConflictNotice
            draft={draft}
            // 看列上存的 tier／來源，不看是否仍生效（Codex review on PR #1210 P2）：後台給的試用過期、訂閱還在終止中時，
            // 這仍是「後台給過的權益」，不能被說成付費來源而叫管理者去退款。
            heldByAdminGrant={household.premiumTier === 'premium' && (household.premiumSource === 'complimentary' || household.premiumSource === 'trial')}
            canApply={canApply}
            saving={saving}
            onGrantAndCancel={onGrantAndCancel}
          />
        )}
        {saved && !saveError && (
          <p className="text-xs font-semibold text-brand-700" role="status">
            {cancelRequested
              // 照實說「標記」而不是「已終止」：向付款服務終止委託是之後的金流流程，完成前仍可能扣款。
              ? text({
                id: 'Tersimpan dan dicatat di riwayat perubahan. Langganan sudah ditandai untuk dihentikan; penghentian di penyedia pembayaran diproses kemudian, dan potongan sebelum itu perlu dikembalikan secara manual.',
                zh: '已儲存並寫入稽核紀錄。訂閱已標記為終止；向付款服務終止扣款由之後的金流流程處理，完成前若仍扣款需要人工退款。',
                en: 'Saved and recorded in the change history. The subscription is marked for termination; the payment provider is told to stop charging later, and any charge before that needs a manual refund.',
              })
              : text({ id: 'Tersimpan dan dicatat di riwayat perubahan.', zh: '已儲存，並寫入稽核紀錄。', en: 'Saved and recorded in the change history.' })}
          </p>
        )}
      </div>

      <div className="mt-3 border-t border-slate-100 pt-2">
        <button type="button" onClick={onToggleAudit} aria-expanded={audit?.open === true} className="min-h-[44px] text-sm font-semibold text-brand-700">
          {audit?.open
            ? text({ id: 'Sembunyikan riwayat perubahan', zh: '收合稽核紀錄', en: 'Hide change history' })
            : text({ id: 'Lihat riwayat perubahan', zh: '檢視稽核紀錄', en: 'View change history' })}
        </button>
        {audit?.open && <HouseholdEntitlementAuditList audit={audit} />}
      </div>
    </article>
  )
}
