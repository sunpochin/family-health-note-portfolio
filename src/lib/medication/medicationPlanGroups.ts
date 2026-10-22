/*
檔案用途：將固定藥單按病人與藥品分組，供整顆藥操作共用。
所在層：src/lib/medication 純資料選擇器。
主要關聯：useMedicationPlanBatchForm、medicationAdmin 與 medicationSchedule。
*/
import type { AdminMedicationPlan } from './medicationAdmin'
import { compareMedicationSlots } from './medicationSchedule'

export interface MedicationPlanGroup {
  patientId: string
  medicationId: string
  plans: AdminMedicationPlan[]
}

export function groupPlansByMedication(plans: AdminMedicationPlan[]): MedicationPlanGroup[] {
  const groups = new Map<string, MedicationPlanGroup>()
  for (const plan of plans) {
    // 同一目錄藥品可被多位病人共用，不能只用 medication_id 合併；PRN 不屬於固定時段批次。
    if (!plan.active || plan.as_needed) continue
    const key = JSON.stringify([plan.patient_id, plan.medication_id])
    const group = groups.get(key) ?? { patientId: plan.patient_id, medicationId: plan.medication_id, plans: [] }
    group.plans.push(plan)
    groups.set(key, group)
  }
  return [...groups.values()].map(group => ({
    ...group,
    plans: [...group.plans].sort((a, b) => compareMedicationSlots(a.schedule_slot, b.schedule_slot)),
  }))
}
