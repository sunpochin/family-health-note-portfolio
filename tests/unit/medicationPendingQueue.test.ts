/*
檔案用途：服藥打卡離線佇列的衝突案例（issue #822 驗收條件）：同一劑離線按兩次、兩台手機各自離線打卡、回應遺失後重送、
  不同時段、切換病人、補送跨過 04:00、送出前撤回、與伺服器資料對帳——每一種都要確認伺服器上「同一劑只有一筆」。
所在層：tests/unit；用假的 Supabase（模擬資料庫唯一索引與 care_date trigger）取代真的資料庫，不連網。
主要關聯：src/lib/medication/medicationPendingQueue.ts、src/lib/medication/medications.ts（insertMedicationDoseLog）、
  supabase 唯一索引 idx_medication_intake_logs_patient_plan_care_date_unique。
*/
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import dayjs from 'dayjs'
import type { MedicationIntakeLog } from '../../src/types/database'

const { careDateKey } = await import('../../src/lib/careDay')

// ── 假伺服器：只模擬這個功能依賴的兩條資料庫規則 ─────────────────────────────
// 1. 唯一索引 (patient_id, plan_id, care_date, dose_number)；2. trigger 一律由 taken_at 重算 care_date。
type InsertPayload = Omit<MedicationIntakeLog, 'id' | 'created_at'>
const server = {
  rows: [] as MedicationIntakeLog[],
  insertAttempts: [] as InsertPayload[],
  deleteFilters: [] as Array<Record<string, unknown>>,
  offline: false,
  // 寫入成功、但回應在回程斷掉（看護手機看到的是失敗）。
  loseNextResponse: false,
  nextError: null as null | { error: { code: string; message: string }; status: number },
}

// 斷線時 supabase-js（postgrest-js 2.x）實際回傳的錯誤形狀：不是原生 TypeError，而是包過的物件、status 0。
// 用這個形狀而不是 new TypeError(...)，測試才會走到真實瀏覽器離線時的判斷路徑（#1116 就是只測 TypeError 而漏掉的）。
// 這個形狀由 tests/unit/dataErrors.test.ts 用真的 supabase-js client 鎖住。
const offlineError = () => ({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' })

function serverInsert(payload: InsertPayload) {
  server.insertAttempts.push(payload)
  if (server.offline) return { data: null, error: offlineError(), status: 0 }
  if (server.nextError) {
    const failure = server.nextError
    server.nextError = null
    return { data: null, ...failure }
  }
  const careDate = careDateKey(dayjs(payload.taken_at))
  const duplicate = server.rows.find(row => row.patient_id === payload.patient_id && row.plan_id === payload.plan_id && row.care_date === careDate && row.dose_number === payload.dose_number)
  if (duplicate) return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "idx_medication_intake_logs_patient_plan_care_date_unique"' }, status: 409 }
  const row: MedicationIntakeLog = { ...payload, care_date: careDate, id: `row-${server.rows.length + 1}`, created_at: payload.taken_at }
  server.rows.push(row)
  if (server.loseNextResponse) {
    server.loseNextResponse = false
    return { data: null, error: offlineError(), status: 0 }
  }
  return { data: row, error: null, status: 201 }
}

function matchesFilters(row: MedicationIntakeLog, filters: Record<string, unknown>) {
  return Object.entries(filters).every(([column, value]) => (row as unknown as Record<string, unknown>)[column] === value)
}

const mockSupabase = {
  from(table: string) {
    if (table !== 'medication_intake_logs') throw new Error(`unexpected table ${table}`)
    return {
      insert: (payload: InsertPayload) => ({ select: () => ({ single: async () => serverInsert(payload) }) }),
      // DELETE ... WHERE 多個 eq；整條鏈被 await 時才真的執行（跟 PostgREST builder 一樣是 thenable）。
      delete: () => {
        const filters: Record<string, unknown> = {}
        const chain = {
          eq(column: string, value: unknown) { filters[column] = value; return chain },
          then(resolve: (value: { error: unknown; status: number }) => void) {
            server.deleteFilters.push({ ...filters })
            if (server.offline) return resolve({ error: offlineError(), status: 0 })
            server.rows = server.rows.filter(row => !matchesFilters(row, filters))
            return resolve({ error: null, status: 204 })
          },
        }
        return chain
      },
      select: () => {
        const filters: Record<string, unknown> = {}
        const chain = {
          eq(column: string, value: unknown) { filters[column] = value; return chain },
          single: async () => {
            const row = server.rows.find(item => Object.entries(filters).every(([column, value]) => (item as unknown as Record<string, unknown>)[column] === value))
            return row ? { data: row, error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
          },
        }
        return chain
      },
    }
  },
}
mock.module('../../src/lib/supabase', () => ({ supabase: mockSupabase }))

const {
  buildPendingMedicationDose,
  enqueuePendingMedicationDose,
  flushPendingMedicationDoses,
  isPendingMedicationLog,
  medicationDoseKey,
  mergeMedicationDayLogs,
  pendingMedicationDoseToLog,
  readPendingMedicationDoses,
  reconcilePendingMedicationDoses,
  removePendingMedicationDose,
  syncPendingMedicationDose,
  upsertMedicationDayLogs,
  withdrawPendingMedicationDose,
  applyMedicationSyncToDayLogs,
} = await import('../../src/lib/medication/medicationPendingQueue')
const { saveMedicationDose } = await import('../../src/lib/medication/medications')
const { isRetryableWriteError } = await import('../../src/lib/dataErrors')
import type { MedicationPlanView } from '../../src/lib/medication/medications'
import type { PendingMedicationDose, PendingMedicationSyncOutcome } from '../../src/lib/medication/medicationPendingQueue'

// ── localStorage 替身 ───────────────────────────────────────────────────────
const originalLocalStorage = globalThis.localStorage
const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  server.rows = []
  server.insertAttempts = []
  server.deleteFilters = []
  server.offline = false
  server.loseNextResponse = false
  server.nextError = null
  ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => { storage.set(key, value) },
    removeItem: key => { storage.delete(key) },
  } as Storage
})
afterEach(() => {
  if (originalLocalStorage) {
    ;(globalThis as typeof globalThis & { localStorage: Storage }).localStorage = originalLocalStorage
  } else {
    delete (globalThis as typeof globalThis & { localStorage?: Storage }).localStorage
  }
})

const plan = (overrides: Partial<MedicationPlanView> = {}): MedicationPlanView => ({
  id: 'plan-morning-norvasc',
  account_email: 'owner@example.com',
  patient_id: 'patient-a',
  medication_id: 'norvasc-5',
  schedule_slot: 'morning',
  as_needed: false,
  dose_amount: 1,
  dose_count: 2,
  display_order: 10,
  active: true,
  created_at: '2026-07-11T00:00:00.000Z',
  medication: { brand_name: 'Norvasc', generic_name: 'amlodipine', dosage_form: 'tablet' },
  ...overrides,
} as MedicationPlanView)

// 台北 2026-10-06 08:00 與 08:05（UTC+8），照護日都是 2026-10-06。
const MORNING = '2026-10-06T00:00:00.000Z'
const MORNING_LATER = '2026-10-06T00:05:00.000Z'
const CAREGIVER = 'care@example.com'

/** 模擬看護在畫面上按一劑：先嘗試線上寫入，斷線才排入佇列（與 MedicationPage 的流程相同）。 */
async function tapDose(target: MedicationPlanView, doseNumber: number, takenAt: string, account = CAREGIVER) {
  try {
    return { log: await saveMedicationDose(target, careDateKey(dayjs(takenAt)), doseNumber, account, takenAt), queued: false }
  } catch (error) {
    // 跟頁面一樣只在可重試的錯誤才排進佇列；這樣離線案例才會真的驗到 supabase-js 斷線形狀的判斷（#1116）。
    if (!isRetryableWriteError(error)) return { log: null, queued: false }
    return { log: null, queued: enqueuePendingMedicationDose(buildPendingMedicationDose(target, doseNumber, account, takenAt)) }
  }
}

async function flush(patientId = 'patient-a', account = CAREGIVER) {
  const results: PendingMedicationSyncOutcome[] = []
  const result = await flushPendingMedicationDoses({
    patientId,
    recordedBy: account,
    save: async dose => { results.push(await syncPendingMedicationDose(dose)) },
  })
  return { ...result, results }
}

describe('medication check-in offline queue (issue #822)', () => {
  test('tapping the same dose twice while offline leaves exactly one row after reconnecting', async () => {
    server.offline = true
    expect((await tapDose(plan(), 1, MORNING)).queued).toBe(true)
    expect((await tapDose(plan(), 1, MORNING_LATER)).queued).toBe(true)

    const queued = readPendingMedicationDoses('patient-a', CAREGIVER)
    expect(queued).toHaveLength(1)
    // 藥是在第一次按下時吃的；第二次按不能把服藥時間改晚。
    expect(queued[0].taken_at).toBe(MORNING)

    server.offline = false
    const result = await flush()
    expect(server.rows).toHaveLength(1)
    expect(server.rows[0]).toMatchObject({ patient_id: 'patient-a', plan_id: 'plan-morning-norvasc', dose_number: 1, care_date: '2026-10-06', taken_at: MORNING })
    expect(result.remaining).toEqual([])
    expect(result.results[0]).toMatchObject({ kind: 'recorded', superseded: false })
  })

  test('a replay sends only real table columns, never the queue bookkeeping fields', async () => {
    // PostgREST 對不存在的欄位回 400 PGRST204（不可重試）；血壓佇列就曾因把 queued_at／notified 一起送出而永遠補不上（#1126）。
    // 假伺服器照單全收，所以這裡直接鎖住實際送出的欄位與撤回用的篩選欄位。
    server.loseNextResponse = true
    await tapDose(plan(), 1, MORNING)
    withdrawPendingMedicationDose(readPendingMedicationDoses('patient-a', CAREGIVER)[0])
    server.offline = true
    await tapDose(plan(), 2, MORNING)
    server.offline = false
    await flush()

    const columns = ['account_email', 'care_date', 'dose_number', 'medication_id', 'medication_name', 'patient_id', 'plan_id', 'taken_at', 'taken_on']
    for (const payload of server.insertAttempts) expect(Object.keys(payload).sort()).toEqual(columns)
    expect(server.deleteFilters.map(filters => Object.keys(filters).sort())).toEqual([['account_email', 'care_date', 'dose_number', 'patient_id', 'plan_id', 'taken_at']])
  })

  test('different doses and different slots each keep their own row', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    await tapDose(plan(), 2, MORNING)
    await tapDose(plan({ id: 'plan-evening-norvasc', schedule_slot: 'evening' }), 1, '2026-10-06T11:00:00.000Z')
    server.offline = false

    await flush()
    expect(server.rows.map(row => `${row.plan_id}#${row.dose_number}`).sort()).toEqual([
      'plan-evening-norvasc#1', 'plan-morning-norvasc#1', 'plan-morning-norvasc#2',
    ])
  })

  test('two phones checking in the same dose offline: the first to reach the server wins and the other is flagged', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING, CAREGIVER)
    server.offline = false
    // 另一位照護者在有訊號的地方先記錄了同一劑。
    await tapDose(plan(), 1, MORNING_LATER, 'family@example.com')

    const result = await flush()
    expect(server.rows).toHaveLength(1)
    expect(server.rows[0].account_email).toBe('family@example.com')
    // 佇列清空（不無限重試），並回報畫面上的時間以先記錄者為準。
    expect(result.remaining).toEqual([])
    expect(result.results).toEqual([{ kind: 'recorded', log: server.rows[0], superseded: true }])
  })

  test('a write that reached the server but lost its response is recognised as our own on retry', async () => {
    server.loseNextResponse = true
    expect((await tapDose(plan(), 1, MORNING)).queued).toBe(true)
    expect(server.rows).toHaveLength(1)

    const result = await flush()
    expect(server.rows).toHaveLength(1)
    expect(result.remaining).toEqual([])
    expect(result.results[0]).toMatchObject({ kind: 'recorded', superseded: false })
  })

  test('a dose tapped before 04:00 and synced after it stays on the earlier care day', async () => {
    // 台北 2026-10-07 03:50 仍屬 2026-10-06 照護日；補送發生在幾小時後也不能被算成 10-07。
    const beforeCutoff = '2026-10-06T19:50:00.000Z'
    server.offline = true
    await tapDose(plan(), 1, beforeCutoff)
    expect(readPendingMedicationDoses('patient-a', CAREGIVER)[0].care_date).toBe('2026-10-06')

    server.offline = false
    await flush()
    expect(server.insertAttempts.at(-1)).toMatchObject({ taken_at: beforeCutoff, care_date: '2026-10-06', taken_on: '2026-10-07' })
    expect(server.rows[0].care_date).toBe('2026-10-06')
  })

  test('switching patients never sends or shows another patient\'s queued doses', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    await tapDose(plan({ id: 'plan-b', patient_id: 'patient-b' }), 1, MORNING)
    server.offline = false

    expect(readPendingMedicationDoses('patient-b', CAREGIVER).map(dose => dose.patient_id)).toEqual(['patient-b'])
    await flush('patient-b')
    expect(server.rows.map(row => row.patient_id)).toEqual(['patient-b'])
    expect(readPendingMedicationDoses('patient-a', CAREGIVER)).toHaveLength(1)
    // 另一個帳號在同一台手機登入時看不到、也送不出前一個帳號的佇列（RLS 也會擋 account_email 不符的寫入）。
    expect(readPendingMedicationDoses('patient-a', 'family@example.com')).toEqual([])
  })

  test('a dose withdrawn on screen while an earlier dose is sending is never written', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    await tapDose(plan(), 2, MORNING_LATER)
    server.offline = false

    const second = readPendingMedicationDoses('patient-a', CAREGIVER)[1]
    await flushPendingMedicationDoses({
      patientId: 'patient-a',
      recordedBy: CAREGIVER,
      save: async dose => {
        await syncPendingMedicationDose(dose)
        if (dose.dose_number === 1) removePendingMedicationDose(second)
      },
    })
    expect(server.rows.map(row => row.dose_number)).toEqual([1])
  })

  test('temporary server errors keep the dose queued in order; permanent errors do not block later doses', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    await tapDose(plan(), 2, MORNING_LATER)
    server.offline = false

    server.nextError = { error: { code: '', message: 'Service Unavailable' }, status: 503 }
    const temporary = await flush()
    expect(temporary.blocked).toBe(true)
    expect(server.insertAttempts).toHaveLength(3)
    expect(temporary.remaining.map(dose => dose.dose_number)).toEqual([1, 2])

    server.nextError = { error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }
    const permanent = await flush()
    expect(permanent.remaining.map(dose => dose.dose_number)).toEqual([1])
    expect(server.rows.map(row => row.dose_number)).toEqual([2])
  })

  test('reconciling with loaded server rows resolves duplicates and flags doses recorded elsewhere', () => {
    const own = buildPendingMedicationDose(plan(), 1, CAREGIVER, MORNING)
    const elsewhere = buildPendingMedicationDose(plan(), 2, CAREGIVER, MORNING)
    const untouched = buildPendingMedicationDose(plan({ id: 'plan-evening' }), 1, CAREGIVER, MORNING)
    const serverLogs: MedicationIntakeLog[] = [
      { ...pendingMedicationDoseToLog(own), id: 'row-1' },
      { ...pendingMedicationDoseToLog(elsewhere), id: 'row-2', account_email: 'family@example.com', taken_at: MORNING_LATER },
    ]

    const { resolved, remaining } = reconcilePendingMedicationDoses([own, elsewhere, untouched], serverLogs)
    expect(resolved.map(item => [item.dose.dose_number, item.superseded])).toEqual([[1, false], [2, true]])
    expect(remaining).toEqual([untouched])
  })

  test('rejects stored entries whose id or care day does not match the dose they describe', () => {
    const dose = buildPendingMedicationDose(plan(), 1, CAREGIVER, MORNING)
    const key = 'jia-jian.pending-medication-dose.v1-patient-patient-a-care@example.com'
    const tampered: PendingMedicationDose[] = [
      { ...dose, id: 'random-id' },
      { ...dose, id: medicationDoseKey('patient-a', dose.plan_id, '2026-10-05', 1), care_date: '2026-10-05' },
    ]
    storage.set(key, JSON.stringify([...tampered, dose]))
    expect(readPendingMedicationDoses('patient-a', CAREGIVER)).toEqual([dose])
  })

  test('the day list shows the server row instead of the pending copy, so a dose is never counted twice', () => {
    const pending = pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 1, CAREGIVER, MORNING))
    const pendingSecond = pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 2, CAREGIVER, MORNING))
    const serverRow = { ...pending, id: 'row-1', account_email: 'family@example.com', taken_at: MORNING_LATER }

    expect(mergeMedicationDayLogs([serverRow], [pending, pendingSecond]).map(log => log.id)).toEqual(['row-1', pendingSecond.id])
    // 補送讀回的伺服器紀錄取代同一劑的舊項目，不在畫面製造第二筆。
    expect(upsertMedicationDayLogs([{ ...serverRow, id: 'stale' }, pendingSecond], [serverRow]).map(log => log.id)).toEqual([pendingSecond.id, 'row-1'])
  })

  test('withdrawing a dose whose write reached the server despite the lost response deletes that row once online', async () => {
    // 回應遺失：伺服器其實已寫入，手機以為失敗而排進佇列；看護隨後發現按錯而撤回。
    server.loseNextResponse = true
    await tapDose(plan(), 1, MORNING)
    expect(server.rows).toHaveLength(1)
    const queued = readPendingMedicationDoses('patient-a', CAREGIVER)[0]
    expect(withdrawPendingMedicationDose(queued)).toBe(true)

    const result = await flush()
    // 只刪掉伺服器上的那筆，不能讓「已服用」留著而掩蓋真正的漏服；佇列也清空。
    expect(server.rows).toEqual([])
    expect(server.insertAttempts).toHaveLength(1)
    expect(server.deleteFilters.at(-1)).toMatchObject({ account_email: CAREGIVER, taken_at: MORNING, care_date: '2026-10-06', dose_number: 1 })
    expect(result.results).toEqual([{ kind: 'withdrawn', dose: { ...queued, withdrawn: true } }])
    expect(result.remaining).toEqual([])
  })

  test('withdrawing a dose that never reached the server finishes without touching anyone else\'s record', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    withdrawPendingMedicationDose(readPendingMedicationDoses('patient-a', CAREGIVER)[0])
    server.offline = false
    // 這段期間家人在另一台手機記錄了同一劑；撤回只對得上自己那次打卡，不能刪到家人那筆。
    await tapDose(plan(), 1, MORNING_LATER, 'family@example.com')

    const result = await flush()
    expect(server.rows.map(row => row.account_email)).toEqual(['family@example.com'])
    expect(result.remaining).toEqual([])
  })

  test('an offline withdrawal stays queued until it can be delivered', async () => {
    server.loseNextResponse = true
    await tapDose(plan(), 1, MORNING)
    withdrawPendingMedicationDose(readPendingMedicationDoses('patient-a', CAREGIVER)[0])

    server.offline = true
    const offline = await flush()
    expect(offline.blocked).toBe(true)
    expect(offline.remaining.map(dose => dose.withdrawn)).toEqual([true])
    expect(server.rows).toHaveLength(1)
  })

  test('checking the dose in again after withdrawing replaces the withdrawal instead of being ignored', async () => {
    server.offline = true
    await tapDose(plan(), 1, MORNING)
    withdrawPendingMedicationDose(readPendingMedicationDoses('patient-a', CAREGIVER)[0])
    await tapDose(plan(), 1, MORNING_LATER)

    const queued = readPendingMedicationDoses('patient-a', CAREGIVER)
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ taken_at: MORNING_LATER })
    expect(queued[0].withdrawn).toBeUndefined()
  })

  test('reconciliation leaves withdrawals alone and the day list hides only the caregiver\'s own withdrawn row', () => {
    const withdrawn = { ...buildPendingMedicationDose(plan(), 1, CAREGIVER, MORNING), withdrawn: true }
    const ownRow = { ...pendingMedicationDoseToLog(withdrawn), id: 'row-own' }
    const familyRow = { ...pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 2, 'family@example.com', MORNING)), id: 'row-family' }

    // 伺服器上那筆正是撤回要刪的東西，不能被當成「已解決」而把撤回丟掉。
    expect(reconcilePendingMedicationDoses([withdrawn], [ownRow]).remaining).toEqual([withdrawn])
    expect(mergeMedicationDayLogs([ownRow, familyRow], [], [withdrawn]).map(log => log.id)).toEqual(['row-family'])
    // 撤回送達後從清單移掉自己那筆；別人那筆（就算是同一劑）不動。
    const sameDoseByFamily = { ...ownRow, id: 'row-family-same-dose', account_email: 'family@example.com', taken_at: MORNING_LATER }
    expect(applyMedicationSyncToDayLogs([ownRow, sameDoseByFamily], [], [withdrawn]).map(log => log.id)).toEqual(['row-family-same-dose'])
  })

  test('exposes queued doses as taken logs with a recognisable pending id', () => {
    const log = pendingMedicationDoseToLog(buildPendingMedicationDose(plan(), 2, ' Care@Example.com ', MORNING))
    expect(log).toMatchObject({ plan_id: 'plan-morning-norvasc', dose_number: 2, care_date: '2026-10-06', taken_at: MORNING, account_email: CAREGIVER })
    expect(isPendingMedicationLog(log)).toBe(true)
    expect(isPendingMedicationLog({ id: 'row-1' })).toBe(false)
  })
})
