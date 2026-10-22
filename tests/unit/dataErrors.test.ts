/*
檔案用途：驗證 unknown 錯誤解析與雙語使用者訊息的挑選規則。
所在層：tests/unit；保護「畫面不得洩漏資料庫原文、且兩種語言都必須存在」這條規範。
主要關聯：src/lib/dataErrors.ts，以及依賴它的 useBpRecords、temperature 與 InputPage.utils。
*/
import { describe, expect, test } from 'bun:test'
import { createClient } from '@supabase/supabase-js'
import {
  DATA_ERROR_TEXT,
  describeReadError,
  describeSaveError,
  isConnectionError,
  isPermissionError,
  isRetryableWriteError,
  matchesConstraint,
  readErrorFields,
} from '../../src/lib/dataErrors'

describe('readErrorFields', () => {
  test('reads Supabase PostgrestError shape', () => {
    expect(readErrorFields({ message: 'permission denied', code: '42501' })).toEqual({
      message: 'permission denied',
      code: '42501',
      status: 0,
    })
  })

  test('reads AuthError shape with an HTTP status', () => {
    expect(readErrorFields({ message: 'unauthorized', status: 401 }).status).toBe(401)
  })

  test('survives non-object throwables without crashing the screen', () => {
    expect(readErrorFields(null)).toEqual({ message: '', code: '', status: 0 })
    expect(readErrorFields('boom')).toEqual({ message: '', code: '', status: 0 })
    expect(readErrorFields(undefined).message).toBe('')
  })

  test('normalizes a string HTTP status so comparisons still match', () => {
    expect(readErrorFields({ status: '403' }).status).toBe(403)
    expect(readErrorFields({ status: 'nope' }).status).toBe(0)
  })

  test('reads native Error instances thrown by fetch', () => {
    expect(readErrorFields(new TypeError('Failed to fetch')).message).toBe('Failed to fetch')
  })
})

describe('error classification', () => {
  test('treats RLS denial and 401/403 as a re-login situation', () => {
    expect(isPermissionError({ code: '42501' })).toBe(true)
    expect(isPermissionError({ status: 401 })).toBe(true)
    expect(isPermissionError({ status: 403 })).toBe(true)
    expect(isPermissionError({ code: 'PGRST301' })).toBe(false)
  })

  test('treats transport and configuration failures separately from permissions', () => {
    expect(isConnectionError({ code: 'PGRST301' })).toBe(true)
    expect(isConnectionError({ code: 'ENOTFOUND' })).toBe(true)
    expect(isConnectionError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isConnectionError({ code: '42501' })).toBe(false)
  })

  test('queues only transport and temporary server failures, never permission errors', () => {
    expect(isRetryableWriteError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isRetryableWriteError({ status: 503 })).toBe(true)
    expect(isRetryableWriteError({ status: 429 })).toBe(true)
    expect(isRetryableWriteError({ code: '42501' })).toBe(false)
    expect(isRetryableWriteError({ message: 'daily_blood_pressure_limit' })).toBe(false)
  })

  test('queues the fetch failure shape that supabase-js actually returns (issue #1116)', () => {
    // postgrest-js 會把 fetch 的 TypeError 吞掉、改回傳這個形狀；只測原生 TypeError 會漏掉真正離線的情況。
    for (const message of ['TypeError: Failed to fetch', 'TypeError: Load failed', 'TypeError: NetworkError when attempting to fetch resource.', 'AbortError: The operation was aborted.', 'FetchError: undefined']) {
      expect(isRetryableWriteError({ message, details: '', hint: '', code: '' })).toBe(true)
      // insertBloodPressureRecord 會把頂層 status（斷線時是 0）掛回錯誤物件，結果必須一樣。
      expect(isRetryableWriteError({ message, code: '', status: 0 })).toBe(true)
    }
  })

  test('does not mistake a database or HTTP error for a dropped connection', () => {
    // 帶錯誤碼或 HTTP 狀態的就是伺服器真的回應了；重送不會改變結果，不能排進佇列。
    expect(isRetryableWriteError({ message: 'TypeError: Failed to fetch', code: '23505' })).toBe(false)
    expect(isRetryableWriteError({ message: 'TypeError: Failed to fetch', code: '', status: 400 })).toBe(false)
    expect(isRetryableWriteError({ message: 'duplicate key value violates unique constraint', code: '' })).toBe(false)
  })

  test('keeps a plain dropped connection on the caller wording instead of "tell the family"', () => {
    // 判斷是否重送與畫面文案刻意分開：看護只是沒訊號時，不該被叫去通知家屬。
    const fallback = { id: 'Gagal menyimpan obat.', zh: '服藥紀錄儲存失敗。', en: 'Failed to save the dose.' }
    expect(describeSaveError({ message: 'TypeError: Failed to fetch', code: '' }, fallback)).toBe(fallback)
  })

  test('matches database constraint names carried in the message', () => {
    expect(matchesConstraint({ message: 'violates daily_temperature_limit' }, 'daily_temperature_limit')).toBe(true)
    expect(matchesConstraint({ message: 'something else' }, 'daily_temperature_limit')).toBe(false)
    expect(matchesConstraint(null, 'daily_temperature_limit')).toBe(false)
  })
})

describe('real supabase-js client errors (issue #1116)', () => {
  // 用真的 supabase-js 產生錯誤，只把 fetch 換成會失敗的假函式（不連網）。
  // 之後升級 supabase-js 若又改了斷線錯誤的形狀，這裡會先壞，而不是讓離線佇列默默失效。
  const clientWith = (fetchImpl: typeof fetch) => createClient('https://example.supabase.co', 'public-anon-key-for-tests', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fetchImpl },
  })

  test('a rejected fetch on INSERT comes back as a retryable error', async () => {
    const client = clientWith(async () => { throw new TypeError('Failed to fetch') })
    const { error, status } = await client.from('blood_pressure_records').insert({ id: 'client-uuid' })
    expect(error).not.toBeNull()
    expect(isRetryableWriteError(error)).toBe(true)
    expect(isRetryableWriteError(Object.assign({ ...error }, { status }))).toBe(true)
  })

  test('an RLS rejection from the server stays a permanent failure', async () => {
    const client = clientWith(async () => new Response(
      JSON.stringify({ code: '42501', message: 'new row violates row-level security policy', details: null, hint: null }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ))
    const { error, status } = await client.from('blood_pressure_records').insert({ id: 'client-uuid' })
    expect(isRetryableWriteError(error)).toBe(false)
    expect(isRetryableWriteError(Object.assign({ ...error }, { status }))).toBe(false)
  })
})

describe('user-facing messages', () => {
  test('permission failures win over the caller fallback', () => {
    expect(describeSaveError({ code: '42501' }, { id: 'x', zh: 'x' ,en: "x" })).toBe(DATA_ERROR_TEXT.reauth)
    expect(describeReadError({ status: 403 }, { id: 'x', zh: 'x' ,en: "x" })).toBe(DATA_ERROR_TEXT.reauth)
  })

  test('connection failures point at the family, not at a retry', () => {
    expect(describeSaveError({ code: 'ENOTFOUND' })).toBe(DATA_ERROR_TEXT.connection)
  })

  test('unknown failures fall back to the caller-specific wording', () => {
    const fallback = { id: 'Gagal membaca suhu.', zh: '無法讀取體溫。' ,en: "Failed read temperature." }
    expect(describeReadError({ code: 'unknown' }, fallback)).toBe(fallback)
  })

  test('never returns a single string, so callers cannot bypass the bilingual rule', () => {
    // 繁體中文註解：這條測試是憲法規範的護欄。回傳型別若退化成 string，
    // 呼叫端就能像過去的 useBpRecords 一樣把中印文用斜線串起來一次顯示兩種語言。
    for (const value of Object.values(DATA_ERROR_TEXT)) {
      expect(typeof value.id).toBe('string')
      expect(typeof value.zh).toBe('string')
      expect(value.id.length).toBeGreaterThan(0)
      expect(value.zh.length).toBeGreaterThan(0)
      expect(value.id).not.toContain('／')
      expect(value.zh).not.toMatch(/[A-Za-z]{4,}/)
    }
  })
})
