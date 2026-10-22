/*
檔案用途：提供每日服藥 tab，讀取藥單、記錄每顆藥是否服用，並可進入授權的調藥介面。
所在層：src/features/medication/pages；是照護流程中的藥物操作畫面。
主要關聯：使用 TabHeader 與 SubjectSwitcher 共用頁首和病人選擇，資料操作集中在 lib/medication/medications 與 MedicationAdminSection；
本週藥單、單一時段卡片與兩個確認視窗已抽成 MedicationWeekView／MedicationSlotCard／MedicationCompletionDialog／
MedicationCancelDoseDialog，頁面本身只負責讀取資料、持有狀態並安排這些元件（AGENTS.md「介面元件化規範」）。
離線打卡佇列（斷線時先存本機、恢復連線後補送、同一劑只留一筆）的狀態在 hooks/useMedicationPendingDoses（issue #822）。
*/
import { lazy, useEffect, useMemo, useRef, useState } from 'react'
import dayjs from 'dayjs'
import 'dayjs/locale/id'
import 'dayjs/locale/zh-tw'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { medicationHoldCoversCareDate, medicationHoldRemaining, medicationHoldNow, medicationServerNow, type MedicationHoldContext } from '../../../lib/medication/medicationHold'
import { getMedicationSyncErrorKind } from '../../../lib/medication/medicationToday'
import { CARE_DAY_TIMEZONE, careDateKey } from '../../../lib/careDay'
import { isRetryableWriteError } from '../../../lib/dataErrors'
import { clearMedicationDose, completesRequiredMedicationSlot, isCurrentMedicationView, readMedicationDay, saveMedicationDose, type MedicationPlanView } from '../../../lib/medication/medications'
import { applyMedicationSyncToDayLogs, isPendingMedicationLog, mergeMedicationDayLogs, upsertMedicationDayLogs } from '../../../lib/medication/medicationPendingQueue'
import { PendingSyncStatus } from '../../../components/ui/PendingSyncStatus'
import { MedicationSupersededNotice } from '../components/MedicationSupersededNotice'
import { useMedicationPendingDoses, type MedicationSyncResult } from '../hooks/useMedicationPendingDoses'
import { savePrnDailyAssessment, savePrnMedicationEvent, updatePrnMedicationEffectStatus, voidPrnMedicationEvent, type SavePrnMedicationEventInput } from '../../../lib/medication/prnMedication'
import { compareMedicationSlots, getMedicationSlotCollapseDefaults, medicationSlotQuantityProgressText } from '../../../lib/medication/medicationSchedule'
import type { MedicationIntakeLog, PrnMedicationDailyAssessment, PrnMedicationEvent } from '../../../types/database'
import type { MedicationManagementPatient, PatientIdentity } from '../../../lib/auth'
import { SubjectSwitcher } from '../../../components/ui/SubjectSwitcher'
import { TabHeader } from '../../../components/ui/TabHeader'
import { MedicationAdminSection } from '../components/MedicationAdminSection'
import { MedicationCancelDoseDialog, type PendingMedicationCancellation } from '../components/MedicationCancelDoseDialog'
import { MedicationCompletionDialog } from '../components/MedicationCompletionDialog'
import { MedicationDetailDialog } from '../components/MedicationDetailDialog'
import { MedicationSlotCard, type MedicationSlotProgress } from '../components/MedicationSlotCard'
import { MedicationViewTabs, type MedicationView } from '../components/MedicationViewTabs'
import { MedicationHoldFacts } from '../components/MedicationHoldFacts'
import { MedicationWeekView } from '../components/MedicationWeekView'
import { PrnMedicationSection } from '../components/PrnMedicationSection'
import { common, useI18n, type LocalizedText } from '../../../lib/i18n'
import { ModuleTrendSection } from '../../../components/daily-care/ModuleTrendSection'

dayjs.extend(utc)
dayjs.extend(timezone)
dayjs.locale('id')

// 圖表套件只在照護者展開趨勢時才下載，不進入每日照護的初始載入路徑。
const MedicationDoseHistoryPanel = lazy(() => import('../components/MedicationDoseHistoryPanel').then(m => ({ default: m.MedicationDoseHistoryPanel })))

const syncErrorMessage = (error: unknown): LocalizedText => {
  const kind = getMedicationSyncErrorKind(error)
  if (kind === 'setup') return { id: 'Catatan obat sementara tidak tersedia. Silakan coba lagi nanti.', zh: '服藥紀錄暫時無法使用，請稍後再試。' ,en: 'Dosing history is temporarily unavailable, please try again later.' }
  if (kind === 'permission') return { id: 'Akun ini tidak dapat membaca daftar obat.', zh: '此帳號無法讀取藥單。' ,en: 'This account can’t read the medication list.' }
  return { id: 'Sinkronisasi gagal. Periksa internet lalu coba lagi.', zh: '同步失敗，請確認網路後再試。' ,en: 'Sync failed, please check your network and try again.' }
}

// 撤回待同步劑次失敗時的說明；兩種都很少見，但都不能讓看護以為已經撤回了（北極星鐵律 4）。
const PENDING_CANCEL_SYNCING_TEXT: LocalizedText = { id: 'Dosis ini sedang dikirim. Tunggu sebentar, lalu ketuk lagi untuk membatalkan.', zh: '這一劑正在送出，請稍候再點一次取消。', en: 'This dose is being sent. Wait a moment, then tap it again to cancel.' }
const PENDING_RECHECK_WAIT_TEXT: LocalizedText = { zh: '尚未確認上一筆撤回，請先連線完成同步，再重新記錄這一劑。', id: 'Pembatalan sebelumnya belum terkonfirmasi. Hubungkan dan selesaikan sinkronisasi, lalu catat dosis ini lagi.', en: 'The previous cancellation is not confirmed. Connect and finish syncing, then record this dose again.' }
const PENDING_RECHECK_STORAGE_TEXT: LocalizedText = { zh: '無法重新記錄：手機儲存無法寫入，撤回標記仍保留。請稍後再試。', id: 'Tidak bisa mencatat ulang: penyimpanan ponsel tidak dapat ditulis. Penanda pembatalan tetap tersimpan. Coba lagi nanti.', en: 'Could not record again: phone storage cannot be written. The cancellation marker is preserved. Try again later.' }
const PENDING_CLEANUP_ERROR_TEXT: LocalizedText = { zh: '服藥確認或更正結果已儲存，但手機的舊撤回標記尚未清除，請稍後重試同步。', id: 'Hasil konfirmasi atau koreksi dosis sudah tersimpan, tetapi penanda pembatalan lama di ponsel belum dihapus. Coba sinkronkan lagi nanti.', en: 'The intake confirmation or correction was saved, but the old cancellation marker on this phone could not be cleared. Retry syncing shortly.' }
const PENDING_CANCEL_STORAGE_TEXT: LocalizedText = { id: 'Tidak bisa membatalkan: penyimpanan ponsel tidak dapat ditulis, jadi dosis ini tetap akan dikirim. Setelah terkirim, ketuk lagi untuk membatalkan.', zh: '無法撤回：手機的本機儲存無法寫入，這一劑仍會送出。送出後請再點一次取消。', en: 'Could not cancel: this phone’s storage cannot be written, so this dose will still be sent. Once it is sent, tap it again to cancel.' }

export function MedicationPage({ manageablePatients, ownPatientId, selectedPatientId, availablePatients, userEmail, onSubjectSelect, embedded = false, slotsExpandedByDefault = true, nameEnglishFirst = true }: { manageablePatients: MedicationManagementPatient[]; ownPatientId: string; selectedPatientId: string; availablePatients: PatientIdentity[]; userEmail: string; onSubjectSelect: (patientId: string) => void; embedded?: boolean; slotsExpandedByDefault?: boolean; nameEnglishFirst?: boolean }) {
  const { locale, text } = useI18n()
  const [today, setToday] = useState(() => careDateKey())
  const loadedDayRef = useRef('')
  const serverClockRef = useRef<{ patientId: string; context: MedicationHoldContext } | null>(null)
  const [plans, setPlans] = useState<MedicationPlanView[]>([])
  const [logs, setLogs] = useState<MedicationIntakeLog[]>([])
  const [prnEvents, setPrnEvents] = useState<PrnMedicationEvent[]>([])
  const [prnAssessments, setPrnAssessments] = useState<PrnMedicationDailyAssessment[]>([])
  const [busyKey, setBusyKey] = useState('')
  const [errorMessage, setErrorMessage] = useState<LocalizedText | null>(null)
  const [loading, setLoading] = useState(true)
  const [medicationView, setMedicationView] = useState<MedicationView>('today')
  const [planRefreshVersion, setPlanRefreshVersion] = useState(0)
  const [collapsedSlots, setCollapsedSlots] = useState<Set<string>>(new Set())
  const collapseDefaultsInitialized = useRef(false)
  const [completedSlotPrompt, setCompletedSlotPrompt] = useState<string | null>(null)
  const [pendingMedicationCancellation, setPendingMedicationCancellation] = useState<PendingMedicationCancellation | null>(null)
  // 只有本週藥單是唯讀掃視畫面，點藥名才彈出詳情；服藥打卡點藥卡是用來記錄服用，兩者操作意圖不同，不共用同一個狀態。
  const [detailPlan, setDetailPlan] = useState<MedicationPlanView | null>(null)
  const [restoreCancellationTriggerFocus, setRestoreCancellationTriggerFocus] = useState(false)
  const cancellationTriggerRef = useRef<HTMLButtonElement | null>(null)
  const previousCompletedSlots = useRef(new Set<string>())
  const collapsedSlotContextRef = useRef('')
  const loadedPlansContextRef = useRef('')
  const activeMedicationOwnerRef = useRef(userEmail)
  activeMedicationOwnerRef.current = userEmail
  const activeMedicationViewRef = useRef({ patientId: selectedPatientId, date: today })
  // 在 render 就更新目前畫面身分，才能擋住「切換後、effect 尚未執行前」剛好回來的舊存檔結果。
  activeMedicationViewRef.current = { patientId: selectedPatientId, date: today }

  // 讀取當天紀錄要依序打好幾個請求；這段期間補送完成的結果若只寫進 state，會被讀取完成時的 setLogs(result.logs)
  // 蓋掉（伺服器回應可能是在補送之前查的），而那一劑已經不在佇列、對帳也救不回來，藥卡就會顯示成沒吃。
  // 所以每次開始讀取時清空、讀取完成時把這段期間的補送結果重新套上去。
  const syncResultsDuringLoadRef = useRef<MedicationSyncResult[]>([])

  // 離線打卡佇列（issue #822）：斷線時先存在這支手機，恢復連線或回前景後自動補送。
  const pendingDoses = useMedicationPendingDoses({
    patientId: selectedPatientId,
    userEmail,
    careDate: today,
    onSynced: ({ recorded, withdrawn }) => {
      // 補送可能在切換病人或跨過 04:00 之後才回來；只把屬於目前畫面的那幾筆併進清單。
      const view = activeMedicationViewRef.current
      const visible: MedicationSyncResult = {
        recorded: recorded.filter(log => log.patient_id === view.patientId && (log.care_date ?? log.taken_on) === view.date),
        withdrawn: withdrawn.filter(dose => dose.patient_id === view.patientId && dose.care_date === view.date),
      }
      if (visible.recorded.length === 0 && visible.withdrawn.length === 0) return
      syncResultsDuringLoadRef.current.push(visible)
      setLogs(current => applyMedicationSyncToDayLogs(current, visible.recorded, visible.withdrawn))
    },
    onExternalQueueChange: () => {
      // 另一分頁移除佇列項目不代表一定是新寫入；重讀伺服器才能保留 server-wins 的實際紀錄與操作者時間。
      setPlanRefreshVersion(version => version + 1)
    },
  })
  // 讀取 effect 只該在病人／照護日／藥單版本變動時重跑；對帳函式用 ref 取最新版本，避免它的 identity 變動觸發重新讀取。
  const reconcileWithServerRef = useRef(pendingDoses.reconcileWithServer)
  reconcileWithServerRef.current = pendingDoses.reconcileWithServer
  const confirmExternalRefreshRef = useRef(pendingDoses.confirmExternalRefresh)
  confirmExternalRefreshRef.current = pendingDoses.confirmExternalRefresh

  useEffect(() => {
    // 標題時鐘已由共用元件處理；這裡仍每秒檢查跨過台北 04:00，避免長開手機把凌晨服藥切到錯的照護日。
    const timer = setInterval(() => {
      const clock = serverClockRef.current
      // 條件用藥與 RPC 共用病人綁定的伺服器日期；手機快慢不能切回錯的照護日。
      const current = clock?.patientId === selectedPatientId ? dayjs(medicationServerNow(clock.context)) : dayjs().tz(CARE_DAY_TIMEZONE)
      setToday(careDateKey(current))
    }, 1000)
    return () => clearInterval(timer)
  }, [selectedPatientId])

  useEffect(() => {
    let cancelled = false
    let redirected = false
    const requestContext = `${selectedPatientId}:${today}:${planRefreshVersion}`
    // 同日刷新保留卡片與補記草稿；換帳號、病人或照護日先清除舊畫面。
    const dayKey = `${userEmail}:${selectedPatientId}:${today}`
    if (loadedDayRef.current !== dayKey) {
      loadedDayRef.current = dayKey
      setLoading(true)
      setPlans([])
      setDetailPlan(null)
      setLogs([])
      setPrnEvents([])
      setPrnAssessments([])
      setCompletedSlotPrompt(null)
      cancellationTriggerRef.current = null
      setPendingMedicationCancellation(null)
      setRestoreCancellationTriggerFocus(false)
    }
    syncResultsDuringLoadRef.current = []
    readMedicationDay(selectedPatientId, today)
      .then(result => {
        if (cancelled) return
        const context = result.plans.find(plan => plan.patient_id === selectedPatientId && plan.holdContext)?.holdContext
        if (context && Number.isFinite(medicationServerNow(context))) {
          serverClockRef.current = { patientId: selectedPatientId, context }
          const serverDate = careDateKey(dayjs(medicationServerNow(context)))
          if (serverDate !== today) {
            // 先重讀正確照護日，不能短暫呈現另一日可按的劑次。
            redirected = true; setLoading(true); setPlans([]); setToday(serverDate)
            return
          }
        } else serverClockRef.current = null
        // 先標記 plans 所屬對象，再讓 React 更新畫面；收合初始化因此不會把上一位病人的資料當成新資料。
        loadedPlansContextRef.current = requestContext
        setPlans(result.plans)
        // 讀取期間完成的補送／撤回要重新套上去，否則會被這次（可能在補送之前查到的）伺服器結果蓋掉。
        setLogs(syncResultsDuringLoadRef.current.reduce(
          (current, synced) => applyMedicationSyncToDayLogs(current, synced.recorded, synced.withdrawn),
          result.logs,
        ))
        // 伺服器已有的劑次直接移出本機佇列（server-wins），免得取消伺服器那筆後佇列又把同一劑寫回去。
        // 先交棒這次讀取已涵蓋的投影；對帳時才發現的新跨頁 drain 必須留給下一次讀取，不能被舊結果抹掉。
        confirmExternalRefreshRef.current(selectedPatientId, today, userEmail)
        reconcileWithServerRef.current(result.logs, selectedPatientId)
        setPrnEvents(result.prnEvents)
        setPrnAssessments(result.prnAssessments)
        setErrorMessage(null)
      })
      .catch(error => {
        if (cancelled) return
        console.error('[medication plan read error]', error)
        setErrorMessage(syncErrorMessage(error))
      })
      .finally(() => { if (!cancelled && !redirected) setLoading(false) })
    return () => { cancelled = true }
  }, [today, selectedPatientId, planRefreshVersion, userEmail])

  const groups = useMemo(() => {
    const result = new Map<string, MedicationPlanView[]>()
    // PRN 沒有固定餐次；先在這裡排除，避免它回到 routine 卡片與進度條。
    plans.filter(plan => plan.patient_id === selectedPatientId && !plan.as_needed).forEach(plan => result.set(plan.schedule_slot, [...(result.get(plan.schedule_slot) ?? []), plan]))
    // 同一時段固定用英文商品名排序，讓照護者每天看到的 A→B→C 順序穩定，不受 Supabase 回傳順序影響。
    return [...result.entries()].sort(([left], [right]) => compareMedicationSlots(left, right)).map(([slot, slotPlans]) => [
      slot,
      slotPlans.sort((left, right) => left.medication.brand_name.localeCompare(right.medication.brand_name, 'en', { sensitivity: 'base' })),
    ] as const)
  }, [plans, selectedPatientId])

  const hasPrnPlans = plans.some(plan => plan.as_needed)
  const canManageSelectedPatient = manageablePatients.some(patient => patient.patientId === selectedPatientId)

  useEffect(() => {
    // 繁體中文註解：手機先展開第一個時段，避免 11 張藥卡一次淹沒畫面；每個時段仍可手動展開，不改變服藥資料或順序。
    // 載入完成前不能使用舊 groups，否則切換病人時會先記住上一位病人的收合結果。
    collapseDefaultsInitialized.current = false
    collapsedSlotContextRef.current = ''
    setCollapsedSlots(new Set())
  }, [selectedPatientId, today, slotsExpandedByDefault])

  useEffect(() => {
    const context = `${selectedPatientId}:${today}:${planRefreshVersion}`
    if (!groups.length || collapseDefaultsInitialized.current || loadedPlansContextRef.current !== context) return
    collapseDefaultsInitialized.current = true
    setCollapsedSlots(getMedicationSlotCollapseDefaults(groups.map(([slot]) => slot), slotsExpandedByDefault))
  }, [groups, planRefreshVersion, selectedPatientId, slotsExpandedByDefault, today])

  // 攤平成「一次一份」的清單，全天進度卡與每個時段標題共用同一份展開結果，不必各自重算一次「dose_count 攤平」。
  const requiredDoses = useMemo(() => groups.flatMap(([slot, slotPlans]) =>
    slotPlans.flatMap(plan =>
      Array.from({ length: plan.dose_count }, (_, index) => ({ slot, planId: plan.id, doseNumber: index + 1, dose_amount: plan.dose_amount, dosage_form: plan.medication.dosage_form })),
    ),
  ), [groups])
  // 無條件藥的待同步劑次維持舊顯示；條件藥須先補記事實，不把未確認的佇列算作已通過醫囑。
  // 同一劑伺服器已有紀錄時以伺服器為準，不重複計算。
  const displayLogs = useMemo(
    () => mergeMedicationDayLogs(logs.filter(log => log.patient_id === selectedPatientId), pendingDoses.pendingLogs, pendingDoses.withdrawnDoses.filter(dose => !plans.some(plan => plan.id === dose.plan_id && plan.holdContext))),
    [logs, pendingDoses.pendingLogs, pendingDoses.withdrawnDoses, plans, selectedPatientId],
  )
  useEffect(() => {
    const medicationIds = [...new Set(plans.filter(plan => plan.patient_id === selectedPatientId && plan.holdContext).map(plan => plan.medication_id))]
    if (!medicationIds.length) return
    // 共用主讀取 effect，讓讀取期間完成的離線補送能重放；不可用舊結果覆蓋新事實。
    const refresh = () => setPlanRefreshVersion(value => value + 1)
    const remaining = plans.flatMap(plan => plan.holdContext ? [medicationHoldRemaining(plan.holdContext)] : [])
    // 失聯且舊時窗已結束時仍每分鐘重試，不能以過期日期形成 100ms 迴圈。
    const timer = window.setTimeout(refresh, Math.min(60_000, ...remaining.filter(ms => ms > 0).map(ms => Math.max(100, ms))))
    window.addEventListener('focus', refresh)
    return () => { clearTimeout(timer); window.removeEventListener('focus', refresh) }
  }, [plans, selectedPatientId, today, planRefreshVersion])
  const requiredTakenDoses = useMemo(() => requiredDoses.filter(dose => displayLogs.some(log => log.plan_id === dose.planId && log.dose_number === dose.doseNumber && !(isPendingMedicationLog(log) && plans.some(plan => plan.id === dose.planId && plan.holdContext)))), [requiredDoses, displayLogs, plans])
  // 真正服用優先；當日暫停只處理尚未服用的劑次，絕不灌入 intake。
  // 每次刷新都重看目前時間，即使查詢失敗也不能把昨日暫停算成今日完成。
  const heldDoses = requiredDoses.filter(dose => !requiredTakenDoses.includes(dose) && !displayLogs.some(log => log.plan_id === dose.planId && log.dose_number === dose.doseNumber && isPendingMedicationLog(log)) && plans.some(plan => plan.id === dose.planId && plan.holdContext && medicationHoldCoversCareDate(plan.holdContext, today)))
  const requiredTotal = requiredDoses.length
  const requiredTaken = requiredTakenDoses.length
  // 全天顆數摘要跟每個時段用同一套「按劑型分組」規則，不能把粉包／液劑混算成「顆」。
  const requiredQuantity = useMemo(() => medicationSlotQuantityProgressText(requiredTakenDoses, requiredDoses), [requiredTakenDoses, requiredDoses])

  const recordPrn = async (input: SavePrnMedicationEventInput) => {
    const requestView = { patientId: selectedPatientId, date: today }
    const saved = await savePrnMedicationEvent({ ...input, recordedByEmail: userEmail })
    // PRN 次數只增加實際回傳的 event；同一 id 重試時以回傳值更新，不在畫面製造第二筆。
    if (isCurrentMedicationView(activeMedicationViewRef.current, requestView)) {
      setPrnEvents(current => current.some(event => event.id === saved.id) ? current.map(event => event.id === saved.id ? saved : event) : [...current, saved])
      setErrorMessage(null)
    }
  }

  const voidPrn = async (event: PrnMedicationEvent, reason: string) => {
    const requestView = { patientId: selectedPatientId, date: today }
    const voided = await voidPrnMedicationEvent(event, selectedPatientId, reason)
    if (isCurrentMedicationView(activeMedicationViewRef.current, requestView)) setPrnEvents(current => current.map(item => item.id === voided.id ? voided : item))
  }

  const assessPrnEffect = async (event: PrnMedicationEvent, effectStatus: PrnMedicationEvent['effect_status']) => {
    const requestView = { patientId: selectedPatientId, date: today }
    const updated = await updatePrnMedicationEffectStatus(event, selectedPatientId, effectStatus)
    if (isCurrentMedicationView(activeMedicationViewRef.current, requestView)) setPrnEvents(current => current.map(item => item.id === updated.id ? updated : item))
  }

  const assessPrn = async (planId: string, status: 'not_assessed' | 'not_needed') => {
    const requestView = { patientId: selectedPatientId, date: today }
    const saved = await savePrnDailyAssessment(selectedPatientId, planId, today, status)
    if (isCurrentMedicationView(activeMedicationViewRef.current, requestView)) setPrnAssessments(current => current.some(item => item.id === saved.id) ? current.map(item => item.id === saved.id ? saved : item) : [...current, saved])
  }

  const selectMedicationView = (nextView: MedicationView) => {
    // 不自動替使用者切換照護對象；管理權不足時顯示明確提示，比無聲跳到另一位病人更安全。
    setMedicationView(nextView)
  }

  // PRN 沒有吃也不代表這餐沒完成，完成標記必須與跳出的完成卡使用同一套固定藥規則，因此只從已排除 PRN 的 requiredDoses 取值。
  const slotProgress = useMemo(() => {
    const map = new Map<string, MedicationSlotProgress>()
    groups.forEach(([slot]) => {
      const doses = requiredDoses.filter(dose => dose.slot === slot)
      const takenDoses = requiredTakenDoses.filter(dose => dose.slot === slot)
      map.set(slot, {
        doseHeld: heldDoses.filter(dose => dose.slot === slot).length,
        doseTaken: takenDoses.length,
        doseTotal: doses.length,
        quantity: medicationSlotQuantityProgressText(takenDoses, doses),
      })
    })
    return map
  }, [groups, requiredDoses, requiredTakenDoses, heldDoses])

  const completedSlots = useMemo(() => new Set(
    Array.from(slotProgress.entries())
      .filter(([, progress]) => progress.doseTotal > 0 && progress.doseTaken + (progress.doseHeld ?? 0) === progress.doseTotal)
      .map(([slot]) => slot),
  ), [slotProgress])

  useEffect(() => {
    if (loading || groups.length === 0) return
    const context = `${selectedPatientId}:${today}:${planRefreshVersion}`
    const collapseContext = `${selectedPatientId}:${today}`
    if (loadedPlansContextRef.current !== context || collapsedSlotContextRef.current === collapseContext) return
    collapsedSlotContextRef.current = collapseContext
    if (slotsExpandedByDefault) {
      // 全開模式不能因完成某餐而自動收合，否則設定會在初始化後又被精簡邏輯覆寫。
      previousCompletedSlots.current = completedSlots
      return
    }
    // 只有選擇精簡模式才自動收合，讓需要一眼核對每餐的照護者不會又被迫點開已完成時段。
    const nextCollapsed = new Set(groups.filter(([slot], index) => index > 0 || completedSlots.has(slot)).map(([slot]) => slot))
    setCollapsedSlots(nextCollapsed)
    previousCompletedSlots.current = completedSlots
  }, [completedSlots, groups, loading, planRefreshVersion, selectedPatientId, slotsExpandedByDefault, today])

  useEffect(() => {
    if (slotsExpandedByDefault) return
    // 只在剛完成時自動收合；若每次其他時段變動都重收，使用者就無法保留手動展開來核對或取消。
    const previous = previousCompletedSlots.current
    setCollapsedSlots(current => {
      const next = new Set(current)
      groups.forEach(([slot, slotPlans]) => {
        // 條件藥可能正填寫補記原因，背景完成狀態不能讓這個草稿消失。
        if (slotPlans.some(plan => plan.holdContext)) return
        const isCompleted = completedSlots.has(slot)
        const wasCompleted = previous.has(slot)
        if (isCompleted && !wasCompleted) next.add(slot)
        if (!isCompleted && wasCompleted) next.delete(slot)
      })
      return next.size === current.size && [...next].every(slot => current.has(slot)) ? current : next
    })
    previousCompletedSlots.current = completedSlots
  }, [completedSlots, groups, slotsExpandedByDefault])

  const clearDose = async (plan: MedicationPlanView, doseNumber: number, existing: MedicationIntakeLog) => {
    const key = `${plan.id}:${doseNumber}`
    if (busyKey) return
    const requestView = { patientId: selectedPatientId, date: today }
    const requestOwner = userEmail
    const requestIsCurrent = () => activeMedicationOwnerRef.current === requestOwner
      && isCurrentMedicationView(activeMedicationViewRef.current, requestView)

    if (isPendingMedicationLog(existing)) {
      // 待同步的劑次走佇列撤回：畫面立刻反映，撤回標記連線後再刪掉自己那次打卡可能已寫進伺服器的那筆
      // （排進佇列的原因可能是「其實寫入了、只是回應遺失」）；離線時也不必等網路。
      const outcome = pendingDoses.cancelPendingDose(plan.id, doseNumber, existing.care_date ?? today)
      if (outcome === 'withdrawn') setErrorMessage(null)
      else if (outcome === 'syncing') setErrorMessage(PENDING_CANCEL_SYNCING_TEXT)
      else if (outcome === 'storage-error') setErrorMessage(PENDING_CANCEL_STORAGE_TEXT)
      // not-pending：確認視窗開著的期間這劑剛好補送完成，或對帳時發現別處已先記錄。看護確認的是她自己那一筆，
      // 不能拿這次確認去刪伺服器上那筆（可能是別人記錄的）；藥卡已更新成伺服器的紀錄，要取消就再點一次。
      return
    }

    setBusyKey(key)
    try {
      await clearMedicationDose(plan.id, selectedPatientId, today, doseNumber)
      if (requestIsCurrent()) {
        setLogs(current => current.filter(log => log.id !== existing.id))
        if (plans.some(value => value.holdContext)) setPlanRefreshVersion(value => value + 1)
      }
      if (requestIsCurrent()) setErrorMessage(null)
    } catch (error) {
      console.error('[medication dose sync error]', error)
      if (requestIsCurrent()) setErrorMessage(syncErrorMessage(error))
    } finally {
      setBusyKey(current => current === key ? '' : current)
    }
  }

  const toggleDose = async (plan: MedicationPlanView, doseNumber: number, existing: MedicationIntakeLog | undefined, trigger?: HTMLButtonElement) => {
    const key = `${plan.id}:${doseNumber}`
    if (busyKey) return

    if (existing) {
      // 先保留這次點擊的完整脈絡，確認視窗才能明確指出會取消哪顆藥、哪個時間的紀錄。
      cancellationTriggerRef.current = trigger ?? null
      setRestoreCancellationTriggerFocus(true)
      setPendingMedicationCancellation({ plan, doseNumber, existing })
      return
    }

    const requestView = { patientId: selectedPatientId, date: today }
    const requestOwner = userEmail
    const requestIsCurrent = () => activeMedicationOwnerRef.current === requestOwner
      && isCurrentMedicationView(activeMedicationViewRef.current, requestView)
    const slotPlans = groups.find(([slot]) => slot === plan.schedule_slot)?.[1] ?? []
    // 按下去的那一刻就是服藥時間；線上寫入失敗轉進離線佇列時沿用同一個時間，補送才不會把照護日或服藥時間記晚。
    // 同頁普通藥使用回應接收時鐘；暫停到期使用的保守提前量不能加進實際服藥時間。
    const clock = serverClockRef.current
    const taken = clock?.patientId === selectedPatientId ? dayjs(medicationServerNow(clock.context)) : dayjs()
    // 回應前後的估時計跨過 04:00 時，無法確定實際照護日；先重讀，不把猜測寫入伺服器或離線佇列。
    if (clock?.patientId === selectedPatientId && careDateKey(taken) !== careDateKey(dayjs(medicationHoldNow(clock.context)))) {
      setErrorMessage({ zh: '正在重新確認服藥日期，請稍後再記錄。', id: 'Tanggal minum obat sedang diperiksa ulang. Coba catat lagi sebentar.', en: 'Rechecking the intake date. Please record again shortly.' })
      setPlanRefreshVersion(value => value + 1)
      return
    }
    if (careDateKey(taken) !== today) { setToday(careDateKey(taken)); return }
    const takenAt = taken.toISOString()
    setBusyKey(key)
    try {
      // 重新打卡不能先留下空佇列：先持久化意圖，兩頁都顯示已服用待同步，才交給殼層補送。
      const recheck = await pendingDoses.prepareRecheck(plan, doseNumber, takenAt)
      if (!requestIsCurrent()) return
      if (recheck === 'blocked' || recheck === 'storage-error') {
        setErrorMessage(recheck === 'blocked' ? PENDING_RECHECK_WAIT_TEXT : PENDING_RECHECK_STORAGE_TEXT)
        return
      }
      if (recheck === 'queued') {
        if (completesRequiredMedicationSlot(slotPlans, displayLogs, plan.id, doseNumber)) setCompletedSlotPrompt(plan.schedule_slot)
        setErrorMessage(null)
        return
      }
      const saved = await saveMedicationDose(plan, today, doseNumber, userEmail, takenAt)
      // 只在這次勾選剛好完成整個時段時提示；重讀資料或切換對象不能反覆跳窗打擾照護者。
      if (requestIsCurrent()) {
        if (completesRequiredMedicationSlot(slotPlans, displayLogs, plan.id, doseNumber)) setCompletedSlotPrompt(plan.schedule_slot)
        setLogs(current => upsertMedicationDayLogs(current, [saved]))
        // 只有條件藥開啟背景讀取；讓較早的請求失效，不能覆蓋剛成功的線上紀錄。
        if (plans.some(value => value.holdContext)) setPlanRefreshVersion(value => value + 1)
      }
      if (requestIsCurrent()) setErrorMessage(null)
    } catch (error) {
      console.error('[medication dose sync error]', error)
      // 斷線或暫時性伺服器錯誤：先存在這支手機、恢復連線後自動補送（issue #822），看護不必記得回來重按。
      // 權限與資料錯誤重送也不會成功，照舊顯示錯誤；本機也存不下來時同樣顯示錯誤，不能假裝已記錄。
      if (isRetryableWriteError(error) && pendingDoses.queueDose(plan, doseNumber, takenAt)) {
        if (requestIsCurrent()) {
          if (completesRequiredMedicationSlot(slotPlans, displayLogs, plan.id, doseNumber)) setCompletedSlotPrompt(plan.schedule_slot)
          setErrorMessage(null)
        }
        return
      }
      if (requestIsCurrent()) setErrorMessage(syncErrorMessage(error))
    } finally {
      setBusyKey(current => current === key ? '' : current)
    }
  }

  // 確認視窗針對的是「正在補送」的那一劑時先停用確認：送出結果回來前，撤回本機那筆不代表伺服器沒收到。
  const cancellationBusy = Boolean(busyKey)
    || (pendingMedicationCancellation !== null && (pendingDoses.syncingDoseKey === `${pendingMedicationCancellation.plan.id}:${pendingMedicationCancellation.doseNumber}`
      || pendingDoses.refreshingDoseKeys.has(`${pendingMedicationCancellation.plan.id}:${pendingMedicationCancellation.doseNumber}`)))

  const cancellationTargetGone = pendingMedicationCancellation !== null
    && isPendingMedicationLog(pendingMedicationCancellation.existing)
    && !pendingDoses.pendingLogs.some(log => log.id === pendingMedicationCancellation.existing.id)
  useEffect(() => {
    // 確認視窗開著時那一劑補送完成（或對帳時被伺服器那筆取代），視窗裡的時間已經不是畫面上那筆；
    // 直接關掉讓看護看到更新後的藥卡，要取消再點一次，不拿舊視窗去刪伺服器上的紀錄。
    if (cancellationTargetGone) setPendingMedicationCancellation(null)
  }, [cancellationTargetGone])

  const confirmMedicationCancellation = () => {
    const pending = pendingMedicationCancellation
    if (!pending || cancellationBusy) return
    setPendingMedicationCancellation(null)
    void clearDose(pending.plan, pending.doseNumber, pending.existing)
  }

  return (
    <section className="min-h-full bg-slate-50 px-4 pb-8 pt-4 text-slate-950 sm:px-5">
      <header className="mb-5 space-y-4">
        {!embedded && <>
          <TabHeader title="medication" />
          <SubjectSwitcher
            patientId={selectedPatientId}
            patients={availablePatients}
            onSelect={onSubjectSelect}
          />
        </>}
        {/* 四個分頁一律可見：服藥打卡與每週藥單是唯讀查詢，被照顧者本人也看得到；
            排藥（原「調整藥單」）與變更藥物則只給有管理權的照護者，由 MedicationViewTabs 自行過濾。 */}
        <MedicationViewTabs activeView={medicationView} onSelect={selectMedicationView} canManage={manageablePatients.length > 0} />
      </header>

      {manageablePatients.length > 0 && medicationView === 'manage' && <div id="medication-view-manage-panel" role="tabpanel" aria-labelledby="medication-view-manage-tab" className="space-y-4">
        {canManageSelectedPatient
          // 繁體中文註解：移除原本重複的實驗性「拍藥袋辨識」區塊（MedicationPhotoOcrSection），
          // 因 MedicationAdminSection 內部已整合更完整、能產生結構化草稿的「AI 藥袋辨識」（MedicationAiDraftSection），
          // 避免照護者在同一個排藥分頁看到兩個功能重疊的辨識入口。
          ? <MedicationAdminSection
              key={selectedPatientId}
              patientId={selectedPatientId}
              patientDisplayName={manageablePatients.find(patient => patient.patientId === selectedPatientId)?.displayName ?? ''}
              isOwnPatient={selectedPatientId === ownPatientId}
              nameEnglishFirst={nameEnglishFirst}
              onMedicationPlanChanged={() => setPlanRefreshVersion(version => version + 1)}
            />
          // 這是「沒有授權」的系統提示，不是功能區塊，所以保留 sky（info）；sky 在服藥目錄只允許出現在這類訊息。
          : <section className="rounded-3xl border border-sky-200 bg-sky-50 p-5 shadow-sm" role="status">
            {/* 未授權時提示文字英文修正 */}
            <h2 className="text-lg font-black text-sky-950">{text({ id: 'Pilih orang yang dapat Anda atur', zh: '請選擇您有權排藥的對象' ,en: "Please select a care recipient you are authorized to manage" })}</h2>
            <p className="mt-2 text-sm font-medium leading-6 text-sky-900">{text({ id: 'Pengaturan obat hanya tersedia untuk penerima perawatan yang diizinkan.', zh: '藥單管理只會對您被授權的照護對象開放。' ,en: 'Medication settings are available only for care recipients you are authorized to manage.' })}</p>
          </section>}
      </div>}

      {medicationView === 'week' && <MedicationWeekView
        loading={loading}
        errorMessage={errorMessage}
        groups={groups}
        prnPlans={plans.filter(plan => plan.as_needed)}
        locale={locale}
        nameEnglishFirst={nameEnglishFirst}
        onSelectPlan={setDetailPlan}
      />}

      {medicationView === 'today' && <div id="medication-view-today-panel" role="tabpanel" aria-labelledby="medication-view-today-tab" className="space-y-4">
        {/* 設計系統 #1146：進度卡是這一頁的「主要區塊」，用 brand-50／brand-200（只用一層），取代原本的 sky 主色。
            已服用／尚未服用的辨識不在這裡——那由下方時段卡的 emerald（已服用）與 amber（尚未服用）承擔，這裡沒動。 */}
        <section className="rounded-3xl border border-brand-200 bg-brand-50 p-5 shadow-sm" aria-labelledby="medication-progress-title">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-emerald-800">{text({ id: 'Hari perawatan', zh: '照護日' ,en: 'Care Day' })}</p>
              <h2 id="medication-progress-title" className="mt-1 text-xl font-black text-emerald-950">{text({ id: 'Kemajuan minum obat', zh: '服藥進度' ,en: 'Medication Progress' })}</h2>
            </div>
            <time className="shrink-0 rounded-full bg-white px-3 py-1 text-sm font-bold tabular-nums text-emerald-900">{today}</time>
          </div>
          <p role="status" className="mt-4 text-2xl font-black tabular-nums text-emerald-950">
            {requiredTotal > 0
              ? text({ id: `${requiredTaken} / ${requiredTotal} dosis sudah diminum`, zh: `${requiredTaken} / ${requiredTotal} 次已服用` ,en: `${requiredTaken} / ${requiredTotal} doses taken` })
              : text({ id: 'Belum ada obat rutin hari ini', zh: '今天沒有固定服藥項目（請另看 PRN）' ,en: 'There are no fixed dosing items today (see also PRN)' })}
          </p>
          {/* 跟每個時段標題同一套「次數＋顆數」規則：全天總次數不等於總顆數，同一次服藥可能不只一顆。 */}
          {requiredTotal > 0 && <p className="mt-1 text-sm font-bold tabular-nums text-emerald-800">
            {text({ id: `Total ${requiredQuantity.id}`, zh: `共 ${requiredQuantity.zh}` ,en: `Total ${requiredQuantity.en}` })}
          </p>}
          {heldDoses.length > 0 && <p className="mt-2 font-bold">{text({ zh: `依醫囑暫停 ${heldDoses.length} 劑（不計為已服用）`, id: `${heldDoses.length} dosis ditunda sesuai instruksi (bukan sudah diminum)`, en: `${heldDoses.length} doses held as prescribed (not taken)` })}</p>}
          {requiredTotal > 0 && <div className="mt-3 h-2 overflow-hidden rounded-full bg-white" aria-hidden="true">
            <div className="h-full rounded-full bg-brand-700" style={{ width: `${Math.min(100, (requiredTaken / requiredTotal) * 100)}%` }} />
          </div>}
          <p className="mt-2 text-sm font-medium text-emerald-900">{requiredTotal > 0
            ? text({ id: 'Ketuk kartu obat untuk mencatat obat yang sudah diminum.', zh: '點擊藥品卡片，記錄已服用的藥物。' ,en: 'Tap a medication card to record a dose as taken.' })
            : text({ id: 'Periksa daftar obat bila resep baru belum ditambahkan.', zh: '如果剛有新醫囑，請到「排藥」查看。' ,en: 'If new prescriptions were issued, check "Manage Schedule".' })}</p>
        </section>

        {/* 待同步狀態列跟血壓共用同一個元件；放在讀取／錯誤判斷之外，離線開 App 讀不到藥單時也看得到還有幾劑沒送出。 */}
        <PendingSyncStatus
          count={pendingDoses.pendingCount}
          syncing={pendingDoses.syncing}
          lastAttemptAt={pendingDoses.lastAttemptAt}
          syncError={pendingDoses.syncError}
          onRetry={() => void pendingDoses.retryNow()}
        >
          {pendingDoses.supersededCount > 0 && <MedicationSupersededNotice count={pendingDoses.supersededCount} controlledCorrectionCount={pendingDoses.controlledCorrectionCount} onDismiss={pendingDoses.dismissSuperseded} />}
        </PendingSyncStatus>

        {loading && <p className="py-12 text-center text-base text-slate-500">{text(common.loading)}</p>}
        {/* 錯誤保留雙語值，切換語言時只重畫文字，不能因此重抓已讀取的藥單。 */}
        {/* 本機標記清理失敗與伺服器讀取分開；重讀成功不能抹掉仍需要重試的清理警示。 */}
        {pendingDoses.cleanupError && <p role="alert" className="rounded-xl bg-red-50 p-3 text-base font-semibold text-red-700">{text(PENDING_CLEANUP_ERROR_TEXT)}</p>}
        {errorMessage && <p role="alert" className="rounded-xl bg-red-50 p-3 text-base font-semibold text-red-700">{text(errorMessage)}</p>}

        <MedicationCancelDoseDialog
          pending={pendingMedicationCancellation}
          busy={cancellationBusy}
          restoreFocus={restoreCancellationTriggerFocus}
          triggerRef={cancellationTriggerRef}
          setRestoreFocus={setRestoreCancellationTriggerFocus}
          onDismiss={() => setPendingMedicationCancellation(null)}
          onConfirm={confirmMedicationCancellation}
        />

        <MedicationCompletionDialog
          slot={completedSlotPrompt}
          slotsExpandedByDefault={slotsExpandedByDefault}
          onDismiss={() => setCompletedSlotPrompt(null)}
        />

        {!loading && !errorMessage && groups.length === 0 && !hasPrnPlans && <section className="rounded-3xl border border-dashed border-slate-300 bg-white p-6 text-center shadow-sm">
          <div aria-hidden="true" className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-2xl font-black text-slate-500">—</div>
          {/* 空狀態與排藥按鈕英文翻譯修正 */}
          <h2 className="mt-4 text-lg font-black text-slate-900">{text({ id: 'Belum ada jadwal obat', zh: '目前沒有服藥時段' ,en: 'No medication schedule' })}</h2>
          <p className="mt-2 text-sm font-medium leading-6 text-slate-600">{text({ id: 'Daftar obat aktif untuk orang ini masih kosong.', zh: '這位照護對象目前沒有現役藥單。' ,en: 'The active medication list for this individual is currently empty.' })}</p>
          {canManageSelectedPatient && <button type="button" onClick={() => selectMedicationView('manage')} className="mt-5 min-h-12 rounded-2xl bg-brand-700 px-5 text-base font-black text-white shadow-sm transition-colors hover:bg-emerald-800 active:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2">
            {text({ id: 'Buka pengaturan obat', zh: '前往排藥' ,en: "Go to Manage Schedule" })}
          </button>}
        </section>}

        {/* 固定用藥是今天最需要完成的照護動作，先呈現第一個時段；PRN 仍完整保留在固定藥單之後，避免首屏先被次要區塊佔滿。 */}
        <div className="space-y-4">
        {groups.map(([slot, slotPlans]) => (
          <MedicationSlotCard
            key={slot}
            slot={slot}
            careDate={today}
            slotPlans={slotPlans}
            progress={slotProgress.get(slot) ?? { doseTaken: 0, doseTotal: 0, quantity: { id: '', zh: '' ,en: "" } }}
            collapsed={collapsedSlots.has(slot)}
            completed={completedSlots.has(slot)}
            busyKey={busyKey}
            syncingDoseKey={pendingDoses.syncingDoseKey}
            refreshingDoseKeys={pendingDoses.refreshingDoseKeys}
            logs={displayLogs}
            locale={locale}
            nameEnglishFirst={nameEnglishFirst}
            onToggleCollapse={() => setCollapsedSlots(current => {
              const next = new Set(current)
              if (next.has(slot)) next.delete(slot)
              else next.add(slot)
              return next
            })}
            onHoldRefresh={() => setPlanRefreshVersion(value => value + 1)}
            onHoldChanged={(plan, doseNumber, action) => {
              // RPC 已成功先重讀事實；標記清理等鎖後執行，不能把已保存的事實說成未保存。
              setPlanRefreshVersion(value => value + 1)
              if (action !== 'correction' && action !== 'taken') return
              const requestView = { patientId: selectedPatientId, date: today }
              const requestOwner = userEmail
              void pendingDoses.discardWithdrawal(plan.id, doseNumber, today).catch(() => false).then(cleared => {
                if (activeMedicationOwnerRef.current !== requestOwner || !isCurrentMedicationView(activeMedicationViewRef.current, requestView)) return
                if (cleared) setPlanRefreshVersion(value => value + 1)
              })
            }}
            onToggleDose={(plan, doseNumber, existing, trigger) => { void toggleDose(plan, doseNumber, existing, trigger) }}
          />
        ))}
        </div>

        {!loading && !errorMessage && <PrnMedicationSection
          plans={plans.filter(plan => plan.patient_id === selectedPatientId && plan.as_needed)}
          events={prnEvents}
          assessments={prnAssessments}
          careDate={today}
          onRecord={recordPrn}
          onVoid={voidPrn}
          onAssessEffect={assessPrnEffect}
          onAssess={assessPrn}
        />}

        {/* 「變更紀錄」記的是藥單被改過什麼；這裡回答的是「這禮拜到底吃了幾次」，兩者互補。 */}
        <MedicationHoldFacts key={selectedPatientId} patientId={selectedPatientId} onChanged={confirmedLogs => { pendingDoses.reconcileWithServer(confirmedLogs, selectedPatientId); setPlanRefreshVersion(value => value + 1) }} />
        <ModuleTrendSection moduleId="medication" titleId="medication-module-trend-title">
          {days => <MedicationDoseHistoryPanel patientId={selectedPatientId} days={days} />}
        </ModuleTrendSection>
      </div>}

      <MedicationDetailDialog plan={detailPlan?.patient_id === selectedPatientId ? detailPlan : null} locale={locale} nameEnglishFirst={nameEnglishFirst} onClose={() => setDetailPlan(null)} />
    </section>
  )
}
