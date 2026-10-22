/*
檔案用途：後台「家庭 Premium」分頁中單一家庭的稽核列表（issue #1180，H6）：household_entitlement_change_logs 的每一列，
         顯示時間、來源、操作者、哪一項權益、原值 → 新值、理由，以及 Premium 列寫入後的來源與有效期。
所在層：src/features/system-admin/components；純呈現元件，資料由 useHouseholdPremium 的 audits 提供。
主要關聯：HouseholdPremiumCard.tsx（唯一呼叫端）、src/features/system-admin/householdPremiumLabels.ts、
         src/lib/adminHouseholds.ts（HouseholdEntitlementChange）。
*/
import { useI18n } from '../../../lib/i18n'
import type { HouseholdAuditState } from '../hooks/useHouseholdPremium'
import {
  AUDIT_ENTITLEMENT_LABELS,
  AUDIT_SOURCE_LABELS,
  HOUSEHOLD_REASON_LABELS,
  HOUSEHOLD_SOURCE_LABELS,
  PREMIUM_TIER_VALUE_LABELS,
  formatPremiumValidThrough,
  formatTaipeiDateTime,
  labelOrRaw,
} from '../householdPremiumLabels'

export function HouseholdEntitlementAuditList({ audit }: { audit: HouseholdAuditState }) {
  const { text } = useI18n()

  if (audit.loading) return <p className="text-xs text-slate-500">{text({ id: 'Memuat…', zh: '載入中…', en: 'Loading…' })}</p>
  if (audit.error) return <p className="text-xs text-red-700" role="alert">{text(audit.error)}</p>
  if (audit.changes.length === 0) {
    return <p className="text-xs text-slate-500">{text({ id: 'Belum ada riwayat perubahan.', zh: '還沒有任何變更紀錄。', en: 'No changes recorded yet.' })}</p>
  }

  // Premium 狀態列的值是 premium／none，要翻成「Premium／免費版」；上限列是數字，原樣顯示。
  // 原值 NULL 依 H1 的定義是「這次之前家庭還沒有 entitlement 列，等同免費」：照它的意思顯示成免費版／2，
  // 而不是「（無）」——家庭第一次被補登（正是 production 核心家庭的情況）時，SOP 寫的「免費版 → Premium」才對得上畫面。
  const valueText = (entitlement: string, value: string | null) => {
    if (entitlement === 'premium_tier') return text(labelOrRaw(PREMIUM_TIER_VALUE_LABELS, value ?? 'none'))
    return value ?? (entitlement === 'care_recipient_limit' ? '2' : text({ id: '(belum ada)', zh: '（無）', en: '(none)' }))
  }

  return (
    <div>
      <ol className="space-y-1.5">
        {audit.changes.map(change => (
          <li key={change.id} className="rounded border border-slate-200 bg-slate-50 px-2 py-1.5 text-xs text-slate-800">
            <div className="flex flex-wrap gap-x-2 text-slate-600">
              <span>{formatTaipeiDateTime(change.createdAt)}</span>
              <span>{text(labelOrRaw(AUDIT_SOURCE_LABELS, change.source))}</span>
              {/* 只有後台操作有「人」；付款通知、排程、migration 是系統來源，沒有操作者。帳號刪除後 email 是 NULL，稽核列仍保留。 */}
              {change.source === 'admin' && (
                <span className="break-all">
                  {change.actorEmail ?? text({ id: 'Akun yang sudah dihapus', zh: '已刪除的帳號', en: 'Deleted account' })}
                </span>
              )}
            </div>
            <div className="mt-0.5">
              <span className="font-semibold">{text(labelOrRaw(AUDIT_ENTITLEMENT_LABELS, change.entitlement))}</span>
              {'：'}
              {valueText(change.entitlement, change.oldValue)} → {valueText(change.entitlement, change.newValue)}
              {' · '}
              {text(labelOrRaw(HOUSEHOLD_REASON_LABELS, change.reason))}
            </div>
            {change.entitlement === 'premium_tier' && change.newPremiumSource && change.newPremiumSource !== 'none' && (
              <div className="mt-0.5 text-slate-600">
                {text(labelOrRaw(HOUSEHOLD_SOURCE_LABELS, change.newPremiumSource))}
                {change.newPremiumUntil
                  ? text({
                    id: ` · berlaku sampai ${formatPremiumValidThrough(change.newPremiumUntil)}`,
                    zh: ` · 有效至 ${formatPremiumValidThrough(change.newPremiumUntil)}`,
                    en: ` · valid through ${formatPremiumValidThrough(change.newPremiumUntil)}`,
                  })
                  : text({ id: ' · tanpa batas waktu', zh: ' · 不到期', en: ' · no expiry' })}
              </div>
            )}
          </li>
        ))}
      </ol>
      {audit.truncated && (
        <p className="mt-1 text-xs text-slate-500">
          {text({ id: 'Hanya menampilkan 100 catatan terbaru.', zh: '只顯示最近 100 筆。', en: 'Showing the latest 100 entries only.' })}
        </p>
      )}
    </div>
  )
}
