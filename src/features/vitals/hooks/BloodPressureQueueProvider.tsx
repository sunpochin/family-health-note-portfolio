/*
檔案用途：把血壓離線佇列的常駐補送器（useBloodPressureQueueCoordinator，issue #1138）掛成 App 殼層的 Provider，
  並提供輸入頁讀取它的 hook；沒有 Provider 時直接丟例外，不靜默退回「只在血壓區段掛載時補送」的舊行為。
所在層：src/features/vitals/hooks；context 外殼，狀態與補送邏輯都在 useBloodPressureQueueCoordinator。
主要關聯：App.tsx（掛載點，必須在 BpStandardProvider 之內，補送器要用畫面上這位的判讀標準）、
  useBloodPressureInputForm（消費端）、tests/unit/bpQueueCoordinator.test.ts（測試直接把 coordinator 的回傳值塞進 context）。
*/
import { createContext, useContext, type ReactNode } from 'react'
import { useBloodPressureQueueCoordinator, type BloodPressureQueue } from './useBloodPressureQueueCoordinator'

export const BloodPressureQueueContext = createContext<BloodPressureQueue | null>(null)

export function BloodPressureQueueProvider({ patientId, userEmail, children }: {
  patientId: string
  userEmail?: string
  children: ReactNode
}) {
  const value = useBloodPressureQueueCoordinator({ patientId, userEmail })
  return <BloodPressureQueueContext.Provider value={value}>{children}</BloodPressureQueueContext.Provider>
}

export function useBloodPressureQueue(): BloodPressureQueue {
  const value = useContext(BloodPressureQueueContext)
  // 檢查形狀而不是只檢查 truthy：測試的 hook harness 對「沒有對應 Provider」的 context 會回傳一個共用的預設值
  // （通常是語系 context），那是 truthy 的（與 useBpEvaluator 同一個理由）。
  if (typeof value?.retryNow !== 'function') {
    throw new Error(
      'useBloodPressureQueue() requires a <BloodPressureQueueProvider>. ' +
      'Without the shell-level coordinator, queued blood pressure would only re-send while the input section is open (issue #1138).',
    )
  }
  return value
}
