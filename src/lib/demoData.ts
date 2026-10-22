/*
檔案用途：提供 /demo 模式之前端離線備援資料與免登入展示輔助函式。
所在層：src/lib；為展示模式與脈絡資料模組。
主要關聯：由 useAuth、血壓／體溫 hooks、CareTimeline、MedicationPage 與 App.tsx 呼叫，確保無網路或資料庫尚未 push 時也能順暢展示。
*/

import type { BpRecord, MedicationCatalog, MedicationPlan, PatientMedicationInstruction, TemperatureRecord } from '../types/database'
import type { MedicationPlanChangeLogView } from './medication/medications'
import type { CareTimelineEntry } from './careTimeline'

export const DEMO_MEILING_PATIENT_ID = '55555555-5555-4555-a555-555555555555'
export const DEMO_CHEN_PATIENT_ID = '66666666-6666-4666-a666-666666666666'
// 李阿姨是永遠存在於 /demo 的驗證用對象，帶著一份憑空組出來的示範藥單（見 getFallbackDemoLeeMedicationCatalog 的說明），
// 讓「四個服藥分頁」「藥名紅色醒目」「英文優先顯示」這些畫面規則每次都能在 staging 立即驗證，不受真實 Supabase 資料異動影響。
export const DEMO_LEE_PATIENT_ID = '44444444-4444-4444-a444-444444444444'
// 與 lib/auth.ts 的同名常數保持相同 UUID 值；這裡獨立宣告是為了不讓純資料層反過來 import 驗證層。
export const DEMO_DOG_PATIENT_ID = '77777777-7777-4777-a777-777777777777'
export const DEMO_CAT_PATIENT_ID = '88888888-8888-4888-a888-888888888888'
export const DEMO_RABBIT_PATIENT_ID = '99999999-9999-4999-a999-999999999999'
export const DEMO_OTHER_PET_PATIENT_ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'

// 展示資料必須跨重新整理與測試執行維持同一條時間軸；若使用現在時間，面試截圖與離線備援會每天漂移。
export const DEMO_FALLBACK_BASE_DATE = '2026-08-01T00:00:00.000Z'

const DEMO_PATIENT_IDS = new Set([DEMO_LEE_PATIENT_ID, DEMO_MEILING_PATIENT_ID, DEMO_CHEN_PATIENT_ID, DEMO_DOG_PATIENT_ID, DEMO_CAT_PATIENT_ID, DEMO_RABBIT_PATIENT_ID, DEMO_OTHER_PET_PATIENT_ID])

export function isDemoPatientId(patientId: string | null | undefined): boolean {
  if (!patientId) return false
  return DEMO_PATIENT_IDS.has(patientId)
}

export function getFallbackDemoBpRecords(days: number, patientId: string = DEMO_MEILING_PATIENT_ID): BpRecord[] {
  const records: BpRecord[] = []
  const baseNow = new Date(DEMO_FALLBACK_BASE_DATE)

  const getFluctuation = (base: number, d: number, slot: number, amplitude: number) => {
    const wave = Math.sin(d * 0.35) * amplitude
    const noise = Math.cos((d * 2.1 + slot * 4.3) * 1.1) * (amplitude * 0.6)
    return Math.round(base + wave + noise)
  }

  for (let day = Math.min(days, 90) - 1; day >= 0; day--) {
    const targetDate = new Date(baseNow.getTime() - day * 86400000)
    const year = targetDate.getFullYear()
    const month = String(targetDate.getMonth() + 1).padStart(2, '0')
    const dateStr = String(targetDate.getDate()).padStart(2, '0')
    const isoPrefix = `${year}-${month}-${dateStr}`

    const morningIso = new Date(`${isoPrefix}T08:15:00+08:00`).toISOString()
    const eveningIso = new Date(`${isoPrefix}T20:30:00+08:00`).toISOString()

    if (patientId === DEMO_CHEN_PATIENT_ID) {
      if (day % 2 === 0) {
        records.push({
          id: `demo-bp-chen-${day}-m`,
          patient_id: DEMO_CHEN_PATIENT_ID,
          systolic: getFluctuation(day > 40 ? 155 : 132, day, 1, 12),
          diastolic: getFluctuation(day > 40 ? 96 : 82, day, 1, 8),
          pulse: getFluctuation(78, day, 1, 6),
          measured_at: morningIso,
          created_at: morningIso,
          recorded_by: 'demo.chen@example.test',
          source: 'manual',
        })
      }
      continue
    }

    // 王美玲 (Demo 1) 故事歷程——整條曲線是為了展示「換藥後下降、舒張壓過低、漏藥回升、突發高壓二測、
    // 回到穩定」這幾個畫面規則而構造的，數值都是依判讀區間挑出來的，不對應任何真實使用者的紀錄
    // （2026-09 逐檔複查與 PR #1013 review：demo 故事跟示範藥單一樣，只能放憑空構造的資料）。
    // 每個情節分支都會完整指定早晚讀值；不先放無效預設值可避免 lint 誤判與維護誤解。
    let sysM: number, diaM: number, pulseM: number
    let sysE: number, diaE: number, pulseE: number

    if (day >= 75) {
      sysM = getFluctuation(158, day, 1, 6)
      diaM = getFluctuation(94, day, 1, 4)
      pulseM = getFluctuation(84, day, 1, 4)

      sysE = getFluctuation(154, day, 2, 5)
      diaE = getFluctuation(91, day, 2, 4)
      pulseE = getFluctuation(82, day, 2, 3)
    } else if (day >= 68) {
      const progress = (75 - day) / 7
      sysM = Math.round(158 - progress * 34 + (Math.sin(day) * 3))
      diaM = Math.round(94 - progress * 22 + (Math.cos(day) * 2))
      pulseM = 80 - Math.round(progress * 6)
      sysE = sysM - 4
      diaE = diaM - 3
      pulseE = pulseM - 2
    } else if (day === 66) {
      // 大事記「起身頭暈與舒張壓偏低」引用的就是這天早上的讀值；寫死，讓時間軸跟血壓圖對得上
      // （tests/unit/demoData.test.ts 會逐筆核對被引用的讀值）。
      sysM = 104; diaM = 52; pulseM = 74
      sysE = 101; diaE = 53; pulseE = 70
    } else if (day >= 64) {
      // 舒張壓只在 50–55 之間擺動：這段故事要示範的是「偏低但還沒到危險」的區間，不能偶然掉到 50 以下。
      sysM = getFluctuation(104, day, 1, 4)
      diaM = getFluctuation(52, day, 1, 1)
      pulseM = getFluctuation(72, day, 1, 3)
      sysE = getFluctuation(102, day, 2, 4)
      diaE = getFluctuation(53, day, 2, 1)
      pulseE = getFluctuation(70, day, 2, 3)
    } else if (day === 45) {
      // 漏服早上降壓藥那天：早上仍正常，晚上 20:30 的 142/90 才是大事記引用的那筆。
      sysM = 126; diaM = 80; pulseM = 72
      sysE = 142; diaE = 90; pulseE = 82
    } else if (day === 15) {
      sysM = 121; diaM = 75; pulseM = 70
      // 突發極高血壓與複測。處置照 src/config/blood-pressure-spec.json 的 danger_high 規則（休息 1–5 分鐘重測；
      // 若持續，立刻就醫或聯絡醫師）：20:25 首測 → 20:30 複測仍高 → 立刻聯絡門診。20:40 的第三筆只是等回電時的
      // 追蹤紀錄，不是任何規則要求的重測——158/92 落在 tinggi 區間，該區間刻意不給建議，「10 分鐘內重測」是
      // cukup_tinggi（≥160 或 ≥100）才有的指示。示範故事不能示範一個跟 app 自己的判讀規則相反或張冠李戴的 SOP
      // （PR #1013 review）。
      const firstMeasuredIso = new Date(`${isoPrefix}T20:25:00+08:00`).toISOString()
      records.push({
        id: `demo-bp-meiling-${day}-e1`,
        patient_id: DEMO_MEILING_PATIENT_ID,
        systolic: 196,
        diastolic: 104,
        pulse: 98,
        measured_at: firstMeasuredIso,
        created_at: firstMeasuredIso,
        recorded_by: 'caregiver@example.com',
        source: 'manual',
      })
      sysE = 158; diaE = 92; pulseE = 86
      const thirdMeasuredIso = new Date(`${isoPrefix}T20:40:00+08:00`).toISOString()
      records.push({
        id: `demo-bp-meiling-${day}-e2`,
        patient_id: DEMO_MEILING_PATIENT_ID,
        systolic: 152,
        diastolic: 90,
        pulse: 84,
        measured_at: thirdMeasuredIso,
        created_at: thirdMeasuredIso,
        recorded_by: 'caregiver@example.com',
        source: 'manual',
      })
    } else {
      sysM = getFluctuation(121, day, 1, 5)
      diaM = getFluctuation(75, day, 1, 4)
      pulseM = getFluctuation(70, day, 1, 3)
      sysE = getFluctuation(119, day, 2, 4)
      diaE = getFluctuation(74, day, 2, 3)
      pulseE = getFluctuation(68, day, 2, 3)
    }

    records.push({
      id: `demo-bp-meiling-${day}-m`,
      patient_id: DEMO_MEILING_PATIENT_ID,
      systolic: sysM,
      diastolic: diaM,
      pulse: pulseM,
      measured_at: morningIso,
      created_at: morningIso,
      recorded_by: 'caregiver@example.com',
      source: 'manual',
    })

    records.push({
      id: `demo-bp-meiling-${day}-e`,
      patient_id: DEMO_MEILING_PATIENT_ID,
      systolic: sysE,
      diastolic: diaE,
      pulse: pulseE,
      measured_at: eveningIso,
      created_at: eveningIso,
      recorded_by: 'caregiver@example.com',
      source: 'manual',
    })
  }

  return records.sort((a, b) => new Date(b.measured_at).getTime() - new Date(a.measured_at).getTime())
}

export function getFallbackDemoTemperatureRecords(days: number, patientId: string = DEMO_MEILING_PATIENT_ID): TemperatureRecord[] {
  if (patientId !== DEMO_MEILING_PATIENT_ID && patientId !== DEMO_CHEN_PATIENT_ID) return []
  const baseNow = new Date(DEMO_FALLBACK_BASE_DATE)
  const count = Math.min(Math.max(1, days), 7)
  return Array.from({ length: count }, (_, index) => {
    const measuredAt = new Date(baseNow.getTime() - (count - index - 1) * 86_400_000 + 9 * 3_600_000).toISOString()
    const temperature = patientId === DEMO_CHEN_PATIENT_ID
      ? 37.2 + ((index % 3) * 0.2)
      : index === count - 1 ? 38.2 : 36.8 + ((index % 2) * 0.2)
    return {
      id: `demo-temperature-${patientId === DEMO_CHEN_PATIENT_ID ? 'chen' : 'meiling'}-${index}`,
      patient_id: patientId,
      temperature_c: temperature,
      measurement_site: 'ear' as const,
      context: (index === count - 1 ? 'symptoms' : 'routine') as TemperatureRecord['context'],
      notes: null,
      measured_at: measuredAt,
      created_at: measuredAt,
      recorded_by: patientId === DEMO_CHEN_PATIENT_ID ? 'demo.chen@example.test' : 'caregiver@example.com',
      source: 'demo_fallback',
    }
  }).sort((left, right) => Date.parse(right.measured_at) - Date.parse(left.measured_at))
}

const mockMedication = (
  id: string,
  name: string,
  zh: string,
  idName: string,
  strengthMg = 5,
  strengthLabel = '5mg',
  appearanceColor: string | null = null,
  appearanceShape: string | null = 'round',
  genericName?: string,
  dosageForm: MedicationCatalog['dosage_form'] = 'tablet',
  // 只填公開可查證的 WHO ATC 碼（對照成分學名，非猜測）；查不到公開分類的藥維持 null，不硬套標籤。
  atcCode: string | null = null,
): MedicationCatalog => ({
  id,
  drug_product_id: null,
  brand_name: name,
  brand_name_zh: zh,
  brand_name_id: idName,
  // 部分商品名（例如 Crestor、Norvasc）跟成分學名不同；沒指定學名時才回退用商品名，避免破壞既有呼叫端行為。
  generic_name: genericName ?? name,
  strength_mg: strengthMg,
  strength_label: strengthLabel,
  dosage_form: dosageForm,
  specialties: [],
  verification_status: 'manually_verified',
  tfda_license_number: null,
  nhi_drug_code: null,
  appearance_note: null,
  appearance_color: appearanceColor,
  appearance_shape: appearanceShape,
  appearance_photo_url: null,
  created_at: DEMO_FALLBACK_BASE_DATE,
  atc_code: atcCode,
})

export function getFallbackDemoLeeMedicationCatalog(): MedicationCatalog[] {
  // 這七項是一份「憑空組出來」的示範藥單：為了讓四個服藥分頁與藥名顯示規則不必依賴登入帳號的真實 Supabase 資料
  // 就能反覆驗證，刻意挑了台灣長輩門診常見、但彼此組合起來不對應任何一位真實使用者的藥品。
  // 為什麼不是「拿真實藥單當 demo」：這個檔案會進公開作品集，藥單＋劑量＋時段組合本身就足以辨識一個人的
  // 治療內容（2026-09 逐檔複查與 PR #1013 review 抓到）。之後改動只能在這份虛構清單上加減，不得回填真實處方。
  // 每一項的角色（讓各個畫面規則都有東西可測）：
  //   - 一顆腸溶錠帶 official_dosage_form_text → 服用方式 A 層 swallow_whole 徽章
  //   - 一顆膜衣錠帶藥師 B 層交代（見 getFallbackDemoLeePatientMedicationInstructions）
  //   - 一顆一天兩個時段 → 「同一顆藥出現在兩個時段」的排法
  //   - 一顆學名／商品未確認、沒有 ATC → 「未驗證藥品」的顯示規則
  //   - 其餘補成早餐後六項、晚餐前兩項，讓手機版「先展開第一個時段」有足夠卡片可看
  return [
    // atc_code 皆為公開可查證的 WHO ATC 分類碼（依成分學名對照，非猜測）：
    // Pantoprazole→A02BC02、Amlodipine→C08CA01、Bisoprolol→C07AB07、Rosuvastatin→C10AA07、
    // Valsartan→C09CA03、Calcium+Vitamin D→A12AX。
    // official_dosage_form_text 是服用方式 A 層 demo：腸溶錠品名已寫明「腸溶」，填官方原文讓
    // resolveSwallowGuidance() 命中 swallow_whole，不必真實 Supabase 資料就能驗證 A 層徽章。
    { ...mockMedication('demo-med-lee-pantoloc-40', 'Pantoloc', '保衛康治潰樂腸溶錠 40毫克', 'Pantoloc 40mg', 40, '40mg', 'yellow', 'oval', 'Pantoprazole', 'tablet', 'A02BC02'), official_dosage_form_text: '腸溶錠' },
    mockMedication('demo-med-lee-norvasc-5', 'Norvasc', '脈優錠 5毫克', 'Norvasc 5mg', 5, '5mg', 'white', 'other', 'Amlodipine', 'tablet', 'C08CA01'),
    mockMedication('demo-med-lee-concor-5', 'Concor', '康肯膜衣錠 5毫克', 'Concor 5mg', 5, '5mg', 'yellow', 'other', 'Bisoprolol', 'tablet', 'C07AB07'),
    mockMedication('demo-med-lee-crestor-10', 'Crestor', '冠脂妥膜衣錠 10毫克', 'Crestor 10mg', 10, '10mg', 'pink', 'round', 'Rosuvastatin', 'tablet', 'C10AA07'),
    mockMedication('demo-med-lee-diovan-80', 'Diovan', '得安穩膜衣錠 80毫克', 'Diovan 80mg', 80, '80mg', 'pink', 'oval', 'Valsartan', 'tablet', 'C09CA03'),
    mockMedication('demo-med-lee-caltrate-600', 'Caltrate', '挺立鈣加維生素D錠 600毫克', 'Caltrate 600mg', 600, '600mg', 'white', 'oval', 'Calcium carbonate + Vitamin D3', 'tablet', 'A12AX'),
    // 氧化鎂學名／商品未確認，沒有查證過的官方連結，不硬套分類碼——示範「未驗證藥品」的顯示規則。
    mockMedication('demo-med-lee-magnesium-oxide-250', 'Magnesium oxide', '氧化鎂錠（學名／商品未確認）', 'Magnesium oxide 250mg', 250, '250mg', 'white', 'round', 'Magnesium oxide'),
  ]
}

export function getFallbackDemoLeeMedicationPlans(): MedicationPlan[] {
  // 早餐後與晚餐前兩個時段；鈣加維生素 D 一天兩次，示範「同一顆藥一天多個時段」的排法（分次補鈣是常見用法）。
  const plan = (id: string, medicationId: string, slot: string, order: number, doseAmount = 1): MedicationPlan => ({
    id, account_email: 'demo.lee@example.test', patient_id: DEMO_LEE_PATIENT_ID,
    medication_id: medicationId, schedule_slot: slot, as_needed: false, dose_amount: doseAmount, dose_count: 1,
    display_order: order, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
  })
  return [
    plan('demo-plan-lee-pantoloc', 'demo-med-lee-pantoloc-40', 'after_breakfast', 1),
    plan('demo-plan-lee-norvasc', 'demo-med-lee-norvasc-5', 'after_breakfast', 2),
    plan('demo-plan-lee-concor', 'demo-med-lee-concor-5', 'after_breakfast', 3, 0.5),
    plan('demo-plan-lee-crestor', 'demo-med-lee-crestor-10', 'after_breakfast', 4),
    plan('demo-plan-lee-magnesium-oxide', 'demo-med-lee-magnesium-oxide-250', 'after_breakfast', 5),
    plan('demo-plan-lee-caltrate-am', 'demo-med-lee-caltrate-600', 'after_breakfast', 6),
    plan('demo-plan-lee-diovan', 'demo-med-lee-diovan-80', 'before_dinner', 7, 1),
    plan('demo-plan-lee-caltrate-pm', 'demo-med-lee-caltrate-600', 'before_dinner', 8),
  ]
}

// 服用方式 B 層 demo：冠脂妥（膜衣錠，官方劑型沒有任何 A 層關鍵字，屬於 unknown）藥師交代過可以磨粉配水，
// 讓 staging 不必真實紀錄就能驗證詳情視窗與交接手冊同時顯示來源、交代日期與備註。
export function getFallbackDemoLeePatientMedicationInstructions(): PatientMedicationInstruction[] {
  return [{
    patient_id: DEMO_LEE_PATIENT_ID,
    medication_id: 'demo-med-lee-crestor-10',
    instruction_codes: ['crush_ok', 'with_food'],
    instruction_note: '吞不下的時候才磨粉配溫水',
    source: 'pharmacist',
    confirmed_on: '2026-07-20',
    updated_by: 'demo.lee@example.test',
    updated_at: DEMO_FALLBACK_BASE_DATE,
  }]
}

export function getFallbackDemoMedicationCatalog(): MedicationCatalog[] {
  // Demo 先在前端準備完整藥品主檔，資料庫未 seed 或訪客未登入時仍能實際操作藥單表單。
  return [
    // 複方藥仍需數字欄位供舊資料契約排序，但畫面一律優先顯示已核對的 5/80mg 原始標示，不能把兩個成分相加成誤導性的 85 mg。
    // atc_code：Amlodipine+Valsartan→C09DB01、Metformin→A10BA02、Bisoprolol→C07AB07、
    // Furosemide→C03CA01、Nifedipine→C08CA05（皆為公開查證的 WHO ATC 分類碼）。Imdur 學名
    // Isosorbide mononitrate 屬硝酸鹽類，對照表未收錄該分類，維持不顯示標籤。
    // 王美玲的故事藥單跟她的血壓曲線一樣是構造出來的（見 getFallbackDemoBpRecords 的說明）。
    mockMedication('demo-med-exforge-5-80', 'Exforge', '易安穩膜衣錠 5/80毫克', 'Exforge 5/80mg', 85, '5/80mg', 'yellow', undefined, undefined, 'tablet', 'C09DB01'),
    mockMedication('demo-med-imdur-30', 'Imdur', '伊姆多持續性藥效錠 30毫克', 'Imdur 30mg', 30, '30mg', 'white'),
    mockMedication('demo-med-metformin-500', 'Glucophage', '庫魯化膜衣錠 500毫克', 'Glucophage 500mg', 500, '500mg', 'white', 'oval', undefined, 'tablet', 'A10BA02'),
    mockMedication('demo-med-concor-5', 'Concor', '康肯膜衣錠 5毫克', 'Concor 5mg', 5, '5mg', 'yellow', undefined, 'Bisoprolol', 'tablet', 'C07AB07'),
    mockMedication('demo-med-lasix-40', 'Lasix', '來喜適錠 40毫克', 'Lasix 40mg', 40, '40mg', 'white', undefined, 'Furosemide', 'tablet', 'C03CA01'),
    mockMedication('demo-med-legacy-bp-30', 'Adalat OROS', '恆脈循持續性藥效錠 30毫克', 'Adalat OROS 30mg', 30, '30mg', 'pink', undefined, 'Nifedipine', 'tablet', 'C08CA05'),
  ]
}

export function getFallbackDemoMedicationPlans(): MedicationPlan[] {
  // 這些是故事中「現在仍在服用」的藥單；停用藥仍留在 history，不應再出現在每日點收。
  return [
    {
      id: 'demo-plan-exforge-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-exforge-5-80', schedule_slot: 'morning', as_needed: false, dose_amount: 0.5, dose_count: 1,
      display_order: 1, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      id: 'demo-plan-metformin-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-metformin-500', schedule_slot: 'before_bed', as_needed: false, dose_amount: 1, dose_count: 1,
      display_order: 2, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      id: 'demo-plan-concor-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-concor-5', schedule_slot: 'morning', as_needed: false, dose_amount: 0.5, dose_count: 1,
      display_order: 3, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      id: 'demo-plan-imdur-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-imdur-30', schedule_slot: 'before_bed', as_needed: false, dose_amount: 1, dose_count: 1,
      display_order: 4, active: false, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      id: 'demo-plan-legacy-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-legacy-bp-30', schedule_slot: 'morning', as_needed: false, dose_amount: 1, dose_count: 1,
      display_order: 5, active: false, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      // Demo 保留一張合成 PRN plan，讓驗收者能看見「尚未評估／今天未需要」而不必連真實照護資料。
      id: 'demo-plan-lasix-prn-meiling', account_email: 'demo.meiling@example.test', patient_id: DEMO_MEILING_PATIENT_ID,
      medication_id: 'demo-med-lasix-40', schedule_slot: 'anytime', as_needed: true, dose_amount: 1, dose_count: 1,
      display_order: 6, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
    },
    {
      id: 'demo-plan-lasix-chen', account_email: 'demo.chen@example.test', patient_id: DEMO_CHEN_PATIENT_ID,
      medication_id: 'demo-med-lasix-40', schedule_slot: 'morning', as_needed: false, dose_amount: 1, dose_count: 1,
      display_order: 1, active: true, created_at: DEMO_FALLBACK_BASE_DATE,
    },
  ]
}

export function getFallbackDemoMedicationHistory(): MedicationPlanChangeLogView[] {
  const baseNow = new Date(DEMO_FALLBACK_BASE_DATE)
  const dateAgoIso = (daysAgo: number) => new Date(baseNow.getTime() - daysAgo * 86400000).toISOString()

  return [
    {
      id: 'demo-log-1',
      patient_id: DEMO_MEILING_PATIENT_ID,
      action: 'deactivate',
      plan_id: 'demo-plan-legacy',
      medication_id: 'demo-med-legacy-bp-30',
      medication: mockMedication('demo-med-legacy-bp-30', 'Adalat OROS', '恆脈循持續性藥效錠 30毫克', 'Adalat OROS 30mg'),
      schedule_slot: 'morning',
      dose_amount: 1,
      dose_count: 1,
      as_needed: false,
      reason: '門診診斷：單方降壓藥兩週平均約 155/92 mmHg 未達標，遵醫囑停用並更換為複方處方。',
      actor_email: 'owner@example.com',
      before_snapshot: { plan_id: 'demo-plan-legacy', medication_id: 'demo-med-legacy-bp-30', schedule_slot: 'morning', dose_amount: 1, dose_count: 1, as_needed: false, active: true, brand_name: 'Adalat OROS', brand_name_zh: '恆脈循持續性藥效錠 30毫克', dosage_form: 'tablet' },
      after_snapshot: { plan_id: 'demo-plan-legacy', medication_id: 'demo-med-legacy-bp-30', schedule_slot: 'morning', dose_amount: 1, dose_count: 1, as_needed: false, active: false, brand_name: 'Adalat OROS', brand_name_zh: '恆脈循持續性藥效錠 30毫克', dosage_form: 'tablet' },
      recorded_at: dateAgoIso(75), effective_at: dateAgoIso(75),
      created_at: dateAgoIso(75),
    },
    {
      id: 'demo-log-2',
      patient_id: DEMO_MEILING_PATIENT_ID,
      action: 'create',
      plan_id: 'demo-plan-exforge',
      medication_id: 'demo-med-exforge-5-80',
      medication: mockMedication('demo-med-exforge-5-80', 'Exforge', '易安穩膜衣錠 5/80毫克', 'Exforge 5/80mg'),
      schedule_slot: 'morning',
      dose_amount: 0.5,
      dose_count: 1,
      as_needed: false,
      reason: '門診開立：改用複方易安穩 Exforge 5/80mg 每日早晨 0.5 錠，先觀察一週早晚讀值再決定是否調整。',
      actor_email: 'owner@example.com',
      before_snapshot: {},
      after_snapshot: { plan_id: 'demo-plan-exforge', medication_id: 'demo-med-exforge-5-80', schedule_slot: 'morning', dose_amount: 0.5, dose_count: 1, as_needed: false, active: true, brand_name: 'Exforge', brand_name_zh: '易安穩膜衣錠 5/80毫克', dosage_form: 'tablet' },
      recorded_at: dateAgoIso(75), effective_at: dateAgoIso(75),
      created_at: dateAgoIso(75),
    },
    {
      id: 'demo-log-3',
      patient_id: DEMO_MEILING_PATIENT_ID,
      action: 'deactivate',
      plan_id: 'demo-plan-imdur',
      medication_id: 'demo-med-imdur-30',
      medication: mockMedication('demo-med-imdur-30', 'Imdur', '伊姆多持續性藥效錠 30毫克', 'Imdur 30mg'),
      schedule_slot: 'before_bed',
      dose_amount: 1,
      dose_count: 1,
      as_needed: false,
      reason: '醫囑停用：起身頭暈且早晚舒張壓連兩日落在 50-54 mmHg，主治醫師指示先停用睡前的硝酸鹽類 Imdur。',
      actor_email: 'caregiver@example.com',
      before_snapshot: { plan_id: 'demo-plan-imdur', medication_id: 'demo-med-imdur-30', schedule_slot: 'before_bed', dose_amount: 1, dose_count: 1, as_needed: false, active: true, brand_name: 'Imdur', brand_name_zh: '伊姆多持續性藥效錠 30毫克', dosage_form: 'tablet' },
      after_snapshot: { plan_id: 'demo-plan-imdur', medication_id: 'demo-med-imdur-30', schedule_slot: 'before_bed', dose_amount: 1, dose_count: 1, as_needed: false, active: false, brand_name: 'Imdur', brand_name_zh: '伊姆多持續性藥效錠 30毫克', dosage_form: 'tablet' },
      recorded_at: dateAgoIso(64), effective_at: dateAgoIso(64),
      created_at: dateAgoIso(64),
    },
    {
      id: 'demo-log-4',
      patient_id: DEMO_MEILING_PATIENT_ID,
      action: 'create',
      plan_id: 'demo-plan-concor',
      medication_id: 'demo-med-concor-5',
      medication: mockMedication('demo-med-concor-5', 'Concor', '康肯膜衣錠 5毫克', 'Concor 5mg'),
      schedule_slot: 'morning',
      dose_amount: 0.5,
      dose_count: 1,
      as_needed: false,
      reason: '門診加開：回診時靜息心率 88-92 bpm 偏快，早晨加開 Concor 5mg 半錠輔助心率穩定。',
      actor_email: 'owner@example.com',
      before_snapshot: {},
      after_snapshot: { plan_id: 'demo-plan-concor', medication_id: 'demo-med-concor-5', schedule_slot: 'morning', dose_amount: 0.5, dose_count: 1, as_needed: false, active: true, brand_name: 'Concor', brand_name_zh: '康肯膜衣錠 5毫克', dosage_form: 'tablet' },
      recorded_at: dateAgoIso(30), effective_at: dateAgoIso(30),
      created_at: dateAgoIso(30),
    },
  ]
}

export function getFallbackDemoCareTimeline(): CareTimelineEntry[] {
  const baseNow = new Date(DEMO_FALLBACK_BASE_DATE)
  const dateAgoIso = (daysAgo: number) => new Date(baseNow.getTime() - daysAgo * 86400000).toISOString()

  // 這條時間軸是為了讓軌跡頁、交接手冊與就診前摘要有「換藥→低血壓→漏藥→突發高壓→穩定」每一種事件可看而寫的
  // 劇本，事件、數值與日期都是構造出來的，不轉述任何真實照護紀錄（PR #1013 review）；改動時只能在劇本上加減。
  // 敘述裡引用的單筆讀值必須真的出現在 getFallbackDemoBpRecords 同一天的資料裡（單元測試會核對），
  // 平均值則是依那段區間的產生器參數估的約數；血壓處置的間隔照 blood-pressure-spec.json 的規則寫。
  return [
    {
      id: 'demo-timeline-1',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'doctor_instruction',
      title: '門診換成複方降壓藥',
      details: '兩週早晚平均約 155/92 mmHg 未達標。主治醫師停用單方 Adalat OROS，改開複方易安穩 Exforge 5/80mg 每日早晨 0.5 錠，請看護早晚各量一次並記錄一週。',
      occurred_at: dateAgoIso(75),
      reassess_on: null,
      created_by: 'owner@example.com',
      created_at: dateAgoIso(75),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-2',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'symptom_observation',
      title: '起身頭暈與舒張壓偏低',
      details: '看護筆記：美玲阿姨早餐後起身時頭暈，坐下休息五分鐘後量到早上的 104/52 mmHg（舒張壓落在偏低區間）。已請她繼續坐著休息，並致電門診護理師報備。',
      occurred_at: dateAgoIso(66),
      reassess_on: null,
      created_by: 'caregiver@example.com',
      created_at: dateAgoIso(66),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-3',
      patient_id: DEMO_MEILING_PATIENT_ID,
      // 這筆是手寫的敘事筆記，不是由調藥 RPC 建立的系統事件；event_type 曾誤用保留給系統事件的
      // 'medication_change'（沒有對應的 medication_plan_change_log_id／snapshot），會讓軌跡頁把它
      // 誤判成 MedicationChangeTrajectoryEvent 而在讀取 .medication 時壞掉（issue #735 發現）。
      // 內容本質是醫師指示，改用 doctor_instruction 才符合 docs/features/care-timeline.md 的既有規則。
      event_type: 'doctor_instruction',
      title: '醫師指示：先停用睡前 Imdur',
      details: '醫師看過頭暈與早晚舒張壓 50-55 mmHg 的紀錄後，指示先停用睡前的 Imdur 30mg，其餘藥物照舊。停藥後兩天舒張壓回到 70 mmHg 上下，起身不再頭暈。',
      occurred_at: dateAgoIso(64),
      reassess_on: null,
      created_by: 'owner@example.com',
      created_at: dateAgoIso(64),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-4',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'milestone',
      title: '早上降壓藥漏服，晚間血壓略高',
      details: '當天家裡有客人，早上的 Exforge 忘了吃，系統標記早藥未確認；晚上 20:30 量到 142/90 mmHg 略高。已在系統補記這次漏服，並把早上的提醒提早到 07:30。',
      occurred_at: dateAgoIso(45),
      reassess_on: null,
      created_by: 'caregiver@example.com',
      created_at: dateAgoIso(45),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-5',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'milestone',
      title: '回診：血壓達標，加開 Concor 穩定心率',
      details: '心臟科回診，近兩週早晚平均約 122/76 mmHg 達標。靜息心率 88-92 bpm 偏快，醫師加開 Concor 康肯 5mg 每日早晨 0.5 錠，四週後回診看心率。',
      occurred_at: dateAgoIso(30),
      reassess_on: null,
      created_by: 'owner@example.com',
      created_at: dateAgoIso(30),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-6',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'symptom_observation',
      title: '突發高血壓 196/104 mmHg：複測仍高，立即聯絡門診',
      details: '晚間 20:25 測得 196/104 mmHg，系統判為極高血壓、要求立即重測。看護讓美玲阿姨坐下休息 5 分鐘，20:30 複測 158/92 mmHg 仍高，沒有口齒不清、單側無力或胸痛，依提示立刻打電話給門診護理師，並用 LINE 通知外地家屬；等回電期間 20:40 再量一次 152/90 mmHg 作追蹤。護理師確認今早的降壓藥已點收後，指示今晚照常服藥、隔天早上回報讀值。',
      occurred_at: dateAgoIso(15),
      reassess_on: null,
      created_by: 'caregiver@example.com',
      created_at: dateAgoIso(15),
      medication_plan_id: null,
    },
    {
      id: 'demo-timeline-7',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'symptom_observation',
      title: '輕微感冒症狀與心衰竭體重水腫監測',
      details: '美玲阿姨鼻塞、輕微咳嗽兩天，體重從 60.2 kg 升到 61.5 kg。看護留意是否為下肢水腫，拍照記錄小腿按壓後的凹陷方便家屬遠端判斷；三天後體重回到 60.4 kg，腫脹消退。',
      occurred_at: dateAgoIso(8),
      reassess_on: null,
      created_by: 'caregiver@example.com',
      created_at: dateAgoIso(8),
      medication_plan_id: null,
      // 展示模式專屬：兩張抽象示意圖，不是任何真人的照片，用來示範「文字講不清楚，拍照最快」這個功能。
      demo_photo_urls: ['/demo/care-timeline/edema-day1.svg', '/demo/care-timeline/edema-day3.svg'],
    },
    {
      id: 'demo-timeline-8',
      patient_id: DEMO_MEILING_PATIENT_ID,
      event_type: 'doctor_instruction',
      title: '90 天照護綜合門診評估',
      details: '主治醫師看過三個月的血壓趨勢圖與服藥點收率，血壓控制穩定（近月平均約 122/76 mmHg），開立未來 3 個月慢性病連續處方箋。',
      occurred_at: dateAgoIso(1),
      reassess_on: null,
      created_by: 'owner@example.com',
      created_at: dateAgoIso(1),
      medication_plan_id: null,
    },
  ]
}
