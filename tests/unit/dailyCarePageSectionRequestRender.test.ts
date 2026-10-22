/*
檔案用途：驗證每日照護頁（DailyCarePage）對外層「打開某個區塊」請求（PWA 捷徑、今天頁的一步操作、Siri 捷徑 issue #868）的回應：
掛載時直接選到該區塊、頁面已掛載後才收到請求時也要切過去（否則語音指令被消費卻沒反應）、請求指向不可見的模組時維持原區塊但仍要消費、
同一個請求只消費一次，以及消費之後使用者手動選的區塊不會被蓋回去。
所在層：tests/unit；用 React hook harness 呼叫頁面函式，子頁面全部換成空元件（不遞迴渲染也不連 Supabase）。
主要關聯：src/features/care-family/pages/DailyCarePage.tsx、src/lib/dailyCareModules.ts（resolveRequestedDailyCareSection）、src/App.tsx。
*/
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll } from './helpers/elementTree'
import { DAILY_CARE_MODULES, type DailyCareModuleId } from '../../src/lib/dailyCareModules'

installReactHookHarness()

// DailyCarePage 靜態 import 了十幾個子頁面（各自牽出 Supabase 與資料層）；這個測試只看區塊切換，一律換成空元件。
const emptyPage = () => null
const pageModules: [string, string][] = [
  ['vitals/pages/InputPage', 'InputPage'],
  ['vitals/pages/TemperaturePage', 'TemperaturePage'],
  ['vitals/pages/WeightPage', 'WeightPage'],
  ['medication/pages/MedicationPage', 'MedicationPage'],
  ['nutrition/pages/NutritionPage', 'NutritionPage'],
  ['pet-care/pages/PetLiquidIntakePage', 'PetLiquidIntakePage'],
  ['pet-care/pages/PetDigestionPage', 'PetDigestionPage'],
  ['pet-care/pages/PetAppetitePage', 'PetAppetitePage'],
  ['pet-care/pages/PetFluidTherapyPage', 'PetFluidTherapyPage'],
  ['pet-care/pages/PetEndocrinePage', 'PetEndocrinePage'],
  ['dementia-care/pages/DementiaCarePage', 'DementiaCarePage'],
  ['postop-care/pages/FluidBalancePage', 'FluidBalancePage'],
  ['reminders/pages/CareDueRemindersPage', 'CareDueRemindersPage'],
  ['reminders/pages/VisitQuestionsPage', 'VisitQuestionsPage'],
  ['labs/pages/LabResultsPage', 'LabResultsPage'],
]
for (const [path, exportName] of pageModules) {
  mock.module(`../../src/features/${path}`, () => ({ [exportName]: emptyPage }))
}
mock.module('../../src/lib/preferences/dailyCareSectionPreference', () => ({
  readLastDailyCareSection: () => null,
  saveLastDailyCareSection: () => undefined,
}))

const originalWindow = globalThis.window
beforeEach(() => {
  // useKeyboardViewport 的 effect 會讀 window.visualViewport。
  globalThis.window = { visualViewport: undefined } as unknown as Window & typeof globalThis
})
afterAll(() => {
  if (originalWindow) globalThis.window = originalWindow
  else delete (globalThis as { window?: Window & typeof globalThis }).window
})

const { DailyCarePage } = await import('../../src/features/care-family/pages/DailyCarePage')
const { DailyCareSectionTabs } = await import('../../src/components/daily-care/DailyCareSectionTabs')

const LOCALE_CONTEXT_VALUE = { locale: 'zh' as const, setLocale: () => {} }

const moduleById = (id: DailyCareModuleId) => DAILY_CARE_MODULES.find(module => module.id === id)!
// 人類病人最常見的三個區塊；營養不在其中，用來模擬「請求指向目前看不到的模組」。
const visibleModules = [moduleById('bloodPressure'), moduleById('temperature'), moduleById('medication')]

let initialSection: DailyCareModuleId | undefined
let consumed: number

const mount = () => renderHook(() => DailyCarePage({
  subject: 'patient-a',
  patientId: 'patient-a',
  patientName: undefined,
  availablePatients: [],
  userEmail: 'owner@example.com',
  onSubjectSelect: () => {},
  canUseMedication: true,
  manageablePatients: [],
  ownPatientId: 'patient-a',
  medicationSlotsExpanded: false,
  medicationNameEnglishFirst: false,
  visibleModules,
  initialSection,
  // 跟 App.tsx 一樣：每次 render 都是新的 inline callback。
  onInitialSectionConsumed: () => { consumed += 1 },
  onMeasurementSessionStart: () => {},
  onMeasurementSessionComplete: () => {},
  onOpenDisplaySettings: () => {},
} as Parameters<typeof DailyCarePage>[0]), { defaultContext: LOCALE_CONTEXT_VALUE })

type SectionTabsProps = { activeModule: DailyCareModuleId, onSelect: (id: DailyCareModuleId) => void }
const tabs = (tree: unknown) => findAll(tree, element => element.type === DailyCareSectionTabs)[0].props as unknown as SectionTabsProps

beforeEach(() => {
  initialSection = undefined
  consumed = 0
})

describe('DailyCarePage section requests', () => {
  test('opens straight on the requested section when it is there at mount, and consumes the request once', () => {
    initialSection = 'medication'
    const view = mount()
    expect(tabs(view.current).activeModule).toBe('medication')
    expect(consumed).toBe(1)
    view.rerender()
    view.rerender()
    // App 每次 render 都會傳新的 inline callback；請求只該被消費一次，不能每次重繪都重跑。
    expect(consumed).toBe(1)
    view.unmount()
  })

  test('a request that arrives while the page is already mounted switches the section instead of being silently swallowed', () => {
    const view = mount()
    expect(tabs(view.current).activeModule).toBe('bloodPressure')
    view.act(() => tabs(view.current).onSelect('temperature'))
    expect(tabs(view.current).activeModule).toBe('temperature')

    // 使用者停在體溫時說「記錄服藥」。
    initialSection = 'medication'
    view.rerender()
    expect(tabs(view.rerender()).activeModule).toBe('medication')
    expect(consumed).toBe(1)
    view.unmount()
  })

  test('after the request is consumed, a section the user picks by hand is not overridden by later renders', () => {
    const view = mount()
    initialSection = 'medication'
    view.rerender()
    expect(tabs(view.rerender()).activeModule).toBe('medication')

    // 父層消費後清掉請求；之後使用者自己點回血壓。
    initialSection = undefined
    view.rerender()
    view.act(() => tabs(view.current).onSelect('bloodPressure'))
    view.rerender()
    view.rerender()
    expect(tabs(view.current).activeModule).toBe('bloodPressure')
    view.unmount()
  })

  test('a request for a module the patient cannot see keeps the current section but is still consumed', () => {
    const view = mount()
    view.act(() => tabs(view.current).onSelect('temperature'))
    initialSection = 'nutrition'
    view.rerender()
    expect(tabs(view.rerender()).activeModule).toBe('temperature')
    // 不消費的話，之後重新掛載會反覆強制同一個無效區塊（見 DailyCarePage 內的註解）。
    expect(consumed).toBe(1)
    view.unmount()
  })

  test('the same section can be requested again later: each new request is its own change', () => {
    const view = mount()
    initialSection = 'medication'
    view.rerender()
    initialSection = undefined
    view.rerender()
    view.act(() => tabs(view.current).onSelect('temperature'))
    initialSection = 'medication'
    view.rerender()
    expect(tabs(view.rerender()).activeModule).toBe('medication')
    expect(consumed).toBe(2)
    view.unmount()
  })
})
