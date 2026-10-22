/*
檔案用途：後台「家庭 Premium」卡片裡的「此家庭有進行中的訂閱」說明區（issue #1202）：送出撞到 subscription_in_progress 之後才出現，
         依目前草稿說明能做什麼——招待／試用可以改按「招待並終止訂閱」、更正要先改理由、關閉則後台不提供。
所在層：src/features/system-admin/components；純呈現元件，衝突狀態與送出由 useHouseholdPremium 提供、確認對話框由 HouseholdPremiumPanel 負責。
主要關聯：HouseholdPremiumCard.tsx（唯一呼叫端）、src/features/system-admin/hooks/useHouseholdPremium.ts（canGrantAndCancel）、
         supabase/functions/admin-set-household-entitlement（409 與 cancelSubscription）、
         supabase/migrations/20261006183520_add_subscription_state_machine_and_payment_ledger.sql（守門與 admin_grant_household_entitlement）、
         docs/operations/core-household-premium-runbook.md「家庭有進行中的訂閱時」。
*/
import { useI18n } from '../../../lib/i18n'
import { type HouseholdDraft, canGrantAndCancel } from '../hooks/useHouseholdPremium'
import { HOUSEHOLD_REASON_LABELS } from '../householdPremiumLabels'

export interface HouseholdSubscriptionConflictNoticeProps {
  draft: HouseholdDraft
  // 家庭目前的 Premium 已經是後台給的（招待／試用），只是訂閱還在終止流程中——通常是先前按過「招待並終止訂閱」。
  // 這時「關閉」被擋的理由不是「付費期間要退款」，而是「訂閱還沒走完」，說明要分開講，不能叫管理者去退一筆不是來源的款。
  heldByAdminGrant: boolean
  // 與「套用」同一個條件（表單改過、送出後會不同）：沒改過的草稿不能用這顆按鈕把訂閱終止掉。
  canApply: boolean
  saving: boolean
  onGrantAndCancel: () => void
}

// 說明區用 role="status" 而不是 alert：它是一段常駐說明，內容跟著草稿變；用 alert 會讓報讀器在每次改草稿時重念一次。
const NOTICE_CLASS = 'rounded bg-amber-50 px-3 py-2 text-xs text-amber-900'

export function HouseholdSubscriptionConflictNotice({ draft, heldByAdminGrant, canApply, saving, onGrantAndCancel }: HouseholdSubscriptionConflictNoticeProps) {
  const { text } = useI18n()
  // 說明跟著「現在的草稿」走而不是撞到衝突當下的草稿：管理者看完說明把「更正」改成「招待」後，按鈕要立刻出現。
  // 措辭刻意不寫「請先終止」：守門連已取消、終止中、服務期未滿的訂閱都擋，付款人取消並不會讓一般的套用變得可行。
  if (!draft.premium) {
    return (
      <p className={NOTICE_CLASS} role="status">
        {heldByAdminGrant
          ? text({
            id: 'Langganan keluarga ini masih dalam proses penghentian, jadi Premium tidak bisa dimatikan atau dikoreksi dari sini sampai langganan selesai dihentikan dan masa yang sudah dibayar berakhir.',
            zh: '此家庭的訂閱還在終止流程中：在訂閱終止完成、而且已付費的期間結束之前，後台不能關閉或更正 Premium。',
            en: 'This household\'s subscription is still being ended, so Premium cannot be turned off or corrected here until the subscription is fully ended and its paid period is over.',
          })
          : text({
            id: 'Keluarga ini memiliki langganan yang sedang berjalan, jadi Premium tidak bisa dimatikan dari sini. Masa yang sudah dibayar hanya bisa dicabut dengan menghentikan langganan lalu mengembalikan dana.',
            zh: '此家庭有進行中的訂閱，後台不能直接關閉 Premium：付款人已付費的期間，只能透過終止訂閱並退款撤銷。',
            en: 'This household has a subscription in progress, so Premium cannot be turned off here. A paid period can only be revoked by ending the subscription and issuing a refund.',
          })}
      </p>
    )
  }

  if (!canGrantAndCancel(draft)) {
    const complimentary = HOUSEHOLD_REASON_LABELS.complimentary
    const trial = HOUSEHOLD_REASON_LABELS.trial
    return (
      <p className={NOTICE_CLASS} role="status">
        {text({
          id: `Keluarga ini memiliki langganan yang belum selesai, jadi perubahan biasa ditolak. Untuk memberi Premium sekaligus menghentikan langganan, ubah alasan menjadi "${complimentary.id}" atau "${trial.id}".`,
          zh: `此家庭有尚未結束的訂閱，一般的變更會被拒絕。若要同時開通並終止訂閱，請把理由改成「${complimentary.zh}」或「${trial.zh}」。`,
          en: `This household has a subscription that has not ended, so a normal change is refused. To grant Premium and end the subscription in one step, change the reason to "${complimentary.en}" or "${trial.en}".`,
        })}
      </p>
    )
  }

  const isTrial = draft.reason === 'trial'
  return (
    <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3" role="status">
      <p className="text-xs text-amber-900">
        {text({
          id: 'Keluarga ini memiliki langganan yang belum selesai (termasuk yang sudah dibatalkan tetapi masa bayarnya belum habis), jadi perubahan biasa ditolak. Jika yakin, gunakan tombol di bawah: langganan ditandai untuk dihentikan (pembayar tidak bisa membatalkannya) dan Premium dari admin dicatat dalam satu langkah.',
          zh: '此家庭有尚未結束的訂閱（包括已取消但付費期間還沒結束的），一般的變更會被拒絕。若確定要改，請按下方按鈕：會在同一步把訂閱標記為終止（付款人不能反悔）並寫入後台給的 Premium。',
          en: 'This household has a subscription that has not ended (including one that was cancelled but whose paid period is not over), so a normal change is refused. If you are sure, use the button below: it marks the subscription for termination (the payer cannot undo it) and records the admin grant in one step.',
        })}
      </p>
      <button
        type="button"
        disabled={saving || !canApply}
        onClick={onGrantAndCancel}
        className="min-h-[44px] rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800 disabled:opacity-50"
      >
        {isTrial
          ? text({ id: 'Beri uji coba dan hentikan langganan', zh: '給試用並終止訂閱', en: 'Grant trial and end subscription' })
          : text({ id: 'Beri gratis dan hentikan langganan', zh: '招待並終止訂閱', en: 'Grant complimentary and end subscription' })}
      </button>
    </div>
  )
}
