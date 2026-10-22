/*
檔案用途：驗證 useDailyCareOnboarding 回報的 dailyCarePreferenceLoadedPatientId（issue #868）：哪一位病人的每日照護顯示偏好「已經讀完」，
冷啟動時預設值（全部可見）不能被當成讀完的結果；讀取失敗也算讀完；換病人先歸零；舊病人遲到的回應不得覆蓋新病人。
所在層：tests/unit；用 React hook harness 執行 hook，偏好讀取以可控的 promise 取代，不連 Supabase。
主要關聯：src/hooks/useDailyCareOnboarding.ts、src/components/system/NativeShortcutNavigator.tsx（ready 閘門）、src/App.tsx。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { DEFAULT_DAILY_CARE_VISIBILITY, type DailyCareVisibilityPreference } from '../../src/lib/dailyCareModules'

installReactHookHarness()

type StoredState = { preference: DailyCareVisibilityPreference, useCustomTemplate: boolean, hasStoredPreference: boolean }
type PendingRead = { patientId: string, resolve: (state: StoredState) => void, reject: (error: Error) => void }

let pendingReads: PendingRead[]

mock.module('../../src/lib/preferences/dailyCarePreferences', () => ({
  readDailyCarePreference: () => ({ preference: { ...DEFAULT_DAILY_CARE_VISIBILITY, labResults: true }, useCustomTemplate: false }),
  readDailyCarePreferenceForPatient: (patientId: string) => new Promise<StoredState>((resolve, reject) => { pendingReads.push({ patientId, resolve, reject }) }),
  saveDailyCarePreference: async () => undefined,
  saveDailyCarePreferenceForPatient: async () => undefined,
}))

const { useDailyCareOnboarding } = await import('../../src/hooks/useDailyCareOnboarding')

const settle = async () => { for (let round = 0; round < 5; round += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

// 病人把血壓關掉的偏好：跟預設值不同，才分辨得出「預設值」與「讀完的結果」。
const bloodPressureOff: DailyCareVisibilityPreference = { ...DEFAULT_DAILY_CARE_VISIBILITY, bloodPressure: false }
const stored = (preference: DailyCareVisibilityPreference): StoredState => ({ preference, useCustomTemplate: false, hasStoredPreference: true })

let params: Parameters<typeof useDailyCareOnboarding>[0]

beforeEach(() => {
  pendingReads = []
  params = {
    activePatientId: 'patient-a',
    isDemoMode: false,
    userId: 'user-1',
    getActivePatientCareRecipientType: () => 'human',
    getActivePatientIdRef: () => params.activePatientId,
  }
})

const mount = () => renderHook(() => useDailyCareOnboarding(params))

describe('useDailyCareOnboarding: dailyCarePreferenceLoadedPatientId', () => {
  test('is null while the read is in flight even though the default preference already says everything is visible', async () => {
    const view = mount()
    expect(view.current.dailyCarePreferenceLoadedPatientId).toBeNull()
    expect(view.current.dailyCarePreference.bloodPressure).toBe(true)
    // 第一個 commit 時 dailyCareSettingsSaving 也還沒變 true——這正是不能拿它當「讀完了沒」的原因。
    await settle()
    expect(pendingReads).toHaveLength(1)
    expect(view.current.dailyCarePreferenceLoadedPatientId).toBeNull()
    view.unmount()
  })

  test('reports the patient only after the stored preference has been applied', async () => {
    const view = mount()
    pendingReads[0].resolve(stored(bloodPressureOff))
    await settle()
    const result = view.rerender()
    expect(result.dailyCarePreference.bloodPressure).toBe(false)
    expect(result.dailyCarePreferenceLoadedPatientId).toBe('patient-a')
    view.unmount()
  })

  test('counts a failed read as loaded, because the screen then runs on the show-everything default', async () => {
    const view = mount()
    pendingReads[0].reject(new Error('network down'))
    await settle()
    const result = view.rerender()
    expect(result.dailyCarePreferenceLoadedPatientId).toBe('patient-a')
    expect(result.dailyCareSettingsError).not.toBeNull()
    view.unmount()
  })

  test('drops back to null when the care recipient changes and ignores the previous recipient\'s late response', async () => {
    const view = mount()
    pendingReads[0].resolve(stored(bloodPressureOff))
    await settle()
    expect(view.rerender().dailyCarePreferenceLoadedPatientId).toBe('patient-a')

    params = { ...params, activePatientId: 'patient-b' }
    const switched = view.rerender()
    expect(switched.dailyCarePreferenceLoadedPatientId).toBeNull()
    expect(switched.dailyCarePreference.bloodPressure).toBe(true)
    await settle()
    expect(pendingReads.map(read => read.patientId)).toEqual(['patient-a', 'patient-b'])

    // A 的回應遲到：不得讓 B 看起來已讀完，也不得把 A 的偏好套到 B。
    pendingReads[0].resolve(stored(bloodPressureOff))
    await settle()
    expect(view.rerender().dailyCarePreferenceLoadedPatientId).toBeNull()

    pendingReads[1].resolve(stored(DEFAULT_DAILY_CARE_VISIBILITY))
    await settle()
    const result = view.rerender()
    expect(result.dailyCarePreferenceLoadedPatientId).toBe('patient-b')
    expect(result.dailyCarePreference.bloodPressure).toBe(true)
    view.unmount()
  })

  test('demo mode reads synchronously, so it is loaded right away', () => {
    params = { ...params, isDemoMode: true, userId: undefined }
    const view = mount()
    expect(view.current.dailyCarePreferenceLoadedPatientId).toBe('patient-a')
    expect(view.current.dailyCarePreference.labResults).toBe(true)
    expect(pendingReads).toHaveLength(0)
    view.unmount()
  })

  test('stays null when there is no signed-in user and no demo mode, so nothing is acted on', () => {
    params = { ...params, userId: undefined }
    const view = mount()
    expect(view.current.dailyCarePreferenceLoadedPatientId).toBeNull()
    view.unmount()
  })
})
