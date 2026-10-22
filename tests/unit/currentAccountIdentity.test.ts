/*
檔案用途：驗證設定頁只標出目前登入帳號與該帳號的「我自己」照護對象，避免多帳號時認錯病人。
所在層：tests/unit；以假身分做伺服器端渲染，不連線或更動資料庫。
主要關聯：CurrentAccountIdentity、PatientIdentity.isOwnPatient、#1314。
*/
import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CurrentAccountIdentity } from '../../src/components/settings/CurrentAccountIdentity'
import { LocaleProvider, type Locale } from '../../src/lib/i18n'
import type { PatientIdentity } from '../../src/lib/auth'

const patient = (patientId: string, displayName: string, isOwnPatient: boolean): PatientIdentity => ({
  patientId, displayName, isOwnPatient, canManageMedication: true, careRecipientType: 'human', archivedAt: null,
})

function render(locale: Locale, email: string | undefined, patients: PatientIdentity[], isDemoMode = false) {
  // 語系是帳號偏好；測試每種語系都從自己的初始值起算，確認畫面只顯示一種語言。
  Object.assign(globalThis, { localStorage: { getItem: () => locale, setItem: () => {} } })
  return renderToStaticMarkup(createElement(LocaleProvider, {
    children: createElement(CurrentAccountIdentity, { userEmail: email, patients, isDemoMode }),
  }))
}

test('the signed-in account is paired only with its own patient across two accounts', () => {
  const first = render('zh', 'owner@example.test', [patient('a', '測試病人甲', true), patient('b', '測試病人乙', false)])
  const second = render('zh', 'other@example.test', [patient('a', '測試病人甲', false), patient('b', '測試病人乙', true)])
  expect(first).toContain('目前登入帳號')
  expect(first).toContain('owner@example.test')
  expect(first).toContain('此帳號的「我自己」照護對象')
  expect(first).toContain('測試病人甲')
  expect(first).not.toContain('測試病人乙')
  expect(second).toContain('other@example.test')
  expect(second).toContain('測試病人乙')
  expect(second).not.toContain('測試病人甲')
})

test('all three locales identify the account; demo and missing email reveal no identity', () => {
  const own = [patient('a', 'Example patient', true)]
  expect(render('id', 'owner@example.test', own)).toContain('Akun yang sedang masuk')
  expect(render('en', 'owner@example.test', own)).toContain('Signed-in account')
  expect(render('zh', 'owner@example.test', own, true)).toBe('')
  expect(render('zh', undefined, own)).toBe('')
})
