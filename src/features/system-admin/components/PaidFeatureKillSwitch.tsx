/*
檔案用途：後台「家庭 Premium」分頁的全域 kill switch 區塊（issue #1180，H6；ADR-012 D2）：三個付費功能各一個暫停／恢復按鈕，
         並明白標示「全域、立即生效、不寫家庭稽核」。
所在層：src/features/system-admin/components；純呈現元件，狀態與寫入由 useHouseholdPremium 提供，確認對話框由上層傳入。
主要關聯：HouseholdPremiumPanel.tsx（唯一呼叫端）、src/features/system-admin/householdPremiumLabels.ts、
         src/lib/adminHouseholds.ts（PAID_FEATURES 值域、HOUSEHOLD_PREMIUM_READER_LIVE：讀取點還沒接上的功能不給暫停）。
*/
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { HOUSEHOLD_PREMIUM_READER_LIVE, PAID_FEATURES, type PaidFeature, type PaidFeatureSuspension } from '../../../lib/adminHouseholds'
import { PAID_FEATURE_LABELS, formatTaipeiDateTime } from '../householdPremiumLabels'

export interface PaidFeatureKillSwitchProps {
  suspensions: PaidFeatureSuspension[]
  saving: Partial<Record<PaidFeature, boolean>>
  saved: boolean
  error: LocalizedText | null
  confirm: (message: string, options?: { danger?: boolean }) => Promise<boolean>
  onToggle: (feature: PaidFeature, suspended: boolean) => Promise<void>
  // 預設用全站常數；只為了單元測試能模擬「讀取點已接上」的畫面而開放注入。
  readerLive?: Readonly<Record<PaidFeature, boolean>>
}

export function PaidFeatureKillSwitch({ suspensions, saving, saved, error, confirm, onToggle, readerLive = HOUSEHOLD_PREMIUM_READER_LIVE }: PaidFeatureKillSwitchProps) {
  const { text } = useI18n()
  const suspendedAt = new Map(suspensions.map(row => [row.feature, row.suspendedAt]))

  const handleToggle = async (feature: PaidFeature, suspend: boolean) => {
    const name = text(PAID_FEATURE_LABELS[feature])
    // 一按就影響所有付費家庭，所以每一次都要確認；暫停用紅色確認鈕，恢復用一般確認鈕。
    const message = suspend
      ? text({
        id: `Hentikan sementara "${name}" untuk SEMUA keluarga sekarang? Keluarga berbayar kembali ke kuota gratis.`,
        zh: `確定要立即對「所有家庭」暫停「${name}」嗎？付費家庭會退回免費版的額度。`,
        en: `Suspend "${name}" for EVERY household right now? Paying households fall back to the free allowance.`,
      })
      : text({
        id: `Aktifkan kembali "${name}" untuk semua keluarga sekarang?`,
        zh: `確定要立即對所有家庭恢復「${name}」嗎？`,
        en: `Resume "${name}" for every household right now?`,
      })
    if (!(await confirm(message, { danger: suspend }))) return
    await onToggle(feature, suspend)
  }

  return (
    <section aria-labelledby="paid-feature-kill-switch-title" className="rounded-lg border border-red-200 bg-white p-4 shadow-sm">
      <h3 id="paid-feature-kill-switch-title" className="text-lg font-bold text-slate-900">
        {text({ id: 'Sakelar darurat fitur berbayar', zh: '付費功能全域暫停開關', en: 'Paid feature global suspension' })}
      </h3>
      {/* 票文要求的三件事寫在最顯眼的位置：全域（不是某個家庭）、立即生效、不寫家庭稽核。
          變更紀錄在資料庫的 app_admin_config_audit_log，後台沒有畫面可看（只能用 SQL 查，見營運 SOP），文案照實說，不暗示有畫面。 */}
      <p className="mt-1 rounded bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
        {text({
          id: 'Berlaku untuk semua keluarga dan langsung aktif. Tidak dicatat di riwayat keluarga mana pun; setiap perubahan dicatat di tabel audit pengaturan admin di basis data (tidak ditampilkan di halaman ini).',
          zh: '全域開關：對所有家庭立即生效，不寫入任何家庭的稽核紀錄；每次變更另記在資料庫的後台設定稽核表（本頁不顯示）。',
          en: 'Global switch: applies to every household immediately and is not written to any household audit; each change is logged in the admin settings audit table in the database (not shown on this page).',
        })}
      </p>
      <p className="mt-2 text-sm text-slate-600">
        {text({
          id: 'Saat sebuah fitur dihentikan, keluarga berbayar kembali ke kuota gratis untuk fitur itu. Peringatan tekanan darah berbahaya tidak pernah terpengaruh oleh sakelar ini.',
          zh: '暫停某項功能時，付費家庭的該功能退回免費版的額度。危險血壓警報不受任何開關影響。',
          en: 'While a feature is suspended, paying households fall back to the free allowance for it. Danger-level blood pressure alerts are never affected by these switches.',
        })}
      </p>

      <ul className="mt-3 divide-y divide-slate-100">
        {PAID_FEATURES.map(feature => {
          const isSuspended = suspendedAt.has(feature)
          const busy = saving[feature] === true
          // 讀取點還沒接上：暫停不會改變任何使用者行為（Codex review on #1194 第二輪 P1）。不給暫停，免得事故時以為已經止血；
          // 若已經有一筆暫停（例如演練留下的），仍給「恢復」，清掉它沒有任何副作用。
          const live = readerLive[feature]
          const canPress = live || isSuspended
          return (
            <li key={feature} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div>
                <p className="text-sm font-semibold text-slate-900">{text(PAID_FEATURE_LABELS[feature])}</p>
                <p className={`text-xs ${isSuspended ? 'font-semibold text-red-700' : 'text-slate-600'}`}>
                  {isSuspended
                    ? text({
                      id: `Dihentikan sejak ${formatTaipeiDateTime(suspendedAt.get(feature) ?? null)}`,
                      zh: `已暫停（自 ${formatTaipeiDateTime(suspendedAt.get(feature) ?? null)}）`,
                      en: `Suspended since ${formatTaipeiDateTime(suspendedAt.get(feature) ?? null)}`,
                    })
                    : text({ id: 'Berjalan normal', zh: '正常提供', en: 'Running normally' })}
                </p>
                {!live && (
                  <p className="text-xs font-semibold text-amber-900">
                    {text({
                      id: 'Belum berlaku: fitur ini belum membaca Premium keluarga, jadi menghentikannya tidak mengubah apa pun bagi pengguna. Untuk menghentikan biaya sekarang, gunakan cara lain.',
                      zh: '尚未生效：這項功能還沒改讀家庭 Premium，在這裡暫停不會改變任何使用者行為。現在要止血請用其他方式。',
                      en: 'Not in effect yet: this feature does not read household Premium yet, so suspending it here changes nothing for users. Use another way to stop costs now.',
                    })}
                  </p>
                )}
              </div>
              <button
                type="button"
                disabled={busy || !canPress}
                onClick={() => void handleToggle(feature, !isSuspended)}
                className={`min-h-[44px] rounded-lg px-3 py-2 text-sm font-semibold transition disabled:opacity-60 ${isSuspended ? 'border-2 border-control-border bg-white text-slate-900 hover:bg-slate-50' : 'bg-red-600 text-white hover:bg-red-700'}`}
              >
                {busy
                  ? text({ id: 'Menyimpan…', zh: '儲存中…', en: 'Saving…' })
                  : isSuspended
                    ? text({ id: 'Aktifkan kembali', zh: '恢復', en: 'Resume' })
                    : text({ id: 'Hentikan sementara', zh: '暫停', en: 'Suspend' })}
              </button>
            </li>
          )
        })}
      </ul>
      {error && <p className="mt-2 text-sm text-red-700" role="alert">{text(error)}</p>}
      {saved && !error && (
        <p className="mt-2 text-sm font-semibold text-brand-700" role="status">
          {text({ id: 'Sakelar sudah diperbarui untuk semua keluarga.', zh: '已更新，所有家庭立即套用。', en: 'Updated; it applies to every household now.' })}
        </p>
      )}
    </section>
  )
}
