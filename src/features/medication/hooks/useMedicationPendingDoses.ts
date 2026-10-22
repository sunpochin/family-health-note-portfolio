/*
檔案用途：把 App 殼層常駐的服藥佇列狀態收斂成目前病人／照護日的畫面資料與打卡操作（issue #1228）。
所在層：src/features/medication/hooks；MedicationPage 專用 adapter，不負責註冊全域補送觸發器。
主要關聯：MedicationQueueProvider、useMedicationQueueCoordinator、lib/medication/medicationPendingQueue、MedicationPage。
*/
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { normalizePendingOwner } from '../../../lib/pendingWriteQueue'
import {
  buildPendingMedicationDose,
  enqueuePendingMedicationDose,
  medicationDoseKey,
  pendingMedicationDoseToLog,
  readPendingMedicationDoses,
  reconcilePendingMedicationDoses,
  removePendingMedicationDose,
  withdrawPendingMedicationDose,
  withMedicationQueueLock,
  type PendingMedicationDose,
} from '../../../lib/medication/medicationPendingQueue'
import type { MedicationPlanView } from '../../../lib/medication/medications'
import type { MedicationIntakeLog } from '../../../types/database'
import type { MedicationSyncResult } from './useMedicationQueueCoordinator'
import { useMedicationQueue } from './MedicationQueueProvider'

export type { MedicationSyncResult } from './useMedicationQueueCoordinator'

/**
 * withdrawn：畫面上已撤回；佇列裡改成撤回標記，連線後刪掉自己那次打卡可能已寫入伺服器的那筆。
 * not-pending：這劑已不在佇列，呼叫端不能拿這次確認去刪伺服器上的紀錄。
 * syncing：這劑正在送出，結果回來前無法確定伺服器是否收到，先不能撤回。
 * storage-error：本機儲存寫不進去，必須告訴看護；不要假裝已撤回。
 */
export type PendingDoseCancelOutcome = 'withdrawn' | 'not-pending' | 'syncing' | 'storage-error'

/** 舊撤回尚在時必須先持久化新事實；blocked／storage-error 不能假裝已重新記錄。 */
export type PendingDoseRecheckOutcome = 'no-withdrawal' | 'queued' | 'blocked' | 'storage-error'

export function useMedicationPendingDoses({
  patientId,
  userEmail,
  careDate,
  onSynced,
  onExternalQueueChange,
}: {
  patientId: string
  userEmail: string
  /** 目前畫面上的照護日；只有這一天的待同步劑次會變成藥卡上的「已服用・待同步」。 */
  careDate: string
  /** 補送成功時只套用目前病人／照護日；切換後才回來的結果不能混進新畫面。 */
  onSynced: (result: MedicationSyncResult) => void
  /** 其他分頁改動本機佇列時重讀伺服器，避免把「已移出佇列」誤當成一定由本機送達。 */
  onExternalQueueChange: () => void
}) {
  const {
    enabled: queueEnabled,
    owner: queueOwner,
    records: queueRecords,
    confirmedIntakes,
    syncingPatientId,
    syncingDose,
    lastAttemptAtByPatient,
    syncErrorByPatient,
    cleanupErrorByPatient,
    supersededCountByPatient,
    controlledCorrectionCountByPatient,
    refresh,
    retryNow,
    confirmWithdrawal,
    confirmFullDayRead,
    isDoseSyncing,
    setScreen,
    addSuperseded,
    dismissSuperseded: dismissQueueSuperseded,
  } = useMedicationQueue()
  const owner = normalizePendingOwner(userEmail)
  const enabled = queueEnabled && queueOwner === owner
  const screenCallbacksRef = useRef({ onSynced, onExternalQueueChange })
  screenCallbacksRef.current = { onSynced, onExternalQueueChange }
  const [awaitingServerDoses, setAwaitingServerDoses] = useState<PendingMedicationDose[]>([])
  const activeRef = useRef(true)
  const scope = `${enabled}:${owner}:${patientId}:${careDate}`
  const scopeRef = useRef(scope)
  const scopeGenerationRef = useRef(0)
  if (scopeRef.current !== scope) { scopeRef.current = scope; scopeGenerationRef.current += 1 }
  useEffect(() => {
    activeRef.current = true
    return () => { activeRef.current = false; scopeGenerationRef.current += 1 }
  }, [])
  useEffect(() => { setAwaitingServerDoses([]) }, [owner, patientId, careDate])
  const currentQueuedDoses = useMemo(
    // 帳號切換時 state effect 尚未清掉舊快照；畫面同步檢查 owner，避免同一病人由另一帳號排入的紀錄短暫露出。
    () => enabled ? queueRecords.filter(dose => dose.patient_id === patientId && dose.recorded_by === owner) : [],
    [enabled, owner, patientId, queueRecords],
  )

  const currentDoses = useMemo(() => {
    // 別頁已移出佇列不代表本頁已讀到伺服器；重讀失敗時仍保留已知服藥／撤回狀態。
    const retained = enabled ? awaitingServerDoses.filter(dose => dose.recorded_by === owner
      && dose.patient_id === patientId && dose.care_date === careDate) : []
    return [...currentQueuedDoses, ...retained.filter(dose => !currentQueuedDoses.some(current => current.id === dose.id))]
  }, [awaitingServerDoses, careDate, currentQueuedDoses, enabled, owner, patientId])

  useEffect(() => {
    if (!enabled) return
    // 畫面 callback 每次 render 都會換 identity；ref 保持註冊穩定，避免同步剛好回來時短暫沒有接手者。
    setScreen({
      patientId,
      owner,
      onSynced: result => {
        // 已拿到逐筆 authoritative 回應時也能交棒，不必再等完整日讀取。
        const confirmed = new Set([...result.withdrawn.map(dose => dose.id), ...result.recorded.flatMap(log => log.plan_id === null ? [] : [
          medicationDoseKey(log.patient_id, log.plan_id, log.care_date ?? log.taken_on, log.dose_number)])])
        setAwaitingServerDoses(previous => previous.filter(dose => !confirmed.has(dose.id)))
        screenCallbacksRef.current.onSynced(result)
      },
      onExternalQueueChange: drained => {
        setAwaitingServerDoses(previous => [...previous.filter(dose => !drained.some(item => item.id === dose.id)), ...drained])
        screenCallbacksRef.current.onExternalQueueChange()
      },
    })
    return () => setScreen(null)
  }, [enabled, owner, patientId, setScreen])

  const currentConfirmedIntakes = useMemo(() => enabled ? confirmedIntakes.filter(log => log.patient_id === patientId
    && normalizePendingOwner(log.account_email) === owner && (log.care_date ?? log.taken_on) === careDate) : [],
  [careDate, confirmedIntakes, enabled, owner, patientId])
  const pendingLogs = useMemo(
    () => [...currentDoses.filter(dose => dose.care_date === careDate && !dose.withdrawn).map(pendingMedicationDoseToLog), ...currentConfirmedIntakes],
    [currentDoses, careDate, currentConfirmedIntakes],
  )
  // 確定的受控事實不能被清理失敗的舊標記藏掉；是否更新 holdContext 不應改變已服用判斷。
  const withdrawnDoses = useMemo(
    () => currentDoses.filter(dose => dose.care_date === careDate && dose.withdrawn
      && !currentConfirmedIntakes.some(log => log.plan_id === dose.plan_id && log.dose_number === dose.dose_number)),
    [currentDoses, careDate, currentConfirmedIntakes],
  )
  const refreshingDoseKeys = useMemo(() => new Set(awaitingServerDoses.filter(dose => enabled
    && dose.recorded_by === owner && dose.patient_id === patientId && dose.care_date === careDate)
    .map(dose => `${dose.plan_id}:${dose.dose_number}`)), [awaitingServerDoses, careDate, enabled, owner, patientId])
  const syncingDoseKey = useMemo(() => {
    const dose = syncingDose
    return dose?.patient_id === patientId && dose.recorded_by === owner && dose.care_date === careDate
      ? `${dose.plan_id}:${dose.dose_number}`
      : null
  }, [careDate, owner, patientId, syncingDose])

  const queueDose = useCallback((plan: MedicationPlanView, doseNumber: number, takenAt: string): boolean => {
    if (!enabled) return false
    const dose = buildPendingMedicationDose(plan, doseNumber, owner, takenAt)
    if (!enqueuePendingMedicationDose(dose)) return false
    // 本分頁不會收到自己的 storage 事件；立即刷新殼層擁有的清單，才會開始退避補送。
    refresh()
    return true
  }, [enabled, owner, refresh])

  const cancelPendingDose = useCallback((planId: string, doseNumber: number, doseCareDate: string): PendingDoseCancelOutcome => {
    const id = medicationDoseKey(patientId, planId, doseCareDate, doseNumber)
    if (isDoseSyncing(id, owner) || refreshingDoseKeys.has(`${planId}:${doseNumber}`)) return 'syncing'
    const dose = readPendingMedicationDoses(patientId, owner).find(item => item.id === id)
    if (!dose || dose.withdrawn) return 'not-pending'
    if (!withdrawPendingMedicationDose(dose)) return 'storage-error'
    refresh()
    return 'withdrawn'
  }, [owner, patientId, isDoseSyncing, refresh, refreshingDoseKeys])

  /** 重新打卡先持久化成完整待送意圖；空掉撤回後才 POST 會讓另一頁誤示可再給藥。 */
  const prepareRecheck = useCallback(async (plan: MedicationPlanView, doseNumber: number, takenAt: string): Promise<PendingDoseRecheckOutcome> => {
    if (!enabled) return 'no-withdrawal'
    const replacement = buildPendingMedicationDose(plan, doseNumber, owner, takenAt)
    if (plan.patient_id !== patientId || replacement.care_date !== careDate) return 'blocked'
    const initial = readPendingMedicationDoses(patientId, owner).find(dose => dose.id === replacement.id)
      ?? currentDoses.find(dose => dose.id === replacement.id)
    if (!initial?.withdrawn) return 'no-withdrawal'
    const generation = scopeGenerationRef.current
    const outcome = await withMedicationQueueLock<PendingDoseRecheckOutcome>(async () => {
      if (!activeRef.current || scopeGenerationRef.current !== generation) return 'blocked'
      // 直接取代同一桶中的撤回，不能先移除；就算 peer 已送完舊 DELETE，也先留下新事實再交棒。
      if (!enqueuePendingMedicationDose(replacement)) return 'storage-error'
      refresh()
      return 'queued'
    }, () => 'blocked', { allowUnlocked: false })
    // pending 原本就為 true；只有釋放鎖後主動重試，才不會沿用撤回失敗的長退避。
    if (outcome === 'queued' && activeRef.current && scopeGenerationRef.current === generation) void retryNow()
    return outcome
  }, [careDate, currentDoses, enabled, owner, patientId, refresh, retryNow])

  /** 受控 RPC 已確認事實後，交給常駐殼層等鎖並只清掉這份舊標記；切換 tab 也不能丟掉清理工作。 */
  const discardWithdrawal = useCallback(async (planId: string, doseNumber: number, doseCareDate: string): Promise<boolean> => {
    if (!enabled) return true
    const id = medicationDoseKey(patientId, planId, doseCareDate, doseNumber)
    const initial = readPendingMedicationDoses(patientId, owner).find(dose => dose.id === id)
    return initial?.withdrawn ? confirmWithdrawal(initial) : true
  }, [confirmWithdrawal, enabled, owner, patientId])

  const confirmExternalRefresh = useCallback((forPatientId: string, forCareDate: string, forOwner: string) => {
    // 只有完整照護日讀取成功才交棒；局部補記對帳或失敗不能抹掉尚未確認的投影。
    if (normalizePendingOwner(forOwner) !== owner || forPatientId !== patientId || forCareDate !== careDate) return
    // 只有此完整成功讀取能退休舊恢復證明；讀取途中收到的新事實仍由頁面的結果緩衝重放。
    confirmFullDayRead(forPatientId, forCareDate)
    setAwaitingServerDoses([])
  }, [careDate, confirmFullDayRead, owner, patientId])

  /** 伺服器已有同一劑時採 server-wins；補送中的劑次留給協調器處理，避免重複提示或移除。 */
  const reconcileWithServer = useCallback((serverLogs: MedicationIntakeLog[], forPatientId: string) => {
    if (!enabled) return
    const { resolved } = reconcilePendingMedicationDoses(readPendingMedicationDoses(forPatientId, owner), serverLogs)
    // owner 是 in-flight 鎖的一部分；只比 id 會把另一登入者正在送出的同劑次提前移除。
    const removable = resolved.filter(item => !isDoseSyncing(item.dose.id, owner))
    if (removable.length === 0) return
    for (const { dose } of removable) removePendingMedicationDose(dose)
    refresh({ confirmedRemovals: removable.map(item => item.dose) })
    if (forPatientId === patientId) {
      addSuperseded(forPatientId, removable.filter(item => item.superseded).map(item => item.dose.id))
    }
  }, [enabled, owner, patientId, addSuperseded, isDoseSyncing, refresh])

  const dismissSuperseded = useCallback(() => dismissQueueSuperseded(patientId), [patientId, dismissQueueSuperseded])

  return {
    enabled,
    pendingCount: currentQueuedDoses.length,
    pendingLogs,
    withdrawnDoses,
    syncingDoseKey,
    refreshingDoseKeys,
    syncing: syncingPatientId === patientId && syncingDose?.recorded_by === owner,
    lastAttemptAt: lastAttemptAtByPatient[patientId] ?? null,
    syncError: Boolean(syncErrorByPatient[patientId]),
    cleanupError: enabled && Boolean(cleanupErrorByPatient[patientId]),
    supersededCount: supersededCountByPatient[patientId] ?? 0,
    controlledCorrectionCount: enabled ? controlledCorrectionCountByPatient[patientId] ?? 0 : 0,
    dismissSuperseded,
    retryNow,
    queueDose,
    prepareRecheck,
    cancelPendingDose,
    discardWithdrawal,
    reconcileWithServer,
    confirmExternalRefresh,
  }
}
