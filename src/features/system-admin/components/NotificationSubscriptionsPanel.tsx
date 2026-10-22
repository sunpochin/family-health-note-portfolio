/*
檔案用途：提供系統管理者管理「通知訂閱」的後台面板，列出有照護權限的病人（含已封存）與可切換的通知管道開關（目前僅 Telegram）。
所在層：src/features/system-admin/components；由 AdminPage 的通知訂閱分頁載入。
主要關聯：src/features/system-admin/hooks/useNotificationSubscriptions.ts、
         src/lib/notificationSubscriptions.ts。
*/
import { useI18n } from '../../../lib/i18n'
import {
  ADMIN_TOGGLEABLE_CHANNELS,
  CHANNEL_LABELS,
  subscriptionKey,
} from '../../../lib/notificationSubscriptions'
import {
  type UseNotificationSubscriptionsOptions,
  useNotificationSubscriptions,
} from '../hooks/useNotificationSubscriptions'

export interface NotificationSubscriptionsPanelProps {
  isAdministrator?: boolean
  hookOptions?: UseNotificationSubscriptionsOptions
}

export function NotificationSubscriptionsPanel({
  isAdministrator = true,
  hookOptions,
}: NotificationSubscriptionsPanelProps) {
  const { text } = useI18n()
  const {
    patients,
    subscriptions,
    loading,
    loadError,
    savingMap,
    errorMap,
    reload,
    toggleSubscription,
  } = useNotificationSubscriptions(hookOptions)

  return (
    <section aria-labelledby="notification-subscriptions-title" className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <h2 id="notification-subscriptions-title" className="text-xl font-bold text-slate-900">
          {text({ id: 'Langganan notifikasi', zh: '通知訂閱管理', en: 'Notification subscription management' })}
        </h2>
        <p className="mt-1 text-sm text-slate-600 leading-relaxed">
          {text({
            id: 'Kelola tujuan notifikasi bersama tingkat proyek di sini. Mengaktifkan saluran akan mengirimkan pemberitahuan perawatan pasien ini ke saluran terkait. Penonaktifan mempertahankan catatan tanpa menghapusnya.',
            zh: '此處管理全站專案層級的共用通知管道訂閱。啟用後，對應管道會接收該照護對象的通知。停用時會保留記錄，不會刪除。',
            en: 'Manage project-level shared notification channel subscriptions here. When enabled, the channel will receive notifications for this care recipient. Disabling retains the record without deleting.',
          })}
        </p>
      </div>

      {/* 非管理者防護提示：依 issue #994 驗收條件，若非管理者進入此區塊需清楚告知原因 */}
      {!isAdministrator && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4" role="alert">
          <p className="text-base font-semibold text-amber-900">
            {text({
              id: 'Hanya administrator sistem yang dapat mengubah pengaturan langganan notifikasi.',
              zh: '只有系統管理員可以變更通知訂閱設定。',
              en: 'Only a system administrator can change notification subscription settings.',
            })}
          </p>
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-base font-semibold text-slate-500">
            {text({ id: 'Memuat…', zh: '載入中…', en: 'Loading…' })}
          </p>
        </div>
      )}

      {loadError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 shadow-sm">
          <p className="text-base font-medium text-red-700">{text(loadError)}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-3 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-red-700 cursor-pointer min-h-[44px]"
          >
            {text({ id: 'Coba lagi', zh: '重試', en: 'Try again' })}
          </button>
        </div>
      )}

      {!loading && !loadError && patients.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <p className="text-base font-medium text-slate-500">
            {text({
              id: 'Belum ada penerima perawatan yang dapat dikelola.',
              zh: '目前沒有任何可管理的照護對象。',
              en: 'No manageable care recipients found.',
            })}
          </p>
        </div>
      )}

      {!loading && !loadError && patients.length > 0 && (
        <div className="space-y-4">
          {patients.map(patient => (
            <div
              key={patient.id}
              className="rounded-lg border border-slate-200 bg-white p-4 sm:p-5 shadow-sm space-y-4"
            >
              {/* 大字顯示病人名稱（身分邊界明確綁定至 patient_id，絕無外部 id 或 chat id）。
                  下方分隔線原本用的 gray-150 在 Tailwind 沒有這一階，不會產生任何 class，線會退回 currentColor 變成深色；
                  改 slate-100，與本目錄其他卡內分隔線一致（#1148）。 */}
              <div className="border-b border-slate-100 pb-2 flex items-center justify-between">
                <h3 className="text-lg font-bold text-slate-900">
                  {patient.displayName}
                </h3>
                <span className="text-xs text-slate-500 font-mono">
                  {patient.archived
                    ? text({ id: 'Diarsipkan', zh: '已封存', en: 'Archived' })
                    : text({ id: 'Penerima perawatan', zh: '照護對象', en: 'Care recipient' })}
                </span>
              </div>

              {/* 三大管道開關列表（telegram | line | push） */}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {ADMIN_TOGGLEABLE_CHANNELS.map(channel => {
                  const key = subscriptionKey(patient.id, channel)
                  const isEnabled = subscriptions[key] === true
                  const isSaving = savingMap[key] === true
                  const mutationError = errorMap[key]
                  const channelLabel = text(CHANNEL_LABELS[channel])
                  const switchAriaLabel = `${patient.displayName} ${channelLabel}`

                  return (
                    <div
                      key={channel}
                      className="flex flex-col justify-between rounded-lg border border-slate-200 bg-slate-50 p-3.5"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <span className="text-base font-bold text-slate-900 block">
                            {channelLabel}
                          </span>
                          <span
                            className={`mt-1 inline-block text-xs font-semibold px-2 py-0.5 rounded ${
                              isEnabled
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-slate-200 text-slate-600'
                            }`}
                          >
                            {isEnabled
                              ? text({ id: 'Aktif', zh: '已開通', en: 'Enabled' })
                              : text({ id: 'Nonaktif', zh: '已停用', en: 'Disabled' })}
                          </span>
                        </div>

                        {/* 開關元件：44px 點擊區套在 button 本身（外層 wrapper 不會放大 hit box），視覺軌道仍維持 h-7 w-12 */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={isEnabled}
                          aria-label={switchAriaLabel}
                          disabled={isSaving || !isAdministrator}
                          onClick={() => void toggleSubscription(patient.id, channel, !isEnabled)}
                          className={`inline-flex min-h-[44px] min-w-[44px] shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 ${
                            isSaving || !isAdministrator ? 'opacity-50 cursor-not-allowed' : ''
                          }`}
                        >
                          <span
                            aria-hidden="true"
                            className={`relative inline-flex h-7 w-12 shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out ${
                              isEnabled ? 'bg-brand-700' : 'bg-slate-300'
                            }`}
                          >
                            <span
                              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                isEnabled ? 'translate-x-5' : 'translate-x-0'
                              }`}
                            />
                          </span>
                        </button>
                      </div>

                      {isSaving && (
                        <p className="mt-2 text-xs font-medium text-slate-500 animate-pulse">
                          {text({ id: 'Menyimpan…', zh: '儲存中…', en: 'Saving…' })}
                        </p>
                      )}

                      {mutationError && (
                        <p className="mt-2 text-xs font-semibold text-red-600" role="alert">
                          {text(mutationError)}
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
