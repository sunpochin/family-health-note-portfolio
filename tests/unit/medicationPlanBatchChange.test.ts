/*
檔案用途：驗證「同一顆藥多個時段一次停用／調劑量」（issue #1232）的前端資料層：
  正式環境只送一次批次 RPC（不是逐筆迴圈），參數形狀正確；/demo 模式走 localStorage 且與 RPC 同樣整批驗證。
所在層：tests/unit；Supabase 以 mock 取代，不連真實資料庫。RPC 本身的授權與原子性由 supabase/tests/rls-authorization.sql 驗證。
主要關聯：src/lib/medication/medicationAdmin.ts（applyMedicationPlanBatchChange）、src/lib/demoStorage/medication.ts。
*/
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { DEMO_MEILING_PATIENT_ID } from '../../src/lib/demoData'

const rpcCalls: Array<{ name: string; args: unknown }> = []
let rpcResponse: { data: unknown; error: unknown } = { data: 3, error: null }

mock.module('../../src/lib/supabase', () => ({
  supabase: {
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args })
      return Promise.resolve(rpcResponse)
    },
    from: () => { throw new Error('batch change must not write tables directly') },
  },
}))

const { addExistingMedicationPlan, applyMedicationPlanBatchChange, readMedicationAdminData } = await import('../../src/lib/medication/medicationAdmin')

const originalWindow = globalThis.window
const values = new Map<string, string>()

function useWindowAt(pathname: string) {
  globalThis.window = {
    location: { pathname },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => values.delete(key),
    },
  } as unknown as Window & typeof globalThis
}

beforeEach(() => {
  rpcCalls.length = 0
  rpcResponse = { data: 3, error: null }
  values.clear()
})

afterEach(() => {
  if (originalWindow) globalThis.window = originalWindow
  else delete (globalThis as { window?: Window & typeof globalThis }).window
})

describe('applyMedicationPlanBatchChange against Supabase', () => {
  beforeEach(() => useWindowAt('/medication'))

  test('sends one batch RPC for the whole medication instead of one call per slot', async () => {
    const changed = await applyMedicationPlanBatchChange({
      action: 'deactivate', patientId: 'patient-1', medicationId: 'med-x', planIds: ['p1', 'p2', 'p3'], reason: '  醫師停藥  ',
    })
    expect(changed).toBe(3)
    expect(rpcCalls).toEqual([{
      name: 'apply_medication_plan_batch_change',
      args: { p_action: 'deactivate', p_patient_id: 'patient-1', p_medication_id: 'med-x', p_plan_ids: ['p1', 'p2', 'p3'], p_reason: '醫師停藥' },
    }])
  })

  test('only sends a dose for update, so a stray dose never reaches a deactivate call', async () => {
    await applyMedicationPlanBatchChange({ action: 'update', patientId: 'patient-1', medicationId: 'med-x', planIds: ['p1'], doseAmount: 0.75 })
    await applyMedicationPlanBatchChange({ action: 'deactivate', patientId: 'patient-1', medicationId: 'med-x', planIds: ['p1'], doseAmount: 2 })
    expect(rpcCalls[0].args).toMatchObject({ p_action: 'update', p_dose_amount: 0.75 })
    expect(rpcCalls[1].args).not.toHaveProperty('p_dose_amount')
  })

  test.each(['update', 'deactivate'] as const)('forwards full-group intent for %s and preserves explicit partial selection', async action => {
    for (const expectAllSchedules of [true, false]) {
      await applyMedicationPlanBatchChange({ action, patientId: 'patient-1', medicationId: 'med-x', planIds: ['p1'], doseAmount: 2, expectAllSchedules })
      expect(rpcCalls.at(-1)?.args).toMatchObject({ p_expect_all_schedules: expectAllSchedules })
    }
  })

  test('surfaces the RPC error instead of reporting success', async () => {
    rpcResponse = { data: null, error: new Error('Medication plan batch does not match this medication') }
    await expect(applyMedicationPlanBatchChange({ action: 'deactivate', patientId: 'patient-1', medicationId: 'med-x', planIds: ['p1'] }))
      .rejects.toThrow('Medication plan batch does not match this medication')
  })

  test('forwards expectedPlans snapshot for optimistic concurrency checking', async () => {
    const expectedPlans = [{ id: 'p1', schedule_slot: 'morning', dose_amount: 1, dose_count: 1, active: true, as_needed: false }]
    await applyMedicationPlanBatchChange({
      action: 'update',
      patientId: 'patient-1',
      medicationId: 'med-x',
      planIds: ['p1'],
      doseAmount: 2,
      expectedPlans,
    })
    expect(rpcCalls[0].args).toMatchObject({
      p_expected_plans: expectedPlans,
    })
  })
})

describe('applyMedicationPlanBatchChange in /demo', () => {
  beforeEach(() => useWindowAt('/demo'))

  async function medicationWithTwoSlots() {
    const before = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    const plan = before.plans.find(item => item.active && !item.as_needed)
    expect(plan).toBeDefined()
    const otherSlot = plan!.schedule_slot === 'before_bed' ? 'after_breakfast' : 'before_bed'
    await addExistingMedicationPlan(plan!.medication_id, DEMO_MEILING_PATIENT_ID, otherSlot, plan!.dose_amount, false, 'second slot')
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    const plans = after.plans.filter(item => item.active && item.medication_id === plan!.medication_id)
    expect(plans.length).toBeGreaterThanOrEqual(2)
    return { medicationId: plan!.medication_id, plans, otherMedicationPlan: after.plans.find(item => item.active && item.medication_id !== plan!.medication_id) }
  }

  test('deactivates every selected slot at once without calling Supabase', async () => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const changed = await applyMedicationPlanBatchChange({ action: 'deactivate', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: plans.map(plan => plan.id) })
    expect(changed).toBe(plans.length)
    expect(rpcCalls).toEqual([])
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(after.plans.filter(plan => plan.medication_id === medicationId && plan.active)).toEqual([])
  })

  test.each(['update', 'deactivate'] as const)('rejects all-schedules %s after a new fixed slot without changing plans or audit', async action => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const nextSlot = ['morning', 'after_lunch', 'before_dinner'].find(slot => !plans.some(plan => plan.schedule_slot === slot))!
    await addExistingMedicationPlan(medicationId, DEMO_MEILING_PATIENT_ID, nextSlot, 1, false, 'new fixed slot')
    const before = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    await expect(applyMedicationPlanBatchChange({
      action, patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: plans.map(plan => plan.id),
      expectedPlans: plans, expectAllSchedules: true, doseAmount: 0.25,
    })).rejects.toThrow('Medication plan batch does not match this medication')
    expect(await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)).toEqual(before)
  })

  test.each(['update', 'deactivate'] as const)('partial %s leaves newly added and unselected slots untouched', async action => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const nextSlot = ['morning', 'after_lunch', 'before_dinner'].find(slot => !plans.some(plan => plan.schedule_slot === slot))!
    await addExistingMedicationPlan(medicationId, DEMO_MEILING_PATIENT_ID, nextSlot, 1, false, 'new fixed slot')
    const before = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    const selected = plans[0]
    expect(await applyMedicationPlanBatchChange({
      action, patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [selected.id],
      expectedPlans: [selected], expectAllSchedules: false, doseAmount: selected.dose_amount + 0.25,
    })).toBe(1)
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(after.plans.filter(plan => plan.id !== selected.id)).toEqual(before.plans.filter(plan => plan.id !== selected.id))
    expect(after.changes.length).toBe(before.changes.length + 1)
  })

  test.each(['update', 'deactivate'] as const)('all-schedules %s ignores PRN and other medication groups', async action => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    await addExistingMedicationPlan(medicationId, DEMO_MEILING_PATIENT_ID, 'anytime', 1, true, 'PRN remains separate')
    const before = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(await applyMedicationPlanBatchChange({
      action, patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: plans.map(plan => plan.id),
      expectedPlans: plans, expectAllSchedules: true, doseAmount: 0.25,
    })).toBe(plans.length)
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(after.plans.filter(plan => !plans.some(selected => selected.id === plan.id)))
      .toEqual(before.plans.filter(plan => !plans.some(selected => selected.id === plan.id)))
  })

  test.each(['schedule_slot', 'dose_amount', 'dose_count', 'active', 'as_needed'] as const)('rejects a stale %s snapshot without changing any plan or audit row', async field => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const before = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    const expectedPlans = plans.map(({ id, schedule_slot, dose_amount, dose_count, active, as_needed }) =>
      ({ id, schedule_slot, dose_amount, dose_count, active, as_needed }))
    // 故意讓最後一筆才不吻合，才能抓到「前面已寫入才發現衝突」造成的部分成功。
    const stale = expectedPlans.at(-1)!
    if (field === 'schedule_slot') stale.schedule_slot = 'fixture-stale-slot'
    else if (field === 'dose_amount') stale.dose_amount += 0.25
    else if (field === 'dose_count') stale.dose_count += 1
    else stale[field] = !stale[field]
    await expect(applyMedicationPlanBatchChange({
      action: 'deactivate', patientId: DEMO_MEILING_PATIENT_ID, medicationId,
      planIds: plans.map(plan => plan.id), expectedPlans,
    })).rejects.toThrow('Medication plan batch does not match this medication')
    expect(await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)).toEqual(before)
    expect(rpcCalls).toEqual([])
  })

  test.each(['update', 'deactivate'] as const)('replaying a confirmed %s cannot append another change', async action => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const input = {
      action, patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: plans.map(plan => plan.id),
      expectedPlans: plans.map(({ id, schedule_slot, dose_amount, dose_count, active, as_needed }) =>
        ({ id, schedule_slot, dose_amount, dose_count, active, as_needed })),
      ...(action === 'update' ? { doseAmount: plans[0].dose_amount + 0.25 } : {}),
    }
    await applyMedicationPlanBatchChange(input)
    const saved = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    // 重播同一份確認快照必須拒絕，不能把同一次醫囑記成第二次調藥。
    await expect(applyMedicationPlanBatchChange(input)).rejects.toThrow('Medication plan batch does not match this medication')
    expect(await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)).toEqual(saved)
  })

  test('adjusts only the selected slots, keeps dose_count and skips slots already at that dose', async () => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const [first, second] = plans
    const changed = await applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [first.id], doseAmount: first.dose_amount + 0.25 })
    expect(changed).toBe(1)
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    const updated = after.plans.find(plan => plan.id === first.id)
    expect(updated?.dose_amount).toBe(first.dose_amount + 0.25)
    expect(updated?.dose_count).toBe(first.dose_count)
    expect(after.plans.find(plan => plan.id === second.id)?.dose_amount).toBe(second.dose_amount)

    // 再送一次同樣的劑量：沒有任何時段需要改，回傳 0，也不新增稽核。
    const changesBefore = after.changes.length
    expect(await applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [first.id], doseAmount: first.dose_amount + 0.25 })).toBe(0)
    expect((await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)).changes.length).toBe(changesBefore)
  })

  test('rejects the whole batch when another medication is mixed in, leaving every slot untouched', async () => {
    const { medicationId, plans, otherMedicationPlan } = await medicationWithTwoSlots()
    expect(otherMedicationPlan).toBeDefined()
    await expect(applyMedicationPlanBatchChange({
      action: 'deactivate', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [...plans.map(plan => plan.id), otherMedicationPlan!.id],
    })).rejects.toThrow('Medication plan batch does not match this medication')
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(after.plans.filter(plan => plan.medication_id === medicationId && plan.active).length).toBe(plans.length)
  })

  test('rounds the dose to three decimals like the RPC before validating and comparing', async () => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    const [first] = plans
    // 捨入後等於原劑量 → 沒變；捨入後是 0 → 視為缺少劑量，跟正式 RPC 一樣拒絕。
    expect(await applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [first.id], doseAmount: first.dose_amount + 0.0004 })).toBe(0)
    await expect(applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [first.id], doseAmount: 0.0004 }))
      .rejects.toThrow('Medication plan batch change is incomplete')
  })

  test('rounds decimal midpoints like PostgreSQL numeric, not like binary floating point', async () => {
    // 0.5005 * 1000 在浮點是 500.4999…；PostgreSQL round(0.5005, 3) = 0.501，demo 必須存成同一個值。
    const { medicationId, plans } = await medicationWithTwoSlots()
    const [first] = plans
    expect(await applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [first.id], doseAmount: 0.5005 })).toBe(1)
    const after = await readMedicationAdminData(DEMO_MEILING_PATIENT_ID)
    expect(after.plans.find(plan => plan.id === first.id)?.dose_amount).toBe(0.501)
  })

  test('rejects duplicate ids and a dose on deactivate, matching the RPC', async () => {
    const { medicationId, plans } = await medicationWithTwoSlots()
    await expect(applyMedicationPlanBatchChange({ action: 'deactivate', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [plans[0].id, plans[0].id] }))
      .rejects.toThrow('Invalid medication plan batch change')
    await expect(applyMedicationPlanBatchChange({ action: 'update', patientId: DEMO_MEILING_PATIENT_ID, medicationId, planIds: [plans[0].id] }))
      .rejects.toThrow('Medication plan batch change is incomplete')
  })
})
