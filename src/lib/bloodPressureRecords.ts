/*
檔案用途：集中處理血壓紀錄的冪等 INSERT，讓線上寫入與離線佇列重試共用同一條資料邊界。
所在層：src/lib；是血壓頁面與 pending queue 之間的 Supabase 薄轉接層。
主要關聯：InputPage、bloodPressurePendingQueue 與 blood_pressure_records 的 RLS／每日配額 trigger；
  逾時歸類由 lib/dataErrors 的 isFetchTransportFailure 認得「AbortError: …」。
*/
import { supabase } from './supabase'
import { matchesConstraint } from './dataErrors'

/**
 * 一次血壓寫入最多等多久（issue #1117）。瀏覽器自己的 fetch 逾時在 iOS Safari 約一分鐘、別處更久，
 * 正是這個 App 針對的弱訊號情境：看護被告知「儲存中」卻等不到結果，多半會去點別的分頁（北極星 15 秒原則）。
 * 逾時後 postgrest-js 回的是 code 空字串、status 0 的「AbortError: …」，isRetryableWriteError() 認得它，
 * 所以這筆會進離線佇列、由殼層補送器重送；id 是 client UUID，伺服器其實已收到時重送也只會回「已存在」，不會多一筆。
 */
export const BLOOD_PRESSURE_SAVE_TIMEOUT_MS = 15_000

export interface BloodPressureInsertPayload {
  id: string
  systolic: number
  diastolic: number
  pulse: number | null
  measured_at: string
  source: string
  patient_id: string
  recorded_by: string | null
}

/**
 * 只挑出 blood_pressure_records 真的有的欄位（issue #1126）。
 * 離線佇列補送時傳進來的是 PendingBloodPressureRecord，多了 queued_at／notified 這些只存在本機的欄位；
 * TypeScript 的結構型別不會擋多出來的屬性，但 PostgREST 會用 JSON 的 key 當 INSERT 欄位，
 * 遇到資料表沒有的欄位就回 400 PGRST204，被當成永久失敗，這筆就永遠卡在佇列、家屬也收不到通知。
 * 在 adapter 邊界逐欄列出，任何呼叫端多帶的欄位都不會送到資料庫。
 */
function toInsertRow(payload: BloodPressureInsertPayload): BloodPressureInsertPayload {
  return {
    id: payload.id,
    systolic: payload.systolic,
    diastolic: payload.diastolic,
    pulse: payload.pulse,
    measured_at: payload.measured_at,
    source: payload.source,
    patient_id: payload.patient_id,
    recorded_by: payload.recorded_by,
  }
}

/**
 * 使用 client UUID 寫入血壓，讓「伺服器已收到但瀏覽器沒拿到回應」的情況可以安全重試。
 * 如果不固定 id，離線佇列重送會產生第二筆健康紀錄，這比單純顯示一次錯誤更危險。
 */
/**
 * 逾時錯誤的形狀與 postgrest-js 中止時回的一樣（name AbortError、message 以「AbortError: 」開頭、code 空字串、status 0），
 * isFetchTransportFailure()／isRetryableWriteError() 不必另外認一種。
 */
function saveTimeoutError(timeoutMs: number): Error & { code: string; status: number } {
  return Object.assign(new Error(`AbortError: blood pressure save timed out after ${timeoutMs} ms`), { name: 'AbortError', code: '', status: 0 })
}

export async function insertBloodPressureRecord(payload: BloodPressureInsertPayload, { timeoutMs = BLOOD_PRESSURE_SAVE_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<'inserted' | 'already-existed'> {
  // 同一個 signal 管 INSERT 與 23505 後的回讀：整個呼叫合計不超過 timeoutMs，不是各自重新計時。
  // 不能只靠 abort：supabase-js 送資料請求前會先 await 取得／更新 access token，那一段不收這個 signal，
  // 登入 session 到期、token refresh 在弱網路卡住時，abort 了也沒有人會回來（Codex App 獨立審查 P1）。
  // 所以整個呼叫再跟一個明確的期限競速：到期就 abort 並立刻以可重試的錯誤結束，這筆進佇列、同一個 UUID 之後重送；
  // 遲到的那個 promise 自己吞掉結果，不變成 unhandled rejection。
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(saveTimeoutError(timeoutMs))
    }, timeoutMs)
  })
  const attempt = insertWithSignal(payload, controller.signal)
  attempt.catch(() => {})
  try {
    return await Promise.race([attempt, deadline])
  } finally {
    clearTimeout(timer)
  }
}

async function insertWithSignal(payload: BloodPressureInsertPayload, signal: AbortSignal): Promise<'inserted' | 'already-existed'> {
  const { error, status } = await supabase.from('blood_pressure_records').insert(toInsertRow(payload)).abortSignal(signal)
  if (!error) return 'inserted'
  // PostgrestError 本身沒有 HTTP status；408/429/5xx 只出現在頂層回應，要一併附上才能讓
  // isRetryableWriteError() 正確辨識該重試的暫時性失敗，否則會被誤判成一般儲存失敗。
  // 斷線時 status 是 0：postgrest-js 不丟例外，而是回 code 空字串的錯誤（issue #1116），
  // 這個 0 也是 isRetryableWriteError() 判斷「根本沒拿到伺服器回應」的依據之一。
  // 23505 只在同一筆 id 已存在時視為成功；先回讀確認，避免把其他唯一約束錯誤吞掉。
  // 每日上限（P0001 daily_blood_pressure_limit）也要回讀（PR #1219 審查）：上限 trigger 是 BEFORE INSERT、只數同一天的筆數、
  // 不排除 NEW.id，所以「第 9 筆在 15 秒逾時後其實已寫入、補送再來一次」會先撞到上限、輪不到主鍵去重；不回讀的話這筆會被
  // 判成「再試也不會成功」永遠卡在佇列、家屬通知也永遠不送，而資料庫裡其實已經有它。
  const mayAlreadyExist = error.code === '23505' || matchesConstraint(error, 'daily_blood_pressure_limit')
  if (!mayAlreadyExist) throw Object.assign(error, { status })

  const { data, error: readError, status: readStatus } = await supabase
    .from('blood_pressure_records')
    .select('id')
    .eq('id', payload.id)
    .abortSignal(signal)
    .maybeSingle()
  // 回讀的錯誤也要帶頂層 HTTP status（Codex App 獨立審查 P1）：回讀暫時回 502／429 時少了 status，
  // isRetryableWriteError() 會把它當永久失敗，補送器把這筆標成「再試也不會成功」而停止退避；
  // 這筆其實可能已在伺服器，之後的家屬通知就得等外部事件。
  if (readError) throw Object.assign(readError, { status: readStatus })
  if (data?.id === payload.id) return 'already-existed'
  throw Object.assign(error, { status })
}

/**
 * 這位病人在資料庫裡，除了這一輪佇列裡的這幾筆之外還有沒有別的血壓（成長漏斗 first_record_saved 的補送路徑用，PR #1218 Codex P2）。
 * 舊版 build 排進佇列的紀錄沒有 first_record 欄位；補送時沒有輸入頁可判斷「歷史是否為空」，就在寫入成功後問一次資料庫。
 * 排除的是整批佇列（不只自己）：兩筆舊紀錄都已在伺服器、只是回應遺失時，各自只排除自己會互相看到對方、誰都不算第一筆（第三輪 Codex P2）。
 * 在寫入之後問：查詢不擋補送（不必等它回來才送下一筆），查不到（斷線、權限）也只是放棄埋點。只回一筆 id，不讀數值。
 */
export async function hasOtherBloodPressureRecord(patientId: string, excludeRecordIds: readonly string[]): Promise<boolean> {
  const { data, error } = await supabase
    .from('blood_pressure_records')
    .select('id')
    .eq('patient_id', patientId)
    // PostgREST 的 in 語法：`(a,b,c)`；client UUID 不含逗號與括號，不必引號。
    .not('id', 'in', `(${excludeRecordIds.join(',')})`)
    .limit(1)
  if (error) throw error
  return Array.isArray(data) && data.length > 0
}
