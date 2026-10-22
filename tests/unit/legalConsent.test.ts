/*
檔案用途：測試版本化同意的讀取／寫入，特別是政策讀取重試與明確確認才寫入的行為。
所在層：tests/unit 單元測試層。
主要關聯：驗證 src/lib/legalConsent.ts；App.tsx 用這個模組決定要不要顯示健康資料同意畫面。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type QueryResponse = { data?: unknown; error?: unknown }
let rpcResponsesByFn: Record<string, QueryResponse | (() => QueryResponse)> = {}
let legalConsentsSelectResponse: QueryResponse | (() => QueryResponse) = { data: null, error: null }
let legalConsentsSelectCallCount = 0
let legalConsentsSelectedColumns: string | undefined
let rpcCallCount: Record<string, number> = {}
let rpcCallArgs: Record<string, unknown[]> = {}

const mockSupabase = {
  from(table: string) {
    if (table === 'legal_consents') {
      return {
        select(columns?: string) {
          legalConsentsSelectedColumns = columns
          return {
            maybeSingle() {
              legalConsentsSelectCallCount += 1
              const response = typeof legalConsentsSelectResponse === 'function' ? legalConsentsSelectResponse() : legalConsentsSelectResponse
              return Promise.resolve(response)
            },
          }
        },
      }
    }
    throw new Error(`unexpected table: ${table}`)
  },
  rpc(fnName: string, args?: unknown) {
    rpcCallArgs[fnName] = [...(rpcCallArgs[fnName] ?? []), args]
    rpcCallCount[fnName] = (rpcCallCount[fnName] ?? 0) + 1
    const configured = rpcResponsesByFn[fnName]
    const response = typeof configured === 'function' ? configured() : (configured ?? { data: null, error: null })
    return Promise.resolve(response)
  },
}

mock.module('../../src/lib/supabase', () => ({ supabase: mockSupabase }))

const { CURRENT_HEALTH_CONSENT_VERSION, CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION, loadLegalConsentWithRetry, readLegalConsent, recordAccountLegalAcceptance, recordHealthDataConsent } = await import('../../src/lib/legalConsent')

describe('legalConsent read/write and retry-on-transient-failure', () => {
  beforeEach(() => {
    rpcResponsesByFn = {}
    legalConsentsSelectResponse = { data: null, error: null }
    legalConsentsSelectCallCount = 0
    rpcCallCount = {}
    rpcCallArgs = {}
  })

  test('readLegalConsent returns the row when present and throws on query error', async () => {
    legalConsentsSelectResponse = { data: { privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self', terms_version: '2026-08-26' }, error: null }
    expect(await readLegalConsent()).toEqual({ privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self', terms_version: '2026-08-26' })
    // #1124：隱私更新畫面靠 terms_version 決定要不要顯示條款變動摘要；沒讀這個欄位，每個人都會被當成「條款過期」。
    expect(legalConsentsSelectedColumns?.split(',').map(column => column.trim())).toContain('terms_version')

    legalConsentsSelectResponse = { data: null, error: new Error('network blip') }
    await expect(readLegalConsent()).rejects.toThrow('network blip')
  })

  test('recordAccountLegalAcceptance and recordHealthDataConsent throw when the RPC reports an error', async () => {
    rpcResponsesByFn = { record_account_legal_acceptance: { data: null, error: new Error('rpc down') } }
    await expect(recordAccountLegalAcceptance()).rejects.toThrow('rpc down')

    rpcResponsesByFn = { record_health_data_consent: { data: null, error: new Error('rpc down') } }
    await expect(recordHealthDataConsent('self')).rejects.toThrow('rpc down')
  })

  test('both writers send the version this client displays, never leaving it to the server (issue #925, #1124)', async () => {
    await recordAccountLegalAcceptance()
    // 條款版本也要送（#1124）：漏送時伺服器記成凍結的舊基準，同意紀錄又分不出使用者看的是哪一版條款。
    expect(rpcCallArgs.record_account_legal_acceptance).toEqual([{
      p_displayed_version: CURRENT_PRIVACY_POLICY_VERSION,
      p_displayed_terms_version: CURRENT_TERMS_VERSION,
    }])

    await recordHealthDataConsent('authorized_representative', '  daughter  ')
    expect(rpcCallArgs.record_health_data_consent).toEqual([{
      p_consent_type: 'authorized_representative',
      p_authorization_basis: 'daughter',
      p_displayed_version: CURRENT_HEALTH_CONSENT_VERSION,
    }])
  })

  test('loadLegalConsentWithRetry returns the already-consented row on the first try without retrying', async () => {
    legalConsentsSelectResponse = { data: { privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self' }, error: null }
    const consent = await loadLegalConsentWithRetry(0)
    expect(consent).toEqual({ privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self' })
    expect(legalConsentsSelectCallCount).toBe(1)
    expect(rpcCallCount.record_account_legal_acceptance).toBeUndefined()
  })

  test('a genuinely new account (no row, no error) resolves to null on the first try without retrying', async () => {
    legalConsentsSelectResponse = { data: null, error: null }
    const consent = await loadLegalConsentWithRetry(0)
    expect(consent).toBeNull()
    expect(legalConsentsSelectCallCount).toBe(1)
    expect(rpcCallCount.record_account_legal_acceptance).toBeUndefined()
  })

  test('a transient error on the first attempt is retried once and recovers the already-consented row', async () => {
    // 模擬新加的 PWA 桌面捷徑第一次呼叫時 session 還沒穩定：第一次讀取直接拋錯，
    // 第二次（重試）才成功回傳資料庫裡本來就有的同意紀錄；重試不能順手寫入同意。
    let callNumber = 0
    legalConsentsSelectResponse = () => {
      callNumber += 1
      return callNumber === 1
        ? { data: null, error: new Error('auth session not ready yet') }
        : { data: { privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self' }, error: null }
    }

    const consent = await loadLegalConsentWithRetry(0)
    expect(consent).toEqual({ privacy_policy_version: '2026-09-06', health_consent_version: '2026-07-30', consent_type: 'self' })
    expect(legalConsentsSelectCallCount).toBe(2)
    expect(rpcCallCount.record_account_legal_acceptance).toBeUndefined()
  })

  test('a persistent error on both attempts still throws, so the caller can fail closed to "required"', async () => {
    let callNumber = 0
    legalConsentsSelectResponse = () => {
      callNumber += 1
      return { data: null, error: new Error('still down') }
    }
    await expect(loadLegalConsentWithRetry(0)).rejects.toThrow('still down')
    expect(legalConsentsSelectCallCount).toBe(2)
    expect(rpcCallCount.record_account_legal_acceptance).toBeUndefined()
  })
})
