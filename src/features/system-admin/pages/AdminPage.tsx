/*
檔案用途：提供管理者檢視與刪除血壓紀錄、查看全站註冊用戶清單與付費旗標、開關家庭 Premium 與全域 kill switch（#1180），以及管理通知訂閱的後台畫面。
所在層：src/features/system-admin/pages；僅由受限的 /admin 路由載入。
主要關聯：AdminBloodPressurePanel 負責血壓總表的篩選、勾選與刪除（狀態在 hooks/useAdminBloodPressureRecords）、i18n 顯示目前語系、lib/adminUsers 呼叫 admin-list-users Edge Function 取得使用者管理分頁資料、
         HouseholdPremiumPanel 管理家庭 Premium（取代使用者分頁的每帳號付費勾選框，那三個勾選框在 H7 移除），以及 NotificationSubscriptionsPanel 管理通知訂閱、MissionControlPanel 提供雲端工程派工。
*/
import { useState, useEffect, useRef } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import 'dayjs/locale/id'
import { signOut } from '../../../lib/auth'
import { type LocalizedText, useI18n } from '../../../lib/i18n'
import { type EntitlementKey, type EntitlementReason, ENTITLEMENT_REASONS } from '../../../lib/adminUsers'
import { HOUSEHOLD_PREMIUM_READER_LIVE } from '../../../lib/adminHouseholds'
import { LEGACY_ENTITLEMENT_FEATURE } from '../../../../supabase/functions/_shared/paidFeatureEntitlementPolicy.ts'
import { ENTITLEMENT_FIELD_BY_KEY, useAccountEntitlements } from '../hooks/useAccountEntitlements'
import { AdminBloodPressurePanel } from '../components/AdminBloodPressurePanel'
import { HouseholdPremiumPanel } from '../components/HouseholdPremiumPanel'
import { MedicationCatalogCurationPanel } from '../components/MedicationCatalogCurationPanel'
import { MissionControlPanel } from '../components/MissionControlPanel'
import { NotificationSubscriptionsPanel } from '../components/NotificationSubscriptionsPanel'

// 延伸 dayjs 以支援時區與 UTC 轉換，確保時間不論管理員本地裝置時區為何，均統一以台北時區呈現
dayjs.extend(utc)
dayjs.extend(timezone)

// 從未登入過的帳號 last_sign_in_at 會是 null；統一顯示「－」，避免管理者誤讀成空白或載入失敗。
function formatAdminTimestamp(value: string | null): string {
  if (!value) return '－'
  const parsed = dayjs(value)
  return parsed.isValid() ? parsed.tz('Asia/Taipei').format('YYYY-MM-DD HH:mm') : '－'
}

// 開通原因的三語文案；值域必須與 adminUsers.ts 的 ENTITLEMENT_REASONS 及 RPC 內的 CHECK 值域一致。
const ENTITLEMENT_REASON_LABELS: Record<EntitlementReason, LocalizedText> = {
  paid: { id: 'Berbayar', zh: '付費', en: 'Paid' },
  trial: { id: 'Uji coba', zh: '試用', en: 'Trial' },
  complimentary: { id: 'Gratis (hadiah)', zh: '招待', en: 'Complimentary' },
  correction: { id: 'Koreksi data', zh: '更正登錄錯誤', en: 'Data correction' },
  revoked: { id: 'Dicabut', zh: '停權', en: 'Revoked' },
}

// medication_ai_draft_tier 的說明文字刻意標出「額度更高」：2026-09-11 起未開通帳號也有每日 3 次
// 免費額度（推廣策略），這裡不再是純粹的「有沒有」開關，勾選只代表把額度從免費的 3 次提高到付費額度，
// 避免管理者誤以為不勾就完全擋掉。
const ENTITLEMENT_LABELS: Record<EntitlementKey, LocalizedText> = {
  personal_notification_tier: { id: 'Notifikasi pribadi', zh: '個人化通知', en: 'Personal notifications' },
  medication_ai_draft_tier: { id: 'Draf AI kantong obat (kuota harian lebih banyak)', zh: 'AI 藥袋草稿（提升每日次數）', en: 'AI medication draft (higher daily quota)' },
  premium_tier: { id: 'Premium', zh: 'Premium 付費會員', en: 'Premium' },
  medication_catalog_curator_tier: { id: 'Pengelola katalog obat bersama', zh: '共用藥品目錄管理員', en: 'Shared medication catalog curator' },
}

// 四個 entitlement 勾選框與各自的錯誤訊息都依這個順序渲染；只有一個地方要改順序或新增/移除一項。
const ENTITLEMENT_DISPLAY_ORDER: readonly EntitlementKey[] = ['personal_notification_tier', 'medication_ai_draft_tier', 'premium_tier', 'medication_catalog_curator_tier']

// 舊制的每帳號付費旗標（以 email 為鍵）：付費改以家庭為單位後，開通在「家庭 Premium」分頁做（ADR-012、#1180），
// 這三個勾選框都標「舊制，H7 移除」，H7 contract 時連同 account_usage_limits 的欄位一起移除。
// 共用藥品目錄管理員是權限、不是付費（ADR-012 D2 排除清單），不在這裡，維持可寫。
const LEGACY_PAID_ENTITLEMENTS: ReadonlySet<EntitlementKey> = new Set(['personal_notification_tier', 'medication_ai_draft_tier', 'premium_tier'])

// 帳號級 premium_tier 從來沒有讀取點，所以勾選框一律唯讀；功能級旗標則依各自的讀取點決定能否新開通。
const LEGACY_READ_ONLY_ENTITLEMENTS: ReadonlySet<EntitlementKey> = new Set(['premium_tier'])
type AdminTab = 'medications' | 'blood-pressure' | 'users' | 'household-premium' | 'subscriptions' | 'catalog' | 'missions'

// tab 順序也決定左右鍵切換順序，維持與畫面排列一致，避免 focus 跳到看不到的分頁。
const ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITH_CATALOG: AdminTab[] = ['medications', 'blood-pressure', 'users', 'household-premium', 'subscriptions', 'catalog', 'missions']
const ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITHOUT_CATALOG: AdminTab[] = ['medications', 'blood-pressure', 'users', 'household-premium', 'subscriptions', 'missions']
// 目錄管理員（curator）不是唯一的 administrator：血壓總表與使用者管理動的是跨病人健康資料與
// 付費／權限旗標，不屬於 curator 的職責範圍，只讓「藥品目錄」分頁可見（文件 §4.6）。
const ADMIN_TAB_ORDER_FOR_CURATOR: AdminTab[] = ['catalog']

export interface AdminPageProps {
  // 由 App.tsx 判斷：是否為站內唯一的 administrator（isAdministratorEmail）。false 代表只是
  // 共用藥品目錄管理員（curator）身分通過 /admin 路由。
  isAdministrator: boolean
  // 由 App.tsx 呼叫 current_user_is_medication_catalog_curator() 取得。新的目錄 RPC 只認這個
  // entitlement、不認舊的寫死 administrator email（文件 §3.6）：administrator 預設不是 curator，
  // 「藥品目錄」分頁只有在這裡是 true 時才顯示，否則 administrator 會看到分頁卻每個動作都被
  // RPC 擋下，一頭霧水（PR #797 review）。curator-only 帳號能進到這個頁面就代表這裡一定是 true
  // （App.tsx 的路由守門已經驗證過）。
  isCatalogCurator: boolean
}

export function AdminPage({ isAdministrator, isCatalogCurator }: AdminPageProps) {
  const { text } = useI18n()
  const tabOrder = isAdministrator
    ? (isCatalogCurator ? ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITH_CATALOG : ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITHOUT_CATALOG)
    : ADMIN_TAB_ORDER_FOR_CURATOR
  // 管理員最常先查看最新血壓，因此以總表作為入口；curator-only 帳號只有「藥品目錄」分頁可選。
  const [activeTab, setActiveTab] = useState<AdminTab>(() => (isAdministrator ? 'blood-pressure' : 'catalog'))
  const medicationTabRef = useRef<HTMLButtonElement>(null)
  const bloodPressureTabRef = useRef<HTMLButtonElement>(null)
  const usersTabRef = useRef<HTMLButtonElement>(null)
  const householdPremiumTabRef = useRef<HTMLButtonElement>(null)
  const subscriptionsTabRef = useRef<HTMLButtonElement>(null)
  const catalogTabRef = useRef<HTMLButtonElement>(null)
  const missionsTabRef = useRef<HTMLButtonElement>(null)
  const tabRefs = { medications: medicationTabRef, 'blood-pressure': bloodPressureTabRef, users: usersTabRef, 'household-premium': householdPremiumTabRef, subscriptions: subscriptionsTabRef, catalog: catalogTabRef, missions: missionsTabRef }

  const {
    users,
    usersLoading,
    usersError,
    fetchUsers,
    loadUsersOnce,
    entitlementReasons,
    entitlementSaving,
    entitlementErrors,
    setReason,
    toggleEntitlement,
  } = useAccountEntitlements()

  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const currentIndex = tabOrder.indexOf(activeTab)
    const delta = event.key === 'ArrowLeft' ? -1 : 1
    const nextTab = tabOrder[(currentIndex + delta + tabOrder.length) % tabOrder.length]
    setActiveTab(nextTab)
    tabRefs[nextTab].current?.focus()
  }

  // 只在第一次切到「使用者管理」分頁時才呼叫 Function，避免管理者只看血壓總表時也額外打一次全站使用者查詢；
  // curator-only 帳號看不到這個分頁，也不該有機會觸發（isAdministrator 守門，見下方 tabOrder）。
  useEffect(() => {
    if (isAdministrator && activeTab === 'users') loadUsersOnce()
  }, [isAdministrator, activeTab, loadUsersOnce])

  return (
    <div className="flex h-full min-h-0 w-full max-w-5xl flex-col bg-slate-50 mx-auto">
      <header className="shrink-0 flex items-center justify-between p-4 bg-white border-b border-slate-200">
        <h1 className="text-xl font-bold text-slate-900">{text({ id: 'Manajemen data admin', zh: '後台資料管理' ,en: 'Background data management' })}</h1>
        <div className="flex items-center gap-3">
          <button onClick={() => window.location.href = '/'} className="text-sm text-brand-700">{text({ id: 'Beranda', zh: '回首頁' ,en: 'Start' })}</button>
          <button onClick={() => signOut()} className="text-sm text-slate-500">{text({ id: 'Keluar', zh: '登出' ,en: 'Sign out' })}</button>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
        <div role="tablist" aria-label={text({ id: 'Fungsi pengelolaan admin', zh: '後台管理功能' ,en: 'Background management features' })} className={`mb-4 grid gap-2 rounded-lg bg-slate-200 p-1 ${tabOrder.length === 7 ? 'grid-cols-2 sm:grid-cols-4' : tabOrder.length === 6 ? 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-6' : tabOrder.length === 5 ? 'grid-cols-2 sm:grid-cols-5' : tabOrder.length === 4 ? 'grid-cols-2 sm:grid-cols-4' : tabOrder.length === 3 ? 'grid-cols-3' : 'grid-cols-1'}`}>
          {/* 各分頁的選中字統一 brand-700：原本各用 emerald／blue／purple／indigo／teal 區分，和設計系統「選中狀態＝品牌色」衝突，
              而且 purple／indigo 是退役色（#1148）。分頁靠文字與位置辨識，不靠色相。 */}
          {/* 分開操作，避免調藥或使用者查詢時誤碰到血壓紀錄刪除按鈕；curator-only 帳號只看得到「藥品目錄」。 */}
          {isAdministrator && (
            <button ref={medicationTabRef} id="medications-tab" type="button" role="tab" tabIndex={activeTab === 'medications' ? 0 : -1} aria-selected={activeTab === 'medications'} aria-controls="medications-panel" onClick={() => setActiveTab('medications')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'medications' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Atur obat', zh: '調藥' ,en: 'Medications' })}</button>
          )}
          {isAdministrator && (
            <button ref={bloodPressureTabRef} id="blood-pressure-tab" type="button" role="tab" tabIndex={activeTab === 'blood-pressure' ? 0 : -1} aria-selected={activeTab === 'blood-pressure'} aria-controls="blood-pressure-panel" onClick={() => setActiveTab('blood-pressure')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'blood-pressure' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Daftar tekanan darah', zh: '血壓總表' ,en: 'Blood pressure table' })}</button>
          )}
          {isAdministrator && (
            <button ref={usersTabRef} id="users-tab" type="button" role="tab" tabIndex={activeTab === 'users' ? 0 : -1} aria-selected={activeTab === 'users'} aria-controls="users-panel" onClick={() => setActiveTab('users')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'users' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Manajemen pengguna', zh: '使用者管理' ,en: 'User management' })}</button>
          )}
          {isAdministrator && (
            <button ref={householdPremiumTabRef} id="household-premium-tab" type="button" role="tab" tabIndex={activeTab === 'household-premium' ? 0 : -1} aria-selected={activeTab === 'household-premium'} aria-controls="household-premium-panel" onClick={() => setActiveTab('household-premium')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'household-premium' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Premium keluarga', zh: '家庭 Premium', en: 'Household Premium' })}</button>
          )}
          {isAdministrator && (
            <button ref={subscriptionsTabRef} id="subscriptions-tab" type="button" role="tab" tabIndex={activeTab === 'subscriptions' ? 0 : -1} aria-selected={activeTab === 'subscriptions'} aria-controls="subscriptions-panel" onClick={() => setActiveTab('subscriptions')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'subscriptions' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Langganan notifikasi', zh: '通知訂閱' ,en: 'Notification subscriptions' })}</button>
          )}
          {tabOrder.includes('catalog') && (
            <button ref={catalogTabRef} id="catalog-tab" type="button" role="tab" tabIndex={activeTab === 'catalog' ? 0 : -1} aria-selected={activeTab === 'catalog'} aria-controls="catalog-panel" onClick={() => setActiveTab('catalog')} onKeyDown={handleTabKeyDown} className={`rounded px-3 py-2 text-sm font-bold ${activeTab === 'catalog' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ id: 'Katalog obat', zh: '藥品目錄', en: 'Medication catalog' })}</button>
          )}
          {/* 工程派工只給 administrator；curator 與照護者權限不因此增加。 */}
          {isAdministrator && <button ref={missionsTabRef} id="missions-tab" type="button" role="tab" tabIndex={activeTab === 'missions' ? 0 : -1} aria-selected={activeTab === 'missions'} aria-controls="missions-panel" onClick={() => setActiveTab('missions')} onKeyDown={handleTabKeyDown} className={`min-h-11 rounded px-3 py-2 text-sm font-bold ${activeTab === 'missions' ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}>{text({ zh: '工程派工', id: 'Tugas pengembangan', en: 'Development tasks' })}</button>}
        </div>

        {isAdministrator && !isCatalogCurator && (
          <p className="mb-4 rounded bg-teal-50 px-3 py-2 text-xs text-teal-900">
            {text({ id: 'Berikan diri Anda sendiri hak "Pengelola katalog obat bersama" di tab Manajemen pengguna untuk membuka tab Katalog obat.', zh: '請在「使用者管理」分頁勾選自己的「共用藥品目錄管理員」，才能開啟「藥品目錄」分頁。', en: 'Grant yourself the "Shared medication catalog curator" entitlement in the Users tab to unlock the Medication catalog tab.' })}
          </p>
        )}

        {isAdministrator && (
          <div id="medications-panel" role="tabpanel" aria-labelledby="medications-tab" tabIndex={0} className={activeTab !== 'medications' ? 'hidden' : ''}>
            <p className="rounded bg-amber-50 p-3 text-sm text-amber-900">{text({ id: 'Pilih diri sendiri atau penerima perawatan di halaman Obat untuk mengatur daftar obat.', zh: '請從「服藥」頁選擇本人或被照顧者後調整藥單。' ,en: 'Select yourself or a care recipient on the Medication page to adjust the medication list.' })}</p>
          </div>
        )}

        {isAdministrator && (
        <div id="blood-pressure-panel" role="tabpanel" aria-labelledby="blood-pressure-tab" tabIndex={0} className={activeTab !== 'blood-pressure' ? 'hidden' : ''}>
          {/* 血壓面板在管理員模式下一掛載就讀取（與改版前相同），切分頁只是隱藏，不重新查詢；curator-only 帳號不會走到這裡。 */}
          <AdminBloodPressurePanel />
        </div>
        )}

        {isAdministrator && (
        <div id="users-panel" role="tabpanel" aria-labelledby="users-tab" tabIndex={0} className={activeTab !== 'users' ? 'hidden' : ''}>
          {usersLoading && <p className="text-sm text-slate-500">{text({ id: 'Memuat…', zh: '載入中…' ,en: 'Loading…' })}</p>}
          {usersError && (
            <div className="rounded bg-red-50 p-3">
              <p className="text-sm text-red-700">{text(usersError)}</p>
              {/* 切分頁不會重試（usersLoadedRef 已設為 true），失敗後必須有明確按鈕才能重新呼叫，不能只靠重新整理整頁。 */}
              <button onClick={fetchUsers} className="mt-2 px-3 py-1.5 bg-red-600 text-white hover:bg-red-700 rounded-lg text-sm font-semibold transition cursor-pointer">
                {text({ id: 'Coba lagi', zh: '重試' ,en: "Try again" })}
              </button>
            </div>
          )}

          {!usersLoading && !usersError && (
            <>
              <div className="mb-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                <span className="text-sm font-semibold text-slate-700">{text({ id: 'Total pengguna terdaftar', zh: '目前總註冊用戶數' ,en: 'Total registered users' })}：</span>
                <span className="text-lg font-bold text-brand-700">{users.length}</span>
              </div>

              {users.length === 0 ? (
                <p className="text-sm text-slate-500">{text({ id: 'Belum ada data.', zh: '目前沒有任何資料。' ,en: 'No data yet.' })}</p>
              ) : (
                <div className="space-y-2">
                  {users.map(u => (
                    <div key={u.userId} className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
                      <div className="text-sm font-semibold text-slate-900 break-all">{u.email}</div>
                      {u.displayName && <div className="text-xs text-slate-600 mt-0.5">{u.displayName}</div>}
                      <div className="text-xs text-slate-600 mt-1 flex flex-wrap gap-x-3">
                        <span>{text({ id: 'Tanggal daftar', zh: '註冊日期' ,en: 'Registration date' })}：{formatAdminTimestamp(u.createdAt)}</span>
                        <span>{text({ id: 'Login terakhir', zh: '最後登入' ,en: 'Last login' })}：{formatAdminTimestamp(u.lastSignInAt)}</span>
                      </div>

                      <div className="mt-2 border-t border-slate-100 pt-2">
                        {/* 開通原因下拉現在只作用在仍可寫的「共用藥品目錄管理員」；付費開通改到「家庭 Premium」分頁。 */}
                        <label className="flex items-center gap-1.5 text-xs text-slate-700 mb-1">
                          <span>{text({ id: 'Alasan perubahan', zh: '開通原因', en: 'Change reason' })}：</span>
                          <select
                            value={entitlementReasons[u.userId] ?? 'paid'}
                            onChange={e => setReason(u.userId, e.target.value as EntitlementReason)}
                            className="rounded border-2 border-control-border px-1.5 py-0.5 text-xs"
                          >
                            {ENTITLEMENT_REASONS.map(reason => (
                              <option key={reason} value={reason}>{text(ENTITLEMENT_REASON_LABELS[reason])}</option>
                            ))}
                          </select>
                        </label>

                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {ENTITLEMENT_DISPLAY_ORDER.map(entitlement => {
                            const field = ENTITLEMENT_FIELD_BY_KEY[entitlement]
                            const key = `${u.userId}:${entitlement}`
                            const checked = u[field] !== 'none'
                            const saving = entitlementSaving[key] === true
                            const legacy = LEGACY_PAID_ENTITLEMENTS.has(entitlement)
                            const readOnly = legacy && LEGACY_READ_ONLY_ENTITLEMENTS.has(entitlement)
                            const liveFeature = LEGACY_ENTITLEMENT_FEATURE[entitlement]
                            // 畫面先阻擋誤勾；同一政策也在 Function 驗證，避免舊分頁跳過這層。
                            const grantBlocked = liveFeature !== undefined && HOUSEHOLD_PREMIUM_READER_LIVE[liveFeature] && !checked
                            const disabled = saving || readOnly || grantBlocked
                            return (
                              <label key={entitlement} className={`flex items-center gap-1.5 text-xs ${disabled ? 'text-slate-500' : 'text-slate-800'}`}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={disabled}
                                  onChange={e => { if (!disabled) toggleEntitlement(u, entitlement, e.target.checked) }}
                                  className="h-3.5 w-3.5"
                                />
                                <span>{text(ENTITLEMENT_LABELS[entitlement])}</span>
                                {legacy && <span>{text({ id: '(sistem lama, dihapus di H7)', zh: '（舊制，H7 移除）', en: '(legacy, removed in H7)' })}</span>}
                                {saving && <span className="text-slate-500">{text({ id: 'Menyimpan…', zh: '儲存中…', en: 'Saving…' })}</span>}
                              </label>
                            )
                          })}
                        </div>
                        <p className="mt-1 text-xs text-slate-500">
                          {text({
                            id: 'Hak berbayar lama per akun tetap berlaku sampai dihapus pada H7. Setelah fitur beralih ke Premium keluarga, centang lama yang sudah aktif tetap bisa dibatalkan, tetapi tidak bisa diaktifkan lagi lewat akun; fitur yang belum beralih masih bisa diubah. Premium tingkat akun hanya dapat dilihat. Atur Premium keluarga di tab Premium keluarga.',
                            zh: '每帳號的舊制付費旗標會在 H7 移除前持續生效。功能改讀家庭 Premium 後，原本已勾選的旗標仍可取消，但不能再透過帳號新增開通；尚未改讀的功能仍可調整。帳號級 Premium 僅供檢視。家庭權益請到「家庭 Premium」分頁管理。',
                            en: 'Legacy per-account paid flags remain in effect until H7 removes them. After a feature switches to household Premium, an existing checked flag can still be cleared, but a new one cannot be granted through the account; flags for features that have not switched over remain editable. Account-level Premium is view-only. Manage household benefits in the Household Premium tab.',
                          })}
                        </p>

                        {ENTITLEMENT_DISPLAY_ORDER.map(entitlement => {
                          const key = `${u.userId}:${entitlement}`
                          const entitlementError = entitlementErrors[key]
                          if (!entitlementError) return null
                          return <p key={entitlement} className="mt-1 text-xs text-red-600">{text(entitlementError)}</p>
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        )}

        {isAdministrator && (
          <div id="household-premium-panel" role="tabpanel" aria-labelledby="household-premium-tab" tabIndex={0} className={activeTab !== 'household-premium' ? 'hidden' : ''}>
            {/* 切到分頁時才掛載（掛載即讀取），只看血壓總表時不會打全站家庭查詢；每次切回來都重讀，看到的是最新狀態。 */}
            {activeTab === 'household-premium' && <HouseholdPremiumPanel />}
          </div>
        )}

        {isAdministrator && (
          <div id="subscriptions-panel" role="tabpanel" aria-labelledby="subscriptions-tab" tabIndex={0} className={activeTab !== 'subscriptions' ? 'hidden' : ''}>
            {activeTab === 'subscriptions' && <NotificationSubscriptionsPanel isAdministrator={isAdministrator} />}
          </div>
        )}

        <div id="catalog-panel" role="tabpanel" aria-labelledby="catalog-tab" tabIndex={0} className={activeTab !== 'catalog' ? 'hidden' : ''}>
          {activeTab === 'catalog' && <MedicationCatalogCurationPanel />}
        </div>
        {isAdministrator && activeTab === 'missions' && <div id="missions-panel" role="tabpanel" aria-labelledby="missions-tab"><MissionControlPanel /></div>}
      </main>
    </div>
  )
}
