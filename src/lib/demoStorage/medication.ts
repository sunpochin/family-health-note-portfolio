/*
檔案用途：/demo 展示模式的藥物核心存取——藥單（plan）建立／調整／停用（含同一顆藥多個時段的批次停用／調劑量）、服藥紀錄（dose log）與服用方式 B 層指示。
所在層：src/lib/demoStorage；medication 核心領域，狀態透過 ./store 的共用 loadState／saveState 存取；
PRN 頓服藥事件另見 ./medicationPrn，避免這個檔案同時混雜例行藥單與頓服藥兩種語意。
主要關聯：由 lib/medication/medications.ts、lib/medication/medicationAdmin.ts、lib/medication/medicationInstructions.ts 經 demoStorage/index.ts 呼叫。
*/
import dayjs from 'dayjs'
import type { MedicationCatalog, MedicationIntakeLog, MedicationPlan, MedicationPlanChangeLog, PatientMedicationInstruction } from '../../types/database'
import { calendarDateKey, careDateKey } from '../careDay'
import type { AdminMedicationPlan, MedicationCorrectionInput, MedicationOption, MedicationPlanExpectedSnapshot, NewMedicationPlanInput } from '../medication/medicationAdmin'
import type { MedicationPlanChangeLogView, MedicationPlanView } from '../medication/medications'
import { DEMO_VISITOR_EMAIL, type DemoState, loadState, localId, saveState } from './store'

export interface DemoMedicationDay {
  // instruction（B 層）由呼叫端 readMedicationDay() 統一掛上，這裡不重複查一次 demo instruction store。
  plans: Omit<MedicationPlanView, 'instruction'>[]
  logs: MedicationIntakeLog[]
}

export interface DemoMedicationAdminData {
  plans: AdminMedicationPlan[]
  medications: MedicationOption[]
  changes: Array<MedicationPlanChangeLog & { patient_id: string }>
}

function medicationFor(state: DemoState, medicationId: string) {
  return state.medications.find(medication => medication.id === medicationId)
}

function demoMedicationCareDate(log: MedicationIntakeLog): string {
  // 繁體中文註解：舊 localStorage 沒有 care_date 時仍依真實時間推導，避免升級後凌晨紀錄消失。
  return log.care_date ?? careDateKey(dayjs(log.taken_at))
}

export function readDemoMedicationDay(patientId: string, date: string): DemoMedicationDay {
  const state = loadState()
  const medicationById = new Map(state.medications.map(medication => [medication.id, medication]))
  const plans = state.medicationPlans
    .filter(plan => plan.patient_id === patientId && plan.active)
    .flatMap(plan => {
      const medication = medicationById.get(plan.medication_id)
      return medication ? [{ ...plan, medication }] : []
    })
  return {
    plans,
    logs: state.medicationLogs.filter(log => log.patient_id === patientId && demoMedicationCareDate(log) === date),
  }
}

export function readDemoMedicationAdminData(patientId: string): DemoMedicationAdminData {
  const state = loadState()
  return {
    plans: state.medicationPlans.filter(plan => plan.patient_id === patientId) as AdminMedicationPlan[],
    // Admin adapter 需要來源欄位；fallback 主檔沒有官方來源時明確填 null，避免把不完整型別硬塞給表單。
    medications: state.medications.map(medication => ({ ...medication, catalog_source: null, catalog_source_id: null })) as MedicationOption[],
    changes: state.medicationChanges.filter(change => change.patient_id === patientId),
  }
}

export function readDemoMedicationHistory(patientId: string, limit = 20): MedicationPlanChangeLogView[] {
  const state = loadState()
  const medicationById = new Map(state.medications.map(medication => [medication.id, medication]))
  return state.medicationChanges
    .filter(change => change.patient_id === patientId)
    .sort((left, right) => Date.parse(right.created_at) - Date.parse(left.created_at))
    .slice(0, limit)
    .flatMap(change => {
      const medication = medicationById.get(change.medication_id)
      return medication ? [{ ...change, medication }] : []
    })
}

function appendMedicationChange(state: DemoState, plan: MedicationPlan, action: MedicationPlanChangeLog['action'], reason: string, actorEmail: string, beforePlan?: MedicationPlan, now = new Date().toISOString()): DemoState {
  const snapshot = (value: MedicationPlan) => ({
    plan_id: value.id, medication_id: value.medication_id, schedule_slot: value.schedule_slot, dose_amount: value.dose_amount,
    dose_count: value.dose_count, as_needed: value.as_needed, active: value.active,
  })
  const change: MedicationPlanChangeLog = {
    id: localId('change'),
    patient_id: plan.patient_id,
    action,
    plan_id: plan.id,
    medication_id: plan.medication_id,
    schedule_slot: plan.schedule_slot,
    dose_amount: plan.dose_amount,
    dose_count: plan.dose_count,
    as_needed: plan.as_needed,
    reason: reason.trim() || null,
    actor_email: actorEmail.trim().toLowerCase(),
    before_snapshot: beforePlan ? snapshot(beforePlan) : {},
    after_snapshot: snapshot(plan),
    recorded_at: now,
    effective_at: now,
    created_at: now,
  }
  return { ...state, medicationChanges: [change, ...state.medicationChanges] }
}

export function createDemoMedicationPlan(input: NewMedicationPlanInput, medicationId: string, patientId: string, reason: string, actorEmail = DEMO_VISITOR_EMAIL) {
  const state = loadState()
  const now = new Date().toISOString()
  const existingMedication = medicationFor(state, medicationId)
  const medication: MedicationCatalog = {
    id: medicationId,
    drug_product_id: existingMedication?.drug_product_id ?? null,
    brand_name: input.brandName.trim(),
    brand_name_zh: input.brandNameZh.trim() || null,
    brand_name_id: existingMedication?.brand_name_id ?? null,
    generic_name: input.genericName.trim() || input.brandName.trim(),
    strength_mg: input.strengthMg,
    strength_label: input.strengthLabel ?? existingMedication?.strength_label ?? null,
    product_kind: input.productKind ?? existingMedication?.product_kind ?? 'drug',
    dosage_form: input.dosageForm,
    specialties: existingMedication?.specialties ?? [],
    verification_status: existingMedication?.verification_status ?? 'unverified',
    tfda_license_number: existingMedication?.tfda_license_number ?? null,
    nhi_drug_code: existingMedication?.nhi_drug_code ?? null,
    appearance_note: existingMedication?.appearance_note ?? null,
    appearance_color: input.appearanceColor || null,
    appearance_shape: input.appearanceShape || null,
    appearance_photo_url: input.appearancePhotoUrl.trim() || null,
    created_at: existingMedication?.created_at ?? now,
  }
  const existingPlan = state.medicationPlans.find(plan => plan.patient_id === patientId && plan.medication_id === medicationId && plan.schedule_slot === input.scheduleSlot)
  const plan: MedicationPlan = existingPlan
    ? { ...existingPlan, account_email: actorEmail.trim().toLowerCase(), as_needed: input.asNeeded, dose_amount: input.doseAmount, dose_count: input.doseCount, active: true, display_order: Math.floor(Date.now() / 1_000) }
    : {
        id: localId('plan'), account_email: actorEmail.trim().toLowerCase(), patient_id: patientId, medication_id: medicationId,
        schedule_slot: input.scheduleSlot, as_needed: input.asNeeded, dose_amount: input.doseAmount, dose_count: input.doseCount,
        display_order: Math.floor(Date.now() / 1_000), active: true, created_at: now,
      }
  const planIndex = existingPlan ? state.medicationPlans.findIndex(item => item.id === existingPlan.id) : -1
  const medicationPlans = planIndex >= 0 ? state.medicationPlans.map((item, index) => index === planIndex ? plan : item) : [...state.medicationPlans, plan]
  saveState(appendMedicationChange({ ...state, medications: existingMedication ? state.medications.map(item => item.id === medicationId ? medication : item) : [...state.medications, medication], medicationPlans }, plan, existingPlan ? 'update' : 'create', reason, actorEmail, existingPlan))
}

export function addExistingDemoMedicationPlan(medicationId: string, patientId: string, scheduleSlot: string, doseAmount: number, asNeeded: boolean, reason = '', actorEmail = DEMO_VISITOR_EMAIL, planId?: string, medicationCorrection?: MedicationCorrectionInput) {
  const state = loadState()
  const medication = medicationFor(state, medicationId)
  if (!medication) throw new Error('Demo medication not found')
  const existingPlan = planId
    ? state.medicationPlans.find(plan => plan.id === planId && plan.patient_id === patientId)
    : state.medicationPlans.find(plan => plan.patient_id === patientId && plan.medication_id === medicationId && plan.schedule_slot === scheduleSlot)
  const plan: MedicationPlan = existingPlan
    // Demo 也要套用和正式 RPC 相同的 plan-id 語意；否則調整時段只會顯示成功，實際藥單仍保留舊藥與舊時段。
    ? { ...existingPlan, account_email: actorEmail.trim().toLowerCase(), medication_id: medicationId, schedule_slot: scheduleSlot, as_needed: asNeeded, dose_amount: doseAmount, active: true, display_order: Math.floor(Date.now() / 1_000) }
    : {
        id: localId('plan'), account_email: actorEmail.trim().toLowerCase(), patient_id: patientId, medication_id: medicationId,
        schedule_slot: scheduleSlot, as_needed: asNeeded, dose_amount: doseAmount, dose_count: 1, display_order: Math.floor(Date.now() / 1_000), active: true, created_at: new Date().toISOString(),
      }
  const planIndex = existingPlan ? state.medicationPlans.findIndex(item => item.id === existingPlan.id) : -1
  const medicationPlans = planIndex >= 0 ? state.medicationPlans.map((item, index) => index === planIndex ? plan : item) : [...state.medicationPlans, plan]
  // 修正資料只在有帶入時才覆寫，避免單純調整時段／劑量的呼叫誤把藥品外觀清空。
  const medications = medicationCorrection
    ? state.medications.map(item => item.id === medicationId ? {
        ...item,
        brand_name: medicationCorrection.brandName.trim() || item.brand_name,
        brand_name_zh: medicationCorrection.brandNameZh.trim() || item.brand_name_zh,
        generic_name: medicationCorrection.genericName.trim() || item.generic_name,
        strength_mg: medicationCorrection.strengthMg || item.strength_mg,
        dosage_form: medicationCorrection.dosageForm || item.dosage_form,
        appearance_color: medicationCorrection.appearanceColor || null,
        appearance_shape: medicationCorrection.appearanceShape || null,
        appearance_photo_url: medicationCorrection.appearancePhotoUrl.trim() || null,
      } : item)
    : state.medications
  saveState(appendMedicationChange({ ...state, medicationPlans, medications }, plan, existingPlan ? 'update' : 'create', reason, actorEmail, existingPlan))
}

export function deactivateDemoMedicationPlan(planId: string, patientId: string, reason = '', actorEmail = DEMO_VISITOR_EMAIL) {
  const state = loadState()
  const plan = state.medicationPlans.find(item => item.id === planId && item.patient_id === patientId)
  if (!plan) throw new Error('Demo medication plan not found')
  const nextPlan = { ...plan, active: false }
  const medicationPlans = state.medicationPlans.map(item => item.id === planId ? nextPlan : item)
  saveState(appendMedicationChange({ ...state, medicationPlans }, nextPlan, 'deactivate', reason, actorEmail))
}

// 對應正式 apply_medication_plan_batch_change（issue #1232）：同一顆藥的多個時段一次停用或調劑量。
// 拒絕條件與錯誤訊息跟 RPC 一致，讓 /demo 也能重現「混到另一顆藥就整批不動」；
// 全部驗證完才 saveState 一次，等同正式環境的整批 rollback。
export function applyDemoMedicationPlanBatchChange(action: 'update' | 'deactivate', patientId: string, medicationId: string, planIds: string[], rawDoseAmount: number | null, reason = '', actorEmail = DEMO_VISITOR_EMAIL, expectedPlans?: MedicationPlanExpectedSnapshot[], expectAllSchedules = false): number {
  // 比照 RPC 先捨入到 numeric(8,3)：否則 0.0004 在 demo 被接受、正式環境卻被拒絕；1.0004 在 demo 寫出變更、正式環境卻是沒變。
  // 用指數字串位移而不是 x * 1000：0.5005 * 1000 在二進位浮點是 500.4999…，會捨成 0.5，
  // 但 PostgreSQL 的 round(numeric, 3) 以十進位計算得到 0.501。'0.5005e3' 由字串解析，會精確得到 500.5。
  // 1e-7 這類指數寫法會變成 NaN，下面的 > 0 檢查會把它當成缺少劑量拒絕；RPC 會把它捨成 0，一樣拒絕。
  const doseAmount = rawDoseAmount === null ? null : Number(`${Math.round(Number(`${rawDoseAmount}e3`))}e-3`)
  if (planIds.length < 1 || planIds.length > 11 || new Set(planIds).size !== planIds.length) throw new Error('Invalid medication plan batch change')
  if (expectedPlans && expectedPlans.length !== planIds.length) throw new Error('Invalid medication plan batch change')
  if (action === 'update' && (doseAmount === null || !(doseAmount > 0))) throw new Error('Medication plan batch change is incomplete')
  if (action === 'deactivate' && doseAmount !== null) throw new Error('Invalid medication plan batch change')
  const state = loadState()
  const targets = state.medicationPlans.filter(plan => planIds.includes(plan.id) && plan.patient_id === patientId)
  if (targets.length !== planIds.length || targets.some(plan => plan.medication_id !== medicationId || !plan.active)) {
    throw new Error('Medication plan batch does not match this medication')
  }
  // 比照正式 RPC 在鎖列時比對 expectedPlans 快照（時段、劑量、dose_count、active、as_needed）：
  // 防止過期寫入覆蓋其他照護者的新醫囑，任一不符整批拒絕。
  if (expectedPlans) {
    for (const expected of expectedPlans) {
      const match = targets.find(item => item.id === expected.id)
      if (
        !match ||
        match.schedule_slot !== expected.schedule_slot ||
        match.dose_amount !== expected.dose_amount ||
        match.dose_count !== expected.dose_count ||
        match.active !== expected.active ||
        match.as_needed !== expected.as_needed
      ) {
        throw new Error('Medication plan batch does not match this medication')
      }
    }
  }
  // 全選須與目前完整固定群組吻合；只比較 selected 會讓新增時段在「全部停用」後仍生效。
  if (expectAllSchedules) {
    const currentGroup = state.medicationPlans.filter(plan => plan.patient_id === patientId && plan.medication_id === medicationId && plan.active && !plan.as_needed)
    if (currentGroup.length !== planIds.length || currentGroup.some(plan => !planIds.includes(plan.id))) {
      throw new Error('Medication plan batch does not match this medication')
    }
  }
  // 同一批共用一個時間戳，跟正式環境同一個 transaction 的 recorded_at 相同，時間線才能用同一組 key 摺疊。
  const now = new Date().toISOString()
  let nextState = state
  let changed = 0
  for (const plan of [...targets].sort((left, right) => left.id.localeCompare(right.id))) {
    // 劑量已相同的時段不寫，避免時間線出現「1 顆 → 1 顆」的假變更（與 RPC 一致）。
    if (action === 'update' && plan.dose_amount === doseAmount) continue
    const nextPlan: MedicationPlan = action === 'update'
      ? { ...plan, account_email: actorEmail.trim().toLowerCase(), dose_amount: doseAmount as number, display_order: Math.floor(Date.now() / 1_000) }
      : { ...plan, active: false }
    nextState = appendMedicationChange({ ...nextState, medicationPlans: nextState.medicationPlans.map(item => item.id === plan.id ? nextPlan : item) }, nextPlan, action, reason, actorEmail, plan, now)
    changed += 1
  }
  if (changed > 0) saveState(nextState)
  return changed
}

export function saveDemoMedicationDose(plan: MedicationPlanView, date: string, doseNumber: number, recordedByEmail: string): MedicationIntakeLog {
  const state = loadState()
  const existing = state.medicationLogs.find(log => log.patient_id === plan.patient_id && log.plan_id === plan.id && demoMedicationCareDate(log) === date && log.dose_number === doseNumber)
  if (existing) return existing
  const now = new Date().toISOString()
  const nowDay = dayjs(now)
  const log: MedicationIntakeLog = {
    id: `demo-intake-${plan.id}-${date}-${doseNumber}`,
    account_email: recordedByEmail.trim().toLowerCase(),
    patient_id: plan.patient_id,
    medication_id: plan.medication_id,
    medication_name: plan.medication.brand_name,
    plan_id: plan.id,
    dose_number: doseNumber,
    // Demo 可固定指定照護日來重播故事；正式 Supabase 仍由 trigger 依 taken_at 強制計算。
    care_date: date,
    taken_on: calendarDateKey(nowDay),
    taken_at: now,
    created_at: now,
  }
  saveState({ ...state, medicationLogs: [...state.medicationLogs, log] })
  return log
}

export function clearDemoMedicationDose(planId: string, patientId: string, date: string, doseNumber: number) {
  const state = loadState()
  const medicationLogs = state.medicationLogs.filter(log => !(log.patient_id === patientId && log.plan_id === planId && demoMedicationCareDate(log) === date && log.dose_number === doseNumber))
  if (medicationLogs.length === state.medicationLogs.length) return false
  saveState({ ...state, medicationLogs })
  return true
}

export function readDemoPatientMedicationInstructions(patientId: string): PatientMedicationInstruction[] {
  return (loadState().patientMedicationInstructions ?? []).filter(instruction => instruction.patient_id === patientId)
}

type DemoPatientMedicationInstructionInsert = Pick<PatientMedicationInstruction, 'patient_id' | 'medication_id' | 'instruction_codes' | 'instruction_note' | 'source' | 'confirmed_on'>

export function saveDemoPatientMedicationInstruction(payload: DemoPatientMedicationInstructionInsert): PatientMedicationInstruction {
  const state = loadState()
  const now = new Date().toISOString()
  // 正式表主鍵是 (patient_id, medication_id)；demo 也必須是同一顆藥覆寫同一筆，而不是疊加成好幾筆歷史紀錄。
  const instruction: PatientMedicationInstruction = { ...payload, updated_by: DEMO_VISITOR_EMAIL, updated_at: now }
  const existing = state.patientMedicationInstructions ?? []
  const withoutCurrent = existing.filter(item => !(item.patient_id === payload.patient_id && item.medication_id === payload.medication_id))
  saveState({ ...state, patientMedicationInstructions: [...withoutCurrent, instruction] })
  return instruction
}

export function clearDemoPatientMedicationInstruction(patientId: string, medicationId: string): void {
  const state = loadState()
  const remaining = (state.patientMedicationInstructions ?? []).filter(item => !(item.patient_id === patientId && item.medication_id === medicationId))
  saveState({ ...state, patientMedicationInstructions: remaining })
}
