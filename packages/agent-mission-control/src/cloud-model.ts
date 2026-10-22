/*
檔案用途：雲端工作單的共用封閉契約與回應驗證；瀏覽器及 Mac 都只接受已知欄位。
所在層：packages/agent-mission-control/src；不依賴 runtime 套件或特定 repo。
主要關聯：cloud.ts、src/lib/missionControl.ts、mission_control_* RPC。
*/
import { dispatchInput, type Dispatch, type WorkItem } from './model'
export const CLOUD_ACTIVE = ['queued', 'claimed', 'preparing', 'running', 'publishing']
export const CLOUD_STATUSES = [...CLOUD_ACTIVE, 'finished', 'blocked', 'failed', 'cancelled', 'interrupted']
export type CloudJob = { id: string; item_number: number; kind: 'issue' | 'pr'; action: Dispatch['action']; title: string; status: string; claim_id?: string; retry_revision?: number; cancel_requested: boolean; retry_requested: boolean; summary: string; reason: string | null; pr_url: string | null; created_at: string; updated_at: string }
export type CloudWorker = { id: string; repository: string; base: string; name: string; paused: boolean; localPaused: boolean; heartbeatAt: string | null; syncedAt: string | null; items: WorkItem[]; jobs: CloudJob[]; hasMoreJobs: boolean }
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
export function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('cloud-data'); return value as Record<string, unknown> }
function string(value: unknown, limit = 800): string { if (typeof value !== 'string' || value.length > limit) throw new Error('cloud-data'); return value }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('cloud-data'); return value }
function timestamp(value: unknown): string { const text = string(value); if (!Number.isFinite(Date.parse(text))) throw new Error('cloud-data'); return text }
export function githubLink(value: unknown, repository: string, kind: 'issue' | 'pr', number?: number): string {
  const text = string(value, 300), url = new URL(text)
  const suffix = kind === 'issue' ? 'issues' : 'pull'
  const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9][0-9]*)$/)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password || url.search || url.hash || !match || match[1].toLowerCase() !== repository.toLowerCase() || match[2] !== suffix || (number !== undefined && Number(match[3]) !== number)) throw new Error('cloud-data')
  return text
}
export function cloudJob(value: unknown, repository: string, withClaim = false): CloudJob {
  const row = object(value)
  if (!uuid(row.id) || (withClaim && (!uuid(row.claim_id) || !Number.isSafeInteger(row.retry_revision) || Number(row.retry_revision) < 0 || Number(row.retry_revision) > 2147483647))) throw new Error('cloud-data')
  const input = dispatchInput({ number: row.item_number, kind: row.kind, action: row.action, agent: 'codex' })
  if (!CLOUD_STATUSES.includes(String(row.status)) || (row.reason !== null && (typeof row.reason !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(row.reason)))) throw new Error('cloud-data')
  return { id: row.id, item_number: input.number, kind: input.kind, action: input.action, title: string(row.title), status: String(row.status), ...(withClaim ? { claim_id: row.claim_id as string, retry_revision: Number(row.retry_revision) } : {}), cancel_requested: boolean(row.cancel_requested), retry_requested: boolean(row.retry_requested), summary: string(row.summary, 2000), reason: row.reason as string | null, pr_url: row.pr_url === null ? null : githubLink(row.pr_url, repository, 'pr'), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at) }
}
// 每頁沿用原本百張上限；明確的 hasMoreJobs 才能讓舊工作被找回，不把缺欄位猜成沒有待辦。
export function cloudWorkers(value: unknown): CloudWorker[] {
  const rows = object(value).workers
  if (!Array.isArray(rows) || rows.length > 10) throw new Error('cloud-data')
  return rows.map(raw => {
    const row = object(raw), repository = string(row.repository, 200)
    if (!uuid(row.id) || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !Array.isArray(row.items) || row.items.length > 10000 || !Array.isArray(row.jobs) || row.jobs.length > 100) throw new Error('cloud-data')
    return { id: row.id, repository, base: string(row.base, 120), name: string(row.name, 80), paused: boolean(row.paused), hasMoreJobs: boolean(row.hasMoreJobs), localPaused: boolean(row.localPaused), heartbeatAt: row.heartbeatAt === null ? null : timestamp(row.heartbeatAt), syncedAt: row.syncedAt === null ? null : timestamp(row.syncedAt), jobs: row.jobs.map(job => cloudJob(job, repository)), items: row.items.map(rawItem => {
      const item = object(rawItem)
      if (!Number.isSafeInteger(item.number) || Number(item.number) < 1 || !['issue', 'pr'].includes(String(item.kind)) || !['open', 'closed'].includes(String(item.state))) throw new Error('cloud-data')
      return { number: Number(item.number), kind: item.kind as WorkItem['kind'], state: item.state as WorkItem['state'], title: string(item.title), url: githubLink(item.url, repository, item.kind as WorkItem['kind'], Number(item.number)), updatedAt: timestamp(item.updatedAt), labels: [] }
    }) }
  })
}
