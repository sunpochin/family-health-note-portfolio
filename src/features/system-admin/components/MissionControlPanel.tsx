/*
檔案用途：既有管理頁的手機工程派工；只安排封閉操作與三語狀態。
所在層：src/features/system-admin/components；administrator tab 才掛載。
主要關聯：useMissionControl、missionControlCopy、cloud-model、AdminPage。
*/
import { useState } from 'react'
import { useI18n } from '../../../lib/i18n'
import { missionSetupCommand } from '../../../lib/missionControl'
import { useMissionControl } from '../hooks/useMissionControl'
import { missionCopy as c, missionActions, missionStatuses } from '../missionControlCopy'
import { CLOUD_ACTIVE } from '../../../../packages/agent-mission-control/src/cloud-model'
import type { Action } from '../../../../packages/agent-mission-control/src/model'
// 同款樣式也用於 PR 連結；inline-flex 才能讓連結的 44px 最小高度真的生效。
const button = 'inline-flex min-h-11 items-center justify-center rounded-lg border border-control-border bg-white px-4 py-2 font-semibold text-brand-700 disabled:opacity-50'
// 2px 高對比邊框明列在每個原生欄位，讓既有可及性檢查能逐一稽核。
const field = 'min-h-11 w-full rounded-lg bg-white px-3 py-2 text-base'
export function MissionControlPanel() {
  const { text, locale } = useI18n()
  const data = useMissionControl()
  const [selected, setSelected] = useState('')
  const [draft, setDraft] = useState({ name: '', repository: '', base: 'staging', token: '' })
  const [filter, setFilter] = useState({ search: '', kind: 'all', count: 40 })
  const [actions, setActions] = useState<Record<number, Action>>({})
  const worker = data.workers.find(row => row.id === selected) ?? data.workers[0]
  const busy = data.saveStatus === 'saving'
  const unavailable = busy || data.paging || data.loading || Boolean(data.loadError)
  const online = Boolean(worker?.heartbeatAt && Date.now() - Date.parse(worker.heartbeatAt) < 30000)
  const items = worker?.items.filter(item => item.state === 'open' && (filter.kind === 'all' || item.kind === filter.kind) && `${item.number} ${item.title}`.toLowerCase().includes(filter.search.toLowerCase())) ?? []
  const connect = async (event: React.FormEvent) => {
    event.preventDefault()
    if (await data.mutate('register', draft)) setDraft(previous => ({ ...previous, token: '' }))
  }
  const formatTime = (value: string | null) => value ? new Date(value).toLocaleString(locale === 'zh' ? 'zh-TW' : locale === 'id' ? 'id-ID' : 'en-US') : text(c.never)
  return <section aria-label={text(c.title)} className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-xl font-bold text-slate-900">{text(c.title)}</h2>
      <button className={button} type="button" disabled={busy || data.loading} onClick={() => void data.refresh()}>{text(c.refresh)}</button>
    </div>
    <p className="text-slate-700">{text(c.intro)}</p>
    {data.loading && <p role="status">{text(c.loading)}</p>}
    {data.loadError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-800">{text(data.loadError === 'forbidden' ? c.forbidden : c.loadError)}</p>}
    {data.saveStatus !== 'idle' && <p role={data.saveStatus === 'err' ? 'alert' : 'status'}>{text(data.saveStatus === 'saving' ? c.saving : data.saveStatus === 'ok' ? c.saved : data.saveMessage === 'forbidden' ? c.forbidden : c.saveError)}</p>}
    {!data.loading && !data.workers.length && !data.loadError && <p>{text(c.empty)}</p>}
    <details className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-brand-700">{text(c.setup)}</summary>
      <p className="my-3 text-slate-700">{text(c.setupHelp)}</p>
      <p className="mb-2 font-semibold">{text(c.setupRepository)}</p>
      <code className="block break-all rounded-lg bg-slate-100 p-3 text-sm">{missionSetupCommand(false,locale)}</code>
      <p className="mb-2 mt-3 font-semibold">{text(c.setupPackage)}</p>
      <code className="block break-all rounded-lg bg-slate-100 p-3 text-sm">{missionSetupCommand(true,locale)}</code>
      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={event => void connect(event)}>
        {(['name', 'repository', 'base', 'token'] as const).map(key => <label key={key} className="space-y-1">
          <span className="block font-semibold">{text(key === 'repository' ? c.repo : key === 'token' ? c.pairCode : c[key])}</span>
          <input className={`border-2 border-control-border ${field}`} required maxLength={key === 'token' ? 64 : key === 'repository' ? 200 : key === 'base' ? 120 : 80} type={key === 'token' ? 'password' : 'text'} autoComplete="off" spellCheck={false} value={draft[key]} pattern={key === 'token' ? '[a-f0-9]{64}' : undefined} onChange={event => setDraft(previous => ({ ...previous, [key]: event.target.value }))} />
        </label>)}
        <button className={button} type="submit" disabled={busy}>{text(c.connect)}</button>
      </form>
    </details>
    {worker && <>
      <label className="block space-y-1"><span className="block font-semibold">{text(c.computer)}</span>
        <select className={`border-2 border-control-border ${field}`} value={worker.id} onChange={event => { setSelected(event.target.value); setActions({}); setFilter(previous => ({ ...previous, count: 40 })) }}>
          {data.workers.map(row => <option value={row.id} key={row.id}>{row.name} · {row.repository}</option>)}
        </select>
      </label>
      <div className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="font-semibold">{text(online ? c.online : c.offline)}</p>
        <p className="mt-1 text-sm text-slate-600">{text(c.lastSeen)} · {formatTime(worker.heartbeatAt)}</p>
        <div className="mt-3 flex flex-wrap gap-3">
          <button className={button} type="button" disabled={unavailable} onClick={() => void data.mutate('pause', { workerId: worker.id, paused: !(worker.paused || worker.localPaused) })}>{text(worker.paused || worker.localPaused ? c.resume : c.pause)}</button>
          {/* 撤銷是配對權限而非刪資料；先展開影響說明，避免手機誤碰立即中斷。 */}
          <details><summary className="flex min-h-11 cursor-pointer items-center px-3 text-slate-600">{text(c.revoke)}</summary>
            <p className="my-2 max-w-sm text-sm">{text(c.revokeHelp)}</p>
            <button className={button} type="button" disabled={unavailable} onClick={() => void data.mutate('revoke', { workerId: worker.id })}>{text(c.revoke)}</button>
          </details>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1"><span className="block font-semibold">{text(c.search)}</span><input className={`border-2 border-control-border ${field}`} type="search" value={filter.search} onChange={event => setFilter(previous => ({ ...previous, search: event.target.value, count: 40 }))} /></label>
        <label className="space-y-1"><span className="block font-semibold">{text(c.kind)}</span><select className={`border-2 border-control-border ${field}`} value={filter.kind} onChange={event => setFilter(previous => ({ ...previous, kind: event.target.value, count: 40 }))}><option value="all">{text(c.all)}</option><option value="issue">{text(c.issue)}</option><option value="pr">{text(c.prType)}</option></select></label>
      </div>
      {!items.length && <p>{text(c.noItems)}</p>}
      <div className="grid gap-3 lg:grid-cols-2">
        {items.slice(0, filter.count).map(item => <article key={`${item.kind}:${item.number}`} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
          <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center font-semibold text-brand-700">{text(item.kind === 'pr' ? c.prType : c.issue)} #{item.number}</a>
          <h3 className="mb-3 break-words font-semibold text-slate-900">{item.title}</h3>
          {item.kind === 'pr' && <label className="mb-3 block space-y-1"><span>{text(c.action)}</span><select className={`border-2 border-control-border ${field}`} value={actions[item.number] ?? 'review'} onChange={event => setActions(previous => ({ ...previous, [item.number]: event.target.value as Action }))}>{Object.entries(missionActions).filter(([key]) => key !== 'implement').map(([key, value]) => <option value={key} key={key}>{text(value)}</option>)}</select></label>}
          <div className="flex flex-wrap gap-3">
            <button className={button} type="button" disabled={unavailable || worker.jobs.some(job => job.item_number === item.number && CLOUD_ACTIVE.includes(job.status))} onClick={() => void data.dispatch(worker.id, { number: item.number, kind: item.kind, agent: 'codex', action: item.kind === 'issue' ? 'implement' : actions[item.number] ?? 'review' })}>{text(c.dispatch)}</button>
            <button className={button} type="button" disabled>{text(c.claude)}</button>
          </div>
        </article>)}
      </div>
      {items.length > filter.count && <button className={button} type="button" onClick={() => setFilter(previous => ({ ...previous, count: previous.count + 40 }))}>{text(c.more)}</button>}
      {/* 舊待辦可能比最新百張還早；翻頁沿用同一個 owner RPC，才有機會安全取消它。 */}
      <h2 className="text-lg font-bold">{text(c.jobs)}</h2>
      <div className="flex flex-wrap items-center gap-3">
        <button className={button} type="button" disabled={data.paging || data.loading || data.saveStatus==='saving' || data.pageNumber(worker.id)===1} onClick={()=>void data.changePage(worker,false)}>{text(c.newerJobs)}</button>
        <span>{text(c.jobPage)} {data.pageNumber(worker.id)}</span>
        <button className={button} type="button" disabled={data.paging || data.loading || data.saveStatus==='saving' || !worker.hasMoreJobs} onClick={()=>void data.changePage(worker,true)}>{text(c.olderJobs)}</button>
      </div>
      {!worker.jobs.length && <p>{text(c.noJobs)}</p>}
      {worker.jobs.map(job => <article key={job.id} className="min-w-0 rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm text-slate-600">#{job.item_number} · {text(missionActions[job.action])}</p>
        <h3 className="break-words font-semibold">{job.title}</h3>
        <p className="my-2 font-semibold">{text(missionStatuses[job.status as keyof typeof missionStatuses])}</p>
        {job.cancel_requested && CLOUD_ACTIVE.includes(job.status) && <p>{text(c.cancelPending)}</p>}
        {job.status === 'cancelled' && <p>{text(c.cancelHelp)}</p>}
        {/* 正常取消已成功結束；不能再用登入／quota 指引把它顯示成操作失敗。 */}
        {job.status !== 'cancelled' && job.reason && job.reason !== 'cancelled' && <p>{text(job.reason === 'publication-unknown' ? c.unknown : c.blocked)}</p>}
        <div className="mt-3 flex flex-wrap gap-3">
          {['queued', 'claimed', 'preparing', 'running'].includes(job.status) && !job.cancel_requested && <button className={button} type="button" disabled={unavailable} onClick={() => void data.mutate('cancel', { workerId: worker.id, jobId: job.id })}>{text(c.cancel)}</button>}
          {['blocked', 'failed', 'interrupted'].includes(job.status) && job.reason !== 'publication-unknown' && <button className={button} type="button" disabled={unavailable || job.retry_requested} onClick={() => void data.mutate('retry', { workerId: worker.id, jobId: job.id })}>{text(c.retry)}</button>}
          {job.pr_url && <a href={job.pr_url} target="_blank" rel="noreferrer" className={button}>{text(c.pr)}</a>}
        </div>
        {job.summary && <details className="mt-3"><summary className="flex min-h-11 cursor-pointer items-center font-semibold text-brand-700">{text(c.result)}</summary><p className="whitespace-pre-wrap break-words text-slate-700">{job.summary}</p></details>}
      </article>)}
      <p className="text-sm text-slate-600">{text(c.reviewHelp)}</p>
    </>}
  </section>
}
