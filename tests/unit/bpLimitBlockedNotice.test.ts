/*
檔案用途：驗證血壓被每日上限擋下時的提示（issue #1060）——一定顯示這筆讀數的等級 badge，
         只有紅色三階（danger／danger-low／critical）才加「直接打電話給家屬」的大字提示。
所在層：tests/unit；以函式呼叫元件取得 React 元素樹，不啟動瀏覽器。
主要關聯：src/features/vitals/components/BpLimitBlockedNotice.tsx、VitalAlertBadge、InputPage.utils 的 L 文案，
         形狀比照 tests/unit/vitalReading.test.ts（同樣以假 evaluator 取代 Provider）。
*/
import { describe, expect, mock, test } from 'bun:test'
import { findAll, textContent } from './helpers/elementTree'

const actualI18n = await import('../../src/lib/i18n')
let locale: 'zh' | 'id' | 'en' = 'zh'
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({
    text: (item: { id: string; zh: string; en: string }) => item[locale],
    locale,
    setLocale: () => {},
  }),
}))

// 判讀用真的 evaluateReading＋一般成人標準：測的是「元件有沒有拿同一套門檻決定要不要叫看護打電話」，
// 不是另寫一份門檻。沒有 Provider 時正式程式碼會丟例外，所以這裡注入假 evaluator 而不是讓 hook 回預設值。
const { evaluateReading, GENERAL_ADULT_STANDARD } = await import('../../src/types/database')
const evaluatedAt: Array<string | Date> = []
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  useBpEvaluator: () => ({
    evaluateAt: (sys: number, dia: number, pulse: number | null | undefined, measuredAt: string | Date) => {
      evaluatedAt.push(measuredAt)
      return evaluateReading(sys, dia, pulse, GENERAL_ADULT_STANDARD)
    },
  }),
}))

const { BpLimitBlockedNotice } = await import('../../src/features/vitals/components/BpLimitBlockedNotice')
const { VitalAlertBadge } = await import('../../src/features/vitals/components/VitalAlertBadge')
const { VitalReading } = await import('../../src/features/vitals/components/VitalReading')
const { L } = await import('../../src/features/vitals/pages/InputPage.utils')

const MEASURED_AT = '2026-10-05T13:30:00.000Z'
const LIMIT_MESSAGE = 'limit-message-sentinel'
const render = (systolic: number, diastolic: number, pulse = 80) =>
  BpLimitBlockedNotice({ reading: { patientId: 'patient-1', systolic, diastolic, pulse, measuredAt: MEASURED_AT }, limitMessage: LIMIT_MESSAGE })
const callFamily = (tree: unknown) => findAll(tree, element => element.props['data-call-family'] === true)

describe('BpLimitBlockedNotice (issue #1060)', () => {
  test('always shows the shared VitalAlertBadge for the blocked reading, evaluated at the submit time', () => {
    locale = 'zh'
    evaluatedAt.length = 0
    const tree = render(120, 75, 70)
    const badges = findAll(tree, element => element.type === VitalAlertBadge)
    expect(badges).toHaveLength(1)
    expect(badges[0].props).toMatchObject({ systolic: 120, diastolic: 75, pulse: 70, measuredAt: MEASURED_AT })
    expect(evaluatedAt).toEqual([MEASURED_AT])
    expect(textContent(tree)).toContain(L.limitBlockedLabel.zh)
    // 數值走共用 VitalReading（配色與逐值讀屏標籤），不是一串自組文字。
    const readings = findAll(tree, element => element.type === VitalReading)
    expect(readings).toHaveLength(1)
    expect(readings[0].props).toMatchObject({ systolic: 120, diastolic: 75, pulse: 70 })
  })

  test('a normal reading gets the badge but no call-the-family alert', () => {
    locale = 'zh'
    const tree = render(120, 75, 70)
    expect(textContent(tree)).not.toContain(L.limitBlockedDanger.zh)
    expect(callFamily(tree)).toHaveLength(0)
    expect(textContent(tree)).toContain(LIMIT_MESSAGE)
  })

  test('warning and pulse-only warning do not ask the caregiver to call', () => {
    locale = 'zh'
    expect(textContent(render(150, 95, 70))).not.toContain(L.limitBlockedDanger.zh)
    expect(textContent(render(120, 75, 130))).not.toContain(L.limitBlockedDanger.zh)
  })

  test.each([
    ['critical', 185, 105],
    ['danger', 165, 95],
    ['danger-low', 82, 50],
  ])('%s reading shows the large call-the-family alert in every locale', (_tone, systolic, diastolic) => {
    for (const next of ['id', 'zh', 'en'] as const) {
      locale = next
      const tree = render(systolic, diastolic)
      expect(callFamily(tree)).toHaveLength(1)
      expect(textContent(callFamily(tree)[0])).toContain(L.limitBlockedDanger[next])
      expect(textContent(tree)).toContain(L.limitBlockedLabel[next])
      // 讀屏器依 DOM 順序唸：危險提示一定在上限說明之前。
      const rendered = textContent(tree)
      expect(rendered.indexOf(L.limitBlockedDanger[next])).toBeLessThan(rendered.indexOf(LIMIT_MESSAGE))
    }
  })

  test('keeps no live region of its own; BpSaveNotices owns the single assertive region (issue #1093)', () => {
    // 外層 BpSaveNotices 會把本元件包進唯一的 assertive region；這裡再掛一層 alert 會變成巢狀 live region，
    // 部分讀屏器只唸最後掛上的那一個。危險提示仍要排在上限說明之前，讓整塊依序唸出。
    locale = 'zh'
    const tree = render(185, 105)
    expect(findAll(tree, element => element.props.role === 'alert' || element.props['aria-live'] !== undefined)).toHaveLength(0)
    const rendered = textContent(tree)
    expect(rendered.indexOf(L.limitBlockedDanger.zh)).toBeLessThan(rendered.indexOf(LIMIT_MESSAGE))
  })

  test('copy is provided in all three locales and never empty', () => {
    for (const entry of [L.limitBlockedLabel, L.limitBlockedDanger]) {
      for (const key of ['id', 'zh', 'en'] as const) expect(entry[key].trim().length).toBeGreaterThan(0)
    }
  })
})
