/*
檔案用途：服藥打卡的離線佇列——打卡遇到斷線時先存在本機，恢復連線後補送；同一劑不論重按、重送或兩台手機各自離線打卡，資料庫都只留一筆；
  按錯撤回時留下撤回標記，連線後刪掉自己那次打卡可能已寫入的那筆。
所在層：src/lib/medication；建立在共用 lib/pendingWriteQueue 之上的服藥專屬 adapter，另含衝突判定、與伺服器資料對帳、畫面轉換等純函式。
主要關聯：features/medication/hooks/useMedicationPendingDoses、lib/medication/medications（insertMedicationDoseLog、deleteOwnMedicationDoseLog）、
  資料庫唯一索引 idx_medication_intake_logs_patient_plan_care_date_unique（patient_id, plan_id, care_date, dose_number）。
*/
import dayjs from 'dayjs'
import { calendarDateKey, careDateKey } from '../careDay'
import { createPendingWriteQueue, normalizePendingOwner, type PendingWriteBase, type PendingWriteFlushResult } from '../pendingWriteQueue'
import { buildMedicationDoseInsertFor, deleteOwnMedicationDoseLog, insertMedicationDoseLog, readConfirmedMedicationDoseLog, type MedicationPlanView } from './medications'
import type { MedicationIntakeLog } from '../../types/database'

/**
 * id 不是隨機 UUID，而是「哪一劑」本身：(patient_id, plan_id, care_date, dose_number)，跟資料庫唯一索引同一組欄位。
 * 這是跟血壓佇列最大的不同——血壓兩次量測就是兩筆，服藥同一劑同一天只能一筆；用隨機 id 的話，
 * 離線時對同一劑按兩次會排進兩筆，補送後漏服偵測（careAnomalySignals）會被重複紀錄干擾。
 * medication_id／medication_name 是打卡當下的快照：補送可能發生在重新開 App、藥單還沒載入的時候。
 */
export interface PendingMedicationDose extends PendingWriteBase {
  plan_id: string
  dose_number: number
  care_date: string
  taken_at: string
  medication_id: string
  medication_name: string
  /**
   * 看護撤回了這一劑（按錯）。不能直接從佇列刪掉：排進佇列的原因可能是「伺服器其實已寫入、只是回應遺失」，
   * 只刪本機會讓伺服器留著「已服用」，真的漏服也不會被發現。所以改成一筆撤回標記，連線後刪掉伺服器上
   * 「自己那次打卡」寫進去的那筆（帳號＋服藥時間都要對得上）；伺服器上沒有就刪到 0 列，一樣算完成。
   */
  withdrawn?: boolean
}

const FLUSH_LOCK_NAME = 'jia-jian-medication-pending-flush.v1'

/**
 * 補送與清除撤回標記共用鎖，避免別頁的舊 DELETE 刪掉已回報成功的重新打卡；若瀏覽器不支援 Web Locks，退回本分頁的 single-flight。
 * 取鎖本身被瀏覽器拒絕時也退回執行，否則 pageshow／bfcache 時可能整輪漏掉。
 */
export async function withMedicationQueueLock<T>(run: () => Promise<T>, whenHeld: () => T, { allowUnlocked = true, wait = false }: { allowUnlocked?: boolean; wait?: boolean } = {}): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  // 冪等補送可以降級；清除撤回會改變健康事實，呼叫端可要求拿不到鎖就保留原標記。
  if (!locks) return allowUnlocked ? run() : whenHeld()

  let requestStarted = false
  try {
    return await locks.request(FLUSH_LOCK_NAME, { ifAvailable: !wait }, lock => {
      requestStarted = true
      return lock ? run() : Promise.resolve(whenHeld())
    })
  } catch (error) {
    if (requestStarted) throw error
    console.warn('[medication pending queue lock unavailable]', error)
    return allowUnlocked ? run() : whenHeld()
  }
}

export type PendingMedicationFlushResult = PendingWriteFlushResult<PendingMedicationDose>

// 已上線後不能改名：改名等於丟掉看護手機上尚未同步的服藥紀錄。
const STORAGE_NAMESPACE = 'jia-jian.pending-medication-dose.v1'
const PENDING_LOG_ID_PREFIX = 'pending-med-'
const CARE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function medicationDoseKey(patientId: string, planId: string, careDate: string, doseNumber: number): string {
  return `${patientId}:${planId}:${careDate}:${doseNumber}`
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isValidPendingDose(value: unknown): value is PendingMedicationDose {
  if (typeof value !== 'object' || value === null) return false
  const dose = value as Record<string, unknown>
  if (!(
    isNonEmptyString(dose.id) && isNonEmptyString(dose.patient_id) && isNonEmptyString(dose.plan_id) &&
    isNonEmptyString(dose.recorded_by) && isNonEmptyString(dose.medication_id) && typeof dose.medication_name === 'string' &&
    Number.isInteger(dose.dose_number) && (dose.dose_number as number) >= 1 && (dose.dose_number as number) <= 9 &&
    typeof dose.care_date === 'string' && CARE_DATE_PATTERN.test(dose.care_date) &&
    typeof dose.taken_at === 'string' && !Number.isNaN(Date.parse(dose.taken_at)) &&
    typeof dose.queued_at === 'string' && !Number.isNaN(Date.parse(dose.queued_at)) &&
    (dose.withdrawn === undefined || typeof dose.withdrawn === 'boolean')
  )) return false
  // id 必須就是它自己的劑次鍵、照護日也必須跟服藥時間一致；被竄改或舊版格式的項目不能拿來繞過「同一劑一筆」的去重。
  return dose.id === medicationDoseKey(dose.patient_id as string, dose.plan_id as string, dose.care_date as string, dose.dose_number as number)
    && dose.care_date === careDateKey(dayjs(dose.taken_at as string))
}

const queue = createPendingWriteQueue<PendingMedicationDose>({
  namespace: STORAGE_NAMESPACE,
  logLabel: 'medication pending queue',
  isValid: isValidPendingDose,
  // 服藥的同 id 替換可能是撤回／重新打卡，不是血壓的通知旗標；只清掉本次確實送出的版本。
  isSameWrite: (submitted, latest) => JSON.stringify(submitted) === JSON.stringify(latest),
})

/**
 * takenAt 是按下去那一刻（不是補送成功的時間）；照護日也由它決定，與資料庫 trigger 的算法相同（台北時間減 4 小時）。
 */
export function buildPendingMedicationDose(plan: MedicationPlanView, doseNumber: number, recordedByEmail: string, takenAt: string, queuedAt = new Date().toISOString()): PendingMedicationDose {
  const careDate = careDateKey(dayjs(takenAt))
  return {
    id: medicationDoseKey(plan.patient_id, plan.id, careDate, doseNumber),
    patient_id: plan.patient_id,
    recorded_by: normalizePendingOwner(recordedByEmail),
    queued_at: queuedAt,
    plan_id: plan.id,
    dose_number: doseNumber,
    care_date: careDate,
    taken_at: takenAt,
    medication_id: plan.medication_id,
    medication_name: plan.medication.brand_name,
  }
}

export function readPendingMedicationDoses(patientId: string, recordedBy: string): PendingMedicationDose[] {
  return queue.read(patientId, recordedBy)
}

/** 只列出此帳號自己的病人分桶；常駐協調器用它在不依賴目前畫面的情況下補送。 */
export function readAllPendingMedicationDoses(recordedBy: string): PendingMedicationDose[] {
  return queue.readAll(recordedBy)
}

/** storage 事件僅需監聽服藥佇列 key，避免其他 localStorage 變更觸發健康資料重讀。 */
export function isPendingMedicationStorageKey(key: string | null): boolean {
  return queue.isStorageKey(key)
}

export function enqueuePendingMedicationDose(dose: PendingMedicationDose): boolean {
  // 同一劑已在佇列時保留第一次：藥是在第一次按下時吃的，第二次按（或重試）不能把服藥時間改晚。
  // 共用佇列的 enqueue 是「同 id 覆蓋」，那是血壓補 notified 旗標要的語意，服藥這裡要先擋下。
  // 例外是撤回標記：撤回後又重新打卡，代表這一劑現在確實吃了，新的打卡要取代撤回。
  const existing = queue.read(dose.patient_id, dose.recorded_by).find(item => item.id === dose.id)
  if (existing && !existing.withdrawn) return true
  return queue.enqueue(dose)
}

/** 把待同步的一劑改成撤回標記（見 PendingMedicationDose.withdrawn）；回傳 false 代表本機儲存寫不進去。 */
export function withdrawPendingMedicationDose(dose: PendingMedicationDose): boolean {
  return queue.enqueue({ ...dose, withdrawn: true })
}

/** 已確認的舊標記只能移掉同一快照；等待鎖時出現的新撤回／重新打卡不能被舊 RPC 清掉。 */
export function removeUnchangedPendingMedicationDose(dose: PendingMedicationDose): 'removed' | 'unchanged' | 'storage-error' {
  const latest = queue.read(dose.patient_id, dose.recorded_by).find(item => item.id === dose.id)
  if (!latest || JSON.stringify(latest) !== JSON.stringify(dose)) return 'unchanged'
  return queue.remove(latest) ? 'removed' : 'storage-error'
}

export function removePendingMedicationDose(dose: Pick<PendingMedicationDose, 'id' | 'patient_id' | 'recorded_by'>): boolean {
  return queue.remove(dose)
}

export function flushPendingMedicationDoses<TResult = unknown>(options: {
  patientId: string
  recordedBy: string
  save: (dose: PendingMedicationDose) => Promise<TResult>
  onSynced?: (dose: PendingMedicationDose, result: TResult) => void | Promise<void>
  shouldContinue?: () => boolean
}): Promise<PendingMedicationFlushResult> {
  return queue.flush(options)
}

/** 每位病人仍依自己的 patient_id 分桶送出；目前畫面上的病人只決定優先順序。 */
export function flushAllPendingMedicationDoses<TResult = unknown>(options: {
  recordedBy: string
  firstPatientId?: string
  save: (dose: PendingMedicationDose) => Promise<TResult>
  onSynced?: (dose: PendingMedicationDose, result: TResult) => void | Promise<void>
  shouldContinue?: () => boolean
}): Promise<PendingMedicationFlushResult> {
  return queue.flushAll(options)
}

/**
 * 伺服器上的這一筆是不是「這支手機這次打卡」寫進去的。
 * 補送遇到唯一鍵衝突時會讀回已存在的那筆；它可能是自己上一次「其實已寫入、只是回應遺失」的請求，
 * 也可能是另一台裝置（或另一位照護者）先記錄的。前者不必提示，後者要告訴看護畫面上的時間以先記錄者為準。
 * 用帳號＋服藥時間比對：時間是打卡當下在本機產生、原樣送出的，別的請求不可能剛好同一毫秒。
 */
export function isOwnMedicationDoseWrite(dose: PendingMedicationDose, log: MedicationIntakeLog): boolean {
  return normalizePendingOwner(log.account_email) === dose.recorded_by && Date.parse(log.taken_at) === Date.parse(dose.taken_at)
}

export type PendingMedicationSyncOutcome =
  /** 伺服器上留下的那一筆，以及它是不是由別處先記錄（server-wins）。 */
  | { kind: 'recorded'; log: MedicationIntakeLog; superseded: boolean; requiresControlledCorrection?: boolean }
  /** 撤回已送達：伺服器上自己那次打卡寫入的那筆（若有）已刪除。 */
  | { kind: 'withdrawn'; dose: PendingMedicationDose }

/** 補送一劑或送出撤回。 */
export async function syncPendingMedicationDose(dose: PendingMedicationDose, signal?: AbortSignal): Promise<PendingMedicationSyncOutcome> {
  if (dose.withdrawn) {
    try {
      await deleteOwnMedicationDoseLog(dose, signal)
      return { kind: 'withdrawn', dose }
    } catch (error) {
      // 只處理特定受控更正 guard，不能把其他 P0001／權限／網路錯誤都當成已確認。
      const guarded = error as { code?: unknown; message?: unknown }
      if (guarded?.code === 'P0001' && guarded.message === 'medication_hold_confirmation_required') {
        const confirmed = await readConfirmedMedicationDoseLog(dose, signal)
        if (confirmed) return { kind: 'recorded', log: confirmed, superseded: false, requiresControlledCorrection: true }
      }
      throw error
    }
  }
  const log = await insertMedicationDoseLog(buildMedicationDoseInsertFor(dose, dose.recorded_by, dose.taken_at), signal)
  return { kind: 'recorded', log, superseded: !isOwnMedicationDoseWrite(dose, log) }
}

function logMatchesDose(log: MedicationIntakeLog, dose: PendingMedicationDose): boolean {
  return log.patient_id === dose.patient_id && log.plan_id === dose.plan_id && log.dose_number === dose.dose_number
    && (log.care_date ?? log.taken_on) === dose.care_date
}

/** 這筆伺服器紀錄是不是某個撤回標記要刪的那筆（同一劑、而且是自己那次打卡寫入的）。 */
export function isWithdrawnOwnLog(log: MedicationIntakeLog, withdrawn: PendingMedicationDose[]): boolean {
  return withdrawn.some(dose => dose.withdrawn === true && logMatchesDose(log, dose) && isOwnMedicationDoseWrite(dose, log))
}

/**
 * 載入當天服藥紀錄後與本機佇列對帳：伺服器已經有同一劑時，佇列裡那筆送出去也只會撞唯一鍵、讀回伺服器那筆，
 * 所以直接視為已解決並移出佇列。不等補送才處理，是因為那段時間畫面會同時有「伺服器那筆」與「待同步那筆」，
 * 看護若取消伺服器那筆，佇列隨後又會把同一劑寫回去。
 * 撤回標記不在這裡對帳：伺服器上有對應的那筆，正是它要去刪的東西。
 */
export function reconcilePendingMedicationDoses(pending: PendingMedicationDose[], serverLogs: MedicationIntakeLog[]) {
  const resolved: Array<{ dose: PendingMedicationDose; log: MedicationIntakeLog; superseded: boolean }> = []
  const remaining: PendingMedicationDose[] = []
  for (const dose of pending) {
    const log = dose.withdrawn ? undefined : serverLogs.find(item => logMatchesDose(item, dose))
    if (log) resolved.push({ dose, log, superseded: !isOwnMedicationDoseWrite(dose, log) })
    else remaining.push(dose)
  }
  return { resolved, remaining }
}

/**
 * 轉成畫面用的服藥紀錄：進度、完成提示與藥卡都把它當成「已服用」（藥已經吃了，只是還沒送到伺服器），
 * 但 id 帶固定前綴，藥卡才能標示「待同步」，取消時也知道要走佇列撤回、不是直接刪伺服器。撤回標記不轉成畫面紀錄。
 */
export function pendingMedicationDoseToLog(dose: PendingMedicationDose): MedicationIntakeLog {
  return {
    id: `${PENDING_LOG_ID_PREFIX}${dose.id}`,
    account_email: dose.recorded_by,
    patient_id: dose.patient_id,
    medication_id: dose.medication_id,
    medication_name: dose.medication_name,
    plan_id: dose.plan_id,
    dose_number: dose.dose_number,
    care_date: dose.care_date,
    taken_on: calendarDateKey(dayjs(dose.taken_at)),
    taken_at: dose.taken_at,
    created_at: dose.queued_at,
  }
}

export function isPendingMedicationLog(log: Pick<MedicationIntakeLog, 'id'>): boolean {
  return log.id.startsWith(PENDING_LOG_ID_PREFIX)
}

function sameDose(left: MedicationIntakeLog, right: MedicationIntakeLog): boolean {
  return left.plan_id === right.plan_id && left.dose_number === right.dose_number
}

/**
 * 畫面上同一天的服藥清單：伺服器紀錄優先，待同步劑次只補上伺服器還沒有的那幾劑。
 * 兩者同時存在時（剛補送成功、或別處先記錄）只能顯示伺服器那筆，否則同一劑會被算兩次、藥卡也不知道該顯示哪個時間。
 * 看護已撤回、但撤回還沒送到伺服器的那筆（自己那次打卡寫入的）先不顯示，畫面要跟她剛做的決定一致。
 */
export function mergeMedicationDayLogs(serverLogs: MedicationIntakeLog[], pendingLogs: MedicationIntakeLog[], withdrawn: PendingMedicationDose[] = []): MedicationIntakeLog[] {
  const visibleServerLogs = withdrawn.length ? serverLogs.filter(log => !isWithdrawnOwnLog(log, withdrawn)) : serverLogs
  return [...visibleServerLogs, ...pendingLogs.filter(pending => !visibleServerLogs.some(log => sameDose(log, pending)))]
}

/** 補送成功的伺服器紀錄併進目前清單：同一劑以新讀回的那筆取代，不在畫面製造第二筆。 */
export function upsertMedicationDayLogs(current: MedicationIntakeLog[], incoming: MedicationIntakeLog[]): MedicationIntakeLog[] {
  return [...current.filter(log => !incoming.some(item => sameDose(item, log))), ...incoming]
}

/** 把一輪補送的結果套到當天清單：新寫入的併進來，撤回已送達的那筆（只限自己那次打卡寫入的）移掉。 */
export function applyMedicationSyncToDayLogs(current: MedicationIntakeLog[], recorded: MedicationIntakeLog[], withdrawn: PendingMedicationDose[]): MedicationIntakeLog[] {
  const merged = recorded.length ? upsertMedicationDayLogs(current, recorded) : current
  return withdrawn.length ? merged.filter(log => !isWithdrawnOwnLog(log, withdrawn)) : merged
}
