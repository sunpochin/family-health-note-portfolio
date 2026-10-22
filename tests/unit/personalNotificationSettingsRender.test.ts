/*
檔案用途：驗證個人化通知設定的管道別閘門（issue #1059、ADR-011 D3）——免費帳號可以綁 Telegram、LINE 仍限付費，
         並顯示「免費＝危險等級、Premium＝所有等級＋LINE＋提醒」的三語說明。
所在層：tests/unit；以最小 hook 執行環境呼叫元件函式，不啟動瀏覽器、不連 Supabase。
主要關聯：src/components/settings/PersonalNotificationSettings.tsx、src/lib/messagingLinks.ts、
         migration 20261005145950_free_danger_level_telegram_notifications.sql（create_messaging_link_token 的同一條規則）。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findButton, textContent } from './helpers/elementTree'

installReactHookHarness()

// 元件在 effect 裡註冊 focus／visibilitychange；bun 沒有 DOM，給最小替身即可。
const noopTarget = { addEventListener: () => {}, removeEventListener: () => {} }
Object.assign(globalThis, { window: { ...noopTarget, open: () => null }, document: { ...noopTarget, visibilityState: 'visible' } })
process.env.VITE_TELEGRAM_BOT_USERNAME = 'example_care_bot'
process.env.VITE_LINE_OA_BASIC_ID = '@example-oa'

const LOCALE_CONTEXT_VALUE = { locale: 'zh' as const, setLocale: () => {} }

let tier: 'none' | 'personal' = 'none'
let linkError: unknown = null
const actualMessagingLinks = await import('../../src/lib/messagingLinks')
mock.module('../../src/lib/messagingLinks', () => ({
  ...actualMessagingLinks,
  createMessagingLinkUrl: async () => { if (linkError) throw linkError; return 'https://t.me/example_care_bot?start=token' },
  fetchMessagingLinkStatus: async () => [
    { channel: 'telegram', linked: false, linkedAt: null, notificationTier: tier },
    { channel: 'line', linked: false, linkedAt: null, notificationTier: tier },
  ],
}))

const actualDemoStorage = await import('../../src/lib/demoStorage')
mock.module('../../src/lib/demoStorage', () => ({ ...actualDemoStorage, isDemoMode: () => false }))

const { PersonalNotificationSettings } = await import('../../src/components/settings/PersonalNotificationSettings')

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

async function render() {
  const view = renderHook(() => PersonalNotificationSettings(), { defaultContext: LOCALE_CONTEXT_VALUE })
  await flush()
  view.rerender()
  return view
}

// 兩列各有一顆「連結」；依畫面順序 Telegram 在前、LINE 在後。
function linkButtons(tree: unknown) {
  const buttons: Array<{ props: Record<string, unknown> }> = []
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk)
    if (!node || typeof node !== 'object' || !('props' in node)) return
    const element = node as { type: unknown; props: Record<string, unknown> }
    if (element.type === 'button' && textContent(element.props.children) === '連結') buttons.push(element)
    walk(element.props.children)
  }
  walk(tree)
  return buttons
}

beforeEach(() => { tier = 'none'; linkError = null })

describe('PersonalNotificationSettings channel gate (issue #1059)', () => {
  test('a free account can link Telegram but not LINE, and is told what free covers', async () => {
    const view = await render()
    const [telegram, line] = linkButtons(view.current)
    expect(telegram.props.disabled).toBe(false)
    expect(line.props.disabled).toBe(true)
    const rendered = textContent(view.current)
    expect(rendered).toContain('免費：透過 Telegram 收到危險等級的血壓警報。')
    expect(rendered).not.toContain('個人化通知是付費功能')
    view.unmount()
  })

  test('an account with no care access gets a plain reason instead of a generic save failure', async () => {
    // 字串與 create_messaging_link_token（migration 20261005145950）的例外訊息相同。
    linkError = { message: 'Telegram notifications require care access to at least one person' }
    const view = await render()
    const [telegram] = linkButtons(view.current)
    view.act(() => { (telegram.props.onClick as () => void)() })
    await flush()
    view.rerender()
    expect(textContent(view.current)).toContain('這個帳號還沒有任何照護對象')
    view.unmount()
  })

  test('a paid account can link both channels and sees no free-tier notice', async () => {
    tier = 'personal'
    const view = await render()
    const [telegram, line] = linkButtons(view.current)
    expect(telegram.props.disabled).toBe(false)
    expect(line.props.disabled).toBe(false)
    expect(textContent(view.current)).not.toContain('免費：')
    expect(findButton(view.current, '連結')).toBeDefined()
    view.unmount()
  })
})
