/*
檔案用途：組合登入後的應用程式外殼、主要 tab、共用語言列與病人選擇狀態。
所在層：src 根入口；負責在頁面元件之間傳遞授權後的病人資料，不直接實作各 tab 的照護流程。
主要關聯：使用 useAuth、LoginScreen、UnauthorizedScreen，以及 lazy 載入的 TrajectoryPage／DailyCarePage／SettingsPage 頁。
公開路由（Privacy／Terms／Releases／Guides／Share）已抽到 components/system/PublicRouteSwitch；
登入後外殼的各項副作用與狀態拆到 hooks/useAppChromeEffects、useLegalConsentStatus、useInvitationHandling、
useMedicationDisplayPreferences、useDailyCareOnboarding、useActiveSubject、useBloodPressureSession
（issue #764 App.tsx 拆分，純搬移不改行為）；iOS 鎖屏血壓倒數的同步另在 useBloodPressureLiveActivity（issue #865）；
Siri 捷徑的語音喚起由 components/system/NativeShortcutNavigator 接收，實際切換分頁仍走本檔的 openDailyCareModule（issue #868）。
已無獨立的「報告」底部分頁——趨勢與報告已回到各照護模組，封存對象的唯讀歷史改由
SettingsPage 底下的 ArchivedPatientHistoryPage 提供，詳見 docs/features/vitals.md。
*/
import { useCallback, useMemo, useRef, useState, lazy, Suspense } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { useAuth } from './hooks/useAuth'
import { isLineBrowser, isAdministratorEmail, type Subject } from './lib/auth'
import { useMedicationCatalogCuratorAccess } from './features/system-admin/hooks/useMedicationCatalogCuratorAccess'
import { saveActivePatientPreference } from './lib/preferences/activeSubjectPreference'
import { BpStandardProvider } from './features/vitals/hooks/useBpEvaluator'
import { BloodPressureQueueProvider } from './features/vitals/hooks/BloodPressureQueueProvider'
import { MedicationQueueProvider } from './features/medication/hooks/MedicationQueueProvider'
import { BloodPressureSaveRejectedBanner } from './features/vitals/components/BloodPressureSaveRejectedBanner'
import { resolveWritableSubject } from './lib/careSubjectGuard'
import { DAILY_CARE_DISPLAY_SETTINGS_ANCHOR, resolveDailyCareModuleOpen, visibleDailyCareModules as getVisibleDailyCareModules, type DailyCareModuleId } from './lib/dailyCareModules'
import { markOnboardingWizardCompleted, type OnboardingCareTarget } from './lib/onboardingWizard'
import { OnboardingWizard } from './components/onboarding/OnboardingWizard'
import { common, useI18n } from './lib/i18n'
import { useTutorial } from './components/tutorial'
import { AppStatusBar } from './components/system/AppStatusBar'
import { HealthDataConsentScreen } from './features/care-family/components/HealthDataConsentScreen'
import { PrivacyPolicyUpdateScreen } from './features/care-family/components/PrivacyPolicyUpdateScreen'
import { DEMO_VISITOR_EMAIL } from './lib/demoStorage'
import { LoginScreen } from './components/auth/LoginScreen'
import { UnauthorizedScreen } from './components/auth/UnauthorizedScreen'
import { LineBrowserGate } from './components/system/LineBrowserGate'
import { useKeyboardViewport } from './hooks/useKeyboardViewport'
import { CaregiverInvitationJoinPage } from './features/care-family/pages/CaregiverInvitationJoinPage'
import { PatientInvitationJoinPage } from './features/care-family/pages/PatientInvitationJoinPage'
import { PatientInvitationScreen } from './features/care-family/components/PatientInvitationScreen'
import { CaregiverInvitationScreen } from './features/care-family/components/CaregiverInvitationScreen'
import { BloodPressureCountdownBanner } from './components/ui/BloodPressureCountdownBanner'
import { NativeShortcutNavigator } from './components/system/NativeShortcutNavigator'
import { consumePwaShortcutQuery, resolvePwaShortcutTarget } from './lib/pwaShortcuts'
import { usePublicRoute } from './components/system/PublicRouteSwitch'
import { DemoModeBanner } from './components/system/DemoModeBanner'
import { ArchivedSubjectNotice } from './components/system/ArchivedSubjectNotice'
import { DemoHandoffNotice } from './components/system/DemoHandoffNotice'
import { BottomNav, type Tab } from './components/system/BottomNav'
import { useAppChromeEffects } from './hooks/useAppChromeEffects'
import { useLegalConsentStatus } from './hooks/useLegalConsentStatus'
import { useInvitationHandling } from './hooks/useInvitationHandling'
import { useMedicationDisplayPreferences } from './hooks/useMedicationDisplayPreferences'
import { useDailyCareOnboarding } from './hooks/useDailyCareOnboarding'
import { useActiveSubject } from './hooks/useActiveSubject'
import { useBloodPressureSession } from './hooks/useBloodPressureSession'
import { useBloodPressureLiveActivity } from './hooks/useBloodPressureLiveActivity'

// 包裝 React.lazy 以提供網路出錯或版本更新時的自動重試機制。
const lazyWithRetry = (importFn: () => Promise<{ default: ComponentType<any> }>) =>
  lazy(() =>
    importFn().catch((err) => {
      console.error('Failed to load chunk, retrying via reload...', err)
      window.location.reload()
      return { default: () => null }
    })
  )

// 使用動態載入以優化 Bundle 大小。有 PWA 快取守護，離線仍可使用。
const AdminPage = lazyWithRetry(() => import('./features/system-admin/pages/AdminPage').then(m => ({ default: m.AdminPage })))
// 今天頁（B 期，issue #733）：預設分頁，組合服藥時段卡與血壓摘要，因此仍要 lazy load 以免拖慢初始 bundle。
const TodayPage = lazyWithRetry(() => import('./features/today/pages/TodayPage').then(m => ({ default: m.TodayPage })))
const DailyCarePage = lazyWithRetry(() => import('./features/care-family/pages/DailyCarePage').then(m => ({ default: m.DailyCarePage })))
// 軌跡頁（D 期，issue #735）：取代原本的事件 tab（EventsPage／CareTimeline），合併調藥、看診、
// 醫師指示、一般事件、到期提醒與血壓週摘要成單一時間軸。
const TrajectoryPage = lazyWithRetry(() => import('./features/care-family/pages/TrajectoryPage').then(m => ({ default: m.TrajectoryPage })))
// 門診頁（E 期，照護閉環 T5，issue #949）：帶什麼／問什麼／醫師說了什麼；原本只給家庭擁有者的「行程」tab 併入這一頁。
const NextVisitPage = lazyWithRetry(() => import('./features/visit/pages/NextVisitPage').then(m => ({ default: m.NextVisitPage })))
const SettingsPage = lazyWithRetry(() => import('./features/system-admin/pages/SettingsPage').then(m => ({ default: m.SettingsPage })))

export default function App() {
  const { text, locale } = useI18n()
  const { startTutorial } = useTutorial()
  const keyboardOpen = useKeyboardViewport()
  // 為什麼同時保留兩組啟動狀態：PWA 捷徑決定初始照護分頁，漏斗追蹤則交給 useAppChromeEffects；兩者都必須由外殼層一次建立。
  const [pwaShortcutTarget, setPwaShortcutTarget] = useState(() => resolvePwaShortcutTarget(window.location.search))

  const consumePwaShortcut = useCallback(() => {
    // 為什麼等 DailyCarePage 首次掛載才消費：App 可能先顯示登入或同意畫面，太早清除 query 會讓登入後遺失原本的捷徑頁籤。
    const nextSearch = consumePwaShortcutQuery(window.location.search)
    setPwaShortcutTarget(null)
    window.history.replaceState(window.history.state, '', window.location.pathname + nextSearch + window.location.hash)
  }, [])

  const [tab, setTab] = useState<Tab>(() => pwaShortcutTarget?.tab ?? 'today')
  // 今天頁的「量血壓」「到期提醒」動作要能一步跳到記錄 tab 裡對應的模組區塊；沿用跟 PWA 捷徑相同的
  // initialSection 機制，而不是另外幫今天頁做一套導覽狀態。
  const [dailyCareSectionRequest, setDailyCareSectionRequest] = useState<DailyCareModuleId | null>(null)
  // 已歸檔對象被自動換掉時必須留下痕跡；靜默換人會讓照護者以為還在同一位對象身上操作。
  const [archivedSubjectNotice, setArchivedSubjectNotice] = useState(false)

  const { user, isDemoMode, enterDemoMode, exitDemoMode, ownPatientId, subject, displayName, accessiblePatients, allAccessiblePatients, accessibleSubjects, allAccessibleSubjects, medicationManagementPatients, patientIdsBySubject, refreshIdentity, loading } = useAuth()

  useAppChromeEffects({ isDemoMode, loading, user })

  const effectiveAccessibleSubjects = accessibleSubjects
  const effectiveAllAccessibleSubjects = allAccessibleSubjects
  const effectiveSubject = subject
  const effectiveDisplayName = displayName || user?.user_metadata?.full_name || user?.email?.split('@')[0]
  const effectiveSubjectsKey = effectiveAccessibleSubjects.join(',')
  const userId = user?.id

  const { activeSubject, setActiveSubject } = useActiveSubject({
    isDemoMode,
    userEmail: user?.email,
    subject,
    accessibleSubjects,
    effectiveAccessibleSubjects,
    effectiveSubject,
    effectiveSubjectsKey,
  })

  const activePatientId = activeSubject ? patientIdsBySubject[activeSubject] : undefined
  const activePatientIdRef = useRef(activePatientId)
  activePatientIdRef.current = activePatientId
  const effectiveUserEmail = user?.email ?? (isDemoMode ? DEMO_VISITOR_EMAIL : '')
  const canUseMedication = Boolean(effectiveUserEmail && effectiveSubject)
  // Google 行程區塊（門診頁內）目前只給擁有 Google Calendar 來源的家庭擁有者使用，其餘照護者暫不開放；之後要開放給更多家人時再放寬。
  const canUseSchedule = isAdministratorEmail(user?.email)
  // 讓頁內頁籤只在偏好或能力真的變動時重建，避免每次外殼重繪都觸發隱藏頁籤校正。
  const activePatientCareRecipientType = activePatientId ? accessiblePatients.find(p => p.patientId === activePatientId)?.careRecipientType : undefined
  // 只給試用承接的非同步套用邏輯讀最新值用；不能把這個值放進 useDailyCareOnboarding effect 的依賴陣列——
  // accessiblePatients 常在該 effect 已經跑過一次之後才非同步載入完成，若列入依賴會讓整個
  // effect（包含開頭把 demoHandoffNotice 重設為 null 那段）在物種到位時重跑一次，
  // 把剛顯示出來的承接提示又立刻清掉。用 ref 讀最新物種即可，不必重跑整個 effect。
  const activePatientCareRecipientTypeRef = useRef(activePatientCareRecipientType)
  activePatientCareRecipientTypeRef.current = activePatientCareRecipientType

  const resolvedSelectedSubject = activeSubject && (effectiveAccessibleSubjects.includes(activeSubject) || effectiveAllAccessibleSubjects.includes(activeSubject))
    ? activeSubject
    : effectiveAccessibleSubjects[0] ?? effectiveSubject ?? ''
  const resolvedSelectedPatientId = patientIdsBySubject[resolvedSelectedSubject]

  const { completeBloodPressureMeasurementSession, startBloodPressureMeasurementSession, currentMeasurementSession } = useBloodPressureSession({
    loading,
    userId,
    resolvedSelectedPatientId,
  })
  // 同一個 currentMeasurementSession 同時餵 App 內 banner 與 iOS 鎖屏倒數，兩邊不會各自計時而不同步（issue #865）。
  useBloodPressureLiveActivity({ session: currentMeasurementSession, locale, loading })

  const {
    medicationSlotsExpanded,
    medicationSettingsSaving,
    medicationSettingsError,
    medicationNameEnglishFirst,
    medicationNameSettingsSaving,
    medicationNameSettingsError,
    caregiverDensityMode,
    caregiverDensitySettingsSaving,
    caregiverDensitySettingsError,
    onToggleMedicationSlotsExpanded,
    onToggleMedicationNameEnglishFirst,
    onToggleCaregiverDensityMode,
  } = useMedicationDisplayPreferences({
    isDemoMode,
    userId,
    locale,
    startTutorial,
    getActivePatientId: () => activePatientIdRef.current ?? null,
  })

  const {
    dailyCarePreference,
    useCustomDailyCareTemplate,
    dailyCareSettingsSaving,
    dailyCarePreferenceLoadedPatientId,
    dailyCareSettingsError,
    onboardingWizardPatientId,
    setOnboardingWizardPatientId,
    onboardingWizardError,
    onboardingWizardSaving,
    demoHandoffNotice,
    setDemoHandoffNotice,
    finishOnboardingWizard,
    onToggleDailyCareModule,
    onToggleCustomTemplate,
  } = useDailyCareOnboarding({
    activePatientId,
    isDemoMode,
    userId,
    getActivePatientCareRecipientType: () => activePatientCareRecipientTypeRef.current as OnboardingCareTarget | undefined,
    getActivePatientIdRef: () => activePatientIdRef.current,
  })

  const visibleDailyCareModules = useMemo(
    () => getVisibleDailyCareModules(dailyCarePreference, { canUseMedication, careRecipientType: activePatientCareRecipientType, useCustomTemplate: useCustomDailyCareTemplate }),
    [dailyCarePreference, canUseMedication, activePatientCareRecipientType, useCustomDailyCareTemplate],
  )

  const { privacyPolicyStatus, setPrivacyPolicyStatus, healthConsentStatus, setHealthConsentStatus, termsUpdateRequired, privacyUpdateRequired } = useLegalConsentStatus(userId)

  const {
    pendingPatientInvitations,
    setPendingCaregiverInvitations,
    patientInvitationLoadError,
    setPatientInvitationLoadAttempt,
    handlePatientInvitationResolved,
    caregiverInvitationsRequiringRequest,
  } = useInvitationHandling({
    isDemoMode,
    userEmail: user?.email,
    healthConsentStatus,
    subject,
    refreshIdentity,
  })

  const currentPath = window.location.pathname
  // usePublicRoute 本身是 hook（內含 useI18n），必須在任何條件式 return 之前、依固定順序呼叫；
  // 回傳 null 代表目前路徑不是免登入公開頁，交由下面的登入／同意流程繼續判斷。
  const publicRouteView = usePublicRoute(currentPath)
  const isAdminRoute = currentPath === '/admin'
  const isAdministratorUser = isAdministratorEmail(user?.email)
  // useMedicationCatalogCuratorAccess 同樣必須在任何條件式 return 之前呼叫（規則同上）；
  // enabled 只在真的可能用到時才為 true（/admin 路由、已登入），避免其他頁面也平白多一次網路呼叫。
  // 這裡刻意也對 administrator 查詢：新的目錄 RPC 只認 entitlement、不認舊的寫死 email
  // （文件 §3.6），administrator 預設並不是 curator，AdminPage 要用這個結果決定「藥品目錄」
  // 分頁能不能真的用，不能只因為是 administrator 就以為一定有 curator 權限（PR #797 review）。
  const { isCurator: isCatalogCurator, loading: curatorAccessLoading } = useMedicationCatalogCuratorAccess(
    userId,
    isAdminRoute && !!user,
  )
  if (publicRouteView) return publicRouteView

  if (isLineBrowser() && currentPath === '/') {
    // 繁體中文註解：LINE 版本對 target=_blank 的行為不一致，提示頁必須同時提供右上角選單指引；只攔公開登入頁，讓條款與 Demo 仍可直接閱讀／試用。
    const externalBrowserUrl = `${window.location.origin}${window.location.pathname}${window.location.hash}`
    return <LineBrowserGate externalBrowserUrl={externalBrowserUrl} />
  }

  if (loading) {
    return (
      <div className="h-dvh flex items-center justify-center bg-white text-slate-500 text-sm">
        {text(common.loading)}
      </div>
    )
  }

  if (isAdminRoute) {
    if (!user) return <LoginScreen onEnterDemo={enterDemoMode} />
    if (!isAdministratorUser) {
      // 共用藥品目錄管理員（curator）不是唯一的 administrator；查詢完成前不能先當作沒有權限，
      // 否則畫面會先閃一次「未授權」才變成藥品目錄分頁，讓真正的 curator 誤以為自己沒有權限。
      if (curatorAccessLoading) {
        return (
          <div className="h-dvh flex items-center justify-center bg-white text-slate-500 text-sm">
            {text(common.loading)}
          </div>
        )
      }
      if (!isCatalogCurator) return <UnauthorizedScreen email={user.email} />
    }
    return (
      <Suspense fallback={
        <div className="h-dvh flex items-center justify-center bg-white text-slate-500 text-sm">
          {text(common.loading)}
        </div>
      }>
        <div className="flex h-dvh flex-col bg-slate-50">
          <AppStatusBar />
          <div className="min-h-0 flex-1"><AdminPage isAdministrator={isAdministratorUser} isCatalogCurator={isCatalogCurator} /></div>
        </div>
      </Suspense>
    )
  }

  if (!user && !isDemoMode) {
    if (currentPath === '/join') return <CaregiverInvitationJoinPage />
    if (currentPath === '/patient-invite') return <PatientInvitationJoinPage />
    return <LoginScreen onEnterDemo={enterDemoMode} />
  }

  if (!isDemoMode && (privacyPolicyStatus === 'idle' || privacyPolicyStatus === 'loading' || healthConsentStatus === 'idle' || healthConsentStatus === 'loading')) return <div className="h-dvh flex items-center justify-center bg-white text-sm text-slate-500">{text(common.loading)}</div>
  if (!isDemoMode && privacyPolicyStatus !== 'ready') return <PrivacyPolicyUpdateScreen showTermsUpdate={termsUpdateRequired} showPrivacyUpdate={privacyUpdateRequired} onAccepted={async () => { setPrivacyPolicyStatus('ready') }} />
  if (!isDemoMode && healthConsentStatus !== 'ready') return <HealthDataConsentScreen onAccepted={async () => { setHealthConsentStatus('ready') }} />

  const withMedicationQueue = (node: ReactNode) => (
    <MedicationQueueProvider patientId={resolvedSelectedPatientId ?? ''} userEmail={effectiveUserEmail}>{node}</MedicationQueueProvider>
  )

  // 登入後、進到主殼層之前還有幾個會擋住 App 好幾分鐘的畫面（邀請連結頁、邀請、精靈）。血壓與服藥佇列在這些畫面仍要補送，
  // 否則登入後停在邀請等待頁時，連線恢復也沒有人接手。寫成函式而不是元件：定義在 render 內的元件
  // 每次重繪都是新的型別，React 會把補送器整個卸載重掛、丟掉它的狀態；函式只是回傳同一組既有元件的 JSX。
  // BpStandardProvider 是補送器的前提；還沒有照護對象時給空字串，補送器對「畫面上這位」不會讀到任何桶，只補送其他人的。
  const withBloodPressureQueue = (node: ReactNode) => (
    <BpStandardProvider patientId={resolvedSelectedPatientId ?? ''}>
      <BloodPressureQueueProvider patientId={resolvedSelectedPatientId ?? ''} userEmail={effectiveUserEmail}>
        {withMedicationQueue(node)}
      </BloodPressureQueueProvider>
    </BpStandardProvider>
  )

  // 已登入的照護者打開邀請連結後，可能停在「已申請、等擁有者」的畫面好幾天（第三輪 Codex P1）。
  if (currentPath === '/join') return withBloodPressureQueue(<CaregiverInvitationJoinPage userEmail={user?.email} />)
  if (currentPath === '/patient-invite') return withBloodPressureQueue(<PatientInvitationJoinPage userEmail={user?.email} />)

  // 被照顧者尚未有自己的 profile 時，先處理明確邀請，不能讓 auto-provision 先建立另一個私人病人。
  if (!isDemoMode && user && !subject && patientInvitationLoadError) {
    return withBloodPressureQueue(<PatientInvitationScreen invitations={[]} loadFailed onRetry={() => setPatientInvitationLoadAttempt(attempt => attempt + 1)} onResolved={handlePatientInvitationResolved} />)
  }
  if (!isDemoMode && user && !subject && pendingPatientInvitations === null) return withMedicationQueue(<div className="h-dvh flex items-center justify-center bg-white text-sm text-slate-500">{text(common.loading)}</div>)
  if (!isDemoMode && user && pendingPatientInvitations && pendingPatientInvitations.length > 0) {
    return withBloodPressureQueue(<PatientInvitationScreen invitations={pendingPatientInvitations} onResolved={handlePatientInvitationResolved} />)
  }

  if (!isDemoMode && user && caregiverInvitationsRequiringRequest.length > 0) {
    // requested 已完成受邀者動作，應讓有既有照護工作的使用者回到 App 等待 owner，而不是被邀請畫面鎖住。
    return withBloodPressureQueue(<CaregiverInvitationScreen invitations={caregiverInvitationsRequiringRequest} onRequested={invitationId => setPendingCaregiverInvitations(current => current.map(invitation => invitation.invitationId === invitationId ? { ...invitation, status: 'requested' } : invitation))} />)
  }

  if (!isDemoMode && user && !subject) return withMedicationQueue(<UnauthorizedScreen email={user.email} />)

  if (!activeSubject) {
    return withMedicationQueue(
      <div className="h-dvh flex items-center justify-center bg-white text-slate-500 text-sm">
        {text(common.loading)}
      </div>
    )
  }
  const selectedSubject = resolvedSelectedSubject
  const selectedPatientId = resolvedSelectedPatientId
  const resolvedOwnPatientId = ownPatientId ?? ''
  if (!selectedPatientId) {
    return withMedicationQueue(
      <div className="h-dvh flex items-center justify-center bg-white px-6 text-center text-sm text-slate-500">
        {text({ id: 'Data keluarga belum siap. Silakan hubungi keluarga.', zh: '家庭資料尚未完成設定，請聯絡家屬。' ,en: 'Family information is not yet set up, please contact a family member.' })}
      </div>
    )
  }
  const canConfigureActiveSubject = effectiveAccessibleSubjects.length > 1
  // Siri 捷徑（issue #868）「語音沒有指名對象，多位時不猜」（AGENTS.md § 3.5）的判斷。刻意不重用 canConfigureActiveSubject：
  // 那個旗標的語意是設定頁「能不能切換對象」，之後若加上權限條件，會悄悄關掉這道防線。
  // 這裡數的是外殼對象選擇器裡的對象：含只能查看的對象、不含已封存的，帳號本人一定算一位。
  const hasMultipleSubjects = effectiveAccessibleSubjects.length > 1

  if (!isDemoMode && onboardingWizardPatientId && onboardingWizardPatientId === selectedPatientId) {
    return (
      // 精靈可能開著好幾分鐘；這段期間另一位病人離線暫存的血壓一樣要補送、家屬一樣要收到通知（PR #1218 Codex P1），
      // 所以補送器在這裡也要掛著。BpStandardProvider 是補送器的前提（評畫面上這位的等級用）。
      <BpStandardProvider patientId={selectedPatientId}>
      <BloodPressureQueueProvider patientId={selectedPatientId} userEmail={effectiveUserEmail}>
      <MedicationQueueProvider patientId={selectedPatientId} userEmail={effectiveUserEmail}>
      <OnboardingWizard
        // 用病人 id 當 key：換病人時強制整個精靈重新掛載，避免上一位病人已經選到一半的答案
        // （物種、勾選項目）留在同一個元件實例裡，被誤存成下一位病人的每日照護設定。
        key={onboardingWizardPatientId}
        // 病人建立時已經選過物種，就用它當第一題的預設答案：精靈算出的模組範圍必須跟
        // visibleDailyCareModules() 實際套用的物種一致，否則會發生「幫貓存了人類的模組組合、
        // 每日照護頁卻照貓過濾」而整頁塌成一個不相干分頁。
        initialCareTarget={activePatientCareRecipientType as OnboardingCareTarget | undefined}
        canUseMedication={canUseMedication}
        saving={onboardingWizardSaving}
        error={onboardingWizardError}
        onComplete={(careTarget, recorder, selectedModuleIds) => finishOnboardingWizard(careTarget, recorder, selectedModuleIds, selectedPatientId)}
        onSkip={() => {
          markOnboardingWizardCompleted(selectedPatientId)
          setOnboardingWizardPatientId(null)
        }}
      />
      </MedicationQueueProvider>
      </BloodPressureQueueProvider>
      </BpStandardProvider>
    )
  }

  const changeActiveSubject = (nextSubject: Subject) => {
    if ((!isDemoMode && !user?.email) || (!accessibleSubjects.includes(nextSubject) && !allAccessibleSubjects.includes(nextSubject))) return
    if (nextSubject !== activeSubject) completeBloodPressureMeasurementSession()
    setArchivedSubjectNotice(false)
    setActiveSubject(nextSubject)
    if (!user?.email) return
    void saveActivePatientPreference(user.email, nextSubject).catch(error => {
      console.error('[active patient preference save error]', error)
    })
  }

  // 已封存對象改由 SettingsPage 的 ArchivedPatientHistoryPage 唯讀查看，不再進入這裡的
  // activeSubject；這個檢查因此是防禦性的，正常操作下不會真的觸發重導向，見 careSubjectGuard.ts。
  const changeTab = (nextTab: Tab) => {
    const resolution = resolveWritableSubject(selectedSubject, effectiveAccessibleSubjects)
    if (resolution.redirected) {
      changeActiveSubject(resolution.subject)
      // changeActiveSubject 會先清掉提示，這裡必須後寫才能保留本次自動切換的說明。
      setArchivedSubjectNotice(true)
    }
    setTab(nextTab)
  }

  // 「打開某個照護模組」的唯一實作，今天頁的一步操作（issue #752）與 Siri 捷徑（issue #868）共用：
  // 病人若已在設定關掉該模組，「照護」頁會找不到這個分頁而靜默退到別的分頁，使用者完全看不出發生什麼事，
  // 所以先確認可見性，不可見時直接帶去顯示設定卡並指名該項目。
  const openDailyCareModule = (moduleId: DailyCareModuleId) => {
    const action = resolveDailyCareModuleOpen(moduleId, visibleDailyCareModules)
    if (action.kind === 'openSection') {
      setDailyCareSectionRequest(action.moduleId)
      changeTab('dailyCare')
      return
    }
    window.location.hash = action.hash
    changeTab('settings')
  }

  return (
    /*
      血壓判讀標準的掛載點（issue #898）。掛在這一層而不是各頁自己接，是因為
      VitalAlertBadge 之類的元件渲染在清單深處，一路傳 patientId 會經過會被遺漏的中繼元件，
      而漏傳的後果是靜默用一般成人標準判讀別人的血壓（AGENTS.md §3.5）。
      selectedPatientId 一變，整棵子樹的判讀跟著換，不會殘留上一位照護對象的目標。
      封存對象的唯讀歷史頁另有巢狀 Provider 覆蓋這一層，見 BloodPressureReportPanel。
    */
    <BpStandardProvider patientId={selectedPatientId}>
    {/* 血壓離線佇列的常駐補送器（issue #1138）。掛在殼層而不是血壓輸入區段：看護離線存了危險血壓後切到今天頁，
        連線恢復時補送與家屬通知不能等有人再打開血壓區段。必須在 BpStandardProvider 之內——補送到畫面上這位的紀錄時
        要用她的判讀標準決定要不要提示「家人沒收到」。 */}
    <BloodPressureQueueProvider patientId={selectedPatientId} userEmail={effectiveUserEmail}>
    {/* 服藥佇列的常駐擁有者（issue #1228）：切到設定或別的 tab 後仍要接住 online／回前景事件，並補送此帳號各病人的分桶。 */}
    <MedicationQueueProvider patientId={selectedPatientId} userEmail={effectiveUserEmail}>
    <div className="app-shell flex h-dvh flex-col mx-auto max-w-md">
      {isDemoMode && <DemoModeBanner onExitDemoMode={() => exitDemoMode()} />}
      <AppStatusBar />
      <BloodPressureCountdownBanner session={currentMeasurementSession} />
      {archivedSubjectNotice && <ArchivedSubjectNotice onDismiss={() => setArchivedSubjectNotice(false)} />}
      {/* 離開血壓頁或換病人後才被拒絕的線上血壓儲存（issue #1117）：輸入頁沒開著時只有這裡能講「剛才那筆沒存進去」；
          回到那位病人的輸入頁後由輸入頁接手顯示，橫幅自動消失。掛在對象提示之下、分頁內容之上，哪一個分頁都看得到。 */}
      <BloodPressureSaveRejectedBanner
        selectedPatientId={selectedPatientId}
        patients={allAccessiblePatients}
        switchablePatientIds={accessiblePatients.map(patient => patient.patientId)}
        onOpenBloodPressure={() => openDailyCareModule('bloodPressure')}
        onSwitchTo={rejectedPatientId => {
          // 用病人 id 反查對象鍵：切換器與偏好都以 subject 為鍵，被拒絕的那筆只記 patient_id（§ 3.5）。
          // 只認 accessiblePatients（不含已封存）：patientIdsBySubject 含封存對象，從這裡切過去會讓封存對象變成可寫入的現役對象
          //（PR #1219 Codex 第二輪 P1）；封存對象的紀錄只能在設定頁唯讀查看。
          if (!accessiblePatients.some(patient => patient.patientId === rejectedPatientId)) return
          const entry = Object.entries(patientIdsBySubject).find(([, candidatePatientId]) => candidatePatientId === rejectedPatientId)
          if (entry) changeActiveSubject(entry[0])
        }}
      />
      {/* Siri 捷徑（issue #868）：外殼走到這裡才表示登入、同意與對象都已就緒，所以在這裡才訂閱；
          多位照護對象時停在今天頁並提示先選對象，不由語音決定是誰（AGENTS.md § 3.5）。 */}
      <NativeShortcutNavigator
        // 偏好讀完才處理：冷啟動時 dailyCarePreference 還是預設值（全部可見），拿它判斷會先開到病人已關掉的模組。
        ready={dailyCarePreferenceLoadedPatientId !== null && dailyCarePreferenceLoadedPatientId === activePatientId}
        tab={tab}
        hasMultipleSubjects={hasMultipleSubjects}
        activePatientId={selectedPatientId}
        onOpenModule={openDailyCareModule}
        onChooseSubject={() => changeTab('today')}
      />

      {demoHandoffNotice && (
        <DemoHandoffNotice
          moduleIds={demoHandoffNotice.moduleIds}
          onReconfigure={() => {
            setDemoHandoffNotice(null)
            setOnboardingWizardPatientId(selectedPatientId)
          }}
          onDismiss={() => setDemoHandoffNotice(null)}
        />
      )}

      <main className="flex-1 min-h-0 overflow-y-auto bg-slate-50">
        <Suspense fallback={
          <div className="h-full flex items-center justify-center bg-slate-50 text-slate-500 text-sm">
            {text(common.loading)}
          </div>
        }>
          {tab === 'today'
            ? <TodayPage
                patientId={selectedPatientId}
                availablePatients={accessiblePatients}
                onSubjectSelect={changeActiveSubject}
                userEmail={effectiveUserEmail}
                // ADR-007 D7：care_access 且 can_record 才能結案；管理者只放寬 can_record（RPC 端仍會再驗一次 care_access）。
                canAcknowledgeIncidents={Boolean(accessiblePatients.find(patient => patient.patientId === selectedPatientId)?.canRecord) || isAdministratorUser}
                canUseMedication={canUseMedication}
                manageablePatients={medicationManagementPatients}
                ownPatientId={resolvedOwnPatientId}
                medicationSlotsExpanded={medicationSlotsExpanded}
                medicationNameEnglishFirst={medicationNameEnglishFirst}
                caregiverDensityMode={caregiverDensityMode}
                onOpenBloodPressureMeasurement={() => openDailyCareModule('bloodPressure')}
                onOpenReminders={() => { setDailyCareSectionRequest('careReminders'); changeTab('dailyCare') }}
                onOpenHistory={() => changeTab('events')}
              />
            : tab === 'events'
            ? <TrajectoryPage patientId={selectedPatientId} availablePatients={accessiblePatients} userEmail={user?.email} onSubjectSelect={changeActiveSubject} />
            : tab === 'visit'
              ? <NextVisitPage
                  patientId={selectedPatientId}
                  availablePatients={accessiblePatients}
                  onSubjectSelect={changeActiveSubject}
                  userEmail={effectiveUserEmail || undefined}
                  isDemoMode={isDemoMode}
                  showSchedule={canUseSchedule}
                  onOpenReminders={() => { setDailyCareSectionRequest('careReminders'); changeTab('dailyCare') }}
                  onOpenHistory={() => changeTab('events')}
                />
              : tab === 'settings'
                ? <SettingsPage activeSubject={selectedSubject} activePatientId={selectedPatientId} onChangeActiveSubject={changeActiveSubject} onCareRecipientCreated={async (patientId: string) => { await refreshIdentity(); setActiveSubject(patientId); if (user?.email) void saveActivePatientPreference(user.email, patientId) }} onCareRecipientArchived={refreshIdentity} availablePatients={accessiblePatients} profileDisplayName={effectiveDisplayName ?? undefined} userEmail={user?.email} canConfigureActiveSubject={canConfigureActiveSubject} medicationSlotsExpanded={medicationSlotsExpanded} medicationSettingsSaving={medicationSettingsSaving} medicationSettingsError={medicationSettingsError} medicationNameEnglishFirst={medicationNameEnglishFirst} medicationNameSettingsSaving={medicationNameSettingsSaving} medicationNameSettingsError={medicationNameSettingsError} caregiverDensityMode={caregiverDensityMode} caregiverDensitySettingsSaving={caregiverDensitySettingsSaving} caregiverDensitySettingsError={caregiverDensitySettingsError} isDemoMode={isDemoMode} dailyCarePreference={dailyCarePreference} dailyCareSettingsSaving={dailyCareSettingsSaving} dailyCareSettingsError={dailyCareSettingsError} canUseMedication={canUseMedication} onToggleDailyCareModule={onToggleDailyCareModule} onToggleCustomTemplate={onToggleCustomTemplate} useCustomDailyCareTemplate={useCustomDailyCareTemplate} activePatientCareRecipientType={activePatientCareRecipientType} onToggleMedicationSlotsExpanded={onToggleMedicationSlotsExpanded} onToggleMedicationNameEnglishFirst={onToggleMedicationNameEnglishFirst} onToggleCaregiverDensityMode={onToggleCaregiverDensityMode} />
                // dailyCare（照護）是 Tab 型別以外任何殘留值的安全回退，避免使用者卡在空白畫面；
                // 'today' 才是 B 期起的預設分頁。
              : <DailyCarePage subject={selectedSubject} patientId={selectedPatientId} patientName={allAccessiblePatients.find((patient) => patient.patientId === selectedPatientId)?.displayName} availablePatients={accessiblePatients} userEmail={effectiveUserEmail} onSubjectSelect={changeActiveSubject} canUseMedication={canUseMedication} manageablePatients={medicationManagementPatients} ownPatientId={resolvedOwnPatientId} medicationSlotsExpanded={medicationSlotsExpanded} medicationNameEnglishFirst={medicationNameEnglishFirst} visibleModules={visibleDailyCareModules} initialSection={dailyCareSectionRequest ?? pwaShortcutTarget?.section} onInitialSectionConsumed={() => { if (dailyCareSectionRequest) setDailyCareSectionRequest(null); else consumePwaShortcut() }} measurementSession={currentMeasurementSession} onMeasurementSessionStart={startBloodPressureMeasurementSession} onMeasurementSessionComplete={completeBloodPressureMeasurementSession} onOpenDisplaySettings={() => { window.location.hash = DAILY_CARE_DISPLAY_SETTINGS_ANCHOR; changeTab('settings') }} />}
        </Suspense>
      </main>

      {!keyboardOpen && <BottomNav tab={tab} onChangeTab={changeTab} />}
    </div>
    </MedicationQueueProvider>
    </BloodPressureQueueProvider>
    </BpStandardProvider>
  )
}
