/*
檔案用途：鎖住服務條款第 5 節的家庭級單位、第 6 節付費方案與第 7 節退款政策（issue #1183，L1）：三語齊備、不寫價格與供應商、
  每一條的關鍵事實與 P1 的狀態機一致、法務未確認的事只用「以購買頁面公告為準」佔位。
所在層：tests/unit；以最小 hook 執行環境 render TermsPage 並逐語言斷言，另直接檢查文案資料。
主要關聯：src/features/system-admin/paidPlanTermsCopy.ts、pages/TermsPage.tsx、docs/product/monetization-plan.md §5.2／§5.3／§6.1～§6.3、
  tests/unit/freemiumDisclosureCopy.test.ts（第 5 節既有的 #1047 斷言）。
*/
import { describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import type { LocalizedText } from '../../src/lib/i18n'

if (typeof (globalThis as any).__APP_VERSION__ === 'undefined') {
  ;(globalThis as any).__APP_VERSION__ = '1.1.1'
  ;(globalThis as any).__APP_RELEASE_DATE__ = '2026-08-13'
  ;(globalThis as any).__APP_GIT_SHA__ = 'test-sha'
  ;(globalThis as any).__APP_ENVIRONMENT__ = 'test'
  ;(globalThis as any).__APP_BUILD_TIME__ = '2026-08-13T00:00:00.000Z'
}

const { TermsPage } = await import('../../src/features/system-admin/pages/TermsPage')
const copy = await import('../../src/features/system-admin/paidPlanTermsCopy')

installReactHookHarness()

const LOCALES = ['zh', 'id', 'en'] as const
type Locale = (typeof LOCALES)[number]

// 與 freemiumDisclosureCopy.test.ts 同一條規則（#1047、monetization-plan §7），再加上 P1 的佔位金額 150 與常見幣別寫法。
const PRICE_OR_PROVIDER = /NT\$|US\$|Rp\s?\d|藍新|NewebPay|ezPay|\b150\b|\d+\s?(元|TWD)/i

function section(root: unknown, id: string) {
  const found = findAll(root, node => node.type === 'section' && node.props.id === id)
  expect(found).toHaveLength(1)
  return found[0]
}

function allTexts(): LocalizedText[] {
  return [
    copy.PAID_PLAN_SECTION_TITLE, copy.PAID_PLAN_INTRO, copy.REFUND_SECTION_TITLE,
    ...copy.PAID_PLAN_CLAUSES.flatMap(clause => [clause.label, clause.body]),
    ...copy.REFUND_CLAUSES.flatMap(clause => [clause.label, clause.body]),
  ]
}

describe('paid plan and refund copy data', () => {
  test('every string exists in all three locales and none names a price or the payment provider', () => {
    for (const value of allTexts()) {
      for (const locale of LOCALES) {
        expect(value[locale].trim().length).toBeGreaterThan(0)
        expect(value[locale]).not.toMatch(PRICE_OR_PROVIDER)
      }
    }
  })

  test('section 6 covers every item monetization-plan §6.1 asks for, in this order', () => {
    expect(copy.PAID_PLAN_CLAUSES.map(clause => clause.key)).toEqual([
      'contents', 'price-and-billing', 'auto-renewal', 'cancellation', 'grace-period', 'after-plan-ends', 'price-changes',
    ])
    expect(copy.REFUND_CLAUSES.map(clause => clause.key)).toEqual(['withdrawal-right', 'requesting-refunds', 'after-refund'])
  })

  test('plan contents list the four Premium items without hard-coding quota numbers (owner 1.7.6)', () => {
    const contents = copy.PAID_PLAN_CLAUSES.find(clause => clause.key === 'contents')!.body
    for (const marker of ['(1)', '(2)', '(3)', '(4)']) for (const locale of LOCALES) expect(contents[locale]).toContain(marker)
    // 數字由 premium_plan_offer() 決定、購買頁顯示；條款寫死 20／5／180 會在常數一改就變成不實條款。
    for (const locale of LOCALES) expect(contents[locale]).not.toMatch(/\b(20|5|180)\b(?!\))/)
    expect(contents.zh).toContain('以購買頁面顯示為準')
  })
})

describe.each(LOCALES)('Terms page renders sections 6 and 7 (%s)', (locale: Locale) => {
  test('every clause label and body is on the page, and the contact section is renumbered to 8', () => {
    const hook = renderHook(() => TermsPage(), { defaultContext: { locale, setLocale: () => {} } })
    const paid = textContent(section(hook.current, 'paid-plan'))
    const refund = textContent(section(hook.current, 'refund'))
    expect(paid).toContain(`6. ${copy.PAID_PLAN_SECTION_TITLE[locale]}`)
    expect(paid).toContain(copy.PAID_PLAN_INTRO[locale])
    for (const clause of copy.PAID_PLAN_CLAUSES) {
      expect(paid).toContain(clause.label[locale])
      expect(paid).toContain(clause.body[locale])
    }
    expect(refund).toContain(`7. ${copy.REFUND_SECTION_TITLE[locale]}`)
    for (const clause of copy.REFUND_CLAUSES) {
      expect(refund).toContain(clause.label[locale])
      expect(refund).toContain(clause.body[locale])
    }
    const page = textContent(hook.current)
    expect(page).toContain({ zh: '8. 聯絡方式', id: '8. Hubungi Kami', en: '8. Contact' }[locale])
    expect(page).not.toMatch(PRICE_OR_PROVIDER)
    hook.unmount()
  })

  test('section 5 says the AI scan allowance is counted per household (H2, monetization-plan §2.5)', () => {
    const hook = renderHook(() => TermsPage(), { defaultContext: { locale, setLocale: () => {} } })
    const fees = textContent(section(hook.current, 'fees'))
    expect(fees).toContain({
      zh: 'AI 藥單辨識的每日次數以「每個家庭」合計：同一個家庭的所有照護對象共用同一份每日次數。',
      id: 'Jatah harian pemindaian resep AI dihitung per keluarga: semua penerima perawatan dalam keluarga yang sama berbagi satu jatah harian.',
      en: 'The daily allowance for AI prescription scanning is counted per household: all care recipients in the same household share one daily allowance.',
    }[locale])
    // 只有 llm_draft 改成家庭級；記錄筆數按記錄者、基礎辨識按照護對象——不得寫成「所有上限都以家庭計算」。
    expect(fees).not.toMatch(/所有.*上限.*每個家庭|all (daily )?limits .*per household/i)
    hook.unmount()
  })

  test('section 4 no longer promises that account deletion clears every record', () => {
    // 帳務列刪帳號後依法保存（payer_user_id ON DELETE SET NULL、household_id 不掛外鍵）；不加例外就是不實承諾。
    const hook = renderHook(() => TermsPage(), { defaultContext: { locale, setLocale: () => {} } })
    expect(textContent(hook.current)).toContain({
      zh: '依法須保存的付款紀錄除外',
      id: 'kecuali catatan pembayaran yang wajib disimpan menurut hukum',
      en: 'except payment records that must be kept by law',
    }[locale])
    hook.unmount()
  })
})

describe('clauses match the P1 state machine and the owner decisions', () => {
  const body = (key: string) => [...copy.PAID_PLAN_CLAUSES, ...copy.REFUND_CLAUSES].find(clause => clause.key === key)!.body

  test('monthly, TWD, auto-renewing, reminder 7 days before each charge (5.6.1, §3.4 a)', () => {
    expect(body('price-and-billing').zh).toContain('以新台幣計價、按月收費')
    expect(body('price-and-billing').zh).toContain('以您購買當時購買頁面顯示的價格為準')
    expect(body('price-and-billing').zh).toContain('不會取得您的完整卡號')
    // 不能承諾「每次」：寬限期、取消處理中不寄，網路錯誤也刻意不重送（bp-reviewer）。
    expect(body('auto-renewal').zh).toContain('通常會在續約扣款日前 7 天內')
    expect(body('auto-renewal').zh).toContain('寬限期或取消處理中不寄')
    expect(body('auto-renewal').en).toContain('We usually send the payer one reminder email within the 7 days')
    for (const locale of LOCALES) expect(body('auto-renewal')[locale]).not.toMatch(/每次續約扣款前|before each renewal charge|sebelum setiap penagihan/)
  })

  test('cancellation: paid period runs to its end; only the payer can withdraw, and only before termination is sent (5.6.5)', () => {
    const cancellation = body('cancellation')
    expect(cancellation.zh).toContain('已付款的這一期照常使用到期末')
    expect(cancellation.zh).toContain('取消處理中')
    expect(cancellation.zh).toContain('在終止送出之前，付款人可以撤回取消')
    expect(cancellation.en).toContain('Until the termination is sent, the payer can withdraw the cancellation')
    // 終止確認前仍可能扣款（period_charge_after_cancel）：不能寫成「取消後不再扣款」的絕對承諾。
    expect(cancellation.zh).toContain('確認終止後就不再扣款')
    expect(cancellation.zh).toContain('若在確認終止前仍被扣款，該期照常提供服務，您也可以依第 7 節申請退款')
    for (const locale of LOCALES) expect(cancellation[locale]).not.toMatch(/取消後不再扣款|After cancelling, no further charges|Setelah dibatalkan, tidak ada tagihan/)
    // 付款人刪帳號＝訂閱轉 cancel_requested（payer_deleted），只有付款人能撤回，所以無法撤回。
    expect(cancellation.zh).toContain('付款人刪除自己的帳號時，家庭的方案會一併取消，且無法撤回')
    expect(cancellation.en).toContain('If the payer deletes their own account, the household’s plan is cancelled too')
    // 原生殼不放管理入口（ADR-012 §4、P4）：條款指向網站版，不能寫成「App 的設定頁」。
    expect(cancellation.zh).toContain('網站版的設定頁')
    expect(cancellation.en).toContain('Settings page of the website')
  })

  test('grace period is 7 days and Premium keeps working during it (5.6.2)', () => {
    expect(body('grace-period').zh).toContain('7 天寬限期，期間照常使用')
    expect(body('grace-period').id).toContain('masa tenggang 7 hari')
    expect(body('grace-period').en).toContain('7-day grace period during which it keeps working')
    // 更新付款方式走建單 RPC，只接受家庭 owner。
    expect(body('grace-period').zh).toContain('家庭擁有者可在寬限期內更新付款方式')
    expect(body('grace-period').zh).not.toContain('付款人可在寬限期內')
  })

  test('after the plan ends nothing in the safety boundary changes (ADR-011, §5.3)', () => {
    const after = body('after-plan-ends')
    for (const phrase of ['健康紀錄', '危險等級的血壓警報都不受影響', '全部保留、可以繼續記錄', '不會被解除', '不會因方案結束而提早刪除', '當天已使用的次數照算']) {
      expect(after.zh).toContain(phrase)
    }
    expect(after.en).toContain('danger-level blood pressure alerts are unaffected')
    // 到期／退款對 entitlement 做 compare-and-set：家庭由招待或另一張訂閱持有 Premium 時不降級（Codex 第 2 輪）。
    expect(after.zh.startsWith('若家庭沒有其他仍有效的 Premium')).toBe(true)
    expect(after.en.startsWith('If the household has no other Premium still in effect')).toBe(true)
    expect(after.id.startsWith('Jika keluarga tidak memiliki Premium lain yang masih berlaku')).toBe(true)
    expect(body('after-refund').zh).toContain('若家庭沒有其他仍有效的 Premium，就回到免費方案')
    expect(after.id).toContain('peringatan tekanan darah tingkat bahaya tidak terpengaruh')
  })

  test('the seven-day exception needs a separate prior checkbox, and the unconfirmed renewal question is a placeholder (6.5.2)', () => {
    const withdrawal = body('withdrawal-right')
    expect(withdrawal.zh).toContain('獨立的勾選框')
    expect(withdrawal.zh).toContain('消費者保護法第 19 條')
    expect(withdrawal.zh).toContain('沒有勾選就無法購買')
    // 法務尚未確認例外是否及於後續各期：只能佔位，不得自行寫成「續約各期也不適用」。
    expect(withdrawal.zh).toContain('是否也適用於自動續約的後續各期，以購買頁面公告為準')
    expect(withdrawal.en).toContain('Whether this consent also covers later automatic renewal periods is as announced on the purchase page')
    expect(withdrawal.id).toContain('mengikuti pengumuman di halaman pembelian')
  })

  test('price changes: purchase-time price by default, re-consent is the single stated exception (Codex on #1211)', () => {
    expect(body('price-and-billing').zh).toContain('唯一例外是您依下方「價格變更」重新同意的新價格')
    const change = body('price-changes')
    expect(change.zh).toContain('進行中的訂閱預設維持購買時的價格')
    expect(change.zh).toContain('唯一的例外')
    expect(change.zh).toContain('付款人不同意時，訂閱維持原價直到取消或結束')
    expect(change.en).toContain('The only exception')
    expect(change.id).toContain('Satu-satunya pengecualian')
  })

  test('refunds end the plan immediately with no grace period, after stopping future charges (§3.6)', () => {
    expect(body('after-refund').zh).toContain('先停止之後的自動扣款')
    expect(body('after-refund').zh).toContain('立即結束、不另給寬限期')
    expect(body('requesting-refunds').zh).toContain('申請期限以購買頁面公告為準')
    expect(body('requesting-refunds').zh).toContain('取消後仍被扣款的那一期，在處理完成前仍照常提供服務')
  })
})
