/*
檔案用途：鎖住 SubjectSwitcher 的 lockedReason（issue #1103）——血壓儲存進行中，病人切換器必須在每一種版型
（分段按鈕、下拉選單、找不到目前對象的退路按鈕）都真的無法切換，並以三種語言顯示原因；解鎖後恢復正常。
所在層：tests/unit；以 React hook harness 呼叫元件函式、檢查元素樹，不啟動瀏覽器。
主要關聯：src/components/ui/SubjectSwitcher.tsx、InputPage／DailyCarePage 的鎖定接線（bpSaveLocksPatientSwitch.test.ts）。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, fire, textContent } from './helpers/elementTree'
import type { PatientIdentity } from '../../src/lib/auth'
import type { Locale } from '../../src/lib/i18n'

installReactHookHarness()

const { SubjectSwitcher } = await import('../../src/components/ui/SubjectSwitcher')

const REASON = { id: 'alasan-sentinel', zh: '原因-sentinel', en: 'reason-sentinel' }

const makePatients = (count: number): PatientIdentity[] => Array.from({ length: count }, (_, index) => ({
  patientId: `patient-${index + 1}`,
  displayName: `Person ${index + 1}`,
  isOwnPatient: index === 0,
  canManageMedication: true,
  careRecipientType: 'human',
  archivedAt: null,
}))

type SwitcherProps = Parameters<typeof SubjectSwitcher>[0]
const render = (props: SwitcherProps, locale: Locale = 'id') =>
  renderHook(() => SubjectSwitcher(props), { defaultContext: { locale, setLocale: () => {} } }).current

const buttons = (tree: unknown) => findAll(tree, element => element.type === 'button')
const selects = (tree: unknown) => findAll(tree, element => element.type === 'select')
// 所有 status 區域（含解鎖時空的那個）與「真的有文字」的說明：讀屏器需要區域先存在、文字再出現。
const regions = (tree: unknown) => findAll(tree, element => element.type === 'p' && element.props.role === 'status')
const notes = (tree: unknown) => regions(tree).filter(region => textContent(region) !== '')

describe('SubjectSwitcher lockedReason (issue #1103)', () => {
  test('segmented buttons: unlocked switches and shows no note', () => {
    const onSelect = mock((_patientId: string) => {})
    const tree = render({ patientId: 'patient-1', patients: makePatients(3), onSelect })
    expect(buttons(tree)).toHaveLength(3)
    expect(buttons(tree).every(button => button.props.disabled === false)).toBe(true)
    expect(notes(tree)).toHaveLength(0)
    fire(buttons(tree)[1], 'onClick')
    expect(onSelect).toHaveBeenCalledWith('patient-2')
  })

  test('the status region exists before the reason appears, so screen readers announce it', () => {
    const unlocked = render({ patientId: 'patient-1', patients: makePatients(3) })
    expect(regions(unlocked)).toHaveLength(1)
    expect(textContent(regions(unlocked)[0])).toBe('')
    const locked = render({ patientId: 'patient-1', patients: makePatients(3), lockedReason: REASON })
    expect(regions(locked)).toHaveLength(1)
    expect(textContent(regions(locked)[0])).toBe('alasan-sentinel')
  })

  test('segmented buttons: locked disables every button, keeps the active one marked, and ignores clicks', () => {
    const onSelect = mock((_patientId: string) => {})
    const tree = render({ patientId: 'patient-1', patients: makePatients(3), onSelect, lockedReason: REASON })
    expect(buttons(tree).every(button => button.props.disabled === true)).toBe(true)
    // 目前對象仍要看得出來是誰，鎖定不是把選取狀態也拿掉。
    expect(buttons(tree).map(button => button.props['aria-pressed'])).toEqual([true, false, false])
    // 原生 disabled 在真實 DOM 會擋點擊；這裡直接呼叫處理函式，證明鎖定規則不只靠元素屬性。
    for (const button of buttons(tree)) fire(button, 'onClick')
    expect(onSelect).not.toHaveBeenCalled()
  })

  test.each([['id', 'alasan-sentinel'], ['zh', '原因-sentinel'], ['en', 'reason-sentinel']] as const)('the lock reason is shown in %s only', (locale, expected) => {
    const tree = render({ patientId: 'patient-1', patients: makePatients(2), lockedReason: REASON }, locale)
    expect(notes(tree).map(textContent)).toEqual([expected])
  })

  test('dropdown (more than three people): locked disables the select and ignores changes', () => {
    const onSelect = mock((_patientId: string) => {})
    const locked = render({ patientId: 'patient-1', patients: makePatients(4), onSelect, lockedReason: REASON })
    expect(selects(locked)[0].props.disabled).toBe(true)
    fire(selects(locked)[0], 'onChange', { target: { value: 'patient-3' } })
    expect(onSelect).not.toHaveBeenCalled()
    expect(notes(locked).map(textContent)).toEqual(['alasan-sentinel'])

    const unlocked = render({ patientId: 'patient-1', patients: makePatients(4), onSelect })
    expect(selects(unlocked)[0].props.disabled).toBe(false)
    expect(notes(unlocked)).toHaveLength(0)
    fire(selects(unlocked)[0], 'onChange', { target: { value: 'patient-3' } })
    expect(onSelect).toHaveBeenCalledWith('patient-3')
  })

  test('a single person has nothing to switch, so no lock note is shown', () => {
    const tree = render({ patientId: 'patient-1', patients: makePatients(1), lockedReason: REASON })
    expect(buttons(tree)).toHaveLength(0)
    expect(selects(tree)).toHaveLength(0)
    expect(regions(tree)).toHaveLength(0)
  })

  test('the "current person unavailable" fallback button is locked too', () => {
    const onSelect = mock((_patientId: string) => {})
    const tree = render({ patientId: 'someone-not-in-list', patients: makePatients(2), onSelect, lockedReason: REASON })
    const [fallback] = buttons(tree)
    expect(fallback.props.disabled).toBe(true)
    fire(fallback, 'onClick')
    expect(onSelect).not.toHaveBeenCalled()
    expect(notes(tree).map(textContent)).toEqual(['alasan-sentinel'])
  })
})
