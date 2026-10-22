/*
檔案用途：守住作品集只輸出必要共用權益政策檔，不因修復建置而公開整個 Supabase 目錄。
所在層：tests/unit；直接檢查 PORTFOLIO-01 allowlist 設定。
主要關聯：scripts/portfolio/allowlist.ts、docs/operations/portfolio-pipeline.md 第 3.1 節。
*/
import { describe, expect, test } from 'bun:test'

import { ALLOWLIST_DIRS, ALLOWLIST_FILES } from '../../scripts/portfolio/allowlist'

describe('portfolio Supabase allowlist boundary', () => {
  test('includes only the browser-shared entitlement policy as a Supabase file', () => {
    // 前端與 Edge Function 共用同一路徑；放寬成目錄會把 migration 與私有設定一併帶進公開快照。
    expect(ALLOWLIST_DIRS).not.toContain('supabase')
    expect(ALLOWLIST_FILES.filter((path) => path.startsWith('supabase/'))).toEqual([
      'supabase/functions/_shared/paidFeatureEntitlementPolicy.ts',
    ])
  })
})
