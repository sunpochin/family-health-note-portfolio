/*
檔案用途：網站派工的三語、未知送出結果 UUID、取消／重試與 curator 邊界驗證。
所在層：tests/unit；使用 React hook harness 與假工程 RPC，不登入或接觸照護資料。
主要關聯：MissionControlPanel、useMissionControl、AdminPage、missionControlCopy。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import type { CloudWorker } from '../../src/lib/missionControl'
let workers: CloudWorker[] = []
let failingLoad = false, failingSubmit = false, loads = 0
const setupLocales:string[]=[]
const submitted: { action: string; input: Record<string, unknown> }[] = []
mock.module('../../src/lib/missionControl', () => ({
  loadMissions: async () => { loads++; if (failingLoad) throw new Error('offline'); return workers },
  missionRequest: async (action: string, input: Record<string, unknown>) => { submitted.push({ action, input }); if (failingSubmit) { failingSubmit = false; throw new Error('response lost') }; return { ok: true } },
  missionSetupCommand: (_standalone:boolean,locale:string) => {setupLocales.push(locale);return 'agent-mission-control cloud-link --cloud-url https://example.supabase.co --cloud-key public-fixture'},
}))
installReactHookHarness()
const { MissionControlPanel } = await import('../../src/features/system-admin/components/MissionControlPanel')
const { AdminPage } = await import('../../src/features/system-admin/pages/AdminPage')
const { missionCopy, missionStatuses, missionActions } = await import('../../src/features/system-admin/missionControlCopy')
const id = '61000000-0000-4000-8000-000000000001'
const fixture = (): CloudWorker => ({ id, repository: 'example/fixture', base: 'staging', name: 'Fixture Mac', paused: false, localPaused: false, hasMoreJobs: false, heartbeatAt: new Date().toISOString(), syncedAt: new Date().toISOString(), jobs: [], items: [{ number: 1, kind: 'pr', title: 'Fixture PR', state: 'open', url: 'https://github.com/example/fixture/pull/1', labels: [], updatedAt: new Date().toISOString() }] })
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const context = (locale: 'zh' | 'id' | 'en') => ({ locale, setLocale: () => {} })
beforeEach(() => { workers = [fixture()]; failingLoad = false; failingSubmit = false; loads = 0; submitted.length = 0; setupLocales.length=0 })
const button = (tree: unknown, label: string) => findAll(tree, el => el.type === 'button' && textContent(el) === label)[0]

describe('website mission control', () => {
  test.each(['zh', 'id', 'en'] as const)('uses the selected locale and disables unvalidated Claude (%s)', async locale => {
    const view = renderHook(() => MissionControlPanel(), { defaultContext: context(locale) })
    await tick()
    expect(textContent(view.current)).toContain(missionCopy.intro[locale])
    expect(button(view.current, missionCopy.dispatch[locale]).props.disabled).toBe(false)
    expect(button(view.current, missionCopy.claude[locale]).props.disabled).toBe(true)
    expect(setupLocales.length).toBeGreaterThanOrEqual(2);expect(setupLocales.every(value=>value===locale)).toBe(true)
    for (const copy of [...Object.values(missionCopy), ...Object.values(missionStatuses), ...Object.values(missionActions)]) expect(copy[locale].trim()).not.toBe('')
    view.unmount()
  })
  test('a lost dispatch response keeps the same UUID on a second click', async () => {
    const view = renderHook(() => MissionControlPanel(), { defaultContext: context('zh') })
    await tick(); failingSubmit = true
    view.act(() => (button(view.current, '交給 Codex').props.onClick as () => void)()); await tick()
    expect(textContent(view.current)).toContain(missionCopy.saveError.zh)
    view.act(() => (button(view.current, '交給 Codex').props.onClick as () => void)()); await tick()
    expect(submitted).toHaveLength(2)
    expect(submitted[1].input.requestId).toBe(submitted[0].input.requestId)
    expect(submitted[0].input).toMatchObject({ workerId: id, number: 1, kind: 'pr', action: 'review', agent: 'codex' })
    view.unmount()
  })
  test('load failures leave the last snapshot visible and block new writes', async () => {
    const view = renderHook(() => MissionControlPanel(), { defaultContext: context('zh') })
    await tick(); failingLoad = true
    view.act(() => (button(view.current, '更新進度').props.onClick as () => void)()); await tick()
    expect(textContent(view.current)).toContain('Fixture PR')
    expect(textContent(view.current)).toContain(missionCopy.loadError.zh)
    expect(button(view.current, '交給 Codex').props.disabled).toBe(true)
    view.unmount()
  })
  test('unknown publication has no retry; publishing has no cancel', async () => {
    const at = new Date().toISOString()
    workers[0].jobs = [{ id, item_number: 1, kind: 'pr', action: 'fix-comments', title: 'Fixture PR', status: 'interrupted', reason: 'publication-unknown', summary: 'Fixture result', cancel_requested: false, retry_requested: false, pr_url: null, created_at: at, updated_at: at }]
    const view = renderHook(() => MissionControlPanel(), { defaultContext: context('zh') })
    await tick()
    expect(textContent(view.current)).toContain(missionCopy.unknown.zh)
    expect(button(view.current, '重試這件工作')).toBeUndefined()
    expect(button(view.current, '取消工作')).toBeUndefined()
    view.unmount()
  })
  test('curator-only accounts never mount the engineering panel', () => {
    const view = renderHook(() => AdminPage({ isAdministrator: false, isCatalogCurator: true }), { defaultContext: context('zh') })
    expect(textContent(view.current)).not.toContain('工程派工')
    expect(findAll(view.current, el => el.type === MissionControlPanel)).toHaveLength(0)
    expect(loads).toBe(0)
    view.unmount()
  })
})

test.each(['zh', 'id', 'en'] as const)('cancelled jobs direct a new dispatch instead of an invalid retry (%s)', async locale => {
  const at = new Date().toISOString()
  workers[0].jobs = [{ id, item_number: 1, kind: 'pr', action: 'review', title: 'Fixture PR', status: 'cancelled', reason: 'cancelled', summary: '', cancel_requested: true, retry_requested: false, pr_url: null, created_at: at, updated_at: at }]
  const view = renderHook(() => MissionControlPanel(), { defaultContext: context(locale) }); await tick()
  expect(button(view.current, missionCopy.retry[locale])).toBeUndefined()
  expect(textContent(view.current)).toContain(missionCopy.cancelHelp[locale])
  expect(textContent(view.current)).not.toContain(missionCopy.blocked[locale])
  expect(button(view.current, missionCopy.dispatch[locale]).props.disabled).toBe(false)
  view.unmount()
})
