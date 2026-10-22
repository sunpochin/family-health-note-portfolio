/*
檔案用途：提供血壓輸入 tab，處理量測值、兩次量測流程與安全儲存。
所在層：src/features/vitals/pages；此頁負責血壓功能的輸入流程與頁面編排，不是共用元件層。
主要關聯：使用 TabHeader 呈現共同頁首，並透過 SubjectSwitcher、LatestVitals 與 Supabase 服務目前病人的紀錄；
  狀態與讀寫邏輯抽到 features/vitals/hooks/useBloodPressureInputForm（AGENTS.md Rule A／B／C），本檔只負責 JSX 編排；
  儲存進行中會鎖住病人切換器（獨立頁自己鎖、嵌入時經 onSavingChange 通知 DailyCarePage 鎖，issue #1103）。
*/
import { useEffect, useRef, useState, lazy } from 'react'
import { PickerCard } from '../../../components/ui/PickerCard'
import { SubjectSwitcher } from '../../../components/ui/SubjectSwitcher'
import { TabHeader } from '../../../components/ui/TabHeader'
import { PendingSyncStatus } from '../../../components/ui/PendingSyncStatus'
import { LatestVitals } from '../components/LatestVitals'
import { VitalReading } from '../components/VitalReading'
import { DailyBloodPressureRecords } from '../components/DailyBloodPressureRecords'
import { VoiceInputDraft } from '../components/VoiceInputDraft'
import { BpSaveNotices } from '../components/BpSaveNotices'
import { ModuleTrendSection } from '../../../components/daily-care/ModuleTrendSection'
import { Icon } from '../../../components/ui/Icon'
import { ALERT_BUTTON_CLASS, ALERT_ICON, ALERT_SOFT_CHIP_CLASS, alertLabelText, alertTone } from '../../../lib/alertPresentation'
import { useBpEvaluator } from '../hooks/useBpEvaluator'
import { type PatientIdentity, type Subject } from '../../../lib/auth'
import { useI18n } from '../../../lib/i18n'
import { useKeyboardViewport } from '../../../hooks/useKeyboardViewport'
import { type BloodPressureMeasurementSession } from '../../../lib/bloodPressureMeasurementSession'
import { useBloodPressureInputForm } from '../hooks/useBloodPressureInputForm'
import {
  L,
  alertCls,
  sessionIcon,
} from './InputPage.utils'

// 圖表套件只在照護者實際展開「近期趨勢」時才下載；血壓是每日照護的第一個區段，
// 若直接 import 會讓 recharts 進入開 App 的初始載入路徑，拖慢每天最常走的量測動線。
// 這裡同時吸收了原本獨立「報告」分頁的統計卡片、逐筆報告與 CSV／GPT 匯出，
// 因為那些內容本來就是血壓資料的延伸，不需要另外佔一個底部分頁才看得到。
const BloodPressureReportPanel = lazy(() => import('../components/BloodPressureReportPanel').then(m => ({ default: m.BloodPressureReportPanel })))

export function InputPage({ subject, patientId, patientName, availablePatients, userEmail, onSubjectSelect, embedded = false, measurementSession = null, onMeasurementSessionStart, onMeasurementSessionComplete, onSavingChange, visible = true }: {
  subject: Subject
  patientId: string
  patientName?: string
  availablePatients: PatientIdentity[]
  userEmail?: string
  onSubjectSelect: (subject: Subject) => void
  embedded?: boolean
  measurementSession?: BloodPressureMeasurementSession | null
  onMeasurementSessionStart?: (session: BloodPressureMeasurementSession) => void
  onMeasurementSessionComplete?: () => void
  /** 儲存進行中回報給外層（嵌入每日照護時，病人切換器在外層，要由外層一起鎖住；issue #1103）。須傳穩定的函式（例如 setState）。 */
  onSavingChange?: (saving: boolean) => void
  /** 嵌入每日照護頁時，目前區段是不是血壓（面板切走時仍掛載、只是 hidden）；被拒絕的儲存不能寫進看不到的面板（issue #1117）。 */
  visible?: boolean
}) {
  const { locale, text } = useI18n()
  const evaluator = useBpEvaluator()
  const keyboardOpen = useKeyboardViewport()
  // 繁體中文註解：建立輸入欄位 Ref，實現輸入完高壓自動跳低壓、低壓自動跳心跳、心跳自動聚焦儲存按鈕之順跳流程。
  const sysRef = useRef<HTMLInputElement>(null)
  const diaRef = useRef<HTMLInputElement>(null)
  const pulRef = useRef<HTMLInputElement>(null)
  const submitBtnRef = useRef<HTMLButtonElement>(null)
  // 「本照護日新增的量測紀錄」裡的修改／刪除不會經過表單 hook 的 dailyRecordsVersion，
  // 另外計數，與 dailyRecordsVersion 相加後交給趨勢面板，任何一邊寫入都會讓「每日紀錄」重抓。
  const [recordEditVersion, setRecordEditVersion] = useState(0)
  const [voiceDraftVersion, setVoiceDraftVersion] = useState(0)

  const {
    systolic,
    diastolic,
    pulse,
    handleSystolicChange,
    handleDiastolicChange,
    handlePulseChange,
    pendingAdvanceField,
    clearAutoAdvanceTimer,
    status,
    errMsg,
    limitBlockedReading,
    notifyFailed,
    familyAlertSkipped,
    familyDelivery,
    everSubmitted,
    canSubmit,
    tone,
    submit,
    session,
    showRestPrompt,
    showDoneMsg,
    summary,
    displayedRule,
    submittedTone,
    resetMeasurementFlow,
    pendingRecords,
    pendingViewRecords,
    pendingSyncing,
    pendingSyncError,
    pendingSyncErrorTexts,
    pendingLastAttemptAt,
    syncPendingRecords,
    otherPatientsPendingCount,
    otherPatientNotifyProblems,
    queuedFamilyAlert,
    dailyRecordsVersion,
    optimisticRecord,
    latest,
  } = useBloodPressureInputForm({ subject, patientId, userEmail, measurementSession, onMeasurementSessionStart, onMeasurementSessionComplete, visible })

  // issue #1103：儲存進行中不能切換病人。寫入途中若切到別人，這筆被拒絕（非暫時性錯誤、每日上限）的結果
  // 因病人已變而不能顯示在新病人的畫面上（AGENTS.md § 3.5），回到原病人時輸入已清空、也看不到錯誤——
  // 一筆可能是危險讀數的紀錄就這樣無聲消失（北極星鐵律 4）。窗口只有「儲存中」那幾秒，鎖住比事後補通知單純。
  const saving = status === 'saving'
  // 外層（每日照護頁）的切換器在本元件之外，要靠這個回報才鎖得到；unmount 時一定歸零，避免外層永遠鎖住。
  useEffect(() => {
    onSavingChange?.(saving)
    return () => onSavingChange?.(false)
  }, [saving, onSavingChange])

  // issue #1125：補送後家人通知沒確認送達的其他照護對象，畫面上只顯示名字。名字從已授權清單解析；
  // 找不到（例如已封存）時仍要講，只是改稱「另一位照護對象」，不能因為查不到名字就不提醒。同名只講一次。
  const otherPatientNotifyNames = [...new Set(otherPatientNotifyProblems.map(problemPatientId =>
    availablePatients.find(patient => patient.patientId === problemPatientId)?.displayName || text(L.anotherCareRecipient),
  ))]

  // 報告區塊的寵物提示需要對象類型；從已授權清單解析，避免額外的 App 層 prop 傳遞。
  const activeCareRecipientType = availablePatients.find(patient => patient.patientId === patientId)?.careRecipientType
  // 病人名稱只能來自已授權的病人資料；不能再用舊角色或登入帳號猜測，以免報告標示到錯的人。
  const activeSubjectName = patientName || text({ id: 'Orang yang diukur', zh: '量測對象' ,en: 'Person measured' })

  // 五個主 tab 用同一個淡灰底，讓白色輸入卡與其他頁面的卡片有一致的閱讀層次。
  return (
    <div className="flex h-full flex-col bg-slate-50">

      {/* ── Header: title + logged-in subject badge + clock ── */}
      <header className={`${keyboardOpen ? 'hidden' : 'shrink-0 px-5'} ${embedded ? 'pt-2 pb-2' : 'pt-5 pb-2'}`}>
        {!embedded && <>
          <TabHeader title="input" />

          {/* 繁體中文註解：獨立頁才自行提供切換；嵌入每日照護時交給共同外層，避免同一人被選兩次。 */}
          <div className="mt-3">
            <SubjectSwitcher
              patientId={subject}
              patients={availablePatients}
              lockedReason={saving ? L.switchLockedWhileSaving : undefined}
              onSelect={nextSubject => {
                onSubjectSelect(nextSubject)
                // 切換病人代表換了一輪照護流程；清掉舊人的倒數，避免誤量到不同對象。
                onMeasurementSessionComplete?.()
                resetMeasurementFlow()
              }}
            />
          </div>
        </>}

        {/* 繁體中文註解（issue #1162）：這一列的單位字（mmHg／bpm）放在頁面底 slate-50（4.55:1）或白卡（4.76:1）上，
            slate-500 已是剛好過 4.5:1 的最淡值，之後做調色盤清理時不要再往淡調（原本的 gray-400 只有約 2.5:1）。
            若改放到警示或品牌淺色底上，要換 slate-600，規則見 docs/platform/i18n-and-accessibility.md「文字對比」。 */}
        {!keyboardOpen && <LatestVitals
          className={`${embedded ? '' : 'mt-3 '}text-base`}
          valueClassName="text-3xl tracking-tight text-slate-950"
          unitClassName="text-base font-semibold text-slate-500"
          showTimestamp={false}
          showInterval={false}
          record={latest.record}
          loading={latest.loading}
          error={Boolean(latest.error)}
        />}

      </header>

      {/* ── Pickers ── */}
      {/* 繁體中文註解：照護者的自然順序是先填數值、再儲存；不把完成動作放在尚未輸入的內容前面，避免誤觸與猶豫。 */}
      {/* 原本的底部狀態區（flex-1 justify-end）已併入按鈕下方（issue #1093）；它順帶提供的頁尾留白改由這裡的 pb-4 負責。 */}
      <div className="shrink-0 px-5 pt-3 pb-4 flex flex-col gap-3">
        {/* 繁體中文註解：三個 accent 只用亮色識別值、不加 Tailwind 的深色變體（issue #1152）——輸入卡永遠是白底，
            OS 深色模式換成淺色值只會讓數字對比掉到 2.5～2.8:1。 */}
        <div className="grid grid-cols-3 gap-2">
          <PickerCard
            ref={sysRef}
            inputId="bp-systolic"
            idLabel={text(L.systolic)} unit="mmHg"
            selected={systolic}
            pendingAdvance={pendingAdvanceField === 'systolic'}
            onChange={(value) => handleSystolicChange(value, () => diaRef.current?.focus())}
            onNextFocus={() => diaRef.current?.focus()}
            enterKeyHint="next"
            onInputFocus={input => {
              // 使用者手動聚焦（點擊或 Tab）任何欄位，代表前一格的延遲自動跳轉已經沒有意義，避免兩次 focus 打架。
              clearAutoAdvanceTimer()
              setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250)
            }}
            accent="text-[#C23B3B]"
          />
          <PickerCard
            ref={diaRef}
            inputId="bp-diastolic"
            idLabel={text(L.diastolic)} unit="mmHg"
            selected={diastolic}
            pendingAdvance={pendingAdvanceField === 'diastolic'}
            onChange={(value) => handleDiastolicChange(value, () => pulRef.current?.focus())}
            onNextFocus={() => pulRef.current?.focus()}
            enterKeyHint="next"
            onInputFocus={input => {
              clearAutoAdvanceTimer()
              setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250)
            }}
            accent="text-[#2563EB]"
          />
          <PickerCard
            ref={pulRef}
            inputId="bp-pulse"
            idLabel={text(L.pulse)} unit="bpm"
            selected={pulse}
            pendingAdvance={pendingAdvanceField === 'pulse'}
            onChange={(value) => handlePulseChange(value, () => submitBtnRef.current?.focus())}
            onNextFocus={() => submitBtnRef.current?.focus()}
            enterKeyHint="done"
            onInputFocus={input => {
              clearAutoAdvanceTimer()
              setTimeout(() => input.scrollIntoView({ behavior: 'smooth', block: 'center' }), 250)
            }}
            accent="text-[#7C3AED]"
          />
        </div>
        {/* 草稿以 patient_id 與語系重建；離開面板或送出時卸載，阻止晚到的語音結果混入下一人的畫面。
            MVP 只展示原文，數值仍由照護者核對填寫，沿用既有驗證與儲存流程。 */}
        {visible && !saving && <VoiceInputDraft key={`${patientId}:${locale}:${voiceDraftVersion}`} />}
        {/* 繁體中文註解：不完整數值友善提示 (如輸入 12 時即時提示是否為 120)，避免冷冰冰的報錯。 */}
        {typeof systolic === 'number' && systolic > 0 && systolic < 70 && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs font-semibold text-amber-800 text-center shadow-xs">
            {text({
              id: `Tekanan sistolik ${systolic} sepertinya tidak lengkap, pastikan apakah ${systolic}0`,
              zh: `收縮壓 ${systolic} 似乎不完整，請確認是否為 ${systolic}0` ,en: `Systolic pressure ${systolic} looks incomplete; check whether it should be ${systolic}0.`
            })}
          </div>
        )}
        {/* 繁體中文註解（issue #1147）：停用色改 slate-300（設計系統退役 gray-*）；focus ring 統一成 brand-700＋ring-offset-2。
            一定要留 offset：按鈕底色本身可能是 brand／綠色警示底，沒有白色間隔的話同色 ring 會和按鈕糊成一塊、看不出焦點。
            按鈕底色與警示階梯（ALERT_BUTTON_CLASS）由 lib/alertPresentation 決定，不在本票範圍。 */}
        <button
          ref={submitBtnRef}
          onClick={() => {
            // 只在真正按儲存時清草稿；成功提示兩秒後回 idle 不應取消下一次口述。
            // 獨立版本也涵蓋快速完成、React 合批而沒畫出 saving 中間狀態的情況。
            setVoiceDraftVersion(version => version + 1)
            void submit()
          }}
          disabled={!canSubmit}
          className={`min-h-14 w-full py-3 rounded-2xl text-white text-lg font-bold tracking-wide transition-all duration-150 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 ${
            canSubmit ? ALERT_BUTTON_CLASS[tone] : 'bg-slate-300'
          }`}
        >
          {status === 'saving' ? text(L.saving) : status === 'queued' ? text(L.queued) : status === 'ok' ? text(L.saved) : text(L.save)}
        </button>
        {/* 繁體中文註解：成功文字不能只依賴按鈕標籤變化；獨立 status 區域才能讓讀屏器在寫入完成時可靠通知使用者。 */}
        <p role="status" aria-live="polite" className="sr-only">{status === 'ok' ? text(L.saved) : status === 'queued' ? text(L.queued) : ''}</p>
        {/* issue #1060／#1093：按下儲存後的所有回饋都緊貼按鈕。嵌在每日照護頁時，原本的底部狀態區落在明細與趨勢之後、
            距離按鈕好幾個螢幕高，看護按完儲存看不到「沒存進去」或「家人沒收到危險血壓通知」（北極星鐵律 4）。
            順序：錯誤與家屬通知失敗（要看護現在處理）→ 離線待同步 → 兩次量測完成摘要／本筆等級與建議動作。 */}
        <BpSaveNotices
          status={status}
          errMsg={errMsg}
          limitBlockedReading={limitBlockedReading}
          notifyFailed={notifyFailed}
          familyAlertSkipped={familyAlertSkipped}
          familyDelivery={familyDelivery}
          queuedFamilyAlert={queuedFamilyAlert}
          otherPatientNotifyNames={otherPatientNotifyNames}
        />
        {/* 待同步狀態列與服藥打卡共用同一個元件（issue #822），佇列清空時元件自己消失。
            血壓的補送涵蓋這個帳號所有照護對象（issue #1125）：別人還在等的只顯示筆數，失敗時講真正的原因。 */}
        <PendingSyncStatus
          count={pendingRecords.length}
          syncing={pendingSyncing}
          lastAttemptAt={pendingLastAttemptAt}
          syncError={pendingSyncError}
          syncErrorTexts={pendingSyncErrorTexts}
          otherPatientsCount={otherPatientsPendingCount}
          onRetry={() => void syncPendingRecords()}
        />
        {/* After 2nd measurement: session complete + 3-day summary */}
        {showDoneMsg && (
          <div className="w-full px-4 py-2 rounded-xl border bg-green-50 border-green-200 text-green-800 text-sm">
            <div className="font-bold text-center">{text({ id: L.done.id(L[session].id), zh: L.done.zh() ,en: L.done.en(L[session].en) })}</div>

            {/* 3-day summary — shown once loaded from Supabase */}
            {summary && summary.length > 0 && (
              <div className="mt-2 border-t border-green-200 pt-1.5 space-y-1">
                {summary.map((row, i) => {
                  // 三日摘要是各時段的平均，沒有單一 measured_at，所以用現在生效的標準判讀；
                  // 與統計卡的平均值同一個理由，兩處必須一致，否則同一組平均會出現兩種顏色。
                  const rowEvaluation = evaluator.evaluateNow(row.avgSys, row.avgDia, row.avgPul)
                  const lv   = alertTone(rowEvaluation)
                  const icon = sessionIcon[row.session]
                  return (
                    <div key={i} className="flex items-center justify-between text-xs text-green-900">
                      <span className="font-medium">{icon} {row.dateStr} {row.timeStr} {text(L[row.session])}</span>
                      <VitalReading systolic={row.avgSys} diastolic={row.avgDia} pulse={row.avgPul} className="text-green-950" unitClassName="text-green-700" />
                      {/* issue #1153：emoji 換成 SVG。SVG 是 currentColor，直接放在綠色摘要框裡會讓危險級也變成綠色八角形，
                          所以包一層淺底 chip（與報告／圖表同一張 ALERT_SOFT_CHIP_CLASS）把該階的顏色帶回來。
                          這一列只有圖示、沒有文字，圖示又是 aria-hidden，所以補一段 sr-only 標籤讓讀屏器念得到等級。 */}
                      <span className={`inline-flex rounded-md p-0.5 ${ALERT_SOFT_CHIP_CLASS[lv]}`}>
                        <Icon name={ALERT_ICON[lv]} className="h-4 w-4" />
                        <span className="sr-only">{text(alertLabelText(rowEvaluation.labels))}</span>
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* BP alert level — only after first save, hidden while session-flow messages show */}
        {everSubmitted && !showRestPrompt && !showDoneMsg && displayedRule && (
          <div className={`w-full p-4 rounded-2xl border text-sm transition-all duration-150 ${alertCls[submittedTone]}`}>
            {/* 狀態標題：中印雙語 */}
            {/* issue #1153：標籤 emoji 留給推播，畫面改用 SVG 圖示＋剝掉 emoji 的文字。 */}
            <div className="flex items-center justify-center gap-1.5 font-bold text-base mb-2.5 border-b pb-2 border-current/15">
              <Icon name={ALERT_ICON[submittedTone]} className="h-5 w-5 shrink-0" />
              <span>{text(alertLabelText(displayedRule.labels))}</span>
            </div>
            {/* 建議處置 / Tindakan */}
            {(displayedRule.recommendations.id || displayedRule.recommendations.zh) && (
              <div className="space-y-2 text-left">
                <div><span className="text-[10px] font-extrabold uppercase tracking-wider opacity-75 block">{text({ id: 'Tindakan:', zh: '建議動作：' ,en: 'Suggested action:' })}</span><span className="text-base font-bold block mt-0.5 leading-snug">{text(displayedRule.recommendations)}</span></div>
              </div>
            )}
          </div>
        )}
        {!keyboardOpen && <DailyBloodPressureRecords patientId={patientId} refreshVersion={dailyRecordsVersion} pendingRecords={pendingViewRecords} optimisticRecord={optimisticRecord?.patient_id === patientId ? optimisticRecord : null} onChanged={() => { latest.refetch(); setRecordEditVersion(version => version + 1) }} />}
        {/* 量完血壓最自然的下一個動作就是跟前幾天比一下；趨勢留在同一頁，不必跳到另一個底部分頁。 */}
        {!keyboardOpen && <ModuleTrendSection moduleId="bloodPressure" titleId="blood-pressure-trend-title">
          {days => <BloodPressureReportPanel patientId={patientId} days={days} subjectLabel={activeSubjectName} careRecipientType={activeCareRecipientType} userEmail={userEmail} allowQuestionAdoption refreshVersion={dailyRecordsVersion + recordEditVersion} />}
        </ModuleTrendSection>}
      </div>

    </div>
  )
}
