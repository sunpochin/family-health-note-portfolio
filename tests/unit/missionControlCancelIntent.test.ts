/*
檔案用途：獨立審查重現的假 RPC 回歸；重現回應遺失後取消，再從工作卡片重新派工。
所在層：tests/unit；只用假 RPC，不連外部服務。
主要關聯：useMissionControl 與 PR #1296 取消後重新派工策略。
*/
import { expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
const at = '2026-10-14T00:00:00Z'
const workerId = '61000000-0000-4000-8000-000000000001'
import type { CloudJob, CloudWorker } from '../../src/lib/missionControl'
const jobs: CloudJob[] = []
let loseCancelResponse = false
const requests: Record<string, unknown>[] = []
const byRequest = new Map<string, string>()
const workers: CloudWorker[] = [{ id: workerId, repository: 'example/fixture', base: 'staging', name: 'Fixture', paused: false, localPaused: false, hasMoreJobs: false, heartbeatAt: at, syncedAt: at, jobs, items: [{ number: 1, kind: 'issue', state: 'open', title: 'Fixture issue', url: 'https://github.com/example/fixture/issues/1', labels: [], updatedAt: at }] }]
mock.module('../../src/lib/missionControl', () => ({
  loadMissions: async () => workers,
  missionSetupCommand: () => 'fixture-command',
  missionRequest: async (action: string, input: Record<string, unknown>) => {
    if (action === 'dispatch') {
      requests.push(input)
      if (!byRequest.has(String(input.requestId))) {
        const id = crypto.randomUUID(); byRequest.set(String(input.requestId), id)
        jobs.push({ id, item_number: 1, kind: 'issue', action: 'implement', title: 'Fixture issue', status: 'queued', cancel_requested: false, retry_requested: false, reason: null, summary: '', pr_url: null, created_at: at, updated_at: at })
      }
      // 模擬伺服器已建立工作，但手機沒有收到第一次回應。
      if (requests.length === 1) throw new Error('response lost')
      return { id: byRequest.get(String(input.requestId)) }
    }
    if (action === 'cancel') {
      const job = jobs.find(row => row.id === input.jobId); if (!job) throw new Error('fixture-job'); job.status = 'cancelled'; job.reason = 'cancelled'; job.cancel_requested = true
      if (loseCancelResponse) throw new Error('cancel response lost')
    }
    return { ok: true }
  },
}))
installReactHookHarness()
const { MissionControlPanel } = await import('../../src/features/system-admin/components/MissionControlPanel')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const button = (tree: unknown, label: string) => findAll(tree, el => el.type === 'button' && textContent(el) === label)[0]
test.each([false, true])('confirmed cancellation ends uncertain dispatch even with a lost cancel reply (%s)', async lostCancelReply => {
  jobs.length = 0; requests.length = 0; byRequest.clear(); loseCancelResponse = lostCancelReply
  const view = renderHook(() => MissionControlPanel(), { defaultContext: { locale: 'zh', setLocale: () => {} } })
  try {
    await tick()
    view.act(() => (button(view.current, '交給 Codex').props.onClick as () => void)()); await tick()
    view.act(() => (button(view.current, '更新進度').props.onClick as () => void)()); await tick()
    view.act(() => (button(view.current, '取消工作').props.onClick as () => void)()); await tick()
    view.act(() => (button(view.current, '更新進度').props.onClick as () => void)()); await tick()
    expect(textContent(view.current)).toContain('要再做一次，請回到上方工作卡片重新派工。')
    view.act(() => (button(view.current, '交給 Codex').props.onClick as () => void)()); await tick()
    expect(requests[1].requestId === requests[0].requestId).toBe(false)
    expect(jobs).toHaveLength(2)
  } finally { view.unmount() }
})
