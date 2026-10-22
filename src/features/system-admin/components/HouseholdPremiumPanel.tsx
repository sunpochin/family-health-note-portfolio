/*
檔案用途：後台「家庭 Premium」分頁（issue #1180，H6；ADR-012 D2、D5）：說明區、全域 kill switch、家庭清單（每個家庭一個 Premium 開關
         與稽核檢視）。核心家庭在 contract（H7）前由 owner 在這裡以「招待」理由補登，步驟見 docs/operations/core-household-premium-runbook.md。
所在層：src/features/system-admin/components；由 AdminPage 的「家庭 Premium」分頁在切到該分頁時才掛載（掛載即讀取）。
主要關聯：src/features/system-admin/hooks/useHouseholdPremium.ts、PaidFeatureKillSwitch.tsx、HouseholdPremiumCard.tsx、
         HouseholdSubscriptionConflictNotice.tsx（「招待並終止訂閱」，issue #1202）、
         src/hooks/useConfirm.ts、src/lib/adminHouseholds.ts。
*/
import { useI18n } from '../../../lib/i18n'
import { useConfirm } from '../../../hooks/useConfirm'
import { type AdminHousehold, HOUSEHOLD_PREMIUM_READER_LIVE, PAID_FEATURES } from '../../../lib/adminHouseholds'
import { type UseHouseholdPremiumOptions, isPremiumNow, useHouseholdPremium } from '../hooks/useHouseholdPremium'
import { HOUSEHOLD_REASON_LABELS, PAID_FEATURE_LABELS } from '../householdPremiumLabels'

const liveFeatures = PAID_FEATURES.filter(feature => HOUSEHOLD_PREMIUM_READER_LIVE[feature])
import { HouseholdPremiumCard } from './HouseholdPremiumCard'
import { PaidFeatureKillSwitch } from './PaidFeatureKillSwitch'

export interface HouseholdPremiumPanelProps {
  hookOptions?: UseHouseholdPremiumOptions
}

export function HouseholdPremiumPanel({ hookOptions }: HouseholdPremiumPanelProps) {
  const { text } = useI18n()
  const { confirm, dialog } = useConfirm()
  const state = useHouseholdPremium(hookOptions)

  // 每一次開關都要確認：會改變整個家庭（所有成員、所有被照顧者）的付費功能，並留下一筆不能刪的稽核。
  // 確認訊息把家庭名稱、owner、理由與日期全部寫出來，讓管理者在按下確定前再對一次「是這個家庭」。
  const handleApply = async (household: AdminHousehold) => {
    const draft = state.draftFor(household)
    const owners = household.ownerEmails.join(', ') || text({ id: '(tidak ada)', zh: '（無）', en: '(none)' })
    const reason = text(HOUSEHOLD_REASON_LABELS[draft.reason])
    const until = draft.premium && draft.reason !== 'complimentary' && draft.trialEndsOn ? draft.trialEndsOn : null
    // 已經是 Premium 的家庭改來源或到期日，是「變更」不是「開通」；用錯字會讓管理者以為這個家庭原本沒開（bp-reviewer 第一點）。
    const alreadyPremium = isPremiumNow(household)
    const message = draft.premium && alreadyPremium
      ? text({
        id: `Ubah Premium "${household.name}" (pemilik: ${owners})? Alasan: ${reason}${until ? `, berlaku sampai ${until}` : ', tanpa batas waktu'}. Perubahan ini dicatat di riwayat keluarga.`,
        zh: `確定要變更「${household.name}」（擁有者：${owners}）的 Premium 嗎？理由：${reason}${until ? `，有效至 ${until}` : '，不到期'}。這次變更會寫入家庭稽核紀錄。`,
        en: `Change Premium for "${household.name}" (owner: ${owners})? Reason: ${reason}${until ? `, valid through ${until}` : ', no expiry'}. This change is recorded in the household audit.`,
      })
      : draft.premium
      ? text({
        id: `Aktifkan Premium untuk "${household.name}" (pemilik: ${owners})? Alasan: ${reason}${until ? `, berlaku sampai ${until}` : ''}. Perubahan ini dicatat di riwayat keluarga.`,
        zh: `確定要讓「${household.name}」（擁有者：${owners}）開通 Premium 嗎？理由：${reason}${until ? `，有效至 ${until}` : ''}。這次變更會寫入家庭稽核紀錄。`,
        en: `Turn on Premium for "${household.name}" (owner: ${owners})? Reason: ${reason}${until ? `, valid through ${until}` : ''}. This change is recorded in the household audit.`,
      })
      : text({
        id: `Matikan Premium untuk "${household.name}" (pemilik: ${owners})? Alasan: ${reason}. Perubahan ini dicatat di riwayat keluarga.`,
        zh: `確定要關閉「${household.name}」（擁有者：${owners}）的 Premium 嗎？理由：${reason}。這次變更會寫入家庭稽核紀錄。`,
        en: `Turn off Premium for "${household.name}" (owner: ${owners})? Reason: ${reason}. This change is recorded in the household audit.`,
      })
    if (!(await confirm(message, { danger: !draft.premium }))) return
    await state.applyDraft(household)
  }

  // 「招待並終止訂閱」（issue #1202）：不可復原（付款人不能反悔），一律用 danger 樣式確認，並把「終止前仍可能扣款、要人工退款」講清楚，
  // 不讓管理者以為按下去扣款就立刻停了。
  const handleGrantAndCancel = async (household: AdminHousehold) => {
    const draft = state.draftFor(household)
    // 先擋缺日期的試用，再問確認：不可復原的確認框不該在「其實送不出去」的時候先跳出來。
    // applyDraft 對缺日期的試用在呼叫寫入函式之前就回 false 並顯示「請先選擇試用到期日」，所以這裡直接交給它，不會送出任何請求。
    if (draft.reason === 'trial' && !draft.trialEndsOn) {
      await state.applyDraft(household, { cancelSubscription: true })
      return
    }
    const owners = household.ownerEmails.join(', ') || text({ id: '(tidak ada)', zh: '（無）', en: '(none)' })
    const reason = text(HOUSEHOLD_REASON_LABELS[draft.reason])
    const until = draft.reason === 'trial' && draft.trialEndsOn ? draft.trialEndsOn : null
    const message = text({
      id: `Ubah "${household.name}" (pemilik: ${owners}) menjadi ${reason}${until ? ` sampai ${until}` : ''} dan hentikan langganan yang sedang berjalan? Langganan ditandai untuk dihentikan dan pembayar tidak bisa membatalkannya. Penghentian di penyedia pembayaran diproses kemudian; jika masih terpotong sebelum selesai, dana perlu dikembalikan secara manual. Perubahan ini dicatat di riwayat keluarga.`,
      zh: `確定要把「${household.name}」（擁有者：${owners}）改為${reason}${until ? `（有效至 ${until}）` : ''}，並終止進行中的訂閱嗎？訂閱會標記為終止，付款人不能反悔；向付款服務終止扣款由之後的金流流程處理，完成前若仍扣款需要人工退款。這次變更會寫入家庭稽核紀錄。`,
      en: `Switch "${household.name}" (owner: ${owners}) to ${reason}${until ? ` through ${until}` : ''} and end the subscription in progress? The subscription is marked for termination and the payer cannot undo it. The payment provider is told to stop charging later; any charge before that needs a manual refund. This change is recorded in the household audit.`,
    })
    if (!(await confirm(message, { danger: true }))) return
    await state.applyDraft(household, { cancelSubscription: true })
  }

  return (
    <section aria-labelledby="household-premium-title" className="space-y-4">
      {dialog}
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="household-premium-title" className="text-xl font-bold text-slate-900">
          {text({ id: 'Premium keluarga', zh: '家庭 Premium', en: 'Household Premium' })}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-slate-600">
          {text({
            id: 'Premium diberikan per keluarga: semua anggota dan semua penerima perawatan di keluarga itu ikut mendapatkannya. Satu sakelar per keluarga; batas penerima perawatan dan kuota mengikuti status Premium secara otomatis dan tidak bisa diubah di sini. Setiap perubahan dicatat di riwayat keluarga.',
            zh: 'Premium 以家庭為單位：家庭裡所有成員與所有被照顧者一起生效。每個家庭只有一個開關；被照顧者上限與各項額度由 Premium 狀態自動決定，這裡不能改。每次變更都會寫入該家庭的稽核紀錄。',
            en: 'Premium is granted per household: every member and every care recipient in that household gets it. One switch per household; the care recipient limit and quotas follow the Premium status automatically and cannot be changed here. Every change is recorded in the household audit.',
          })}
        </p>
        {/* 讀取點逐票接上（H2／H4／H5）之前，家庭開關只會記錄與留稽核，使用者端不會變；照實說，避免以為已經替誰開通了（Codex review on #1194 第二輪）。 */}
        <p className="mt-2 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {liveFeatures.length === 0
            ? text({
              id: 'Belum ada fitur yang membaca Premium keluarga. Sakelar di sini untuk sementara hanya dicatat dan diaudit, tanpa perubahan bagi pengguna; yang berlaku masih hak per akun di tab Manajemen pengguna.',
              zh: '目前還沒有任何功能改讀家庭 Premium：在這裡開關只會記錄並留稽核，使用者端暫時不會有變化；生效中的仍是「使用者管理」分頁的舊制每帳號旗標。',
              en: 'No feature reads household Premium yet: switching here is recorded and audited but changes nothing for users for now; the per-account legacy flags in the User management tab still apply.',
            })
            : text({
              id: `Sudah membaca Premium keluarga: ${liveFeatures.map(feature => PAID_FEATURE_LABELS[feature].id).join(', ')}. Fitur lain masih memakai hak per akun di tab Manajemen pengguna.`,
              zh: `已改讀家庭 Premium：${liveFeatures.map(feature => PAID_FEATURE_LABELS[feature].zh).join('、')}。其餘功能仍以「使用者管理」分頁的舊制每帳號旗標為準。`,
              en: `Already reading household Premium: ${liveFeatures.map(feature => PAID_FEATURE_LABELS[feature].en).join(', ')}. Other features still use the per-account legacy flags in the User management tab.`,
            })}
        </p>
      </div>

      {state.loading && (
        <p className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-500">{text({ id: 'Memuat…', zh: '載入中…', en: 'Loading…' })}</p>
      )}

      {state.loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{text(state.loadError)}</p>
          <button type="button" onClick={() => void state.reload()} className="mt-2 min-h-[44px] rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700">
            {text({ id: 'Coba lagi', zh: '重試', en: 'Try again' })}
          </button>
        </div>
      )}

      {!state.loading && !state.loadError && (
        <>
          {/* 寫入成功後的安靜重讀失敗：清單照樣留著（可能是舊的），明講「已儲存」並給一顆重讀按鈕，不讓管理者為了確認而重按套用。 */}
          {state.refreshError && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3" role="alert">
              <p className="text-sm text-amber-900">{text(state.refreshError)}</p>
              <button type="button" onClick={() => void state.refresh()} className="mt-2 min-h-[44px] rounded-lg border-2 border-control-border bg-white px-3 py-1.5 text-sm font-semibold text-slate-900">
                {text({ id: 'Muat ulang', zh: '重新讀取', en: 'Reload' })}
              </button>
            </div>
          )}

          <PaidFeatureKillSwitch
            suspensions={state.suspensions}
            saving={state.killSwitchSaving}
            saved={state.killSwitchSaved}
            error={state.killSwitchError}
            confirm={confirm}
            onToggle={state.toggleSuspension}
          />

          <div className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
            <span className="text-sm font-semibold text-slate-700">{text({ id: 'Jumlah keluarga', zh: '家庭總數', en: 'Households' })}：</span>
            <span className="text-lg font-bold text-brand-700">{state.households.length}</span>
          </div>

          {state.households.length === 0 ? (
            <p className="text-sm text-slate-500">{text({ id: 'Belum ada data.', zh: '目前沒有任何資料。', en: 'No data yet.' })}</p>
          ) : (
            <div className="space-y-3">
              {state.households.map(household => (
                <HouseholdPremiumCard
                  key={household.householdId}
                  household={household}
                  draft={state.draftFor(household)}
                  canApply={state.canApply(household)}
                  saving={state.saving[household.householdId] === true}
                  saved={state.savedNotices[household.householdId] === true}
                  saveError={state.saveErrors[household.householdId] ?? null}
                  audit={state.audits[household.householdId]}
                  subscriptionConflict={state.subscriptionConflicts[household.householdId] ?? null}
                  cancelRequested={state.cancelRequestedNotices[household.householdId] === true}
                  onDraftChange={patch => state.updateDraft(household, patch)}
                  onApply={() => void handleApply(household)}
                  onGrantAndCancel={() => void handleGrantAndCancel(household)}
                  onToggleAudit={() => state.toggleAudit(household.householdId)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  )
}
