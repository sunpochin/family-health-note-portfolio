/*
檔案用途：把服藥離線佇列協調器掛在登入後 App 殼層，並讓服藥畫面從 context 取得佇列狀態與同步動作（issue #1228）。
所在層：src/features/medication/hooks；狀態生命週期跨越 tab、邀請畫面與設定精靈。
主要關聯：App.tsx、useMedicationQueueCoordinator、useMedicationPendingDoses、tests/unit/medicationQueueCoordinator.test.ts。
*/
import { createContext, useContext, type ReactNode } from 'react'
import { useMedicationQueueCoordinator, type MedicationQueueCoordinator } from './useMedicationQueueCoordinator'

export const MedicationQueueContext = createContext<MedicationQueueCoordinator | null>(null)

export function MedicationQueueProvider({ patientId, userEmail, children }: {
  patientId: string
  userEmail?: string
  children: ReactNode
}) {
  const value = useMedicationQueueCoordinator({ patientId, userEmail })
  return <MedicationQueueContext.Provider value={value}>{children}</MedicationQueueContext.Provider>
}

export function useMedicationQueue(): MedicationQueueCoordinator {
  const value = useContext(MedicationQueueContext)
  if (typeof value?.retryNow !== 'function') {
    throw new Error(
      'useMedicationQueue() requires a <MedicationQueueProvider>. ' +
      'Without the shell-level coordinator, queued medication only re-sends while its section is open (issue #1228).',
    )
  }
  return value
}
