/*
檔案用途：驗證服藥打卡藥卡如何呈現離線佇列裡的劑次：算作已服用、虛線框與「待同步・點擊取消」標示、正在送出時停用並顯示「同步中…」（issue #822）。
所在層：tests/unit；以最小 hook 執行環境呼叫元件取得元素樹，不啟動瀏覽器。
主要關聯：src/features/medication/components/MedicationSlotCard.tsx、src/lib/medication/medicationPendingQueue.ts。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import type { MedicationIntakeLog } from '../../src/types/database'

installReactHookHarness()

const actualI18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ text: (item: { zh: string }) => item.zh, locale: 'zh', setLocale: () => {} }),
}))

const { MedicationSlotCard } = await import('../../src/features/medication/components/MedicationSlotCard')
const { buildPendingMedicationDose, pendingMedicationDoseToLog } = await import('../../src/lib/medication/medicationPendingQueue')
import type { MedicationPlanView } from '../../src/lib/medication/medications'

const plan = {
  id: 'plan-morning', account_email: 'owner@example.com', patient_id: 'patient-a', medication_id: 'norvasc-5',
  schedule_slot: 'morning', as_needed: false, dose_amount: 1, dose_count: 2, display_order: 10, active: true,
  created_at: '2026-07-11T00:00:00.000Z',
  medication: { id: 'norvasc-5', brand_name: 'Norvasc', brand_name_zh: '脈優', generic_name: 'amlodipine', strength_mg: 5, dosage_form: 'tablet', atc_code: null },
  instruction: null,
} as unknown as MedicationPlanView

const pendingLog = pendingMedicationDoseToLog(buildPendingMedicationDose(plan, 1, 'care@example.com', '2026-10-06T00:00:00.000Z'))
const serverLog: MedicationIntakeLog = { ...pendingLog, id: 'row-2', dose_number: 2 }

const render = (syncingDoseKey: string | null = null, refreshingDoseKeys?: ReadonlySet<string>, slotPlan = plan) => renderHook(() => MedicationSlotCard({
  careDate: '2026-10-10',
  onHoldRefresh: () => {},
  slot: 'morning', slotPlans: [slotPlan], progress: { doseTaken: 2, doseTotal: 2, quantity: { id: '', zh: '', en: '' } },
  collapsed: false, completed: true, busyKey: '', syncingDoseKey, refreshingDoseKeys, logs: [pendingLog, serverLog], locale: 'zh', nameEnglishFirst: true,
  onToggleCollapse: () => {}, onToggleDose: () => {},
})).current

const doseButtons = (tree: unknown) => findAll(tree, node => node.type === 'button' && node.props['aria-pressed'] !== undefined)

describe('MedicationSlotCard pending sync (issue #822)', () => {
  test('a queued dose counts as taken but is visibly marked as waiting to sync and still cancellable', () => {
    const [pending, saved] = doseButtons(render())
    expect(pending.props['aria-pressed']).toBe(true)
    expect(String(pending.props.className)).toContain('border-dashed')
    expect(textContent(pending)).toContain('08:00')
    expect(textContent(pending)).toContain('待同步・點擊取消')
    expect(pending.props.disabled).toBe(false)

    // 已存進伺服器的劑次維持原樣，看護才分得出哪一筆家人那邊也看得到。
    expect(String(saved.props.className)).not.toContain('border-dashed')
    expect(textContent(saved)).toContain('點擊取消')
    expect(textContent(saved)).not.toContain('待同步')
  })

  test('the dose being sent is disabled and says it is syncing', () => {
    const [pending, saved] = doseButtons(render('plan-morning:1'))
    expect(pending.props.disabled).toBe(true)
    expect(textContent(pending)).toContain('同步中…')
    expect(saved.props.disabled).toBe(false)
  })
  test('all peer-drained doses remain taken and disabled until their authoritative read finishes', () => {
    const buttons = doseButtons(render(null, new Set(['plan-morning:1', 'plan-morning:2'])))
    expect(buttons).toHaveLength(2)
    expect(buttons.every(button => button.props.disabled && button.props['aria-pressed'])).toBe(true)
  })

  test('conditional cards also disable every action while their projection is awaiting refresh', () => {
    // 條件藥另有補記事實與更正按鈕；停用原生 fieldset 才能涵蓋整張卡，不能只鎖 routine 按鈕。
    const conditional = { ...plan, holdContext: {} } as MedicationPlanView
    const fields = findAll(render(null, new Set(['plan-morning:1', 'plan-morning:2']), conditional), node => node.type === 'fieldset')
    expect(fields).toHaveLength(2)
    expect(fields.every(field => field.props.disabled)).toBe(true)
  })

})
