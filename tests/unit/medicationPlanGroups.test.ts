/*
檔案用途：驗證整顆藥分組不混病人、不包含 PRN 或停用醫囑。
所在層：tests/unit；使用虛構藥單測試純選擇器。
主要關聯：medicationPlanGroups 與批次排藥表單。
*/
import { describe, expect, test } from 'bun:test'
import { groupPlansByMedication } from '../../src/lib/medication/medicationPlanGroups'
import type { AdminMedicationPlan } from '../../src/lib/medication/medicationAdmin'

const plan = (id: string, extra: Partial<AdminMedicationPlan> = {}): AdminMedicationPlan => ({
  id, patient_id: 'patient-a', medication_id: 'med-a', account_email: 'owner@example.test',
  schedule_slot: 'after_breakfast', dose_amount: 1, dose_count: 1, as_needed: false, active: true, display_order: 1, ...extra,
})

describe('groupPlansByMedication', () => {
  test('keeps patients and medications separate, filters non-scheduled plans and sorts without changing input', () => {
    const input = [plan('evening', { schedule_slot: 'after_dinner' }), plan('morning'),
      plan('other-patient', { patient_id: 'patient-b' }), plan('other-medication', { medication_id: 'med-b' }),
      plan('prn', { as_needed: true }), plan('inactive', { active: false })]
    const groups = groupPlansByMedication(input)
    expect(groups.map(group => [group.patientId, group.medicationId, group.plans.map(item => item.id)])).toEqual([
      ['patient-a', 'med-a', ['morning', 'evening']], ['patient-b', 'med-a', ['other-patient']], ['patient-a', 'med-b', ['other-medication']],
    ])
    expect(input[0].id).toBe('evening')
  })
})
