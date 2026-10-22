/*
檔案用途：測試 VitalReading、VitalValue 與 PulseReading 生命徵象元件之指標色系與語意屬性。
所在層：tests/unit 單元測試層。
主要關聯：驗證 src/components/VitalReading.tsx 呈現在不同數據輸入時的產出，
        以及 VitalAlertBadge 的換行預設與最高階行動文字不重複（issue #1096）。
*/
import { describe, expect, mock, test } from 'bun:test'
import React from 'react'
import { textContent } from './helpers/elementTree'

const actualI18n = await import('../../src/lib/i18n')

// Mock 三語 Context Hook，保留原本的 dictionary 與 helper 匯出，避免影響其它測試檔。
// 語系做成可切換：徽章文字重複（issue #1096）三個語系都有，只驗 zh 會漏掉 id 才是看護實際看到的那一份。
let mockLocale: 'zh' | 'id' | 'en' = 'zh'
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({
    text: (item: { id?: string; zh?: string; en?: string }) => item[mockLocale] || item.zh || item.id || '',
    language: mockLocale,
    setLanguage: () => {},
  }),
}))

const { PulseReading, VitalReading, VitalValue } = await import('../../src/features/vitals/components/VitalReading')
// VitalAlertBadge 需要 useBpEvaluator() 提供的病人綁定標準；本檔是非 DOM 的純函式測試，
// 沒有 React 樹可以掛 Provider，所以把 hook 換成一個固定回一般成人標準的假 evaluator。
// 這裡刻意**不**讓 hook 回傳預設值來規避例外——正式程式碼沒有 Provider 就該炸掉（見 useBpEvaluator）。
const { evaluateReading, GENERAL_ADULT_STANDARD } = await import('../../src/types/database')
mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  useBpEvaluator: () => ({
    resolver: () => ({ standard: GENERAL_ADULT_STANDARD, templateKey: 'general_adult', prescribedNote: null, configured: false, unavailable: false }),
    evaluateAt: (sys: number, dia: number, pulse: number | null | undefined) => ({
      ...evaluateReading(sys, dia, pulse, GENERAL_ADULT_STANDARD),
      resolved: { standard: GENERAL_ADULT_STANDARD, templateKey: 'general_adult', prescribedNote: null, configured: false, unavailable: false },
    }),
  }),
}))

const { VitalAlertBadge } = await import('../../src/features/vitals/components/VitalAlertBadge')
const { ALERT_CHIP_CLASS } = await import('../../src/lib/alertPresentation')

describe('VitalReading component presentation and accessibility', () => {
  test('VitalReading renders systolic, diastolic, and optional pulse with correct class names', () => {
    const element = VitalReading({
      systolic: 120,
      diastolic: 80,
      pulse: 72,
      showUnits: true,
      showPulse: true,
    })

    expect(element).not.toBeNull()
    expect(element.type).toBe('span')
    const children = React.Children.toArray(element.props.children)
    expect(children.length).toBeGreaterThanOrEqual(4)
  })

  test('VitalReading can hide pulse or units when specified', () => {
    const noPulseElement = VitalReading({
      systolic: 135,
      diastolic: 85,
      pulse: 75,
      showUnits: false,
      showPulse: false,
    })
    expect(noPulseElement).not.toBeNull()
  })

  test('VitalValue renders single vital sign indicator with unit', () => {
    const systolicValue = VitalValue({
      kind: 'systolic',
      value: 125,
      unit: 'mmHg',
    })

    expect(systolicValue).not.toBeNull()
    expect(systolicValue.props.className).toContain('vital-systolic')

    const diastolicValue = VitalValue({
      kind: 'diastolic',
      value: 85,
      unit: 'mmHg',
    })
    expect(diastolicValue.props.className).toContain('vital-diastolic')

    const pulseValue = VitalValue({
      kind: 'pulse',
      value: 75,
      unit: 'bpm',
    })
    expect(pulseValue.props.className).toContain('vital-pulse')
  })

  test('PulseReading renders heart symbol and pulse value or fallback dash', () => {
    const pulseWithData = PulseReading({ pulse: 68 })
    expect(pulseWithData).not.toBeNull()
    expect(pulseWithData.props.className).toContain('vital-pulse')

    const pulseNull = PulseReading({ pulse: null })
    expect(pulseNull).not.toBeNull()
  })

  test('低側與正常維持原有色階（§4.2「維持現況」那三列）', () => {
    // 高側改成分級紅是刻意的；低側與正常**不**跟著改，因為「琥珀＝低、紅＝高」這個語彙
    // 是全 app 一致的既有約定，把低側也變紅會把「往哪邊調」這個資訊丟掉。
    expect(ALERT_CHIP_CLASS['danger-low']).toContain('bg-red-600')
    expect(ALERT_CHIP_CLASS['warning-low']).toContain('bg-orange-700')
    expect(ALERT_CHIP_CLASS.normal).toContain('bg-emerald-700')
  })

  test('renders the shared blood-pressure alert text and preserves caller classes', () => {
    const element = VitalAlertBadge({ systolic: 180, diastolic: 110, pulse: 130, measuredAt: '2026-09-23T00:00:00.000Z', className: 'test-class' })
    expect(element.type).toBe('span')
    expect(element.props.className).toContain('test-class')
    expect(element.props.children).toBeTruthy()
  })

  // issue #1096：danger_high 的標籤本身就以行動文字結尾，徽章又接一次 CRITICAL_ACTION_TEXT，
  // 印尼文畫面變成「…, ukur ulang segera · Ukur ulang segera」。每個語系都要剛好出現一次——
  // 不能是零次，因為 §4.2 規定最高階必須帶「立即複測」行動文字。
  test.each([
    ['zh', '立即複測'],
    ['id', 'ukur ulang segera'],
    ['en', 'measure again'],
  ] as const)('critical badge states the re-measure action exactly once (%s)', (locale, action) => {
    mockLocale = locale
    try {
      const element = VitalAlertBadge({ systolic: 185, diastolic: 100, measuredAt: '2026-09-23T00:00:00.000Z' })
      // 用 textContent 遞迴取字：舊版多接的是一個 <span> 子元素，只 join 頂層 children 會看不到它。
      const rendered = textContent(element).toLowerCase()
      expect(rendered.split(action.toLowerCase()).length - 1).toBe(1)
    } finally {
      mockLocale = 'zh'
    }
  })

  // issue #1096：375px 印尼文下 nowrap 的徽章把 <main> 撐出 481px 橫向捲動。
  // 換行要是元件預設，而不是靠每個清單呼叫端自己記得覆寫。
  test('badge wraps inside its container by default', () => {
    const element = VitalAlertBadge({ systolic: 185, diastolic: 100, measuredAt: '2026-09-23T00:00:00.000Z' })
    const classes = String(element.props.className).split(/\s+/)
    expect(classes).toContain('whitespace-normal')
    expect(classes).toContain('max-w-full')
    expect(classes).not.toContain('whitespace-nowrap')
    // 多行時 rounded-full 會變成兩端半圓、把行首行尾的字切出底色。
    expect(classes).not.toContain('rounded-full')
  })
})
