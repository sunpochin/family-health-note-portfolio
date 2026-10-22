/*
檔案用途：血壓點名與拒絕提示的舊儲存格式轉接；保留 namespace、錯誤摘要、讀回順序。
所在層：src/features/vitals/lib；只定義血壓提示的 codec，不處理補送或提示分流。
主要關聯：shellNoticeStore、usePerKeyStoreState、useBloodPressureQueueCoordinator。
*/
import { readErrorFields } from '../../../lib/dataErrors'
import type { RejectedBloodPressureSave } from '../hooks/useBloodPressureQueueCoordinator'
import { createPerKeyStore } from './shellNoticeStore'

function isStoredRejectedSave(value: unknown): value is RejectedBloodPressureSave {
  if (typeof value !== 'object' || value === null) return false
  const item = value as Record<string, unknown>
  const reading = item.limitBlockedReading
  const validReading = reading === null || (
    typeof reading === 'object' && reading !== null &&
    typeof (reading as Record<string, unknown>).patientId === 'string' &&
    Number.isInteger((reading as Record<string, unknown>).systolic) && Number.isInteger((reading as Record<string, unknown>).diastolic) &&
    Number.isInteger((reading as Record<string, unknown>).pulse) && typeof (reading as Record<string, unknown>).measuredAt === 'string'
  )
  return typeof item.recordId === 'string' && item.recordId.length > 0 && typeof item.patientId === 'string' && item.patientId.length > 0 &&
    typeof item.error === 'object' && item.error !== null && validReading && typeof item.at === 'number' &&
    (item.uncertain === undefined || typeof item.uncertain === 'boolean') && (item.callFamily === undefined || typeof item.callFamily === 'boolean')
}

export function createRejectedSavesStore(owner: string) {
  return createPerKeyStore<RejectedBloodPressureSave>({
    namespace: 'jia-jian.pending-blood-pressure.rejected-saves.v1', owner, keyType: 'record',
    valueKey: item => item.recordId,
    compare: (left, right) => left.at - right.at,
    parse: raw => {
      const parsed: unknown = JSON.parse(raw)
      return isStoredRejectedSave(parsed) ? parsed : null
    },
    // 原始錯誤未必可序列化；畫面判讀只需這三個欄位，不能把其他請求內容存進手機。
    serialize: item => JSON.stringify({ ...item, error: readErrorFields(item.error) }),
  })
}

export function createNotifyProblemsStore(owner: string) {
  return createPerKeyStore<string>({
    namespace: 'jia-jian.pending-blood-pressure.notify-problems.v2', owner, keyType: 'patient',
    valueKey: id => id,
    valueFromKey: id => id,
    compare: (left, right) => left < right ? -1 : left > right ? 1 : 0,
    // 舊點名只認 key 存在，不因值不是 '1' 而讓已存提醒消失；新寫入仍只存 '1'，不含讀數。
    parse: (_raw, id) => id,
    serialize: () => '1',
  })
}
