/*
檔案用途：鎖住「血壓儲存進行中不能切換病人」的接線（issue #1103）。寫入途中切到別的病人，這筆被拒絕的紀錄
（非暫時性錯誤、每日上限）因病人已變而不能顯示，看護就看不到——所以獨立的輸入頁與嵌入每日照護頁的兩個切換器
都要在 status === 'saving' 期間鎖住，結果出來後解鎖。
所在層：tests/unit；以 React hook harness 呼叫 InputPage／DailyCarePage 取得元素樹，表單 hook 換成可控替身，不啟動瀏覽器。
主要關聯：src/features/vitals/pages/InputPage.tsx、src/features/care-family/pages/DailyCarePage.tsx、SubjectSwitcher
  （元件本身的鎖定行為見 subjectSwitcherLock.test.ts）。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, fire } from './helpers/elementTree'
import type { PatientIdentity } from '../../src/lib/auth'

installReactHookHarness()

mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  useBpEvaluator: () => ({ evaluateNow: () => ({ level: 'normal', pulseWarning: false }), evaluateAt: () => ({ level: 'normal', pulseWarning: false }) }),
}))
mock.module('../../src/hooks/useKeyboardViewport', () => ({ useKeyboardViewport: () => false }))

const { L } = await import('../../src/features/vitals/pages/InputPage.utils')

const formState = {
  systolic: 120, diastolic: 80, pulse: 70,
  handleSystolicChange: () => {}, handleDiastolicChange: () => {}, handlePulseChange: () => {},
  pendingAdvanceField: null, clearAutoAdvanceTimer: () => {},
  status: 'idle', errMsg: '', limitBlockedReading: null,
  notifyFailed: false, familyAlertSkipped: false, familyDelivery: 'idle',
  everSubmitted: false, canSubmit: true, tone: 'normal', submit: () => {},
  session: 'pagi', showRestPrompt: false, showDoneMsg: false, summary: null,
  displayedRule: null, submittedTone: 'normal', resetMeasurementFlow: () => {},
  pendingRecords: [], pendingViewRecords: [], pendingSyncing: false, pendingSyncError: false, pendingSyncErrorTexts: [], pendingLastAttemptAt: null,
  syncPendingRecords: async () => {}, otherPatientsPendingCount: 0, otherPatientNotifyProblems: [],
  dailyRecordsVersion: 0, optimisticRecord: null,
  latest: { record: null, loading: false, error: null, refetch: () => {} },
}
mock.module('../../src/features/vitals/hooks/useBloodPressureInputForm', () => ({ useBloodPressureInputForm: () => formState }))

const { InputPage } = await import('../../src/features/vitals/pages/InputPage')
const { DailyCarePage } = await import('../../src/features/care-family/pages/DailyCarePage')
const { SubjectSwitcher } = await import('../../src/components/ui/SubjectSwitcher')
const { DAILY_CARE_MODULES } = await import('../../src/lib/dailyCareModules')

const PATIENTS: PatientIdentity[] = ['patient-1', 'patient-2'].map((patientId, index) => ({
  patientId, displayName: `Person ${index + 1}`, isOwnPatient: index === 0, canManageMedication: true, careRecipientType: 'human', archivedAt: null,
}))
const context = { defaultContext: { locale: 'id' as const, setLocale: () => {} } }
const switchers = (tree: unknown) => findAll(tree, element => element.type === SubjectSwitcher)

type InputPageProps = Parameters<typeof InputPage>[0]
const renderInput = (props: Partial<InputPageProps> = {}) => renderHook(() => InputPage({
  subject: 'patient-1', patientId: 'patient-1', availablePatients: PATIENTS, onSubjectSelect: () => {}, ...props,
}), context)

describe('the lock copy', () => {
  // 若連同接線一起被還原，L.switchLockedWhileSaving 會變成 undefined，下面「undefined 對 undefined」的比對會假性通過；
  // 這裡單獨確認文案真的存在、三個語系都有內容，並用它當 saving 列的期望值。
  test('exists in all three locales', () => {
    expect(L.switchLockedWhileSaving).toBeDefined()
    for (const locale of ['id', 'zh', 'en'] as const) {
      expect(L.switchLockedWhileSaving[locale].trim().length).toBeGreaterThan(8)
      expect(L.switchLockedWhileSaving[locale]).not.toContain('[EN:')
    }
  })
})

describe('standalone InputPage locks its own switcher while saving', () => {
  test.each([
    ['idle', undefined],
    ['saving', L.switchLockedWhileSaving],
    // 結果一出來（成功、暫存、失敗）就解鎖：失敗訊息此時仍在原病人的畫面上，看護看得到。
    ['ok', undefined],
    ['queued', undefined],
    ['err', undefined],
  ] as const)('status %s', (status, expected) => {
    formState.status = status
    const [switcher] = switchers(renderInput().current)
    expect(switcher.props.lockedReason).toBe(expected)
    if (status === 'saving') expect(switcher.props.lockedReason).toBeDefined()
  })

  test('the switcher unlocks again once the save resolves', () => {
    formState.status = 'saving'
    const handle = renderInput()
    expect(switchers(handle.current)[0].props.lockedReason).toBe(L.switchLockedWhileSaving)
    formState.status = 'err'
    expect(switchers(handle.rerender())[0].props.lockedReason).toBeUndefined()
  })
})

describe('InputPage reports the saving state to its parent', () => {
  test('reports true while saving, false once resolved, and false again on unmount', () => {
    const onSavingChange = mock((_saving: boolean) => {})
    formState.status = 'idle'
    const handle = renderInput({ embedded: true, onSavingChange })
    expect(onSavingChange.mock.calls.at(-1)).toEqual([false])

    formState.status = 'saving'
    handle.rerender()
    expect(onSavingChange.mock.calls.at(-1)).toEqual([true])

    formState.status = 'ok'
    handle.rerender()
    expect(onSavingChange.mock.calls.at(-1)).toEqual([false])

    // 面板被移除（例如病人的血壓模組被關掉）時外層不能永遠鎖著。
    formState.status = 'saving'
    handle.rerender()
    expect(onSavingChange.mock.calls.at(-1)).toEqual([true])
    handle.unmount()
    expect(onSavingChange.mock.calls.at(-1)).toEqual([false])
  })

  test('embedded mode renders no switcher of its own (the daily-care page owns it)', () => {
    formState.status = 'saving'
    expect(switchers(renderInput({ embedded: true }).current)).toHaveLength(0)
  })
})

describe('DailyCarePage locks its switcher while the embedded blood pressure save is in flight', () => {
  const bloodPressureOnly = DAILY_CARE_MODULES.filter(module => module.id === 'bloodPressure')
  const renderDailyCare = () => renderHook(() => DailyCarePage({
    subject: 'patient-1', patientId: 'patient-1', availablePatients: PATIENTS, onSubjectSelect: () => {},
    canUseMedication: false, manageablePatients: [], ownPatientId: 'patient-1',
    medicationSlotsExpanded: true, medicationNameEnglishFirst: true,
    visibleModules: bloodPressureOnly, initialSection: 'bloodPressure',
    measurementSession: null, onMeasurementSessionStart: () => {}, onMeasurementSessionComplete: () => {}, onOpenDisplaySettings: () => {},
  }), context)
  const embeddedInput = (tree: unknown) => findAll(tree, element => element.type === InputPage)[0]

  test('unlocked by default, locked after InputPage reports saving, unlocked after it reports done', () => {
    const handle = renderDailyCare()
    expect(switchers(handle.current)[0].props.lockedReason).toBeUndefined()

    handle.act(() => fire(embeddedInput(handle.current), 'onSavingChange', true))
    expect(switchers(handle.current)[0].props.lockedReason).toBe(L.switchLockedWhileSaving)

    handle.act(() => fire(embeddedInput(handle.current), 'onSavingChange', false))
    expect(switchers(handle.current)[0].props.lockedReason).toBeUndefined()
  })
})
