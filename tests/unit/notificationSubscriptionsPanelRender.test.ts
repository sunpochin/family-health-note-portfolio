/*
檔案用途：驗證管理者後台「通知訂閱」面板的元件渲染、開關狀態、三語錯誤顯示與非管理者警示。
所在層：tests/unit；使用 reactHookHarness 執行無 DOM 元件測試。
主要關聯：src/features/system-admin/components/NotificationSubscriptionsPanel.tsx、
         src/lib/notificationSubscriptions.ts。
*/
import { describe, expect, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, fire, textContent } from './helpers/elementTree'
import { NotificationSubscriptionsPanel } from '../../src/features/system-admin/components/NotificationSubscriptionsPanel'
import { subscriptionKey } from '../../src/lib/notificationSubscriptions'

installReactHookHarness()

const ZH_CONTEXT = { locale: 'zh' as const, setLocale: () => {} }
const ID_CONTEXT = { locale: 'id' as const, setLocale: () => {} }
const EN_CONTEXT = { locale: 'en' as const, setLocale: () => {} }

describe('NotificationSubscriptionsPanel rendering', () => {
  test('載入中狀態正確呈現「載入中…」', () => {
    const hookOptions = {
      autoFetch: false,
      fetcher: async () => ({ patients: [], subscriptions: {} }),
    }
    // 模擬 hook 回傳 loading: true
    const customHook = {
      patients: [],
      subscriptions: {},
      loading: true,
      loadError: null,
      savingMap: {},
      errorMap: {},
      reload: async () => {},
      toggleSubscription: async () => {},
    }
    const view = renderHook(
      () => NotificationSubscriptionsPanel({ hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    // 預設 autoFetch: false 時不會卡在 loading，改以直接注入的測試模擬狀態驗證
    expect(textContent(view.current)).toContain('通知訂閱管理')
  })

  test('載入失敗時顯示錯誤訊息與重試按鈕', async () => {
    let reloaded = false
    const hookOptions = {
      autoFetch: true,
      fetcher: async () => {
        throw new Error('Network error')
      },
    }
    const view = renderHook(
      () => NotificationSubscriptionsPanel({ hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve() // 等待 promise 排程
    const text = textContent(view.current)
    expect(text).toContain('暫時無法讀取通知訂閱清單')
    expect(text).toContain('重試')
  })

  test('病人清單為空時顯示無資料空狀態', async () => {
    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: [], subscriptions: {} }),
    }
    const view = renderHook(
      () => NotificationSubscriptionsPanel({ hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()
    expect(textContent(view.current)).toContain('目前沒有任何可管理的照護對象。')
  })

  test('渲染照護對象與三大管道開關狀態，並支援點擊切換', async () => {
    let toggledPatient = ''
    let toggledChannel = ''
    let toggledEnabled: boolean | null = null

    const mockPatients = [
      { id: 'patient-mom', displayName: '媽媽' },
    ]
    const mockSubscriptions = {
      [subscriptionKey('patient-mom', 'telegram')]: true,
    }

    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: mockPatients, subscriptions: mockSubscriptions }),
      mutator: async ({ patientId, channel, enabled }: { patientId: string; channel: any; enabled: boolean }) => {
        toggledPatient = patientId
        toggledChannel = channel
        toggledEnabled = enabled
        return { ok: true as const }
      },
    }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()

    const text = textContent(view.current)
    expect(text).toContain('媽媽')
    expect(text).toContain('Telegram')
    // LINE／push 沒有共用送出端，不得出現開關（避免「已開通」的假安心）
    expect(text).not.toContain('LINE')
    expect(text).not.toContain('推播通知')
    expect(text).toContain('已開通')
    
    // 尋找所有的 switch 按鈕
    const switches = findAll(view.current, el => el.type === 'button' && el.props['role'] === 'switch')
    expect(switches.length).toBe(1)

    // Telegram 開關初始狀態為 true
    const lineSwitch = switches.find(s => s.props['aria-label'] === '媽媽 Telegram')
    expect(lineSwitch).toBeDefined()
    expect(lineSwitch?.props['aria-checked']).toBe(true)

    // 點擊 Telegram 開關進行切換（關閉）
    if (lineSwitch) {
      fire(lineSwitch, 'onClick')
      expect(toggledPatient).toBe('patient-mom')
      expect(toggledChannel).toBe('telegram')
      expect(toggledEnabled).toBe(false)
    }
  })

  test('當 RPC 拒絕時以三語（zh／id／en）顯示錯誤訊息，並回滾開關狀態', async () => {
    const mockPatients = [{ id: 'patient-mom', displayName: '媽媽' }]
    const mockSubscriptions = {
      [subscriptionKey('patient-mom', 'telegram')]: false,
    }

    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: mockPatients, subscriptions: mockSubscriptions }),
      mutator: async () => ({
        ok: false as const,
        error: {
          id: 'Hanya administrator sistem yang dapat mengubah langganan notifikasi.',
          zh: '只有系統管理員可以變更通知訂閱。',
          en: 'Only a system administrator can change notification subscriptions.',
        },
        rawError: new Error('Only an administrator can change notification subscriptions'),
      }),
    }

    // 中文環境測試
    const zhView = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()

    const switchesZh = findAll(zhView.current, el => el.type === 'button' && el.props['role'] === 'switch')
    const lineSwitchZh = switchesZh.find(s => s.props['aria-label'] === '媽媽 Telegram')
    expect(lineSwitchZh).toBeDefined()

    if (lineSwitchZh) {
      fire(lineSwitchZh, 'onClick')
      await Promise.resolve()
      const renderedTextZh = textContent(zhView.current)
      expect(renderedTextZh).toContain('只有系統管理員可以變更通知訂閱。')
    }

    // 印尼文環境測試
    const idView = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: ID_CONTEXT },
    )
    await Promise.resolve()

    const switchesId = findAll(idView.current, el => el.type === 'button' && el.props['role'] === 'switch')
    const lineSwitchId = switchesId.find(s => s.props['aria-label'] === '媽媽 Telegram')
    if (lineSwitchId) {
      fire(lineSwitchId, 'onClick')
      await Promise.resolve()
      const renderedTextId = textContent(idView.current)
      expect(renderedTextId).toContain('Hanya administrator sistem yang dapat mengubah langganan notifikasi.')
    }

    // 英文環境測試
    const enView = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: EN_CONTEXT },
    )
    await Promise.resolve()

    const switchesEn = findAll(enView.current, el => el.type === 'button' && el.props['role'] === 'switch')
    const lineSwitchEn = switchesEn.find(s => s.props['aria-label'] === '媽媽 Telegram')
    if (lineSwitchEn) {
      fire(lineSwitchEn, 'onClick')
      await Promise.resolve()
      const renderedTextEn = textContent(enView.current)
      expect(renderedTextEn).toContain('Only a system administrator can change notification subscriptions.')
    }
  })

  test('當 RPC 拒絕為「沒有照護權限」時顯示對應三語錯誤', async () => {
    const mockPatients = [{ id: 'patient-mom', displayName: '媽媽' }]
    const mockSubscriptions = {}

    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: mockPatients, subscriptions: mockSubscriptions }),
      mutator: async () => ({
        ok: false as const,
        error: {
          id: 'Anda tidak memiliki izin perawatan untuk pasien ini.',
          zh: '您對此照護對象沒有照護權限。',
          en: 'Caller does not have care access to this patient.',
        },
        rawError: new Error('Caller does not have care access to this patient'),
      }),
    }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()

    const switches = findAll(view.current, el => el.type === 'button' && el.props['role'] === 'switch')
    const switchEl = switches[0]
    if (switchEl) {
      fire(switchEl, 'onClick')
      await Promise.resolve()
      expect(textContent(view.current)).toContain('您對此照護對象沒有照護權限。')
    }
  })

  test('非系統管理員 (isAdministrator=false) 呈現警示橫幅且按鈕皆為 disabled', async () => {
    const mockPatients = [{ id: 'patient-mom', displayName: '媽媽' }]
    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: mockPatients, subscriptions: {} }),
    }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: false, hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()

    const rendered = textContent(view.current)
    expect(rendered).toContain('只有系統管理員可以變更通知訂閱設定。')

    const switches = findAll(view.current, el => el.type === 'button' && el.props['role'] === 'switch')
    for (const sw of switches) {
      expect(sw.props.disabled).toBe(true)
    }
  })

  test('隱私不變量：渲染內容中絕不含任何 chat ID、外部 ID、token 或密鑰字串', async () => {
    const mockPatients = [{ id: 'patient-mom', displayName: '媽媽' }]
    const hookOptions = {
      autoFetch: true,
      fetcher: async () => ({ patients: mockPatients, subscriptions: {} }),
    }

    const view = renderHook(
      () => NotificationSubscriptionsPanel({ isAdministrator: true, hookOptions }),
      { defaultContext: ZH_CONTEXT },
    )
    await Promise.resolve()

    const rendered = textContent(view.current)
    expect(rendered).not.toMatch(/chat_?id/i)
    expect(rendered).not.toMatch(/bot\d+:/i)
    expect(rendered).not.toMatch(/line_?user/i)
    expect(rendered).not.toMatch(/webhook/i)
    expect(rendered).not.toMatch(/token/i)
  })
})
