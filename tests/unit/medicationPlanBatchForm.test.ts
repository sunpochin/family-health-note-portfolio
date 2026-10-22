/*
檔案用途：驗證批次調藥提示不會誤報、以及缺翻譯藥名仍有醒目的識別。
所在層：tests/unit；用真正的 React 元件輸出驗證照護者看到的內容。
主要關聯：MedicationPlanBatchForm、useSaveStatus、MedicationSnapshotNameHeading。
*/
import { expect, mock, test } from 'bun:test'
import { createElement, createRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MedicationOption } from '../../src/lib/medication/medicationAdmin'
import type { useMedicationPlanBatchForm } from '../../src/features/medication/hooks/useMedicationPlanBatchForm'

mock.module('../../src/lib/i18n', () => ({ useI18n: () => ({ locale: 'zh', text: (copy: { zh: string }) => copy.zh }) }))
const { MedicationPlanBatchForm } = await import('../../src/features/medication/components/MedicationPlanBatchForm')
const batch: ReturnType<typeof useMedicationPlanBatchForm> = {
  group: { patientId: 'patient-a', medicationId: 'med-a', plans: [] }, groups: [], selectedIds: [],
  dose: '', setDose: () => {}, reason: '', setReason: () => {}, open: () => {}, close: () => {},
  toggle: () => {}, submit: async () => {}, panelRef: createRef<HTMLDivElement>(),
  dialog: null, status: 'ok', message: 'Fixture result',
}
const medication = { id: 'med-a', brand_name: 'FixtureMed', brand_name_zh: null, strength_mg: 10, dosage_form: 'tablet' } as MedicationOption
function render(status: typeof batch.status, disabled = false, englishFirst = true) {
  return renderToStaticMarkup(createElement(MedicationPlanBatchForm, {
    batch: { ...batch, status }, disabled, nameEnglishFirst: englishFirst, patientName: 'Fixture patient',
    medicationById: new Map([['med-a', medication]]),
  }))
}

test('only current save results are visible; idle and later writes cannot reuse an old success', () => {
  expect(render('ok')).toContain('role="status"')
  for (const status of ['idle', 'saving'] as const) {
    expect(render(status)).not.toContain('Fixture result')
    expect(render(status, true)).not.toContain('Fixture result')
  }
  // 送出反饋獨立於表單 disabled/載入狀態（Rule C）：即使重新讀取失敗或處於唯讀狀態，仍須維持可見，避免照護者在無提示下誤重送
  expect(render('ok', true)).toContain('Fixture result')
  expect(render('err', true)).toContain('Fixture result')
})

test('failures have alert semantics and distinct error styling', () => {
  const html = render('err')
  expect(html).toContain('role="alert"')
  expect(html).toContain('bg-red-50')
  expect(html).not.toContain('role="status"')
})

test('missing localized catalog name still leaves a prominent medication identifier', () => {
  // 以本地化優先測試，才會抓到空白 primary 被英文次要名稱掩蓋的情況。
  expect(render('idle', false, false)).toMatch(/text-red-700[^>]*>FixtureMed<\/span>/)
})
