/*
檔案用途：驗證批次排藥確認、病人切換、重複提交及讀寫失敗的行為。
所在層：tests/unit；以 hook harness 執行非同步流程，RPC 使用虛構替身。
主要關聯：useMedicationPlanBatchForm、medicationPlanBatchChange.test.ts。
*/
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { AdminMedicationPlan, MedicationOption, MedicationPlanBatchChangeInput } from '../../src/lib/medication/medicationAdmin'
import { medicationErrorStatus } from '../../src/lib/medication/medicationAdminFormHelpers'

installReactHookHarness()
let confirmResult: (accepted: boolean) => void
let confirmMessages: string[]
const calls: MedicationPlanBatchChangeInput[] = []
let write: () => Promise<number>
mock.module('../../src/hooks/useConfirm', () => ({ useConfirm: () => ({ dialog: null,
  confirm: (message: string) => { confirmMessages.push(message); return new Promise<boolean>(resolve => { confirmResult = resolve }) },
}) }))
mock.module('../../src/lib/medication/medicationAdmin', () => ({
  applyMedicationPlanBatchChange: (input: MedicationPlanBatchChangeInput) => { calls.push(input); return write() },
}))
const { useMedicationPlanBatchForm } = await import('../../src/features/medication/hooks/useMedicationPlanBatchForm')

const plans: AdminMedicationPlan[] = ['after_breakfast', 'after_lunch', 'after_dinner'].map((schedule_slot, i) => ({
  id: `plan-${i}`, patient_id: 'patient-a', medication_id: 'med-a', account_email: 'owner@example.test',
  schedule_slot, dose_amount: i === 2 ? 0.5 : 1, dose_count: 1, active: true, as_needed: false, display_order: i,
}))
const medication = { id: 'med-a', brand_name: 'FixtureMed', brand_name_zh: '測試藥', strength_mg: 10, strength_label: null, dosage_form: 'tablet' } as MedicationOption
const unmounts: (() => void)[] = []
function setup(locale: 'zh' | 'id' | 'en' = 'zh') {
  const state = { patientId: 'patient-a', plans, canEditSubject: true, saving: false, refreshes: 0, notifications: 0, refreshFails: false }
  const view = renderHook(() => useMedicationPlanBatchForm({ ...state,
    medicationById: new Map([['med-a', medication]]), setSaving: value => { state.saving = value },
    refresh: async () => { state.refreshes++; if (state.refreshFails) throw new Error('fixture read failure') },
    onMedicationPlanChanged: () => { state.notifications++ },
  }), { defaultContext: { locale, setLocale: () => {} } })
  unmounts.push(view.unmount)
  view.act(() => view.current.open('med-a'))
  return { view, state }
}
beforeEach(() => { calls.length = 0; confirmMessages = []; write = async () => 3 })
afterEach(() => { unmounts.splice(0).forEach(unmount => unmount()) })

describe('batch medication form', () => {
  test('defaults to every schedule, confirms before writing and ignores repeated clicks', async () => {
    const { view, state } = setup()
    expect(view.current.selectedIds).toEqual(plans.map(plan => plan.id))
    expect(view.current.dose).toBe('')
    const pending = view.current.submit('deactivate', '虛構病人')
    await view.current.submit('deactivate', '虛構病人')
    expect(confirmMessages).toHaveLength(1)
    expect(calls).toHaveLength(0)
    expect(confirmMessages[0]).toContain('今天已記錄的服藥不受影響')
    expect(confirmMessages[0].match(/→ 停用/g)).toHaveLength(3)
    confirmResult(true)
    await pending
    expect(calls[0]).toMatchObject({ action: 'deactivate', patientId: 'patient-a', medicationId: 'med-a', planIds: ['plan-0', 'plan-1', 'plan-2'], expectAllSchedules: true, reason: '' })
    expect(calls[0].expectedPlans).toHaveLength(3)
    expect(state.refreshes).toBe(1)
    expect(state.notifications).toBe(1)
    expect(view.current.group).toBeNull()
    expect(state.saving).toBe(false)
  })

  test('only selected schedules are sent with a quarter-step dose and a reason', async () => {
    const { view } = setup()
    view.act(() => { view.current.toggle('plan-1'); view.current.setDose('0.75'); view.current.setReason('fixture order') })
    const pending = view.current.submit('update', '虛構病人')
    expect(confirmMessages[0].match(/→/g)).toHaveLength(2)
    confirmResult(true)
    await pending
    expect(calls[0]).toMatchObject({ action: 'update', planIds: ['plan-0', 'plan-2'], doseAmount: 0.75, expectAllSchedules: false, reason: 'fixture order' })
  })

  test('cancelling, empty selections and invalid doses never call RPC', async () => {
    const { view } = setup()
    await view.current.submit('update', '虛構病人')
    expect(confirmMessages).toHaveLength(0)
    view.act(() => view.current.setDose('0.3'))
    await view.current.submit('update', '虛構病人')
    view.act(() => plans.forEach(plan => view.current.toggle(plan.id)))
    await view.current.submit('deactivate', '虛構病人')
    expect(confirmMessages).toHaveLength(0)
    view.act(() => view.current.toggle('plan-0'))
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(false)
    await pending
    expect(calls).toHaveLength(0)
  })

  test.each(['patient', 'unmount', 'permission', 'plan'] as const)('rejects confirmation after %s changes', async change => {
    const { view, state } = setup()
    const pending = view.current.submit('deactivate', '虛構病人')
    if (change === 'unmount') view.unmount()
    else {
      if (change === 'patient') state.patientId = 'patient-b'
      if (change === 'permission') state.canEditSubject = false
      if (change === 'plan') state.plans = plans.map(plan => ({ ...plan, dose_amount: 2 }))
      view.rerender()
    }
    confirmResult(true)
    await pending
    expect(calls).toHaveLength(0)
  })

  test('a late response invalidates the parent list without updating the unmounted form', async () => {
    const { view, state } = setup()
    let resolveWrite!: (count: number) => void
    write = () => new Promise(resolve => { resolveWrite = resolve })
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    view.unmount()
    resolveWrite(3)
    await pending
    expect(state.refreshes).toBe(0)
    expect(state.notifications).toBe(1)
  })

  test('read failure after successful write is reported as saved, with no retry', async () => {
    const { view, state } = setup()
    state.refreshFails = true
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await pending
    expect(view.current.message).toContain('已完成 3 個時段')
    expect(view.current.message).toContain('重新讀取失敗')
    expect(calls).toHaveLength(1)
    expect(state.notifications).toBe(1)
  })

  test('server rejection reloads the list and shows a translated conflict instead of success', async () => {
    const { view, state } = setup()
    write = async () => { throw { message: 'Medication plan batch does not match this medication' } }
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await pending
    expect(view.current.status).toBe('err')
    expect(view.current.message).toBe('藥單已變更，請重新讀取並核對時段後再試。')
    expect(state.refreshes).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test.each(['ok', 'err'] as const)('another write clears the old batch %s result permanently', async result => {
    const { view, state } = setup()
    if (result === 'err') write = async () => { throw { message: 'Medication plan batch does not match this medication' } }
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await pending
    // harness 的 setSaving 只更新父層參數；補上 finally 解鎖後真正 React 會做的父層重繪。
    view.rerender()
    expect(view.current.status).toBe(result)
    // 單筆操作只共用 saving；必須清掉舊批次結果，而非寫完後又把舊錯誤顯示回來。
    state.saving = true
    view.rerender()
    expect(view.current.status).toBe('idle')
    expect(view.current.message).toBe('')
    state.saving = false
    view.rerender()
    expect(view.current.status).toBe('idle')
    expect(view.current.message).toBe('')
  })

  test('load-disabled state keeps the batch verification warning visible', async () => {
    const { view, state } = setup()
    state.refreshFails = true
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await pending
    state.canEditSubject = false
    view.rerender()
    expect(view.current.status).toBe('err')
    expect(view.current.message).toContain('已完成 3 個時段')
    expect(view.current.message).toContain('重新讀取失敗')
  })

  test('all-selected confirmation rejects a newly visible fixed schedule before sending', async () => {
    const { view, state } = setup()
    const pending = view.current.submit('deactivate', '虛構病人')
    state.plans = [...plans, { ...plans[0], id: 'plan-new', schedule_slot: 'before_bed' }]
    view.rerender()
    confirmResult(true)
    await pending
    expect(calls).toHaveLength(0)
    expect(view.current.status).toBe('err')
    expect(view.current.message).toContain('藥單已變更')
  })

  test('partial selection leaves newly visible schedules outside the change', async () => {
    const { view, state } = setup()
    view.act(() => view.current.toggle('plan-1'))
    const pending = view.current.submit('deactivate', '虛構病人')
    state.plans = [...plans, { ...plans[0], id: 'plan-new', schedule_slot: 'before_bed' }]
    view.rerender()
    confirmResult(true)
    await pending
    expect(calls).toHaveLength(1)
    expect(calls[0].planIds).toEqual(['plan-0', 'plan-2'])
  })

  test('a lost write response and failed read keep an explicit verification warning without retrying', async () => {
    const { view, state } = setup()
    state.refreshFails = true
    write = async () => { throw new TypeError('fixture response lost') }
    const pending = view.current.submit('deactivate', '虛構病人')
    confirmResult(true)
    await pending
    // 寫入可能已提交，重讀也失敗時不能聲稱未變更，更不能自動重送調藥。
    expect(view.current.status).toBe('err')
    expect(view.current.message).toContain('無法確認變更結果，請重新整理藥單核對後再試。')
    expect(view.current.group).toBeNull()
    expect(calls).toHaveLength(1)
    expect(state.refreshes).toBe(1)
    expect(state.notifications).toBe(1)
    expect(state.saving).toBe(false)
  })

  test('an unchanged dose result is reported without claiming a new change', async () => {
    const { view } = setup()
    write = async () => 0
    view.act(() => view.current.setDose('1'))
    const pending = view.current.submit('update', '虛構病人')
    confirmResult(true)
    await pending
    expect(view.current.message).toContain('沒有變更')
  })

  test.each(['Invalid medication plan batch change', 'Medication plan batch change is incomplete', 'Medication plan batch does not match this medication'])('translates %s for all three locales', message => {
    const translated = medicationErrorStatus({ message }, { zh: '失敗', id: 'Gagal', en: 'Failed' })
    for (const locale of ['zh', 'id', 'en'] as const) {
      expect(translated[locale]).toBeTruthy()
      expect(translated[locale]).not.toContain(message)
    }
    expect(new Set(Object.values(translated)).size).toBe(3)
  })
})
