/*
檔案用途：驗證 AdminPage（issue #1180，H6）：管理者看得到三語的「家庭 Premium」分頁、curator-only 看不到；
  使用者管理分頁的三個舊制每帳號付費勾選框都標「舊制，H7 移除」；AI 草稿與個人化通知在各自 reader live 後
  阻擋新的帳號級開通，但既有勾選仍可取消（dual-read 期間舊旗標仍有效；#1195），只有帳號級 premium_tier 一律唯讀，
  共用藥品目錄管理員勾選框維持可寫。
所在層：tests/unit；以 reactHookHarness 執行元件函式，admin-list-users 的 adapter 以 mock 取代。
主要關聯：src/features/system-admin/pages/AdminPage.tsx、src/lib/adminUsers.ts。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'

installReactHookHarness()

const realAdminUsers = await import('../../src/lib/adminUsers')
const toggled: string[] = []
let fetchedEntitlements = {
  personalNotificationTier: 'personal',
  medicationAiDraftTier: 'none',
  premiumTier: 'premium',
  medicationCatalogCuratorTier: 'none',
}
mock.module('../../src/lib/adminUsers', () => ({
  ...realAdminUsers,
  fetchAdminUsers: async () => ({
    users: [{
      userId: 'u1',
      email: 'caregiver@example.com',
      displayName: null,
      createdAt: null,
      lastSignInAt: null,
      ...fetchedEntitlements,
    }],
    totalCount: 1,
  }),
  setAccountEntitlement: async (params: { entitlement: string }) => { toggled.push(params.entitlement) },
}))

const { AdminPage } = await import('../../src/features/system-admin/pages/AdminPage')
const { HOUSEHOLD_PREMIUM_READER_LIVE } = await import('../../src/lib/adminHouseholds')

const contexts = {
  zh: { locale: 'zh' as const, setLocale: () => {} },
  id: { locale: 'id' as const, setLocale: () => {} },
  en: { locale: 'en' as const, setLocale: () => {} },
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function tabTexts(tree: unknown): string[] {
  return findAll(tree, element => element.type === 'button' && element.props.role === 'tab').map(tab => textContent(tab))
}

describe('AdminPage household Premium tab', () => {
  test('the administrator sees the tab in all three languages, between users and notification subscriptions', () => {
    const expected = { zh: '家庭 Premium', id: 'Premium keluarga', en: 'Household Premium' }
    for (const locale of ['zh', 'id', 'en'] as const) {
      const view = renderHook(() => AdminPage({ isAdministrator: true, isCatalogCurator: true }), { defaultContext: contexts[locale] })
      const tabs = tabTexts(view.current)
      expect(tabs).toHaveLength(7)
      expect(tabs[3]).toBe(expected[locale])
      // 新工程 tab 追加在尾端，不改既有家庭／照護分頁順序。
      expect(tabs[6]).toBe({ zh: '工程派工', id: 'Tugas pengembangan', en: 'Development tasks' }[locale])
      view.unmount()
    }
  })

  test('a curator-only account does not see it', () => {
    const view = renderHook(() => AdminPage({ isAdministrator: false, isCatalogCurator: true }), { defaultContext: contexts.zh })
    expect(tabTexts(view.current)).toEqual(['藥品目錄'])
    view.unmount()
  })

  // 窮舉兩個 reader-live 旗標：只有未勾選的舊旗標在讀取點上線後才 disabled，已勾選的仍能取消。
  async function renderUsersPanel(
    live: { medication_ai_draft: boolean; personal_notification_extras: boolean },
    entitlements: Partial<typeof fetchedEntitlements> = {},
  ) {
    const mutableLive = HOUSEHOLD_PREMIUM_READER_LIVE as Record<string, boolean>
    const original = { ...HOUSEHOLD_PREMIUM_READER_LIVE }
    const originalEntitlements = fetchedEntitlements
    Object.assign(mutableLive, live)
    fetchedEntitlements = { ...fetchedEntitlements, ...entitlements }
    try {
      const view = renderHook(() => AdminPage({ isAdministrator: true, isCatalogCurator: false }), { defaultContext: contexts.zh })
      const usersTab = findAll(view.current, element => element.type === 'button' && element.props.id === 'users-tab')[0]
      view.act(() => (usersTab.props.onClick as () => void)())
      await tick()
      view.rerender()
      const usersPanel = findAll(view.current, element => element.props.id === 'users-panel')[0]
      return { view, usersPanel, checkboxes: findAll(usersPanel, element => element.type === 'input' && element.props.type === 'checkbox') }
    } finally {
      Object.assign(mutableLive, original)
      fetchedEntitlements = originalEntitlements
    }
  }

  test.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('legacy AI and notification grants close only after their household readers go live (ai=%p, notification=%p)', async (aiLive, notificationLive) => {
    const { view, checkboxes } = await renderUsersPanel(
      { medication_ai_draft: aiLive, personal_notification_extras: notificationLive },
      { personalNotificationTier: 'none', medicationAiDraftTier: 'none' },
    )
    expect(checkboxes).toHaveLength(4)
    // 順序：通知、AI、帳號級 Premium、目錄管理員；功能旗標只有 reader live 且尚未勾選時封住新開通。
    expect(checkboxes.map(box => box.props.disabled)).toEqual([notificationLive, aiLive, true, false])
    view.unmount()
  })

  test('live readers block new legacy grants but checked legacy flags remain revocable', async () => {
    toggled.length = 0
    const { view: grantView, checkboxes: uncheckedBoxes } = await renderUsersPanel(
      { medication_ai_draft: true, personal_notification_extras: true },
      { personalNotificationTier: 'none', medicationAiDraftTier: 'none' },
    )
    expect(uncheckedBoxes.map(box => box.props.disabled)).toEqual([true, true, true, false])
    // 即使測試直接呼叫 disabled input 的 handler，新的帳號級開通也不能繞過家庭開關。
    for (const box of uncheckedBoxes.slice(0, 2)) (box.props.onChange as (event: unknown) => void)({ target: { checked: true } })
    await tick()
    expect(toggled).toEqual([])
    grantView.unmount()

    const { view: revokeView, usersPanel, checkboxes } = await renderUsersPanel(
      { medication_ai_draft: true, personal_notification_extras: true },
      { personalNotificationTier: 'personal', medicationAiDraftTier: 'ai' },
    )
    expect(checkboxes).toHaveLength(4)
    expect(checkboxes.map(box => box.props.disabled)).toEqual([false, false, true, false])
    expect(checkboxes.map(box => box.props.checked)).toEqual([true, true, true, false])
    expect(textContent(usersPanel).split('（舊制，H7 移除）').length - 1).toBe(3)
    expect(textContent(usersPanel)).toContain('家庭權益請到「家庭 Premium」分頁管理')

    // checked 值仍可在 reader live 後取消，避免 dual-read 保留已撤權的舊帳號旗標。
    for (const box of checkboxes.slice(0, 2)) (box.props.onChange as (event: unknown) => void)({ target: { checked: false } })
    await tick()
    expect(toggled.sort()).toEqual(['personal_notification_tier', 'medication_ai_draft_tier'].sort())
    revokeView.unmount()
  })
})
