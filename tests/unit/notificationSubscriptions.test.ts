/*
檔案用途：驗證管理者後台「通知訂閱」UI 元件（NotificationSubscriptionsPanel）的渲染與互動——
  (1) 開關狀態（role="switch"、aria-checked、已開通／已停用狀態呈現）；
  (2) 點擊開關呼叫 mutator；
  (3) 非管理者提示與按鈕禁用；
  (4) 錯誤文案呈現（包含 RPC 拒絕之三語訊息）；
  (5) 隱私保護：畫面不顯示任何 chat id、webhook 或 external id；
  (6) AdminPage 整合：分頁順序與守門條件。
所在層：tests/unit；以 hook harness 執行元件渲染，不啟動真實瀏覽器。
主要關聯：src/features/system-admin/components/NotificationSubscriptionsPanel.tsx、
  src/features/system-admin/hooks/useNotificationSubscriptions.ts、
  src/features/system-admin/pages/AdminPage.tsx。
*/
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import { NotificationSubscriptionsPanel } from '../../src/features/system-admin/components/NotificationSubscriptionsPanel'
import { subscriptionKey } from '../../src/lib/notificationSubscriptions'

installReactHookHarness()

const adminPageSource = readFileSync(new URL('../../src/features/system-admin/pages/AdminPage.tsx', import.meta.url), 'utf8')

function renderPanel(
  locale: 'zh' | 'id' | 'en' = 'zh',
  props: Partial<Parameters<typeof NotificationSubscriptionsPanel>[0]> = {},
) {
  const view = renderHook(
    () => NotificationSubscriptionsPanel({ isAdministrator: true, ...props }),
    { defaultContext: { locale, setLocale: () => {} } },
  )
  const tree = view.current
  view.unmount()
  return tree
}

describe('NotificationSubscriptionsPanel rendering', () => {
  test('renders loading state when fetching data', () => {
    const tree = renderPanel('zh', {
      hookOptions: {
        autoFetch: true, // autoFetch 且未給予 initialPatients 時預設進入 loading
      },
    })
    expect(textContent(tree)).toContain('載入中…')
  })

  test('renders empty state when there are no manageable patients', () => {
    for (const [locale, expected] of [
      ['zh', '目前沒有任何可管理的照護對象。'],
      ['id', 'Belum ada penerima perawatan yang dapat dikelola.'],
      ['en', 'No manageable care recipients found.'],
    ] as const) {
      const tree = renderPanel(locale, {
        hookOptions: {
          initialPatients: [],
          initialSubscriptions: {},
        },
      })
      const text = textContent(tree)
      expect(text).toContain(expected)
    }
  })

  test('renders patient cards with only the Telegram switch (LINE/push have no shared consumer) and accurate switch states', async () => {
    const mockPatients = [
      { id: 'p-1', displayName: '媽媽' },
      { id: 'p-2', displayName: '爸爸' },
    ]
    const mockSubscriptions = {
      [subscriptionKey('p-1', 'telegram')]: true,
    }

    const tree = renderPanel('zh', {
      hookOptions: {
        initialPatients: mockPatients,
        initialSubscriptions: mockSubscriptions,
      },
    })

    const text = textContent(tree)
    expect(text).toContain('媽媽')
    expect(text).toContain('爸爸')
    expect(text).toContain('Telegram')
    expect(text).not.toContain('LINE')
    expect(text).not.toContain('推播通知')

    const switches = findAll(tree, el => el.type === 'button' && el.props.role === 'switch')
    // 2 位病人 × 1 個管道（telegram）= 2 個開關
    expect(switches).toHaveLength(2)

    const momTelegramSwitch = switches.find(s => s.props['aria-label'] === '媽媽 Telegram')
    expect(momTelegramSwitch).toBeDefined()
    expect(momTelegramSwitch?.props['aria-checked']).toBe(true)

    const dadTelegramSwitch = switches.find(s => s.props['aria-label'] === '爸爸 Telegram')
    expect(dadTelegramSwitch?.props['aria-checked']).toBe(false)

    // 點擊區必須在 button 本身達 44px（外層 wrapper 不會放大 hit box）
    expect(String(momTelegramSwitch?.props.className)).toContain('min-h-[44px]')
  })

  test('tapping a switch triggers mutator with patientId, channel, and nextEnabled', async () => {
    let calledParams: unknown = null
    const mockPatients = [{ id: 'patient-42', displayName: '長輩' }]
    const mockSubscriptions = {
      [subscriptionKey('patient-42', 'telegram')]: false,
    }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({
        isAdministrator: true,
        hookOptions: {
          initialPatients: mockPatients,
          initialSubscriptions: mockSubscriptions,
          mutator: async (params) => {
            calledParams = params
            return { ok: true }
          },
        },
      }),
      { defaultContext: { locale: 'zh', setLocale: () => {} } },
    )

    const tree = view.current
    const switches = findAll(tree, el => el.type === 'button' && el.props.role === 'switch')
    const lineSwitch = switches.find(s => s.props['aria-label'] === '長輩 Telegram')
    expect(lineSwitch).toBeDefined()

    // 觸發點擊，從 false 改為 true
    await (lineSwitch?.props.onClick as () => Promise<void>)()

    expect(calledParams).toEqual({
      patientId: 'patient-42',
      channel: 'telegram',
      enabled: true,
    })

    view.unmount()
  })

  test('non-administrator sees warning banner and switches are disabled', () => {
    const mockPatients = [{ id: 'p-1', displayName: '長輩' }]
    const tree = renderPanel('zh', {
      isAdministrator: false,
      hookOptions: {
        initialPatients: mockPatients,
        initialSubscriptions: {},
      },
    })

    const text = textContent(tree)
    expect(text).toContain('只有系統管理員可以變更通知訂閱設定。')

    const switches = findAll(tree, el => el.type === 'button' && el.props.role === 'switch')
    expect(switches.length).toBeGreaterThan(0)
    for (const sw of switches) {
      expect(sw.props.disabled).toBe(true)
    }
  })

  test('displays trilingual RPC error text when mutator rejects', async () => {
    const mockPatients = [{ id: 'p-1', displayName: '媽媽' }]
    const mockSubscriptions = { [subscriptionKey('p-1', 'telegram')]: false }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({
        isAdministrator: true,
        hookOptions: {
          initialPatients: mockPatients,
          initialSubscriptions: mockSubscriptions,
          mutator: async () => ({
            ok: false,
            error: {
              id: 'Hanya administrator sistem yang dapat mengubah langganan notifikasi.',
              zh: '只有系統管理員可以變更通知訂閱。',
              en: 'Only a system administrator can change notification subscriptions.',
            },
            rawError: new Error('Only an administrator...'),
          }),
        },
      }),
      { defaultContext: { locale: 'zh', setLocale: () => {} } },
    )

    const switches = findAll(view.current, el => el.type === 'button' && el.props.role === 'switch')
    const lineSwitch = switches.find(s => s.props['aria-label'] === '媽媽 Telegram')
    await (lineSwitch?.props.onClick as () => Promise<void>)()

    const text = textContent(view.current)
    expect(text).toContain('只有系統管理員可以變更通知訂閱。')

    view.unmount()
  })

  test('strictly conforms to privacy boundary: no external ids, chat ids or tokens rendered', () => {
    const mockPatients = [{ id: 'secret-uuid-1234', displayName: '媽媽' }]
    const mockSubscriptions = { [subscriptionKey('secret-uuid-1234', 'telegram')]: true }
    const tree = renderPanel('zh', {
      hookOptions: {
        initialPatients: mockPatients,
        initialSubscriptions: mockSubscriptions,
      },
    })

    const text = textContent(tree)
    expect(text).not.toMatch(/chat_id|webhook|token|secret|recipient_id/i)
  })
})

describe('AdminPage notification subscriptions tab integration', () => {
  test('AdminPage defines subscriptions tab in tab orders', () => {
    expect(adminPageSource).toContain("'subscriptions'")
    expect(adminPageSource).toContain("NotificationSubscriptionsPanel")
    expect(adminPageSource).toContain("ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITH_CATALOG")
    expect(adminPageSource).toContain("ADMIN_TAB_ORDER_FOR_ADMINISTRATOR_WITHOUT_CATALOG")
    // curator-only 不包含 subscriptions
    expect(adminPageSource).toContain("ADMIN_TAB_ORDER_FOR_CURATOR: AdminTab[] = ['catalog']")
    // tablist 包含通知訂閱按鈕與對應 panel
    expect(adminPageSource).toContain('id="subscriptions-tab"')
    expect(adminPageSource).toContain('id="subscriptions-panel"')
  })
})
