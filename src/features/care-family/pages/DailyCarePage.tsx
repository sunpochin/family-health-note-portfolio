/*
檔案用途：將病人可用的每日照護功能放在同一個主頁，並依帳號設定動態顯示頁內 tab。
所在層：src/features/care-family/pages 頁面組合層；持有頁內切換狀態，將共同的對象選擇傳給照護流程。
主要關聯：由 App.tsx 的底部主 tab 掛載，組合每日照護 registry、各 feature page、SubjectSwitcher 與 TabHeader；
標題列的「自訂顯示」按鈕透過 onOpenDisplaySettings 呼叫 App.tsx 切到設定頁的 DailyCareDisplaySettings；
血壓儲存進行中由嵌入的 InputPage 回報，這裡據此鎖住 SubjectSwitcher（issue #1103）。
*/
import { useEffect, useRef, useState } from 'react'
import type { MedicationManagementPatient, PatientIdentity, Subject } from '../../../lib/auth'
import { useI18n } from '../../../lib/i18n'
import { resolveRequestedDailyCareSection, type DailyCareModule, type DailyCareModuleId } from '../../../lib/dailyCareModules'
import { readLastDailyCareSection, saveLastDailyCareSection } from '../../../lib/preferences/dailyCareSectionPreference'
import { InputPage } from '../../vitals/pages/InputPage'
import { L as bpInputCopy } from '../../vitals/pages/InputPage.utils'
import { TemperaturePage } from '../../vitals/pages/TemperaturePage'
import { WeightPage } from '../../vitals/pages/WeightPage'
import { MedicationPage } from '../../medication/pages/MedicationPage'
import { NutritionPage } from '../../nutrition/pages/NutritionPage'
import { PetLiquidIntakePage } from '../../pet-care/pages/PetLiquidIntakePage'
import { PetDigestionPage } from '../../pet-care/pages/PetDigestionPage'
import { PetAppetitePage } from '../../pet-care/pages/PetAppetitePage'
import { PetFluidTherapyPage } from '../../pet-care/pages/PetFluidTherapyPage'
import { PetEndocrinePage } from '../../pet-care/pages/PetEndocrinePage'
import { DementiaCarePage } from '../../dementia-care/pages/DementiaCarePage'
import { FluidBalancePage } from '../../postop-care/pages/FluidBalancePage'
import { CareDueRemindersPage } from '../../reminders/pages/CareDueRemindersPage'
import { VisitQuestionsPage } from '../../reminders/pages/VisitQuestionsPage'
import { LabResultsPage } from '../../labs/pages/LabResultsPage'
import { SubjectSwitcher } from '../../../components/ui/SubjectSwitcher'
import { TabHeader } from '../../../components/ui/TabHeader'
import { Icon } from '../../../components/ui/Icon'
import { DailyCareSectionTabs } from '../../../components/daily-care/DailyCareSectionTabs'
import { ExperimentalModuleNotice } from '../../../components/daily-care/ExperimentalModuleNotice'
import { useKeyboardViewport } from '../../../hooks/useKeyboardViewport'
import type { BloodPressureMeasurementSession } from '../../../lib/bloodPressureMeasurementSession'

export function DailyCarePage({ subject, patientId, patientName, availablePatients, userEmail, onSubjectSelect, canUseMedication, manageablePatients, ownPatientId, medicationSlotsExpanded, medicationNameEnglishFirst, visibleModules, initialSection, onInitialSectionConsumed, measurementSession, onMeasurementSessionStart, onMeasurementSessionComplete, onOpenDisplaySettings }: {
  subject: Subject
  patientId: string
  patientName?: string
  availablePatients: PatientIdentity[]
  userEmail?: string
  onSubjectSelect: (patientId: Subject) => void
  canUseMedication: boolean
  manageablePatients: MedicationManagementPatient[]
  ownPatientId: string
  medicationSlotsExpanded: boolean
  medicationNameEnglishFirst: boolean
  visibleModules: DailyCareModule[]
  initialSection?: DailyCareModuleId
  onInitialSectionConsumed?: () => void
  measurementSession: BloodPressureMeasurementSession | null
  onMeasurementSessionStart: (session: BloodPressureMeasurementSession) => void
  onMeasurementSessionComplete: () => void
  onOpenDisplaySettings: () => void
}) {
  const { text } = useI18n()
  const keyboardOpen = useKeyboardViewport()
  const [section, setSection] = useState<DailyCareModuleId>(() => {
    // PWA shortcut 只提供頁籤，不提供 patient_id；這裡仍依 visibleModules 過濾，讓權限與物種規則保持唯一來源。
    const requestedSection = resolveRequestedDailyCareSection(initialSection, visibleModules)
    if (requestedSection) return requestedSection
    const lastSection = readLastDailyCareSection(patientId)
    return lastSection && visibleModules.some(module => module.id === lastSection)
      ? lastSection
      : (visibleModules[0]?.id ?? 'bloodPressure')
  })
  const visibleModulesKey = visibleModules.map(module => module.id).join(',')
  // 用 ref 讀最新的消費 callback：下面的 effect 現在帶有「切換區塊」的副作用，不能再依賴 App.tsx 每次 render 都新建的
  // inline callback（依賴它會讓 effect 每次重繪都重跑；萬一哪條路徑沒清掉 initialSection，就會一直蓋掉使用者手動選的區塊）。
  const onInitialSectionConsumedRef = useRef(onInitialSectionConsumed)
  onInitialSectionConsumedRef.current = onInitialSectionConsumed
  // 血壓儲存中不能切換病人（issue #1103）：切換器在這一層、儲存狀態在嵌入的 InputPage 裡，
  // 所以由 InputPage 回報、這裡鎖。InputPage 面板即使切到別的區段也仍掛載（只是 hidden），儲存仍在跑，鎖要維持。
  const [bpSaving, setBpSaving] = useState(false)

  useEffect(() => {
    // 為什麼由真正使用頁籤的元件回報消費：外層可能先經過登入／同意流程，需避免 App 太早清掉 PWA query。
    // 即使捷徑指向目前不可見的模組也要消費，否則之後重新掛載會反覆強制同一個無效頁籤。
    // 為什麼這裡也要切換區塊：useState 的初始值只在掛載時讀 initialSection，使用者本來就停在照護頁時
    // （例如 Siri 捷徑 #868 說「記錄服藥」），請求會被消費掉但區塊沒變，等於語音指令靜默失效。
    // 區塊都是常駐掛載、只用 hidden 切換（見下方 tabpanel），所以切換不會丟掉其他區塊尚未儲存的草稿。
    // 掛載當下 section 已等於 requested，setSection 是 no-op，既有的今天頁／PWA 捷徑流程不受影響。
    const requestedSection = resolveRequestedDailyCareSection(initialSection, visibleModules)
    if (requestedSection) setSection(requestedSection)
    if (initialSection) onInitialSectionConsumedRef.current?.()
    // visibleModules 刻意不列入依賴：它每次 render 都是新陣列，列進去會讓這個 effect 每次重繪都重跑；
    // 只有「新的請求到來」才需要切換，而請求就是 initialSection 的變化。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialSection])

  const handleSelectSection = (moduleId: DailyCareModuleId) => {
    setSection(moduleId)
    saveLastDailyCareSection(patientId, moduleId)
  }

  useEffect(() => {
    // 切換病人時優先還原該病人上次選擇的頁籤，讀不到時才回到第一個可用入口。
    if (!visibleModules.some(module => module.id === section)) {
      const lastSection = readLastDailyCareSection(patientId)
      setSection(lastSection && visibleModules.some(module => module.id === lastSection)
        ? lastSection
        : (visibleModules[0]?.id ?? 'bloodPressure'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, visibleModulesKey])

  const activeSection = visibleModules.some(module => module.id === section)
    ? section
    : (visibleModules[0]?.id ?? 'bloodPressure')
  const activeModule = visibleModules.find(module => module.id === activeSection)
  // patientName 由外層以「含已歸檔」的完整病人清單解析，是目前唯一保證對應 patientId 的名稱來源。
  const activePatientName = patientName || text({ id: 'Orang yang dirawat', zh: '被照護者', en: 'Care recipient' })
  // petEndocrine 現在也對人類開放（見 dailyCareModules.ts），內分泌頁的血糖判讀門檻與報告用語要能依物種分流，不能整頁預設當成寵物。
  const activeCareRecipientType = availablePatients.find(patient => patient.patientId === patientId)?.careRecipientType

  const renderPanel = (module: DailyCareModule) => {
    switch (module.id) {
      case 'bloodPressure':
        return <InputPage embedded subject={subject} patientId={patientId} patientName={patientName} availablePatients={availablePatients} userEmail={userEmail} onSubjectSelect={onSubjectSelect} measurementSession={measurementSession} onMeasurementSessionStart={onMeasurementSessionStart} onMeasurementSessionComplete={onMeasurementSessionComplete} onSavingChange={setBpSaving} visible={activeSection === module.id} />
      case 'temperature':
        return <TemperaturePage subject={subject} patientId={patientId} patientName={patientName} availablePatients={availablePatients} userEmail={userEmail} onSubjectSelect={onSubjectSelect} embedded />
      case 'medication':
        return canUseMedication && userEmail
          ? <MedicationPage embedded manageablePatients={manageablePatients} ownPatientId={ownPatientId} selectedPatientId={patientId} availablePatients={availablePatients} userEmail={userEmail} onSubjectSelect={onSubjectSelect} slotsExpandedByDefault={medicationSlotsExpanded} nameEnglishFirst={medicationNameEnglishFirst} />
          : null
      case 'nutrition':
        return <NutritionPage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'weight':
        return <WeightPage embedded patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'petLiquidIntake':
        return <PetLiquidIntakePage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'petDigestion':
        return <PetDigestionPage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'petAppetite':
        return <PetAppetitePage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'petFluidTherapy':
        return <PetFluidTherapyPage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'petEndocrine':
        return <PetEndocrinePage patientId={patientId} patientName={patientName} userEmail={userEmail} careRecipientType={activeCareRecipientType} />
      case 'dementiaCare':
        return <DementiaCarePage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'fluidBalance':
        return <FluidBalancePage patientId={patientId} patientName={patientName} userEmail={userEmail} />
      case 'careReminders':
        return <CareDueRemindersPage patientId={patientId} canManage={availablePatients.find(patient => patient.patientId === patientId)?.canManageMedication ?? false} careRecipientType={activeCareRecipientType} />
      case 'visitQuestions':
        return <VisitQuestionsPage patientId={patientId} />
      case 'labResults':
        return <LabResultsPage patientId={patientId} patientName={patientName} userEmail={userEmail} />
    }
  }

  return (
    <div className="min-h-full bg-slate-50 text-slate-900">
      <header className={`px-5 pt-5 pb-2 space-y-3 ${keyboardOpen ? 'hidden' : ''}`}>
        <TabHeader title="dailyCare" />
        <SubjectSwitcher patientId={patientId} patients={availablePatients} onSelect={onSubjectSelect} lockedReason={bpSaving ? bpInputCopy.switchLockedWhileSaving : undefined} />
        {/* 顯示哪些項目原本只能在設定頁調整；這裡加一個直接入口，不重複那張卡的儲存邏輯，
            只負責把使用者帶過去並捲到它的位置（見 DailyCareDisplaySettings 的錨點捲動）。 */}
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1"><DailyCareSectionTabs modules={visibleModules} activeModule={activeSection} onSelect={handleSelectSection} /></div>
          <button
            type="button"
            onClick={onOpenDisplaySettings}
            aria-label={text({ id: 'Sesuaikan tampilan perawatan harian', zh: '自訂每日照護顯示', en: 'Customize daily care display' })}
            title={text({ id: 'Sesuaikan tampilan', zh: '自訂顯示', en: 'Customize view' })}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-200/80 text-lg text-slate-700 ring-1 ring-inset ring-slate-300/60 transition hover:bg-white active:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700"
          >
            <Icon name="settings" className="h-5 w-5" />
          </button>
        </div>
      </header>

      {/* 鍵盤展開時整個頁首會讓出高度，但「這筆要存給誰」正是按下儲存前最需要確認的資訊；
          因此改用一條最精簡的常駐標示保留對象與目前項目，只收掉時鐘、標題與頁籤。 */}
      {keyboardOpen && (
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-slate-900 px-5 py-1.5 text-sm font-bold text-white">
          <span className="truncate">{activePatientName}</span>
          {activeModule && <span className="shrink-0 rounded-md bg-white/15 px-1.5 py-0.5 text-xs font-bold">{text(activeModule.label)}</span>}
        </div>
      )}

      {visibleModules.map(module => (
        <div
          key={module.id}
          id={`daily-care-${module.id}-panel`}
          role="tabpanel"
          aria-labelledby={visibleModules.length > 1 ? `daily-care-${module.id}-tab` : undefined}
          aria-label={visibleModules.length === 1 ? text(module.label) : undefined}
          hidden={activeSection !== module.id}
        >
          {/* 純紀錄、尚無趨勢與報表的模組即使被手動開啟，也要在面板最上方講明白（issue #656）。 */}
          {module.experimental && <ExperimentalModuleNotice />}
          {renderPanel(module)}
        </div>
      ))}
    </div>
  )
}
