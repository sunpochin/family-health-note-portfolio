/*
檔案用途：病人／帳號分區的通用離線寫入佇列——寫入遇到暫時性錯誤時先存在 localStorage，恢復連線後依序重送；
  可只送畫面上那位病人（flush），也可送這個帳號所有病人的佇列（flushAll，issue #1125），並回報每筆失敗的原因。
所在層：src/lib 共用核心層；各種紀錄的離線佇列都由 createPendingWriteQueue 建立，各自只定義資料形狀、驗證與 storage namespace。
主要關聯：lib/bloodPressurePendingQueue、lib/medication/medicationPendingQueue、lib/localCache（patient-scoped key）、
  lib/dataErrors（可重試／永久錯誤判斷）、hooks/usePendingWriteFlush（什麼時候觸發 flush）。
*/
import { isRetryableWriteError } from './dataErrors'
import { patientScopedCacheKey } from './localCache'

/**
 * 每一種佇列項目都必須帶的欄位；分區、去重與保序只靠這四個欄位，其餘欄位由各領域自行定義。
 * id 是佇列內的去重鍵：同一個 id 再次入列只會覆蓋舊的，不會多出第二筆（重按、重試都安全）。
 * recorded_by 只代表「誰操作」，不代表資料屬於誰；資料屬於誰一律看 patient_id（AGENTS.md § 3.5）。
 */
export interface PendingWriteBase {
  id: string
  patient_id: string
  recorded_by: string
  queued_at: string
}

/**
 * 一筆送出失敗的紀錄與它的原因（issue #1125）。
 * 只回一個 blocked 布林時，畫面分不出「沒網路，等一下會自己送」和「伺服器拒絕，重試也不會成功」，
 * 只好一律叫看護檢查網路；呼叫端拿到原始錯誤才能顯示真正的原因。
 */
export interface PendingWriteFailure<T> {
  record: T
  error: unknown
  /** 與 isRetryableWriteError 同一個判斷：true 代表這一輪就此停下、之後會自動再試。 */
  retryable: boolean
}

export interface PendingWriteFlushResult<T> {
  synced: T[]
  remaining: T[]
  blocked: boolean
  /** 這一輪每一筆送出失敗的紀錄（依送出順序）；暫時性失敗之後的紀錄沒有嘗試，所以不在這裡。 */
  failures: PendingWriteFailure<T>[]
}

export interface PendingWriteQueue<T extends PendingWriteBase> {
  read: (patientId: string, recordedBy: string) => T[]
  readAll: (recordedBy: string) => T[]
  enqueue: (record: T) => boolean
  remove: (record: Pick<T, 'id' | 'patient_id' | 'recorded_by'>) => boolean
  flush: <TResult = unknown>(options: {
    patientId: string
    recordedBy: string
    save: (record: T) => Promise<TResult>
    onSynced?: (record: T, result: TResult) => void | Promise<void>
    shouldContinue?: () => boolean
  }) => Promise<PendingWriteFlushResult<T>>
  flushAll: <TResult = unknown>(options: {
    recordedBy: string
    firstPatientId?: string
    save: (record: T) => Promise<TResult>
    onSynced?: (record: T, result: TResult) => void | Promise<void>
    shouldContinue?: () => boolean
  }) => Promise<PendingWriteFlushResult<T>>
  /** 這把 localStorage key 屬於這個佇列嗎（任何病人、任何帳號）；給跨分頁的 storage 事件過濾用（issue #1138）。 */
  isStorageKey: (key: string | null) => boolean
}

export function normalizePendingOwner(email: string): string {
  return email.trim().toLowerCase()
}

export function createPendingWriteQueue<T extends PendingWriteBase>({
  namespace,
  logLabel,
  isValid,
  isSameWrite,
}: {
  /** localStorage key 前綴；改名等於丟掉使用者手機上尚未同步的資料，已上線的 namespace 不能改。 */
  namespace: string
  /** console 訊息標籤，例如 'blood pressure pending queue'。 */
  logLabel: string
  /** 逐筆驗證讀回來的資料；壞掉或舊版形狀的項目直接略過，不把來路不明的物件當成健康紀錄重送。 */
  isValid: (value: unknown) => value is T
  /** 需要保留送出途中替換意圖的領域提供比較；預設沿用既有按 id 清除，血壓補 notified 旗標仍可清除。 */
  isSameWrite?: (submitted: T, latest: T) => boolean
}): PendingWriteQueue<T> {
  function storageKey(patientId: string, recordedBy: string): string {
    // storage key 也要帶 patient_id；只靠讀取時 filter 仍可能讓同一瀏覽器的不同病人共用一個健康資料桶。
    return patientScopedCacheKey(namespace, patientId, normalizePendingOwner(recordedBy))
  }

  function readKey(key: string): T[] {
    try {
      const raw = localStorage.getItem(key)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isValid) : []
    } catch (error) {
      // localStorage 被停用或 JSON 損壞時不能讓輸入頁崩潰；這次資料會回到一般錯誤提示。
      // 標籤走 %s 佔位符而不是樣板字串：Semgrep unsafe-formatstring 把「變數插進第一個參數」視為格式字串注入（與下方 list error 同一寫法）。
      console.warn('[%s read error]', logLabel, error)
      return []
    }
  }

  function readQueue(patientId: string, recordedBy: string): T[] {
    return readKey(storageKey(patientId, recordedBy))
  }

  function writeQueue(patientId: string, recordedBy: string, records: T[]): boolean {
    try {
      localStorage.setItem(storageKey(patientId, recordedBy), JSON.stringify(records))
      return true
    } catch (error) {
      // 沒有可用的本機儲存時不能假裝已建立離線備份，呼叫端會保留輸入錯誤狀態讓使用者重試。
      console.warn('[%s write error]', logLabel, error)
      return false
    }
  }

  function read(patientId: string, recordedBy: string): T[] {
    const owner = normalizePendingOwner(recordedBy)
    return readQueue(patientId, owner)
      .filter(record => record.patient_id === patientId && record.recorded_by === owner)
      .sort((left, right) => Date.parse(left.queued_at) - Date.parse(right.queued_at))
  }

  /**
   * 這個帳號在這台裝置上有待送紀錄的病人，依各自最早一筆的 queued_at 排序（issue #1125）。
   * 佇列依病人分桶，以前只會讀「畫面上這位」的桶；看護切到別人之後，前一位的離線紀錄就沒人補送。
   */
  // 與 patientScopedCacheKey 的組法同源：namespace、`patient-<id>`、owner 以 `-` 相接。
  const keyPrefix = `${namespace}-patient-`

  function isStorageKey(key: string | null): boolean {
    return key !== null && key.startsWith(keyPrefix)
  }

  function ownerKeys(owner: string): string[] {
    const prefix = keyPrefix
    const suffix = `-${owner}`
    try {
      return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
        .filter((key): key is string => key !== null && key.startsWith(prefix) && key.endsWith(suffix))
    } catch (error) {
      // 列舉失敗時退回「沒有其他病人」：畫面上這位的佇列仍由 flush 直接讀它自己的桶，不受影響。
      // 格式字串用常數、標籤當參數：Semgrep unsafe-formatstring 會擋「第一個參數不是字面值」的 console 呼叫（security-ci）。
      console.warn('[%s list error]', logLabel, error)
      return []
    }
  }

  function patientIds(recordedBy: string): string[] {
    const owner = normalizePendingOwner(recordedBy)
    const oldestByPatient = new Map<string, number>()
    for (const key of ownerKeys(owner)) {
      // 不從 key 字串切出病人 id：UUID 與 email 都含 '-'，另一個帳號的 email 也可能剛好以 `-${owner}` 結尾。
      // 改用桶內紀錄自己的 patient_id 反推：recorded_by 必須是這個帳號（擋掉上述別人的桶），
      // 而且這個 key 正是那位病人的桶（放錯桶的紀錄不算，否則會列出一個讀不到東西的病人）。
      for (const record of readKey(key)) {
        if (record.recorded_by !== owner || storageKey(record.patient_id, owner) !== key) continue
        const queuedAt = Date.parse(record.queued_at)
        const previous = oldestByPatient.get(record.patient_id)
        if (previous === undefined || queuedAt < previous) oldestByPatient.set(record.patient_id, queuedAt)
      }
    }
    return [...oldestByPatient.entries()].sort((left, right) => left[1] - right[1]).map(([patientId]) => patientId)
  }

  function readAll(recordedBy: string): T[] {
    return patientIds(recordedBy).flatMap(patientId => read(patientId, recordedBy))
  }

  function enqueue(record: T): boolean {
    const normalized: T = { ...record, recorded_by: normalizePendingOwner(record.recorded_by) }
    const records = readQueue(normalized.patient_id, normalized.recorded_by).filter(existing => existing.id !== normalized.id)
    return writeQueue(normalized.patient_id, normalized.recorded_by, [...records, normalized])
  }

  function remove(record: Pick<T, 'id' | 'patient_id' | 'recorded_by'>): boolean {
    const owner = normalizePendingOwner(record.recorded_by)
    const records = readQueue(record.patient_id, owner)
    return writeQueue(record.patient_id, owner, records.filter(existing => existing.id !== record.id))
  }

  function removeSynced(record: T): boolean {
    const owner = normalizePendingOwner(record.recorded_by)
    const records = readQueue(record.patient_id, owner)
    const latest = records.find(existing => existing.id === record.id)
    // 等待伺服器時另一分頁可能把同 id 改成撤回或新版本；舊成功只能清掉自己送的快照，不能吞掉較新的意圖。
    if (!latest || (isSameWrite && !isSameWrite(record, latest))) return true
    return writeQueue(record.patient_id, owner, records.filter(existing => existing.id !== record.id))
  }

  async function flush<TResult = unknown>({
    patientId,
    recordedBy,
    save,
    onSynced,
    shouldContinue,
  }: {
    patientId: string
    recordedBy: string
    save: (record: T) => Promise<TResult>
    onSynced?: (record: T, result: TResult) => void | Promise<void>
    shouldContinue?: () => boolean
  }): Promise<PendingWriteFlushResult<T>> {
    const candidates = read(patientId, recordedBy)
    const synced: T[] = []
    const failures: PendingWriteFailure<T>[] = []
    let blocked = false

    for (const candidate of candidates) {
      // 跨 await 期間登入者可能已改變；舊帳號的佇列不可接著用新 session 送下一筆。
      if (shouldContinue && !shouldContinue()) break
      // 每送一筆前重新確認它還在佇列裡：前一筆等待回應的期間，使用者可能已在畫面上取消這筆
      // （服藥打卡按錯可以撤回），另一個分頁也可能已經送出並移除它。只用開頭讀到的快照會把
      // 已撤回的紀錄照樣寫進資料庫。讀回最新版本也讓 save 看到其他流程剛更新的欄位。
      const record = read(patientId, recordedBy).find(item => item.id === candidate.id)
      if (!record) continue
      try {
        const result = await save(record)
        // 先移除已確認寫入的項目；若 localStorage 此刻失敗，下一次仍會靠固定 id 安全去重。
        removeSynced(record)
        synced.push(record)
        if (onSynced) {
          try {
            // 畫面通知必須在每筆成功後送出，否則後面病人卡住時目前畫面會留著已完成的舊狀態。
            await onSynced(record, result)
          } catch {
            // 呈現通知失敗不能把已成功的伺服器寫入誤判成可重送的失敗。
            console.warn('[%s completion callback error]', logLabel)
          }
        }
      } catch (error) {
        blocked = true
        console.warn('[%s sync error]', logLabel, record.id, error)
        const retryable = isRetryableWriteError(error)
        failures.push({ record, error, retryable })
        if (retryable) {
          // 暫時性失敗（斷線、408/429/5xx）：保留原本順序，之後這筆與後面的紀錄一起再試。
          break
        }
        // 永久性失敗（權限被收回、配額已滿等）：這筆留在佇列讓使用者知道，但繼續送出後面尚未同步的資料，
        // 不能讓一筆卡住的紀錄擋住後續所有離線資料。
      }
    }

    return {
      synced,
      remaining: read(patientId, recordedBy),
      blocked,
      failures,
    }
  }

  /**
   * 依序補送這個帳號所有病人的佇列（issue #1125），firstPatientId（畫面上這位）優先，其餘依最早待送時間。
   * 每位病人仍走上面的 flush，分桶、保序與「送前重讀」的規則完全相同；save 收到的每筆紀錄都帶自己的 patient_id，
   * 呼叫端必須用它（而不是畫面上的病人）決定寫到誰身上、通知誰。
   */
  async function flushAll<TResult = unknown>({
    recordedBy,
    firstPatientId,
    save,
    onSynced,
    shouldContinue,
  }: {
    recordedBy: string
    firstPatientId?: string
    save: (record: T) => Promise<TResult>
    onSynced?: (record: T, result: TResult) => void | Promise<void>
    shouldContinue?: () => boolean
  }): Promise<PendingWriteFlushResult<T>> {
    const others = patientIds(recordedBy).filter(patientId => patientId !== firstPatientId)
    // 畫面上這位即使列舉不到（例如 localStorage.key 不可用）也照樣讀它自己的桶，不能因為新功能退步。
    const order = firstPatientId ? [firstPatientId, ...others] : others
    const synced: T[] = []
    const failures: PendingWriteFailure<T>[] = []
    let blocked = false
    for (const patientId of order) {
      // 病人分桶之間也可能跨過帳號切換；先停下，讓新 session 不會接手舊帳號的佇列。
      if (shouldContinue && !shouldContinue()) break
      const result = await flush({ patientId, recordedBy, save, onSynced, shouldContinue })
      synced.push(...result.synced)
      failures.push(...result.failures)
      blocked ||= result.blocked
      // 暫時性失敗（斷線、5xx）代表這一輪連不上伺服器，換下一位病人也一樣會失敗；停下來等下一次觸發，
      // 不要一口氣把每個桶都打一遍。永久性失敗只卡那一筆，其他病人照樣補送。
      if (result.failures.some(failure => failure.retryable)) break
    }
    const remaining = firstPatientId
      ? [...read(firstPatientId, recordedBy), ...readAll(recordedBy).filter(record => record.patient_id !== firstPatientId)]
      : readAll(recordedBy)
    return { synced, remaining, blocked, failures }
  }

  return { read, readAll, enqueue, remove, flush, flushAll, isStorageKey }
}
