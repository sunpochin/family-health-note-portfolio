/*
檔案用途：登入期間常駐的服藥離線佇列擁有者，負責跨分頁鎖、帳號佇列補送與可見服藥畫面的狀態通知（issue #1228）。
所在層：src/features/medication/hooks；由 MedicationQueueProvider 掛在 App 殼層，不依賴服藥畫面是否開啟。
主要關聯：lib/medication/medicationPendingQueue、hooks/usePendingWriteFlush、MedicationPage、MedicationQueueProvider。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePendingWriteFlush } from '../../../hooks/usePendingWriteFlush'
import { isDemoMode } from '../../../lib/demoStorage'
import { normalizePendingOwner } from '../../../lib/pendingWriteQueue'
import {
  flushAllPendingMedicationDoses,
  isPendingMedicationStorageKey,
  readAllPendingMedicationDoses,
  syncPendingMedicationDose,
  removeUnchangedPendingMedicationDose,
  withMedicationQueueLock,
  type PendingMedicationDose,
} from '../../../lib/medication/medicationPendingQueue'
import type { MedicationIntakeLog } from '../../../types/database'

export const MEDICATION_QUEUE_REQUEST_TIMEOUT_MS = 15_000
const CONTROLLED_CORRECTION_PREFIX = 'controlled-correction:'
const QUEUE_SIGNAL_CHANNEL = 'jia-jian-medication-queue-signal.v1'
const QUEUE_SIGNAL_STORAGE_PREFIX = `${QUEUE_SIGNAL_CHANNEL}:`
const NO_RECORDS: PendingMedicationDose[] = []
const EMPTY_PATIENT_STATUS = {}
let queueSignalSequence = 0

type MedicationQueueSignalPayload =
  | { patientId: string; type: 'superseded'; count: number; doseIds: string[] }
  | { patientId: string; type: 'dismissed' }
type MedicationQueueSignal = MedicationQueueSignalPayload & { owner: string }

export interface MedicationSyncResult {
  recorded: MedicationIntakeLog[]
  withdrawn: PendingMedicationDose[]
}

export interface MedicationQueueScreen {
  patientId: string
  owner: string
  onSynced: (result: MedicationSyncResult) => void
  onExternalQueueChange: (drained: PendingMedicationDose[]) => void
}

export interface MedicationQueueCoordinator {
  enabled: boolean
  owner: string
  records: readonly PendingMedicationDose[]
  confirmedIntakes: readonly MedicationIntakeLog[]
  syncingPatientId: string | null
  syncingDose: PendingMedicationDose | null
  lastAttemptAtByPatient: Readonly<Record<string, number>>
  syncErrorByPatient: Readonly<Record<string, boolean>>
  cleanupErrorByPatient: Readonly<Record<string, boolean>>
  supersededCountByPatient: Readonly<Record<string, number>>
  controlledCorrectionCountByPatient: Readonly<Record<string, number>>
  refresh: (options?: { confirmedRemovals?: readonly PendingMedicationDose[] }) => void
  retryNow: () => Promise<void>
  confirmWithdrawal: (dose: PendingMedicationDose) => Promise<boolean>
  confirmFullDayRead: (patientId: string, careDate: string) => void
  isDoseSyncing: (doseId: string, owner: string) => boolean
  setScreen: (screen: MedicationQueueScreen | null) => void
  addSuperseded: (patientId: string, doseIds: readonly string[]) => void
  dismissSuperseded: (patientId: string) => void
}

export function useMedicationQueueCoordinator({ patientId, userEmail }: {
  /** 畫面上這位只用來決定補送優先順序；每筆寫入仍使用佇列自己的 patient_id。 */
  patientId: string
  userEmail?: string
}): MedicationQueueCoordinator {
  const owner = normalizePendingOwner(userEmail ?? '')
  const enabled = Boolean(owner) && !isDemoMode()
  const ownerRef = useRef(owner)
  ownerRef.current = owner
  const drainGenerationRef = useRef(0)
  const drainOwnerRef = useRef(owner)
  const requestControllerRef = useRef<AbortController | null>(null)
  if (drainOwnerRef.current !== owner) {
    // A→B→A 也必須讓 A 的舊請求失效，否則字串相同會讓舊輪次誤以為仍可繼續。
    drainOwnerRef.current = owner
    drainGenerationRef.current += 1
  }
  const patientIdRef = useRef(patientId)
  patientIdRef.current = patientId

  // 首次 render 就讀到待送項目，讓觸發器的第一輪探測不會先以空佇列排 30 秒重試。
  const statusOwnerRef = useRef(owner)
  const [records, setRecords] = useState<PendingMedicationDose[]>(() => (
    enabled ? readAllPendingMedicationDoses(owner) : NO_RECORDS
  ))
  const recordsRef = useRef(records)
  recordsRef.current = records
  const [syncingPatientId, setSyncingPatientId] = useState<string | null>(null)
  const [syncingDose, setSyncingDose] = useState<PendingMedicationDose | null>(null)
  // 同一病人同一劑可能分屬不同登入者；舊帳號請求尚未返回時不能鎖住新帳號的撤回操作。
  const syncingDoseRef = useRef<{ id: string; owner: string } | null>(null)
  const [lastAttemptAtByPatient, setLastAttemptAtByPatient] = useState<Record<string, number>>({})
  const [syncErrorByPatient, setSyncErrorByPatient] = useState<Record<string, boolean>>({})
  const [cleanupErrorByPatient, setCleanupErrorByPatient] = useState<Record<string, boolean>>({})
  const [supersededCountByPatient, setSupersededCountByPatient] = useState<Record<string, number>>({})
  // 同一劑可能同時被另一分頁對帳與補送發現；用穩定劑次 id 合併提示，避免數量重複相加。
  const seenSupersededDoseIdsRef = useRef(new Map<string, Set<string>>())
  const controlledCorrectionDoseIdsRef = useRef(new Map<string, Set<string>>())
  // 受控 RPC 已確認的清理工作也屬於殼層；離開服藥頁後仍要完成，storage 失敗可由同一重試入口接手。
  const confirmedWithdrawalsRef = useRef(new Map<string, PendingMedicationDose>())
  // 證明已服用後 storage 仍可能失敗；事實投影不能等待舊藥單載入最新 holdContext 才顯示。
  const confirmedIntakesRef = useRef(new Map<string, { dose: PendingMedicationDose; log: MedicationIntakeLog }>())
  const screenRef = useRef<MedicationQueueScreen | null>(null)
  const channelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => () => {
    // 登出會直接卸載 App 殼層 provider；owner 字串不變時也要讓等待中的舊輪次停止。
    drainGenerationRef.current += 1
    requestControllerRef.current?.abort()
  }, [owner])

  const replaceRecords = useCallback((next: PendingMedicationDose[]) => {
    recordsRef.current = next
    setRecords(next)
  }, [])

  const refresh = useCallback((options?: { confirmedRemovals?: readonly PendingMedicationDose[] }) => {
    const before = recordsRef.current
    const after = enabled ? readAllPendingMedicationDoses(owner) : NO_RECORDS
    const screen = screenRef.current
    // online／pageshow 的刷新可能比 storage 事件先到；在共同入口交棒，才不會先抹掉服藥投影。
    if (screen?.owner === owner) {
      const drained = before.filter(record => record.recorded_by === owner
        // 本頁只確認其中一劑時，不能連另一頁剛送走的其他劑次一起略過。
        && !options?.confirmedRemovals?.some(confirmed => JSON.stringify(confirmed) === JSON.stringify(record))
        && !after.some(candidate => candidate.id === record.id && candidate.patient_id === record.patient_id))
      // peer 清理舊標記時，已證明的事實仍是「吃過」；以服藥投影交棒並等待完整日讀取，不能交回舊撤回。
      const handedOff = drained.map(record => {
        const proof = confirmedIntakesRef.current.get(record.id)
        return proof && JSON.stringify(proof.dose) === JSON.stringify(record) ? { ...record, withdrawn: false } : record
      })
      if (handedOff.some(record => record.patient_id === screen.patientId)) screen.onExternalQueueChange(handedOff)
    }
    replaceRecords(after)
  }, [enabled, owner, replaceRecords])

  const recordSuperseded = useCallback((forPatientId: string, doseIds: readonly string[]) => {
    let seen = seenSupersededDoseIdsRef.current.get(forPatientId)
    if (!seen) {
      seen = new Set<string>()
      seenSupersededDoseIdsRef.current.set(forPatientId, seen)
    }
    const freshDoseIds = [...new Set(doseIds)].filter(doseId => !seen.has(doseId))
    if (freshDoseIds.length === 0) return []
    for (const doseId of freshDoseIds) seen.add(doseId)
    // 同時發生一般衝突與受控恢復時要各自計數，不能用其中一種提示蓋掉另一種結果。
    const controlled = controlledCorrectionDoseIdsRef.current.get(forPatientId) ?? new Set<string>()
    for (const id of freshDoseIds) if (id.startsWith(CONTROLLED_CORRECTION_PREFIX)) controlled.add(id)
    if (controlled.size > 0) controlledCorrectionDoseIdsRef.current.set(forPatientId, controlled)
    setSupersededCountByPatient(previous => ({ ...previous, [forPatientId]: (previous[forPatientId] ?? 0) + freshDoseIds.length }))
    return freshDoseIds
  }, [])

  const applyQueueSignal = useCallback((value: unknown) => {
    if (typeof value !== 'object' || value === null) return
    const signal = value as Record<string, unknown>
    const forPatientId = signal.patientId
    const doseIds = signal.doseIds
    const count = signal.count
    if (signal.owner !== owner || typeof forPatientId !== 'string' || forPatientId.length === 0) return
    if (signal.type === 'superseded') {
      if (Array.isArray(doseIds) && doseIds.every(doseId => typeof doseId === 'string' && doseId.length > 0)) {
        recordSuperseded(forPatientId, doseIds as string[])
      } else if (typeof count === 'number' && Number.isSafeInteger(count) && count > 0) {
        // 舊版分頁只會傳數量；保留讀取能力，避免更新期間前景分頁完全漏掉提示。
        setSupersededCountByPatient(previous => ({ ...previous, [forPatientId]: (previous[forPatientId] ?? 0) + count }))
      }
    } else if (signal.type === 'dismissed') {
      controlledCorrectionDoseIdsRef.current.delete(forPatientId)
      setSupersededCountByPatient(previous => {
        if (!(forPatientId in previous)) return previous
        const next = { ...previous }
        delete next[forPatientId]
        return next
      })
    }
  }, [owner, recordSuperseded])

  const publishQueueSignal = useCallback((signal: MedicationQueueSignalPayload) => {
    const message: MedicationQueueSignal = { ...signal, owner }
    try {
      if (channelRef.current) {
        channelRef.current.postMessage(message)
        return
      }
    } catch {
      // BroadcastChannel 可能在受限 WebView 中無法送出，下面的短暫 storage 訊號作為降級路徑。
    }
    try {
      const uniqueId = globalThis.crypto?.randomUUID?.()
        ?? `${Date.now()}-${queueSignalSequence++}-${Math.random().toString(36).slice(2)}`
      const key = `${QUEUE_SIGNAL_STORAGE_PREFIX}${uniqueId}`
      const value = JSON.stringify(message)
      localStorage.setItem(key, value)
      setTimeout(() => {
        try {
          // 只清掉自己的訊號，避免延遲清理覆蓋另一個分頁剛寫入的訊息。
          if (localStorage.getItem(key) === value) localStorage.removeItem(key)
        } catch {
          // 訊號已是最佳努力提示；儲存被停用時仍保留本分頁的狀態。
        }
      }, 0)
    } catch {
      console.warn('[medication queue signal unavailable]')
    }
  }, [owner])

  useEffect(() => {
    refresh()
    // 換帳號或進入 demo 時不沿用上一個帳號的畫面狀態，避免舊同步錯誤或提示殘留。
    setSyncErrorByPatient({})
    setCleanupErrorByPatient({})
    setSupersededCountByPatient({})
    seenSupersededDoseIdsRef.current = new Map()
    controlledCorrectionDoseIdsRef.current.clear()
    confirmedWithdrawalsRef.current.clear()
    confirmedIntakesRef.current.clear()
    setLastAttemptAtByPatient({})
    statusOwnerRef.current = owner
  }, [owner, refresh])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    let channel: BroadcastChannel | null = null
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel(QUEUE_SIGNAL_CHANNEL)
        channel.onmessage = event => applyQueueSignal(event.data)
        channelRef.current = channel
      }
    } catch {
      channel = null
      channelRef.current = null
    }
    const handleStorageSignal = (event: StorageEvent) => {
      if (!event.key?.startsWith(QUEUE_SIGNAL_STORAGE_PREFIX) || !event.newValue) return
      try {
        applyQueueSignal(JSON.parse(event.newValue) as unknown)
      } catch {
        // 忽略無法解析的跨分頁提示；佇列資料本身仍由原有 storage 事件流程處理。
      }
    }
    window.addEventListener('storage', handleStorageSignal)
    return () => {
      window.removeEventListener('storage', handleStorageSignal)
      if (channel) {
        channel.onmessage = null
        channel.close()
        if (channelRef.current === channel) channelRef.current = null
      }
    }
  }, [enabled, owner, applyQueueSignal])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const handleStorage = (event: StorageEvent) => {
      // 衝突提示只攜帶病人範圍與數量；分開處理，避免把它誤認成佇列被清空而多讀一次健康紀錄。
      if (event.key?.startsWith(QUEUE_SIGNAL_STORAGE_PREFIX)) return
      if (event.key !== null && !isPendingMedicationStorageKey(event.key)) return
      refresh()
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [enabled, refresh])

  const setScreen = useCallback((screen: MedicationQueueScreen | null) => {
    screenRef.current = screen
  }, [])

  const addSuperseded = useCallback((forPatientId: string, doseIds: readonly string[]) => {
    const freshDoseIds = recordSuperseded(forPatientId, doseIds)
    if (freshDoseIds.length === 0) return
    // count 讓更新中的舊分頁仍看得懂；新版優先用 doseIds 做跨分頁去重。
    publishQueueSignal({ type: 'superseded', patientId: forPatientId, count: freshDoseIds.length, doseIds: freshDoseIds })
  }, [publishQueueSignal, recordSuperseded])
  const dismissSuperseded = useCallback((forPatientId: string) => {
    controlledCorrectionDoseIdsRef.current.delete(forPatientId)
    setSupersededCountByPatient(previous => {
      if (!(forPatientId in previous)) return previous
      const next = { ...previous }
      delete next[forPatientId]
      return next
    })
    publishQueueSignal({ type: 'dismissed', patientId: forPatientId })
  }, [publishQueueSignal])

  const confirmFullDayRead = useCallback((forPatientId: string, forCareDate: string) => {
    if (!enabled || ownerRef.current !== owner) return
    let retired = false
    for (const [id, proof] of confirmedIntakesRef.current) if (proof.dose.patient_id === forPatientId && proof.dose.care_date === forCareDate) {
      // 後來完整成功的日讀取可能已看到別裝置的受控更正；只留本機清理工作，不能重播舊事實。
      confirmedIntakesRef.current.delete(id)
      retired = true
    }
    if (retired) replaceRecords([...recordsRef.current])
  }, [enabled, owner, replaceRecords])

  const confirmWithdrawal = useCallback(async (dose: PendingMedicationDose): Promise<boolean> => {
    const generation = drainGenerationRef.current
    const isCurrent = () => enabled && ownerRef.current === owner && drainGenerationRef.current === generation
    if (!isCurrent() || dose.recorded_by !== owner) return false
    if (!dose.withdrawn) return true
    confirmedWithdrawalsRef.current.set(dose.id, dose)
    return withMedicationQueueLock(async () => {
      if (!isCurrent()) return false
      const removal = removeUnchangedPendingMedicationDose(dose)
      if (removal === 'storage-error') {
        setCleanupErrorByPatient(previous => ({ ...previous, [dose.patient_id]: true }))
        return false
      }
      if (confirmedWithdrawalsRef.current.get(dose.id) === dose) confirmedWithdrawalsRef.current.delete(dose.id)
      const proof = confirmedIntakesRef.current.get(dose.id)
      if (proof && JSON.stringify(proof.dose) === JSON.stringify(dose)) {
        // 畫面可能在 storage 故障期間才重掛；清掉殼層投影前先交棒，讀取失敗也不能忘掉已知事實。
        const screen = screenRef.current
        if (removal === 'removed' && screen?.owner === owner && screen.patientId === dose.patient_id) screen.onSynced({ recorded: [proof.log], withdrawn: [] })
        // 標記已被 peer 改掉時走原本的重讀交棒；不能把舊證明當成此刻剛確認的事實。
        if (removal === 'unchanged') refresh()
        confirmedIntakesRef.current.delete(dose.id)
      }
      refresh(removal === 'removed' ? { confirmedRemovals: [dose] } : undefined)
      if (![...confirmedWithdrawalsRef.current.values()].some(record => record.patient_id === dose.patient_id)) setCleanupErrorByPatient(previous => {
        const next = { ...previous }; delete next[dose.patient_id]; return next
      })
      // 已確認且沒有其他待送項目時，舊 DELETE 的拒絕不該繼續顯示成同步失敗。
      if (!recordsRef.current.some(record => record.patient_id === dose.patient_id)) setSyncErrorByPatient(previous => {
        const next = { ...previous }; delete next[dose.patient_id]; return next
      })
      return true
    }, () => false, { wait: true }).catch(() => {
      if (isCurrent()) setCleanupErrorByPatient(previous => ({ ...previous, [dose.patient_id]: true }))
      return false
    })
  }, [enabled, owner, refresh])

  const performSync = useCallback(async (): Promise<boolean> => {
    const generation = drainGenerationRef.current
    const isCurrentDrain = () => ownerRef.current === owner && drainGenerationRef.current === generation
    if (!enabled || !isCurrentDrain()) return true
    for (const dose of [...confirmedWithdrawalsRef.current.values()]) {
      const cleared = await confirmWithdrawal(dose)
      if (!isCurrentDrain()) return true
      // 本機仍寫不進去時不能再對同一已確認事實送 DELETE，否則又製造誤導的永久拒絕。
      if (!cleared) return false
    }
    refresh()
    const queued = readAllPendingMedicationDoses(owner)
    if (queued.length === 0) return true
    // navigator.onLine 只用來避免離線時空打；伺服器寫入結果仍由 Supabase 確認。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return false

    try {
      const result = await withMedicationQueueLock(async () => {
        // 等鎖期間可能登出、卸載 provider 或換帳號；舊輪次不能再使用後來的 Supabase session。
        if (!isCurrentDrain()) return true
        const failedThisRound = new Set<string>()
        const flushed = await flushAllPendingMedicationDoses({
          recordedBy: owner,
          // 請求等待期間可能登出或換帳號；世代檢查讓舊佇列不會由新 session 接著送出。
          shouldContinue: isCurrentDrain,
          // 所有已排入佇列的病人都要送；目前畫面只影響先後，不會替別人的值套用目前病人的設定。
          firstPatientId: patientIdRef.current || undefined,
          save: async dose => {
            syncingDoseRef.current = { id: dose.id, owner: dose.recorded_by }
            setSyncingDose(dose)
            setSyncingPatientId(dose.patient_id)
            setLastAttemptAtByPatient(previous => ({ ...previous, [dose.patient_id]: Date.now() }))
            const controller = new AbortController()
            requestControllerRef.current = controller
            // 無限等待會讓其他帳號一直拿不到 Web Lock；逾時保留原劑次，之後靠唯一鍵安全對帳重試。
            const timeout = setTimeout(() => controller.abort(), MEDICATION_QUEUE_REQUEST_TIMEOUT_MS)
            try {
              return await syncPendingMedicationDose(dose, controller.signal)
            } catch (error) {
              if (isCurrentDrain()) {
                // 永久拒絕後仍會送下一位；她的請求若停住，這一位也必須立刻看見失敗結果。
                failedThisRound.add(dose.patient_id)
                setSyncErrorByPatient(previous => ({ ...previous, [dose.patient_id]: true }))
              }
              throw error
            } finally {
              clearTimeout(timeout)
              if (requestControllerRef.current === controller) requestControllerRef.current = null
              syncingDoseRef.current = null
              setSyncingDose(null)
              setSyncingPatientId(null)
            }
          },
          onSynced: (dose, outcome) => {
            if (!isCurrentDrain()) return
            // 每筆已由伺服器確認後立刻同步外殼與目前畫面，不能等其他病人的網路請求全部結束。
            refresh({ confirmedRemovals: [dose] })
            if (!failedThisRound.has(dose.patient_id)) {
              setSyncErrorByPatient(previous => {
                const next = { ...previous }
                delete next[dose.patient_id]
                return next
              })
            }
            if (outcome.kind === 'recorded' && outcome.requiresControlledCorrection) {
              addSuperseded(dose.patient_id, [`${CONTROLLED_CORRECTION_PREFIX}${dose.id}`])
              if (recordsRef.current.some(record => JSON.stringify(record) === JSON.stringify(dose))) {
                // 已從伺服器恢復清理證明，但本機移除仍失敗；殼層下次先清理，不再重送 DELETE。
                confirmedWithdrawalsRef.current.set(dose.id, dose)
                confirmedIntakesRef.current.set(dose.id, { dose, log: outcome.log })
                setCleanupErrorByPatient(previous => ({ ...previous, [dose.patient_id]: true }))
              }
            }
            if (outcome.kind === 'recorded' && outcome.superseded) addSuperseded(dose.patient_id, [dose.id])
            const screen = screenRef.current
            if (screen && screen.owner === owner && screen.patientId === dose.patient_id) {
              screen.onSynced(outcome.kind === 'withdrawn'
                ? { recorded: [], withdrawn: [outcome.dose] }
                : { recorded: [outcome.log], withdrawn: [] })
            }
          },
        })

        if (!isCurrentDrain()) return true

        const failedPatients = new Set(flushed.failures.map(failure => failure.record.patient_id))
        const syncedPatients = new Set(flushed.synced.map(dose => dose.patient_id))
        setSyncErrorByPatient(previous => {
          const next = { ...previous }
          for (const id of syncedPatients) if (!failedPatients.has(id)) delete next[id]
          for (const id of failedPatients) next[id] = true
          return next
        })
        // 自己這輪完成時也可能讀到另一頁對帳造成的移除；只略過本輪真的確認的快照。
        refresh({ confirmedRemovals: flushed.synced })
        return recordsRef.current.length === 0
      }, () => null)
      // 另一分頁持有鎖時讓它完成；回傳未清空讓共用觸發器保留退避重試。
      return result === null ? false : result
    } catch {
      // 錯誤細節可能含伺服器回應內容；同步提示由畫面呈現，console 不輸出健康資料或原始回應。
      console.error('[medication pending sync error]')
      const activePatientId = patientIdRef.current
      if (isCurrentDrain() && activePatientId) setSyncErrorByPatient(previous => ({ ...previous, [activePatientId]: true }))
      return false
    }
  }, [enabled, owner, refresh, addSuperseded, confirmWithdrawal])

  const { syncing, retryNow } = usePendingWriteFlush({
    enabled,
    hasPending: records.length > 0,
    sync: performSync,
    // 切換畫面病人時重探測並優先處理該病人，但不改變帳號佇列的完整範圍。
    resetKey: `${owner}:${patientId}`,
  })

  const isDoseSyncing = useCallback((doseId: string, doseOwner: string) => (
    syncingDoseRef.current?.id === doseId && syncingDoseRef.current.owner === doseOwner
  ), [])
  return {
    enabled,
    owner,
    records,
    // 只覆蓋仍吻合的舊快照；新撤回／打卡不能沿用舊確認，帳號切換的第一個 render 也要隔離。
    confirmedIntakes: statusOwnerRef.current === owner ? [...confirmedIntakesRef.current.values()]
      .filter(proof => records.some(record => JSON.stringify(record) === JSON.stringify(proof.dose))).map(proof => proof.log) : [],
    syncingPatientId: syncing ? syncingPatientId : null,
    syncingDose,
    // effect 尚未清掉上一帳號狀態的那一次 render，也不能露出舊的同步／清理資訊。
    lastAttemptAtByPatient: statusOwnerRef.current === owner ? lastAttemptAtByPatient : EMPTY_PATIENT_STATUS,
    syncErrorByPatient: statusOwnerRef.current === owner ? syncErrorByPatient : EMPTY_PATIENT_STATUS,
    cleanupErrorByPatient: statusOwnerRef.current === owner ? cleanupErrorByPatient : EMPTY_PATIENT_STATUS,
    supersededCountByPatient: statusOwnerRef.current === owner ? supersededCountByPatient : EMPTY_PATIENT_STATUS,
    controlledCorrectionCountByPatient: statusOwnerRef.current === owner
      ? Object.fromEntries([...controlledCorrectionDoseIdsRef.current].map(([id, doses]) => [id, doses.size])) : EMPTY_PATIENT_STATUS,
    refresh,
    retryNow,
    confirmWithdrawal,
    confirmFullDayRead,
    isDoseSyncing,
    setScreen,
    addSuperseded,
    dismissSuperseded,
  }
}
