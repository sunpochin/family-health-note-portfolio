/*
檔案用途：抽出 InputPage 原本超過 15 個 useState 與所有讀寫／兩次量測流程邏輯，讓頁面檔只剩下 JSX 編排。
所在層：src/features/vitals/hooks；血壓輸入表單專用的狀態容器 hook（AGENTS.md Rule A），不對外通用。
         離線佇列的補送（涵蓋這個帳號所有照護對象，issue #1125）住在 App 殼層的 useBloodPressureQueueCoordinator（issue #1138），
         不在這裡：本 hook 只讀它的狀態、按「現在同步」，並在掛載期間登記成「這筆」通知提示的主人。
主要關聯：由 InputPage 呼叫；資料存取仍透過 lib/bloodPressureRecords、lib/bloodPressurePendingQueue、
  lib/telegramNotification 等既有資料層完成，讀取狀態則沿用 hooks/useLatestBpRecord（Rule C：讀寫狀態分離）；
  佇列狀態來自 BloodPressureQueueProvider（useBloodPressureQueue）。
*/
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import 'dayjs/locale/id'
import 'dayjs/locale/zh-tw'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { alertTone } from '../../../lib/alertPresentation'
import { useBpEvaluator } from './useBpEvaluator'
import { useBloodPressureQueue } from './BloodPressureQueueProvider'
import {
  applyFamilyDeliveryResult,
  familyMayNotKnow,
  isDocumentVisible,
  queuedRecordAlertLevel,
  type BloodPressureQueueScreen,
} from './useBloodPressureQueueCoordinator'
import type { BpRecord } from '../../../types/database'
import type { Subject } from '../../../lib/auth'
import { getSession } from '../../../lib/session'
import { useI18n } from '../../../lib/i18n'
import { usePwaUpdateGuard } from '../../../lib/pwaUpdateGuard'
import { useLatestBpRecord } from '../../../hooks/useLatestBpRecord'
import { isDemoPatientId } from '../../../lib/demoData'
import { isDemoMode, saveDemoBpRecord } from '../../../lib/demoStorage'
import { sendTelegramNotification } from '../../../lib/telegramNotification'
import { insertBloodPressureRecord, type BloodPressureInsertPayload } from '../../../lib/bloodPressureRecords'
import {
  enqueuePendingBloodPressureRecord,
  pendingBloodPressureRecordToView,
  type PendingBloodPressureRecord,
} from '../../../lib/bloodPressurePendingQueue'
import { isRetryableWriteError } from '../../../lib/dataErrors'
import type { LocalizedText } from '../../../lib/i18n'
import { getBloodPressureMeasurementSessionKey, SECOND_MEASUREMENT_DELAY_MS, type BloodPressureMeasurementSession } from '../../../lib/bloodPressureMeasurementSession'
import { isFirstRecordEventEligible, trackFirstRecordSaved } from '../../../lib/analytics'
import { isCallFamilyTone, type LimitBlockedReading } from '../components/BpLimitBlockedNotice'
import type { FamilyDeliveryState, QueuedFamilyAlert } from '../components/BpSaveNotices'
import {
  TZ,
  bpAutoAdvance,
  BP_AUTO_ADVANCE_DELAY_MS,
  fetchRecentSummary,
  isFamilyAlertLevelReading,
  isValidBpInput,
  isDailyBpLimitError,
  L,
  saveErrorMessage,
  type BpField,
  type SessionSummary,
} from '../pages/InputPage.utils'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('id')

// ── Snapshot of the 1st measurement (shown in the "rest" prompt) ──────────
interface FirstRecord { sys: number; dia: number; pul: number }

// 繁體中文註解：用固定來源鍵註冊 dirty 狀態，避免 hidden 的體溫頁 cleanup 清掉血壓頁保護。
const UNSAVED_INPUT_SOURCE = 'blood-pressure'

// 共用的空陣列，避免每次「沒有其他病人」都產生新的 identity。
const NO_OTHER_PENDING: Array<Pick<PendingBloodPressureRecord, 'id' | 'patient_id'>> = []

interface UseBloodPressureInputFormParams {
  subject: Subject
  patientId: string
  userEmail?: string
  measurementSession?: BloodPressureMeasurementSession | null
  onMeasurementSessionStart?: (session: BloodPressureMeasurementSession) => void
  onMeasurementSessionComplete?: () => void
  /**
   * 這個輸入頁現在看得到嗎（issue #1117）。每日照護頁切到別的區段時 InputPage 仍掛載、只是 hidden，
   * 被拒絕的儲存若照樣寫進這裡，就是寫進一個看不到的面板；要改交殼層保管。預設 true（獨立頁一定看得到）。
   */
  visible?: boolean
}

/**
 * 血壓輸入頁的狀態容器 hook（Rule A）。
 *
 * 寫入狀態刻意不改用共用的 useSaveStatus（Rule B「或 feature-specific 變體」）：
 * 血壓離線補送流程需要額外的 'queued' 狀態（已存本機、尚未同步到 Supabase），
 * 這不是 useSaveStatus 的 'idle'|'saving'|'ok'|'err' 能表達的语意，硬套用反而會讓
 * 「已存但未同步」跟「儲存失敗」被迫共用同一種畫面文字。計時器清理與多語訊息轉譯
 * 仍遵循 Rule B 的精神（見下方 resetTimerRef 的 clearTimeout 與 saveErrorMessage）。
 *
 * 讀取狀態（今日最新讀值）已透過 hooks/useLatestBpRecord 獨立管理，本 hook 只回傳
 * 該 hook 的結果，不與這裡的送出狀態 status 混用，滿足 Rule C。
 */
export function useBloodPressureInputForm({
  subject,
  patientId,
  userEmail,
  measurementSession = null,
  onMeasurementSessionStart,
  onMeasurementSessionComplete,
  visible = true,
}: UseBloodPressureInputFormParams) {
  const { locale, text } = useI18n()
  const { registerUnsavedInput } = usePwaUpdateGuard()
  // 這位病人的判讀標準；切換照護對象時整份 evaluator 會被 Provider 換掉，
  // 不會出現「用上一位的目標判讀這一位的輸入」。
  const evaluator = useBpEvaluator()
  // 繁體中文註解：登入者身分與量測對象要分開；量測對象直接使用 App 共用 state，才不會在其他 tab 已切換後本頁仍保留舊人。
  const activeSubject = subject

  // 三個短數字直接用手機鍵盤輸入；初始留白才能防止範例數字被誤存成量測值。
  const [systolic,      setSystolic]      = useState<number | ''>('')
  const [diastolic,     setDiastolic]     = useState<number | ''>('')
  const [pulse,         setPulse]         = useState<number | ''>('')
  const [status,        setStatus]        = useState<'idle' | 'saving' | 'ok' | 'queued' | 'err'>('idle')
  const [errMsg,        setErrMsg]        = useState('')
  // issue #1060：被每日上限擋下的那一筆只存在這裡（不進資料庫、不排入離線佇列），讓畫面仍能顯示它的危險等級。
  // 與 errMsg 同生同滅：只要上限說明還在畫面上，這筆讀數的等級就要跟著在。
  const [limitBlockedReading, setLimitBlockedReading] = useState<LimitBlockedReading | null>(null)
  // 通知失敗跟儲存失敗要分開顯示：血壓其實已經存進資料庫，只是家人沒收到 Telegram 提醒。
  const [notifyFailed,  setNotifyFailed]  = useState(false)
  // 通知服務正常，但這筆沒有任何家屬通知送出（病人沒訂閱共用群組、也沒排入個人化通知）；
  // 和 notifyFailed 分開，因為這是設定狀態而非故障，畫面用說明語氣而不是失敗警示。
  const [familyAlertSkipped, setFamilyAlertSkipped] = useState(false)
  // ADR-007 D9-b：共用群組那一則的送達狀態。Function 回 2xx 不代表送到了——
  //   in_progress：另一個呼叫正在送，結果未定，前端在門檻 M 內回看帳本直到終局；
  //   unconfirmed：結果不明（sending 逾時／delivery_unknown／resolve 失敗），家人可能收到也可能沒有；
  //   not_sent：確定沒送、也不會自動重試（直送路徑沒有重試者，不得對看護說「稍後重試」）。
  // 三者都必須讓看護看到，且文案要說「紀錄已存」，不能讓看護以為要重新輸入血壓。
  //   *_personal_queued：共用群組那一則沒送／不明，但個人化通知已排入 outbox（有自己的重試者）——文案只能說「群組那一則」，
  //   不能說「家人通知沒送出、不會重試」（PR #988 Codex P2）。
  //   *_personal_unknown：共用群組那一則沒送／不明，個人化通知沒有在路上、但有一則可能已送達（delivery_unknown，不會重送）——
  //   文案要保守說「個人通知無法確認是否送達」，不能講成「沒有個人通知」。
  //   personal_unknown：共用群組未訂閱（沒有群組那一則），個人那一則不明——沒有任何一則被確認送達，仍要請看護聯絡家人（PR #988 Codex P2）。
  // 型別與「每個值顯示哪一句」放在 BpSaveNotices，新增值時 Record 窮舉會逼著同時補文案。
  const [familyDelivery, setFamilyDelivery] = useState<FamilyDeliveryState>('idle')
  // 提示寫的是「這筆紀錄」沒通知家人，所以只有最新一個通知請求的結果可以改它。每次送出通知、
  // 每次清除提示都領一個新序號；較慢的舊請求回來時序號已過期就丟掉，避免把新一筆已送達／
  // 已排入的讀數誤標成「沒通知」（Codex review on PR #927）。
  const familyAlertRequestSeqRef = useRef(0)
  const [everSubmitted, setEverSubmitted] = useState(false)   // gate for alert banner
  const [now,           setNow]           = useState(() => dayjs().tz(TZ))
  const [isDirty,       setIsDirty]       = useState(false)
  const [lastSubmittedRecord, setLastSubmittedRecord] = useState<FirstRecord | null>(null)
  const [dailyRecordsVersion, setDailyRecordsVersion] = useState(0)
  const [optimisticRecord, setOptimisticRecord] = useState<BpRecord | null>(null)
  // 離線佇列的狀態與補送都在 App 殼層的常駐補送器（issue #1138）：待送清單、同步中、失敗原因、
  // 被拒絕的原因、點名提示都從這裡讀；本 hook 只依病人過濾成畫面要的樣子。
  const queue = useBloodPressureQueue()
  const submittingRef = useRef(false)
  // 卸載後遲到的通知結果不能再寫進這個畫面的「這筆」提示（寫了也沒人看到）；要改走補送器的點名提示。
  // 在 effect 裡設 true、cleanup 設 false：StrictMode 會 掛載→卸載→再掛載，只在 cleanup 設 false 會讓第二次掛載永遠是「已卸載」。
  const mountedRef = useRef(false)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])
  // 看不到的面板（每日照護頁切到別的區段）與卸載同一個待遇：結果回來時先問這個 ref。render 時就更新，不等 effect。
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoAdvanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    // PWA 更新會重載頁面；把本頁 dirty 狀態交給外層，才能在更新前真正保住尚未送出的量測值。
    registerUnsavedInput(UNSAVED_INPUT_SOURCE, isDirty)
    return () => registerUnsavedInput(UNSAVED_INPUT_SOURCE, false)
  }, [isDirty, registerUnsavedInput])

  const resetInputs = () => {
    setSystolic('')
    setDiastolic('')
    setPulse('')
    setIsDirty(false)
  }

  const resetMeasurementFlow = () => {
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    setSessionCount(0)
    setFirstRecord(null)
    setSummary(null)
    setEverSubmitted(false)
    setLastSubmittedRecord(null)
    setStatus('idle')
    setErrMsg('')
    setLimitBlockedReading(null)
    setNotifyFailed(false)
    setFamilyAlertSkipped(false)
    setFamilyDelivery('idle')
    familyAlertRequestSeqRef.current += 1
    resetInputs()
  }

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
      if (autoAdvanceTimerRef.current) clearTimeout(autoAdvanceTimerRef.current)
    }
  }, [])

  // 兩位數延遲跳轉期間顯示提示，讓使用者知道系統正準備自動跳走，不用急著手動點下一格。
  const [pendingAdvanceField, setPendingAdvanceField] = useState<BpField | null>(null)

  const clearAutoAdvanceTimer = useCallback(() => {
    if (autoAdvanceTimerRef.current) {
      clearTimeout(autoAdvanceTimerRef.current)
      autoAdvanceTimerRef.current = null
    }
    setPendingAdvanceField(null)
  }, [])

  // 三個輸入格共用同一條自動跳欄規則，避免外觀相同的框行為不同。
  // 每次輸入都先取消上一個待跳轉，否則使用者補打第三位數時會被前一次的延遲跳走。
  const handleAutoAdvance = useCallback((field: BpField, value: number | '', focusNext: () => void) => {
    clearAutoAdvanceTimer()
    const decision = bpAutoAdvance(field, value)
    if (decision === 'immediate') {
      focusNext()
    } else if (decision === 'delayed') {
      setPendingAdvanceField(field)
      autoAdvanceTimerRef.current = setTimeout(() => {
        autoAdvanceTimerRef.current = null
        setPendingAdvanceField(null)
        focusNext()
      }, BP_AUTO_ADVANCE_DELAY_MS)
    }
  }, [clearAutoAdvanceTimer])

  // 三個欄位共用同一套「標記 dirty + 寫入數值 + 判斷是否自動跳欄」流程；
  // 包成語意操作函數讓 JSX 端只需傳入 value 與 focusNext，不必碰內部 setState。
  const handleSystolicChange = useCallback((value: number | '', focusNext: () => void) => {
    setIsDirty(true)
    setSystolic(value)
    handleAutoAdvance('systolic', value, focusNext)
  }, [handleAutoAdvance])

  const handleDiastolicChange = useCallback((value: number | '', focusNext: () => void) => {
    setIsDirty(true)
    setDiastolic(value)
    handleAutoAdvance('diastolic', value, focusNext)
  }, [handleAutoAdvance])

  const handlePulseChange = useCallback((value: number | '', focusNext: () => void) => {
    setIsDirty(true)
    setPulse(value)
    handleAutoAdvance('pulse', value, focusNext)
  }, [handleAutoAdvance])

  // Track how many times this subject was submitted in the current session
  const [sessionCount,  setSessionCount]  = useState(measurementSession ? 1 : 0)
  const [firstRecord,   setFirstRecord]   = useState<FirstRecord | null>(measurementSession ? {
    sys: measurementSession.firstRecord.systolic,
    dia: measurementSession.firstRecord.diastolic,
    pul: measurementSession.firstRecord.pulse ?? 0,
  } : null)

  // 3-day summary loaded after the 2nd measurement
  const [summary, setSummary] = useState<SessionSummary[] | null>(null)
  // 每秒更新是為了讓量測者能精準看見兩次量測之間的一分鐘休息時間。
  useEffect(() => {
    const t = setInterval(() => setNow(dayjs().tz(TZ)), 1000)
    return () => clearInterval(t)
  }, [])

  const hour    = now.hour()
  const session = getSession(hour)
  const hasValues = isValidBpInput(systolic, diastolic, pulse)
  const canSubmit = isDirty && hasValues && status !== 'saving'
  // 輸入當下還沒有 measured_at（紀錄尚未存進資料庫），所以即時回饋用**現在**生效的標準——
  // 這也正是照護者此刻被要求達到的目標。存檔後清單重新渲染時會改用該筆的 measured_at 解析，
  // 兩者在「現在量、現在存」的常見情形下結果相同。
  const liveRule = hasValues ? evaluator.evaluateNow(systolic as number, diastolic as number, pulse as number) : null
  const tone = liveRule ? alertTone(liveRule) : 'normal'
  // 輸入頁與報告共用同一份顯示判定，避免心跳警示在兩個頁面出現不同文字。
  const displayedRule = lastSubmittedRecord
    ? evaluator.evaluateNow(lastSubmittedRecord.sys, lastSubmittedRecord.dia, lastSubmittedRecord.pul)
    : null
  const submittedTone = displayedRule ? alertTone(displayedRule) : 'normal'
  // 切換對象後，晚回來的摘要不能覆蓋新對象的畫面；用 ref 保留目前真實選擇。
  const activeSubjectRef = useRef(activeSubject)
  useEffect(() => {
    activeSubjectRef.current = activeSubject
  }, [activeSubject])
  // 離線佇列補送是非同步流程，補送完成時使用者可能已切到別的病人；用 ref 避免遲到的失敗汙染新病人的畫面。
  const patientIdRef = useRef(patientId)
  useEffect(() => {
    patientIdRef.current = patientId
  }, [patientId])
  const latest = useLatestBpRecord(patientId)
  const firstRecordEventEligible = isFirstRecordEventEligible({
    hasExistingRecord: latest.record !== null,
    historyLoading: latest.loading,
    historyError: latest.error !== null,
  })
  const refetchLatest = latest.refetch
  const normalizedUserEmail = userEmail?.trim().toLowerCase() ?? ''
  // 補送器的清單是整個帳號的；渲染當下就依病人過濾（同下方 limitBlockedReading 的理由），今日清單的待同步列、
  // 失敗原因都從這裡推導，不能掛到別人身上（§ 3.5）。
  const currentPendingRecords = useMemo(() => queue.records.filter(record => record.patient_id === patientId), [patientId, queue.records])
  const pendingViewRecords = useMemo(() => currentPendingRecords.map(pendingBloodPressureRecordToView), [currentPendingRecords])
  // 同一帳號其他病人還在等的紀錄（issue #1125）：只留 id 與 patient_id、不留數值（§ 3.5），用來算筆數與對照拒絕原因。
  const otherPendingRecords = useMemo(() => {
    const others = queue.records.filter(record => record.patient_id !== patientId).map(record => ({ id: record.id, patient_id: record.patient_id }))
    return others.length === 0 ? NO_OTHER_PENDING : others
  }, [patientId, queue.records])
  const otherPatientsPendingCount = otherPendingRecords.length
  // 被伺服器永久拒絕的待送紀錄 → 真正的原因（issue #1125），以紀錄 id 為鍵：只有同一位病人的紀錄會被拿來顯示原因。
  const pendingRejections = queue.rejections
  const otherPatientsRejected = otherPendingRecords.some(record => pendingRejections[record.id] !== undefined)
  // useLatestBpRecord 依病人換一個 refetch；補送結束時要用「現在」畫面上那位的，不是補送開始時閉包裡那位的。
  const refetchLatestRef = useRef(refetchLatest)
  useEffect(() => {
    refetchLatestRef.current = refetchLatest
  }, [refetchLatest])
  // 佇列裡還有「需要通知家人」等級、而且還沒通知過的讀數嗎？（issue #1126）
  // 離線儲存現在會進佇列、畫面只顯示琥珀色「已暫存」，看護沒有理由打電話；但家人要等補送成功才收到通知。
  // 直接從佇列推導、不另存一個旗標：切換病人再切回來、或重新開 App，只要這筆還卡著就繼續提醒，
  // 補送成功移出佇列（或已標 notified）就自動消失，不會跟佇列狀態不同步。
  // 用 patient_id 再過濾一次：切換病人後、佇列重新讀取前的那一次 render，pendingRecords 可能還是上一位的（§ 3.5）。
  // 判讀用量測當下（measured_at）生效的標準，與補送後決定要不要通知家人的判讀一致。
  //
  // 個別標準讀不到時（離線重開 App，Codex review on PR #1127）不能拿一般成人門檻的結果下結論：
  // 長輩標準下 100/55 是偏低警示、一般成人卻算正常。依序退回：
  //   1. 標準讀得到 → 用現在的判讀（標準可能在入佇列後改過，以 measured_at 那段為準）。
  //   2. 讀不到，但入佇列時記過 family_alert → 用當時的個別判讀。
  //   3. 兩者都沒有 → 'unknown'，畫面改講「無法判斷，數值偏高偏低就打電話」。標準還在載入中不算，
  //      否則連線正常時每次開頁都會先閃一下這句；載入失敗（離線）才算。
  // 被伺服器拒絕、再試也不會成功的那筆（settled，issue #1125）不會自動補送，「連線恢復後會自動補送」對它是錯的：
  // 需要通知家人的改用 'rejected'（家人不會收到，請直接打電話），優先於其他所有狀態；
  // 等級不明的改用 'rejected_unknown'，不能因為被拒絕就連「無法判斷、偏高偏低就打電話」都不講（審查發現）。
  // 權限類拒絕不是定局（會再試），維持原本的 'alert'／'unknown'。
  const queuedFamilyAlert = useMemo((): QueuedFamilyAlert => {
    let alert = false
    let unknown = false
    let rejectedUnknown = false
    for (const record of currentPendingRecords) {
      if (record.notified) continue
      const level = queuedRecordAlertLevel(record, evaluator)
      const undetermined = level === undefined && !evaluator.loading
      if (pendingRejections[record.id]?.settled) {
        if (level === true) return 'rejected'
        if (undetermined) rejectedUnknown = true
        continue
      }
      if (level === true) alert = true
      else if (undetermined) unknown = true
    }
    return alert ? 'alert' : rejectedUnknown ? 'rejected_unknown' : unknown ? 'unknown' : 'none'
  }, [currentPendingRecords, evaluator, pendingRejections])

  // 線上與離線補送都只傳固定 UUID；Edge Function 會以登入者 session 重新讀取資料並套用 RLS，
  // 避免不同帳號／不同 build 因舊版通知設定缺漏而走出不同結果。
  const sendBpTelegramNotification = useCallback(async (recordId: string, recordPatientId: string) => {
    return sendTelegramNotification({ recordId, patientId: recordPatientId })
  }, [])

  // 補送器的「畫面」（issue #1138）：補送到紀錄時，由這裡決定要不要把通知結果寫進「這筆」的提示、要不要重抓今日清單。
  // 每次 render 更新 ref 裡的實作、只向補送器登記一次穩定的轉接物件：補送器在非同步流程裡呼叫時拿到的永遠是最新的閉包，
  // 補送器也不必因為這個 hook 重繪而重新登記。
  const screenRef = useRef<BloodPressureQueueScreen | null>(null)
  screenRef.current = {
    claimNotice: recordPatientId => {
      // 只有畫面上這位的紀錄領新序號：替別人的紀錄領號，會讓畫面上這位還在等的通知結果被當成過期而丟掉。
      // 只有真正看得到的畫面能獨占「這筆」的提示（Codex App 審查 P1）：背景分頁的表單仍掛著、又拿到鎖時，
      // 結果若只寫進它的 state，前景分頁只看到待送紀錄消失、背景分頁一關提示就沒了；改走持久化的點名提示。
      if (!isDocumentVisible() || recordPatientId !== patientIdRef.current) return null
      const familyAlertRequestSeq = ++familyAlertRequestSeqRef.current
      // 結果回來時還擁有提示：畫面還掛著、分頁在前景、沒換病人、序號沒被較新的一筆接手。
      return () => mountedRef.current && isDocumentVisible() && familyAlertRequestSeqRef.current === familyAlertRequestSeq && patientIdRef.current === recordPatientId
    },
    onFamilyAlertSkipped: () => setFamilyAlertSkipped(true),
    onFamilyDelivery: setFamilyDelivery,
    onNotifyFailed: () => setNotifyFailed(true),
    onSynced: records => {
      // 只看「現在」畫面上那位：補送途中換到 B、而這一輪剛好送出 B 的紀錄時，B 的清單要重抓，
      // 不然待同步列消失了、剛寫入的那筆卻還沒出現在今日清單上。別人的紀錄不在這個畫面的清單裡。
      if (!records.some(record => record.patient_id === patientIdRef.current)) return
      // 佇列補送只有在遠端 INSERT 確認後才算啟用，不能把尚未同步的本機草稿算進漏斗。
      // firstRecordEventEligible 是畫面上這位的歷史，不能拿來替別人的紀錄埋點。
      if (firstRecordEventEligible) trackFirstRecordSaved({ locale, record_type: 'blood_pressure' })
      // queue 成功後讓今日清單與最新讀值重新向資料庫確認，移除本機 pending 標記。
      setDailyRecordsVersion(version => version + 1)
      void refetchLatestRef.current()
    },
  }
  const registerScreen = queue.setScreen
  useEffect(() => {
    const screen: BloodPressureQueueScreen = {
      claimNotice: recordPatientId => screenRef.current?.claimNotice(recordPatientId) ?? null,
      onFamilyAlertSkipped: () => screenRef.current?.onFamilyAlertSkipped(),
      onFamilyDelivery: state => screenRef.current?.onFamilyDelivery(state),
      onNotifyFailed: () => screenRef.current?.onNotifyFailed(),
      onSynced: records => screenRef.current?.onSynced(records),
    }
    registerScreen(screen)
    return () => registerScreen(null)
  }, [registerScreen])

  // 狀態列要講的失敗原因（issue #1125）：先列這位病人被伺服器拒絕的真正原因（重新登入、每日上限……），
  // 別人有被拒絕的紀錄時只講「請切到那位查看」（原因可能牽涉那位的權限或配額，不在這位的畫面上細說），
  // 最後視連線狀況講「請確認網路」或「有網路卻連不到伺服器」。
  const pendingSyncErrorTexts = useMemo(() => {
    const messages: LocalizedText[] = []
    for (const record of currentPendingRecords) {
      const reason = pendingRejections[record.id]?.text
      if (reason && !messages.some(message => message.zh === reason.zh)) messages.push(reason)
    }
    if (otherPatientsRejected) messages.push(L.otherPatientsRejected)
    if (queue.retryFailed && currentPendingRecords.length + otherPatientsPendingCount > 0) {
      messages.push(queue.unreachable ? L.pendingUnreachable : L.pendingSyncError)
    }
    return messages
  }, [currentPendingRecords, otherPatientsPendingCount, otherPatientsRejected, pendingRejections, queue.retryFailed, queue.unreachable])

  // 包含目前病人、照護日與時段，確保重新載入或切換量測對象時不會沿用舊輪次。
  // 繁體中文註解：凌晨 00:00–03:59 仍屬前一個照護日，兩次量測流程不能在午夜被拆開。
  const currentSessionKey = getBloodPressureMeasurementSessionKey(patientId, now.valueOf())
  const sessionKeyRef = useRef(currentSessionKey)
  useEffect(() => {
    if (sessionKeyRef.current === currentSessionKey) return
    sessionKeyRef.current = currentSessionKey
    resetMeasurementFlow()
    // 繁體中文註解：session/對象切換屬於流程歸零，放在 effect 避免 render 階段觸發 setState。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSessionKey])

  // 離開頁面或換病人後才被拒絕的儲存由殼層的補送器保管（issue #1117）；回到那位病人的輸入頁就接手顯示，
  // 與當場被拒絕時同一個位置（BpSaveNotices）、同一句話、同一個等級提示。接手就從殼層清掉，橫幅跟著消失。
  // 執行順序要在上面的流程歸零 effect 之後：換病人的那一次 commit 兩個 effect 都會跑，歸零會把 status 設回 idle，
  // 這個 effect 排在後面才能把 err 蓋回去。
  // 同一位病人可能有好幾筆在等（離開兩次、兩筆都被拒絕）：一次接手最早的一筆，其餘留在殼層橫幅。
  const rejectedSave = queue.rejectedSaves.find(rejection => rejection.patientId === patientId) ?? null
  const clearRejectedSave = queue.clearRejectedSave
  // 看不到時不接手（PR #1219 審查）：每日照護頁可能停在別的區段、輸入頁隱藏著，接手等於把錯誤藏進看不到的面板並順手關掉橫幅。
  // 只在表單沒有自己的結果在畫面上（status 為 idle）時接手（PR #1219 Codex 兩輪）：看護離開又回來、15 秒內再送一筆，
  // 舊的拒絕這時回來——新的一筆還在送（saving）時接手，按鈕會看起來可以按、切換器提早解鎖；新的一筆也被拒絕（err）時接手，
  // 會把較新、可能更危險的那筆的訊息與等級蓋掉。所以等到 idle：成功／暫存會在 2 秒後自己回 idle，被拒絕則留在殼層橫幅、
  // 不覆蓋眼前這筆；接手時把成功後 2 秒清空輸入的計時器取消，否則它會把剛接手的 err 又改回 idle。
  useEffect(() => {
    // 分頁在背景時不接手：那筆別的分頁也看得到（殼層保管是跨分頁的），收進這個背景分頁的 state 等於從別人眼前拿走。
    if (!visible || !queue.documentVisible || status !== 'idle' || !rejectedSave || rejectedSave.patientId !== patientId) return
    clearRejectedSave(rejectedSave.recordId)
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)
    resetTimerRef.current = null
    setErrMsg(rejectedSave.uncertain ? text(L.saveOutcomeUnknown) : saveErrorMessage(rejectedSave.error, locale))
    setLimitBlockedReading(rejectedSave.limitBlockedReading)
    setStatus('err')
  }, [visible, queue.documentVisible, status, rejectedSave, patientId, clearRejectedSave, locale, text])

  const submit = async () => {
    if (submittingRef.current) return
    // 下面兩個驗證失敗也會換掉 errMsg；舊的被擋讀數若還留著，畫面會把上一筆的等級配上這次的驗證訊息。
    setLimitBlockedReading(null)
    if (!isDirty) {
      setErrMsg(text({ id: 'Silakan ukur dulu', zh: '請先實際調整數值' ,en: 'Please adjust the value first' }))
      setStatus('err')
      return
    }
    if (!isValidBpInput(systolic, diastolic, pulse)) {
      setErrMsg(text({ id: 'Angka tidak masuk akal, periksa lagi.', zh: '數值不合理，請重新確認' ,en: 'Value is not reasonable, please reconfirm' }))
      setStatus('err')
      return
    }

    submittingRef.current = true
    setStatus('saving')
    setErrMsg('')
    setNotifyFailed(false)
    setFamilyAlertSkipped(false)
    setFamilyDelivery('idle')
    // 點名提示（別人的、或已被接手的通知結果）與「這筆」的提示一起在下一次儲存時清掉。
    queue.clearNotifyProblems()
    familyAlertRequestSeqRef.current += 1
    if (resetTimerRef.current) clearTimeout(resetTimerRef.current)

    const submittedAt = dayjs().tz(TZ)
    const measured_at = submittedAt.toISOString()
    const submittedSubject = activeSubject
    const sys = systolic as number
    const dia = diastolic as number
    const pul = pulse as number
    const recordId = globalThis.crypto.randomUUID()
    const recordedBy = normalizedUserEmail || null
    const payload: BloodPressureInsertPayload = {
      id: recordId,
      systolic: sys,
      diastolic: dia,
      pulse: pul,
      measured_at,
      source: 'manual_web',
      patient_id: patientId,
      recorded_by: recordedBy,
    }
    let queuedLocally = false
    let savedRecord: BpRecord

    try {
      if (isDemoMode() && isDemoPatientId(patientId)) {
        // 匿名 Demo 不碰公開資料庫；寫入本機 overlay 才能讓面試者看到輸入真的改變趨勢與明細。
        savedRecord = saveDemoBpRecord({ systolic: sys, diastolic: dia, pulse: pul, measured_at, patient_id: patientId })
      } else {
        // 不等待第二次查詢才更新 UI；INSERT 成功本身就是資料庫已接受這筆紀錄的確認。
        await insertBloodPressureRecord(payload)
        // INSERT 不要求回傳 row，避免把資料庫回傳權限當成寫入成功的必要條件；這個快照只用於成功後的即時回饋。
        savedRecord = {
          id: recordId,
          patient_id: patientId,
          systolic: sys,
          diastolic: dia,
          pulse: pul,
          measured_at,
          created_at: measured_at,
          recorded_by: recordedBy,
          source: 'manual_web',
        }
      }
    } catch (error) {
      if (!isDemoMode() && recordedBy && isRetryableWriteError(error)) {
        // 趁這位病人的個別標準還在手上，先記下「需不需要通知家人」；之後離線重開 App 讀不到標準時靠它判斷
        // 要不要請看護打電話（issue #1126）。標準此刻也讀不到就不記，留給畫面標成「無法判斷」。
        const queuedEvaluation = evaluator.evaluateAt(sys, dia, pul, measured_at)
        const pendingRecord: PendingBloodPressureRecord = {
          ...payload,
          recorded_by: recordedBy,
          queued_at: new Date().toISOString(),
          ...(queuedEvaluation.resolved.unavailable ? {} : { family_alert: isFamilyAlertLevelReading(queuedEvaluation) }),
          // 這筆是不是帳號的第一筆，補送成功時要埋 first_record_saved；補送可能在沒有輸入頁時完成，所以在這裡記下（PR #1218 Codex P2）。
          // 一律寫 true／false：只有舊版 build 排進的紀錄才是 undefined，補送器對那種才會去問資料庫。
          first_record: firstRecordEventEligible,
        }
        if (enqueuePendingBloodPressureRecord(pendingRecord)) {
          // 連線失敗時先保存在本機；畫面會標成同步中，不冒充已寫入遠端資料庫。
          queuedLocally = true
          savedRecord = pendingBloodPressureRecordToView(pendingRecord)
          // 佇列是整個帳號的，補送器重讀清單後各畫面自己依病人過濾（§ 3.5）；狀態列同時改講「請確認網路」。
          queue.noteQueued()
        } else {
          console.error('[blood pressure pending queue unavailable]')
          submittingRef.current = false
          // 同下方：寫入期間已切到別的病人或離開這一頁（卸載或隱藏），就不把錯誤掛到看不到的畫面上，改交殼層保管（issue #1117）。
          // 結果不明：暫時性失敗（含逾時）代表伺服器可能其實已寫入，本機又存不了佇列。不能叫看護「重新輸入」（新 UUID 會多一筆），
          // 改成「先看今日紀錄，沒有再輸入」（PR #1219 Codex P1）。
          // 瀏覽器分頁在背景也算離開（Codex 第四輪 P1）：在分頁 A 送出、切到分頁 B 才回來，結果要進跨分頁的殼層保管，B 才看得到。
          if (!mountedRef.current || !visibleRef.current || !isDocumentVisible() || patientIdRef.current !== patientId) {
            queue.reportRejectedSave({ recordId, patientId, error, limitBlockedReading: null, uncertain: true, at: Date.now() })
            // 這個表單自己的請求已經結束：隱藏著的面板不能停在「儲存中」，否則回到血壓區段時接手 effect 會以為還有一筆在送。
            if (mountedRef.current) setStatus('idle')
            return
          }
          setErrMsg(text(L.saveOutcomeUnknown))
          setStatus('err')
          return
        }
      } else {
        // 繁體中文註解：使用者只需要知道儲存失敗；技術細節留在 console，避免把資料庫訊息直接露出。
        console.error('[supabase save error]', error)
        submittingRef.current = false
        // 只記快照、不做任何寫入或通知：上限是防濫用，繞過它（暫存重送）等於讓上限失效。
        const limitBlockedSnapshot = isDailyBpLimitError(error) ? { patientId, systolic: sys, diastolic: dia, pulse: pul, measuredAt: measured_at } : null
        // 寫入期間若已切到別的病人，晚回來的錯誤整個不寫進眼前的畫面：不只是被擋讀數的數值，連錯誤訊息與 status 也不能
        // 掛到這位病人的畫面上——BpSaveNotices 會捲過去顯示，看護會以為是眼前這位病人存失敗
        // （AGENTS.md § 3.5；Codex review on PR #1092），與下方通知結果的病人比對同一個理由。
        // 但也不能就此消失（issue #1117，北極星鐵律 4）：離開這一頁（輸入頁已卸載，或每日照護頁切到別的區段而隱藏）或換了病人，
        // 就交給殼層的補送器保管，回到這位病人、看得到的輸入頁時接手顯示，其餘時間由殼層橫幅點名提醒。
        if (!mountedRef.current || !visibleRef.current || !isDocumentVisible() || patientIdRef.current !== patientId) {
          // 被上限擋下的危險讀數：趁這位的標準還在手上判定「要不要立刻聯絡家人」記下來。那位之後若切不到（已封存），
          // 橫幅不能畫數值、也不能用別人的標準重判，只能靠這個旗標講「請直接打電話」（Codex 第四輪 P1）。
          const callFamily = limitBlockedSnapshot ? isCallFamilyTone(alertTone(evaluator.evaluateAt(sys, dia, pul, measured_at))) : undefined
          queue.reportRejectedSave({ recordId, patientId, error, limitBlockedReading: limitBlockedSnapshot, ...(callFamily === undefined ? {} : { callFamily }), at: Date.now() })
          // 這個表單自己的請求已經結束：隱藏著的面板不能停在「儲存中」，否則回到血壓區段時接手 effect 會以為還有一筆在送。
          if (mountedRef.current) setStatus('idle')
          return
        }
        setErrMsg(saveErrorMessage(error, locale))
        setLimitBlockedReading(limitBlockedSnapshot)
        setStatus('err')
        return
      }
    }

    if (!isDemoMode() && !queuedLocally && firstRecordEventEligible) {
      // 只在正式資料庫接受紀錄後埋點；不把血壓數值、病人或操作者資訊交給分析服務。
      trackFirstRecordSaved({ locale, record_type: 'blood_pressure' })
    }

    // 寫入期間若已切到別的病人：這筆紀錄已經是 A 的、已經存好，下方的家屬通知**一定要照送**（警報鏈）；
    // 但量測流程、成功狀態、判讀橫幅、樂觀紀錄與 2 秒後清空輸入都屬於畫面，寫上去就是把 A 的結果掛在 B 身上
    // （B 的「第一筆」會被算成第二筆、判讀橫幅用 B 的標準評 A 的數值、計時器還會清掉看護剛在 B 打的數字）。
    // AGENTS.md § 3.5；PR #1092 暫代審查 P2。
    const stillOnSubmittedPatient = patientIdRef.current === patientId
    if (stillOnSubmittedPatient) {
      const newCount = sessionCount + 1
      setSessionCount(newCount)
      setLastSubmittedRecord({ sys, dia, pul })

      if (newCount === 1) {
        setFirstRecord({ sys, dia, pul })
        // 第一筆成功寫入後才開始倒數，避免網路失敗時讓照護者誤以為已可進行第二次量測。
        const deadline = Date.now() + SECOND_MEASUREMENT_DELAY_MS
        onMeasurementSessionStart?.({ patientId, sessionKey: currentSessionKey, deadline, firstRecord: { systolic: sys, diastolic: dia, pulse: pul } })
      }

      if (newCount === 2) {
        onMeasurementSessionComplete?.()
        if (!queuedLocally && currentPendingRecords.length === 0) {
          fetchRecentSummary(patientId)
            .then(result => {
              if (activeSubjectRef.current === submittedSubject) {
                setSummary(result)
              }
            })
            .catch(error => console.error('[summary fetch error]', error))
        } else {
          // 不能把尚未同步到資料庫的本機紀錄混進遠端摘要，避免顯示不完整的趨勢。
          setSummary(null)
        }
      }

      setEverSubmitted(true)
      setIsDirty(false)
      setStatus(queuedLocally ? 'queued' : 'ok')
      setOptimisticRecord(savedRecord)
      latest.setOptimisticRecord(savedRecord)
      // 繁體中文註解：先完成寫入再收鍵盤，確保按下儲存後 compact mode 能隨 viewport 恢復正常畫面。
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      setDailyRecordsVersion(version => version + 1)
    }

    // 透過 Supabase Edge Function 發送 Telegram 通知；只傳紀錄／病人 UUID，讓 server 重新套用 RLS。
    // 使用非同步呼叫以防通知服務異常阻礙血壓主寫入流程；所有病人 UUID 都共用同一條通知管線。
    if (!isDemoMode() && !queuedLocally) {
      // 送出前就決定這筆是否屬於警示級，不在 .then 裡用當下的 evaluator：回應回來前標準可能已重新載入。
      const alertLevelReading = isFamilyAlertLevelReading(evaluator.evaluateNow(sys, dia, pul))
      const familyAlertRequestSeq = ++familyAlertRequestSeqRef.current
      // 結果回來時還擁有「這筆」的提示嗎：畫面還掛著、沒換病人、序號沒被較新的一筆（或同一位病人的補送）接手。
      // 不擁有時不能像以前那樣直接丟掉（issue #1138）：切換病人後才回來的遲到結果不能汙染新病人的畫面，
      // 但「家人可能沒收到」這件事要改走補送器的點名提示——換到誰的畫面、分頁離開再回來都看得到，只有名字沒有數值。
      // 分頁在背景時同樣不獨占：結果改走持久化的點名提示，前景分頁（或回到前景後）看得到（Codex App 審查 P1）。
      const ownsNotice = () => mountedRef.current && isDocumentVisible() && familyAlertRequestSeqRef.current === familyAlertRequestSeq && patientIdRef.current === patientId
      void sendBpTelegramNotification(recordId, patientId).then(result => {
        // 沒有任何家屬通知送出、而且是需要現在行動的讀數時才提示（Fail loudly ＋ 警報分級）。
        if (result.familyAlertSkipped && alertLevelReading) {
          if (ownsNotice()) setFamilyAlertSkipped(true)
          else queue.flagNotifyProblem(patientId)
        }
        applyFamilyDeliveryResult(result, { recordId, patientId }, () => true, state => {
          if (ownsNotice()) setFamilyDelivery(state)
          else if (familyMayNotKnow(state)) queue.flagNotifyProblem(patientId)
        })
      }).catch(err => {
        // 為什麼只記錄而不回滾：血壓已成功寫入，通知失敗不能讓看護重送而造成重複紀錄。
        console.error('[telegram notification function error]', err)
        if (ownsNotice()) setNotifyFailed(true)
        else queue.flagNotifyProblem(patientId)
      })
    }

    submittingRef.current = false
    if (!stillOnSubmittedPatient) return
    resetTimerRef.current = setTimeout(() => {
      resetInputs()
      setStatus('idle')
    }, 2000)
  }

  const showRestPrompt = sessionCount === 1 && firstRecord !== null
  const showDoneMsg    = sessionCount >= 2

  return {
    // 輸入欄位與變更處理
    systolic,
    diastolic,
    pulse,
    handleSystolicChange,
    handleDiastolicChange,
    handlePulseChange,
    pendingAdvanceField,
    clearAutoAdvanceTimer,

    // 送出狀態（Rule C：與下方 latest 讀取狀態分開管理）
    status,
    errMsg,
    // 渲染當下就比對病人，不等 resetMeasurementFlow 的 effect：切換病人後的第一次 commit，effect 還沒跑，
    // 舊快照若照樣交出去，畫面會用新病人的標準判讀上一位的數值（Codex review on PR #1092，同 BpStandardProvider 的理由）。
    limitBlockedReading: limitBlockedReading?.patientId === patientId ? limitBlockedReading : null,
    notifyFailed,
    familyAlertSkipped,
    familyDelivery,
    everSubmitted,
    canSubmit,
    tone,
    submit,

    // 兩次量測流程
    session,
    showRestPrompt,
    showDoneMsg,
    summary,
    displayedRule,
    submittedTone,
    resetMeasurementFlow,

    // 離線佇列（補送住在 App 殼層的補送器、涵蓋這個帳號所有病人；issue #1125、#1138）
    pendingRecords: currentPendingRecords,
    pendingViewRecords,
    pendingSyncing: queue.syncing,
    pendingSyncError: pendingSyncErrorTexts.length > 0,
    pendingSyncErrorTexts,
    pendingLastAttemptAt: queue.lastAttemptAt,
    syncPendingRecords: queue.retryNow,
    queuedFamilyAlert,
    otherPatientsPendingCount,
    otherPatientNotifyProblems: queue.notifyProblems,

    // 今日清單／樂觀更新
    dailyRecordsVersion,
    optimisticRecord,

    // 最新讀值：直接透傳 useLatestBpRecord 的讀取狀態，不與 status 混用
    latest,
  }
}
