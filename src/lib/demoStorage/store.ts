/*
檔案用途：demoStorage 模組共用的狀態容器——定義 /demo 展示模式整份本機狀態的形狀、初始值與 localStorage 讀寫。
所在層：src/lib/demoStorage；本目錄其餘依領域拆分的檔案（vitals／petCare／medication／medicationPrn／careRecords）
都透過這裡的 loadState()／saveState() 存取同一份狀態，不得各自維護獨立的 localStorage key。
主要關聯：由 demoStorage/index.ts 匯出對外；初始資料取自 ../demoData 的展示故事 fallback。
*/
import type { BpRecord, DementiaCareRecord, FluidBalanceRecord, MealFoodCatalogItem, MealRecord, MealRecordItem, MedicationCatalog, MedicationIntakeLog, MedicationPlan, MedicationPlanChangeLog, PatientMedicationInstruction, PetAppetiteRecord, PetBloodGlucoseRecord, PetDigestionRecord, PetInsulinRecord, PetLiquidIntakeRecord, PetSubcutaneousFluidRecord, PrnMedicationDailyAssessment, PrnMedicationEvent, TemperatureRecord } from '../../types/database'
import { getFallbackDemoLeeMedicationCatalog, getFallbackDemoLeeMedicationPlans, getFallbackDemoLeePatientMedicationInstructions, getFallbackDemoMedicationCatalog, getFallbackDemoMedicationHistory, getFallbackDemoMedicationPlans } from '../demoData'
import type { CareTimelineEntry } from '../careTimeline'

export const DEMO_VISITOR_EMAIL = 'demo.visitor@example.test'

export interface DemoWeightRecord {
  id: string
  patient_id: string
  weight_kg: number
  measured_on: string
  measurement_number: number
  measured_at: string
}

// 為什麼 key 一路從 v1 換到 v3：v1／v2 的示範藥單與用藥異動已整份換成現在 demoData.ts 裡憑空構造的資料。
// localStorage 快照不會跟著程式碼更新，只換 seed 的話，之前開過 /demo 的瀏覽器會一直顯示舊清單；
// 所以種子內容每次整份換掉，就換一個新 key 讓既有訪客的展示狀態自然作廢，並在讀取時把所有舊 key
// 直接刪掉，不留舊快照在裝置上（PR #1013 review）。試用資料本來就是可拋棄的，不做搬移。
const STORAGE_KEY = 'jia-jian-log.demo-state.v3'
const LEGACY_STORAGE_KEYS = ['jia-jian-log.demo-state.v1', 'jia-jian-log.demo-state.v2']

export interface DemoState {
  version: 1
  bpRecords: BpRecord[]
  temperatureRecords?: TemperatureRecord[]
  medications: MedicationCatalog[]
  medicationPlans: MedicationPlan[]
  medicationLogs: MedicationIntakeLog[]
  medicationChanges: MedicationPlanChangeLog[]
  prnMedicationEvents?: PrnMedicationEvent[]
  prnMedicationAssessments?: PrnMedicationDailyAssessment[]
  mealFoodCatalogItems?: MealFoodCatalogItem[]
  mealRecords?: MealRecord[]
  mealRecordItems?: MealRecordItem[]
  weightRecords?: DemoWeightRecord[]
  petLiquidIntakeRecords?: PetLiquidIntakeRecord[]
  petDigestionRecords?: PetDigestionRecord[]
  petAppetiteRecords?: PetAppetiteRecord[]
  petFluidRecords?: PetSubcutaneousFluidRecord[]
  petInsulinRecords?: PetInsulinRecord[]
  petGlucoseRecords?: PetBloodGlucoseRecord[]
  dementiaCareRecords?: DementiaCareRecord[]
  fluidBalanceRecords?: FluidBalanceRecord[]
  patientMedicationInstructions?: PatientMedicationInstruction[]
  // 訪客在展示模式當場新增或修改的照護大事記；種子故事（getFallbackDemoCareTimeline）不放在這裡，
  // 一律即時計算，避免同一份故事內容在 localStorage 與程式碼裡各存一份、之後改詞漏改一邊。
  careTimelineEntries?: CareTimelineEntry[]
  // 訪客刪除的大事記 id。種子故事是程式碼常數、不能真的從陣列裡拿掉，所以用「墓碑」名單在讀取時濾掉，
  // 讓「刪除」在畫面上看起來跟真的刪除一樣，同時完全不影響 getFallbackDemoCareTimeline 這份共用資料。
  deletedCareTimelineIds?: string[]
}

export function isDemoMode() {
  return typeof window !== 'undefined' && window.location.pathname === '/demo'
}

function initialDemoState(): DemoState {
  const medicationChanges = getFallbackDemoMedicationHistory().map(({ medication: _medication, ...change }) => ({
    ...change,
    dose_count: change.dose_count ?? 1,
  }))
  return {
    version: 1,
    bpRecords: [],
    temperatureRecords: [],
    // 李阿姨的藥單與其他展示對象合併成同一份初始清單；她永遠存在，不受任一展示故事的登入或重置流程影響。
    medications: [...getFallbackDemoLeeMedicationCatalog(), ...getFallbackDemoMedicationCatalog()],
    medicationPlans: [...getFallbackDemoLeeMedicationPlans(), ...getFallbackDemoMedicationPlans()],
    medicationLogs: [],
    medicationChanges,
    prnMedicationEvents: [],
    prnMedicationAssessments: [],
    mealFoodCatalogItems: [],
    mealRecords: [],
    mealRecordItems: [],
    weightRecords: [],
    petLiquidIntakeRecords: [],
    petDigestionRecords: [],
    petAppetiteRecords: [],
    petFluidRecords: [],
    petInsulinRecords: [],
    petGlucoseRecords: [],
    dementiaCareRecords: [],
    fluidBalanceRecords: [],
    // 李阿姨的服用方式 B 層 demo 紀錄；跟藥單／藥品目錄同一種「永遠存在」的待遇，其餘展示對象沒有這項資料。
    patientMedicationInstructions: getFallbackDemoLeePatientMedicationInstructions(),
    careTimelineEntries: [],
    deletedCareTimelineIds: [],
  }
}

let memoryState: DemoState | null = null
let memoryStatePersistenceFailed = false

export function isPersistenceFailed(): boolean {
  return memoryStatePersistenceFailed
}

// 舊版 key 的快照一律清掉，不讀、不搬。失敗（隱私模式封鎖、storage 不可用）只當沒清到，不影響本次讀取。
function scrubLegacyDemoState() {
  for (const key of LEGACY_STORAGE_KEYS) {
    try {
      window.localStorage.removeItem(key)
    } catch {
      // 讀取路徑自己會處理 storage 被封鎖的情況；這裡不重複記 log。
    }
  }
}

export function loadState(): DemoState {
  if (typeof window !== 'undefined') {
    let storageReadFailed = false
    scrubLegacyDemoState()
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY)
      if (memoryState && memoryStatePersistenceFailed) {
        // 寫入失敗時 localStorage 可能只讀到舊快照；先相信本頁記憶體狀態，避免剛完成的試用操作被舊值蓋掉。
        return memoryState
      }
      if (raw) {
        const parsed = JSON.parse(raw) as DemoState
        if (parsed?.version === 1 && Array.isArray(parsed.bpRecords) && Array.isArray(parsed.medications) && Array.isArray(parsed.medicationPlans) && Array.isArray(parsed.medicationLogs) && Array.isArray(parsed.medicationChanges)) {
          // 舊的 Demo 快照沒有體溫欄位；讀取時補空陣列，避免新功能讓既有展示資料整份失效。
          // 舊 Demo 快照要同時補齊新 PRN 與餐點欄位，避免其中一個功能讀到 undefined 而遺失本頁操作。
          memoryState = { ...parsed, temperatureRecords: parsed.temperatureRecords ?? [], prnMedicationEvents: parsed.prnMedicationEvents ?? [], prnMedicationAssessments: parsed.prnMedicationAssessments ?? [], mealFoodCatalogItems: parsed.mealFoodCatalogItems ?? [], mealRecords: parsed.mealRecords ?? [], mealRecordItems: parsed.mealRecordItems ?? [], weightRecords: parsed.weightRecords ?? [], patientMedicationInstructions: parsed.patientMedicationInstructions ?? [], careTimelineEntries: parsed.careTimelineEntries ?? [], deletedCareTimelineIds: parsed.deletedCareTimelineIds ?? [] }
          memoryStatePersistenceFailed = false
          return memoryState
        }
      }
    } catch (error) {
      // localStorage 可能被隱私模式封鎖；保留記憶體備援，至少讓本次面試操作不會失效。
      console.warn('[demo storage read warning]', error)
      storageReadFailed = true
    }
    if (storageReadFailed) {
      if (!memoryState) memoryState = initialDemoState()
      return memoryState
    }
    // 清除網站資料後應回到乾淨的展示故事，而不是被模組記憶體偷偷復原舊試用結果。
    memoryState = initialDemoState()
    return memoryState
  }
  if (!memoryState) memoryState = initialDemoState()
  return memoryState
}

export function saveState(state: DemoState) {
  memoryState = state
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    memoryStatePersistenceFailed = false
  } catch (error) {
    // 試用資料不是正式健康資料；儲存被封鎖時不把畫面操作變成錯誤流程。
    memoryStatePersistenceFailed = true
    console.warn('[demo storage write warning]', error)
  }
}

export function localId(prefix: string) {
  return `demo-${prefix}-local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}
