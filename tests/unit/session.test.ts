/*
檔案用途：驗證 getSession 把一天 24 小時對應到五個量測時段的邊界（每個 bucket 的起訖小時）。
所在層：tests/unit；純函式測試，不掛 React、不 mock Supabase。
主要關聯：src/lib/session.ts；時段定義也被輸入頁與每日照護摘要共用，改邊界要同步看這裡的斷言。
*/
import { describe, test, expect } from 'bun:test'
import { getSession } from '../../src/lib/session'

// 時段切法：pagi 5–11、siang 12–16、malam1 17–18、malam2 19–20、malam3 21–4（跨過午夜）。
// 為什麼晚上要拆成三個 bucket：長輩若有夜間低血壓的傾向，照護者可能在 18:00／20:00／22:00
// 分別量測；原本單一的 17:00–04:59「malam」會讓後面的量測點誤沿用第一個量測點的「休息／完成」
// 流程。這些只是分組用的 bucket，不代表每晚一定要量三次。（通用照護情境，不描述任何特定使用者。）
describe('getSession', () => {
  test('early morning hours fall into malam3 (last night-check bucket, not yet pagi)', () => {
    expect(getSession(0)).toBe('malam3')
    expect(getSession(4)).toBe('malam3')
  })

  test('5 through 11 is pagi', () => {
    expect(getSession(5)).toBe('pagi')
    expect(getSession(11)).toBe('pagi')
  })

  test('12 through 16 is siang', () => {
    expect(getSession(12)).toBe('siang')
    expect(getSession(16)).toBe('siang')
  })

  test('17 through 18 is malam1 (~18:00 checkpoint)', () => {
    expect(getSession(17)).toBe('malam1')
    expect(getSession(18)).toBe('malam1')
  })

  test('19 through 20 is malam2 (~20:00 checkpoint)', () => {
    expect(getSession(19)).toBe('malam2')
    expect(getSession(20)).toBe('malam2')
  })

  test('21 through 23 is malam3 (~22:00 checkpoint)', () => {
    expect(getSession(21)).toBe('malam3')
    expect(getSession(23)).toBe('malam3')
  })
})
