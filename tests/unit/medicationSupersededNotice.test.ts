/*
檔案用途：確認一般跨裝置時間衝突與受控撤回恢復同時存在時，三語畫面都說明兩種結果。
所在層：tests/unit；以元件元素樹驗證照護者看到的訊息及關閉操作，不連線、不讀真實資料。
主要關聯：MedicationSupersededNotice、useMedicationQueueCoordinator、issue #1228。
*/
import { expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, fire, textContent } from './helpers/elementTree'

installReactHookHarness()
type Locale = 'zh' | 'id' | 'en'
let locale: Locale = 'zh'
const i18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({ ...i18n, useI18n: () => ({ locale, text: (item: Record<Locale, string>) => item[locale] }) }))
const { MedicationSupersededNotice } = await import('../../src/features/medication/components/MedicationSupersededNotice')

test.each([
  ['zh', '2 劑離線打卡', '1 筆服藥紀錄', '「更正」', '關閉'],
  ['id', '2 dosis', '1 catatan dosis', 'koreksi', 'Tutup'],
  ['en', '2 doses', '1 intake record', 'correction flow', 'Close'],
] as const)('mixed %s notices keep both outcomes and the controlled correction instruction', (language, ordinary, controlled, correction, close) => {
  locale = language
  let dismissed = false
  const rendered = renderHook(() => MedicationSupersededNotice({ count: 3, controlledCorrectionCount: 1, onDismiss: () => { dismissed = true } }))
  const paragraphs = findAll(rendered.current, element => element.type === 'p')
  expect(paragraphs).toHaveLength(2)
  expect(textContent(paragraphs[0])).toContain(ordinary)
  expect(textContent(paragraphs[1])).toContain(controlled)
  expect(textContent(paragraphs[1])).toContain(correction)
  const button = findAll(rendered.current, element => element.type === 'button')[0]
  expect(textContent(button)).toBe(close)
  fire(button, 'onClick')
  expect(dismissed).toBe(true)
  rendered.unmount()
})

test('a controlled-only result is not described as a family time conflict', () => {
  locale = 'zh'
  const rendered = renderHook(() => MedicationSupersededNotice({ count: 1, controlledCorrectionCount: 1, onDismiss: () => {} }))
  expect(findAll(rendered.current, element => element.type === 'p')).toHaveLength(1)
  expect(textContent(rendered.current)).not.toContain('家人先記錄')
  expect(textContent(rendered.current)).toContain('舊的離線撤回沒有取消')
  rendered.unmount()
})
