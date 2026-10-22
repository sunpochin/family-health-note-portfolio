/*
檔案用途：驗證共用的「N 筆紀錄等待同步」狀態列：筆數、同步中、最後嘗試時間、失敗提示、現在同步按鈕，以及佇列清空時整塊消失。
所在層：tests/unit；以最小 hook 執行環境呼叫元件取得元素樹，不啟動瀏覽器。
主要關聯：src/components/ui/PendingSyncStatus.tsx；血壓輸入頁與服藥打卡頁共用（issue #816、#822）。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, findButton, fire, textContent } from './helpers/elementTree'

installReactHookHarness()

const actualI18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ text: (item: { zh: string }) => item.zh, locale: 'zh', setLocale: () => {} }),
}))

const { PendingSyncStatus, PENDING_SYNC_TEXT, formatPendingAttemptTime } = await import('../../src/components/ui/PendingSyncStatus')

type Props = Parameters<typeof PendingSyncStatus>[0]
const render = (props: Partial<Props> = {}) => renderHook(() => PendingSyncStatus({
  count: 2, syncing: false, lastAttemptAt: null, syncError: false, onRetry: () => {}, ...props,
})).current

describe('PendingSyncStatus', () => {
  test('announces the pending count in a status region with a manual sync button', () => {
    let retries = 0
    const tree = render({ onRetry: () => { retries += 1 } })
    expect(findAll(tree, node => node.props.role === 'status')).toHaveLength(1)
    expect(textContent(tree)).toContain('2 筆紀錄等待同步')
    fire(findButton(tree, '現在同步'), 'onClick')
    expect(retries).toBe(1)
  })

  test('shows syncing instead of the count and disables the button while a flush is running', () => {
    const tree = render({ syncing: true, lastAttemptAt: Date.parse('2026-10-06T02:15:00.000Z') })
    expect(textContent(tree)).toContain('正在同步紀錄…')
    expect(textContent(tree)).not.toContain('最後一次嘗試同步時間')
    expect(findButton(tree, '現在同步').props.disabled).toBe(true)
  })

  test('shows the last attempt in Taipei time and the connection hint after a failed round', () => {
    const tree = render({ lastAttemptAt: Date.parse('2026-10-06T02:15:00.000Z'), syncError: true })
    expect(formatPendingAttemptTime(Date.parse('2026-10-06T02:15:00.000Z'))).toBe('10:15')
    expect(textContent(tree)).toContain('最後一次嘗試同步時間：10:15')
    expect(textContent(tree)).toContain(PENDING_SYNC_TEXT.syncError.zh)
  })

  test('disappears once the queue is empty, but still shows an extra notice passed by the caller', () => {
    expect(render({ count: 0 })).toBeNull()
    const tree = render({ count: 0, children: 'notice-sentinel' })
    expect(textContent(tree)).toBe('notice-sentinel')
    // 沒有待送紀錄時不能留「現在同步」按鈕，看護會以為還有東西沒送。
    expect(findAll(tree, node => node.type === 'button')).toHaveLength(0)
  })

  test('replaces the generic connection hint with the reasons the caller passes (issue #1125)', () => {
    const tree = render({ syncError: true, syncErrorTexts: [{ id: 'reason-a', zh: 'reason-a', en: 'reason-a' }, { id: 'reason-b', zh: 'reason-b', en: 'reason-b' }] })
    expect(textContent(tree)).toContain('reason-a')
    expect(textContent(tree)).toContain('reason-b')
    expect(textContent(tree)).not.toContain(PENDING_SYNC_TEXT.syncError.zh)
    // 呼叫端沒給原因時仍沿用通用那句（服藥打卡維持原樣）。
    expect(textContent(render({ syncError: true, syncErrorTexts: [] }))).toContain(PENDING_SYNC_TEXT.syncError.zh)
  })

  test('shows only a count for other people, and keeps the sync button when only they are waiting (issue #1125)', () => {
    let retries = 0
    const tree = render({ count: 0, otherPatientsCount: 3, syncError: true, onRetry: () => { retries += 1 } })
    expect(textContent(tree)).toContain(PENDING_SYNC_TEXT.otherPatients(3).zh)
    expect(textContent(tree)).not.toContain('0 筆紀錄等待同步')
    expect(textContent(tree)).toContain(PENDING_SYNC_TEXT.syncError.zh)
    fire(findButton(tree, '現在同步'), 'onClick')
    expect(retries).toBe(1)
    expect(textContent(render({ count: 2, otherPatientsCount: 1 }))).toContain(PENDING_SYNC_TEXT.otherPatients(1).zh)
  })
})
