/*
檔案用途：驗證 AdminPage 後台在管理員模式下包含「通知訂閱」分頁，而在非管理員（僅目錄管理員）模式下隱藏該分頁。
所在層：tests/unit；使用 reactHookHarness 執行無 DOM 元件測試。
主要關聯：src/features/system-admin/pages/AdminPage.tsx。
*/
import { describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import { AdminPage } from '../../src/features/system-admin/pages/AdminPage'

installReactHookHarness()

const ZH_CONTEXT = { locale: 'zh' as const, setLocale: () => {} }
const ID_CONTEXT = { locale: 'id' as const, setLocale: () => {} }
const EN_CONTEXT = { locale: 'en' as const, setLocale: () => {} }

describe('AdminPage notification subscriptions tab integration', () => {
  test('當 isAdministrator 為 true 時，tablist 包含「通知訂閱」分頁按鈕', () => {
    const view = renderHook(
      () => AdminPage({ isAdministrator: true, isCatalogCurator: false }),
      { defaultContext: ZH_CONTEXT },
    )
    const tabs = findAll(view.current, el => el.type === 'button' && el.props['role'] === 'tab')
    const tabTexts = tabs.map(t => textContent(t))
    expect(tabTexts).toContain('通知訂閱')
    expect(tabTexts).toContain('使用者管理')
    expect(tabTexts).toContain('血壓總表')
  })

  test('通知訂閱分頁按鈕支援三語顯示 (zh / id / en)', () => {
    // 繁體中文
    const zhView = renderHook(
      () => AdminPage({ isAdministrator: true, isCatalogCurator: false }),
      { defaultContext: ZH_CONTEXT },
    )
    expect(textContent(zhView.current)).toContain('通知訂閱')

    // 印尼文
    const idView = renderHook(
      () => AdminPage({ isAdministrator: true, isCatalogCurator: false }),
      { defaultContext: ID_CONTEXT },
    )
    expect(textContent(idView.current)).toContain('Langganan notifikasi')

    // 英文
    const enView = renderHook(
      () => AdminPage({ isAdministrator: true, isCatalogCurator: false }),
      { defaultContext: EN_CONTEXT },
    )
    expect(textContent(enView.current)).toContain('Notification subscriptions')
  })

  test('當 isAdministrator 為 false 時，tablist 不包含「通知訂閱」分頁', () => {
    const view = renderHook(
      () => AdminPage({ isAdministrator: false, isCatalogCurator: true }),
      { defaultContext: ZH_CONTEXT },
    )
    const tabs = findAll(view.current, el => el.type === 'button' && el.props['role'] === 'tab')
    const tabTexts = tabs.map(t => textContent(t))
    expect(tabTexts).not.toContain('通知訂閱')
    expect(tabTexts).not.toContain('Langganan notifikasi')
    expect(tabTexts).not.toContain('Notification subscriptions')
    // 僅有藥品目錄
    expect(tabTexts).toEqual(['藥品目錄'])
  })
})
