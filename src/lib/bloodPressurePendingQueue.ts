/*
檔案用途：保存血壓寫入失敗時的本機 pending queue，並在恢復連線後逐筆重送；
  可只送畫面上那位，也可送這個帳號所有照護對象的佇列（issue #1125）。
所在層：src/lib；是血壓輸入頁與共用離線佇列（lib/pendingWriteQueue）之間的血壓專屬 adapter。
主要關聯：InputPage、DailyBloodPressureRecords、bloodPressureRecords、lib/pendingWriteQueue。
*/
import type { BpRecord } from '../types/database'
import type { BloodPressureInsertPayload } from './bloodPressureRecords'
import { createPendingWriteQueue, type PendingWriteFlushResult } from './pendingWriteQueue'

export type PendingBloodPressureRecord = Omit<BloodPressureInsertPayload, 'recorded_by'> & {
  recorded_by: string
  queued_at: string
  // 記錄是否已嘗試過 Telegram 通知：insertBloodPressureRecord 的 'already-existed' 結果
  // 可能來自「這筆本來就是這次補送才真正寫入，只是伺服器回應遺失」，也可能來自「先前
  // 補送已成功通知，但移除佇列時 localStorage 寫入失敗而殘留」，兩者無法只靠 insert 結果
  // 分辨。缺這個欄位就得二選一：永遠不補通知（原始 bug）或每次重試都重複通知家人。
  notified?: boolean
  // 入佇列當下用「這位病人的個別標準」判讀出來的「需不需要通知家人」（issue #1126，Codex review on PR #1127）。
  // 離線重開 App 時 BpStandardProvider 讀不到個別標準，只能退回一般成人門檻；長輩標準下 100/55 是偏低警示、
  // 一般成人卻算正常，看護就收不到「請打電話給家人」的提醒。所以趁標準還在手上時先記下結論。
  // 標準當下也讀不到時不寫這個欄位（undefined＝不知道），不能把退回門檻的結果冒充成個別判讀。
  // 只存在本機：insertBloodPressureRecord 只送資料表欄位，這個欄位不會送到資料庫。
  family_alert?: boolean
  // 入佇列當下，這筆是不是這個帳號的「第一筆紀錄」（成長漏斗 first_record_saved；PR #1218 Codex P2）。
  // 補送可能在沒有輸入頁的情況下完成（殼層補送器，issue #1138），那時沒有畫面能判斷「歷史是否為空」；
  // 輸入頁在入佇列時就知道，所以記在紀錄上，補送成功時由補送器埋點（analytics 自己有一次性 marker 去重）。
  // 只存在本機：insertBloodPressureRecord 只送資料表欄位。
  first_record?: boolean
}

export type PendingBloodPressureFlushResult = PendingWriteFlushResult<PendingBloodPressureRecord>

// 已上線的 namespace：改名等於丟掉看護手機上尚未同步的血壓，不能動。
const STORAGE_NAMESPACE = 'jia-jian.pending-blood-pressure.v1'

function isValidPendingRecord(value: unknown): value is PendingBloodPressureRecord {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.id === 'string' && record.id.length > 0 &&
    typeof record.patient_id === 'string' && record.patient_id.length > 0 &&
    Number.isInteger(record.systolic) && Number.isInteger(record.diastolic) &&
    (record.pulse === null || Number.isInteger(record.pulse)) &&
    typeof record.measured_at === 'string' && !Number.isNaN(Date.parse(record.measured_at)) &&
    typeof record.source === 'string' &&
    typeof record.recorded_by === 'string' && record.recorded_by.length > 0 &&
    typeof record.queued_at === 'string' && !Number.isNaN(Date.parse(record.queued_at)) &&
    (record.notified === undefined || typeof record.notified === 'boolean') &&
    (record.family_alert === undefined || typeof record.family_alert === 'boolean') &&
    (record.first_record === undefined || typeof record.first_record === 'boolean')
  )
}

// 分區、去重、保序與可重試／永久錯誤的處理都在共用佇列（issue #822 從這支檔案泛化出去）；
// 這裡只保留血壓專屬的資料形狀與畫面轉換，對外函式簽章維持不變。
const queue = createPendingWriteQueue<PendingBloodPressureRecord>({
  namespace: STORAGE_NAMESPACE,
  logLabel: 'blood pressure pending queue',
  isValid: isValidPendingRecord,
})

export function pendingBloodPressureRecordToView(record: PendingBloodPressureRecord): BpRecord {
  return {
    id: `pending-bp-${record.id}`,
    systolic: record.systolic,
    diastolic: record.diastolic,
    pulse: record.pulse,
    measured_at: record.measured_at,
    source: record.source,
    recorded_by: record.recorded_by,
    patient_id: record.patient_id,
    created_at: record.queued_at,
  }
}

export function readPendingBloodPressureRecords(patientId: string, recordedBy: string): PendingBloodPressureRecord[] {
  return queue.read(patientId, recordedBy)
}

export function enqueuePendingBloodPressureRecord(record: PendingBloodPressureRecord): boolean {
  return queue.enqueue(record)
}

export function removePendingBloodPressureRecord(record: Pick<PendingBloodPressureRecord, 'id' | 'patient_id' | 'recorded_by'>): boolean {
  return queue.remove(record)
}

export function flushPendingBloodPressureRecords({
  patientId,
  recordedBy,
  save,
}: {
  patientId: string
  recordedBy: string
  save: (record: PendingBloodPressureRecord) => Promise<unknown>
}): Promise<PendingBloodPressureFlushResult> {
  return queue.flush({ patientId, recordedBy, save })
}

/** 這個帳號在這台裝置上所有病人的待送血壓（issue #1125）；只拿來算筆數與補送，不得把別人的數值畫在目前病人的畫面上（§ 3.5）。 */
export function readAllPendingBloodPressureRecords(recordedBy: string): PendingBloodPressureRecord[] {
  return queue.readAll(recordedBy)
}

/**
 * 補送這個帳號所有病人的待送血壓，畫面上那位（firstPatientId）優先（issue #1125）。
 * 以前只送畫面上那位：A 的危險血壓離線暫存後切到 B，連線恢復也不會送、家人也不會收到通知，要等有人再打開 A。
 */
/**
 * 另一個分頁／視窗改了血壓佇列時，storage 事件帶的 key 是不是本佇列的（issue #1138）。
 * 常駐補送器靠它在別的分頁送完後立刻重讀清單，不必等自己的下一輪。
 */
export function isPendingBloodPressureStorageKey(key: string | null): boolean {
  return queue.isStorageKey(key)
}

export function flushAllPendingBloodPressureRecords({
  recordedBy,
  firstPatientId,
  save,
}: {
  recordedBy: string
  firstPatientId?: string
  save: (record: PendingBloodPressureRecord) => Promise<unknown>
}): Promise<PendingBloodPressureFlushResult> {
  return queue.flushAll({ recordedBy, firstPatientId, save })
}
