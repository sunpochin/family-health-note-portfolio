/*
檔案用途：工程派工管理頁的讀取／送出狀態；UUID 重送與卸載取消避免重複派工。
所在層：src/features/system-admin/hooks；不把配對碼存進瀏覽器永久 storage。
主要關聯：MissionControlPanel、lib/missionControl、useSaveStatus。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { loadMissions, missionRequest, type CloudWorker } from '../../../lib/missionControl'
import { useSaveStatus } from '../../../hooks/useSaveStatus'
import type { Dispatch } from '../../../../packages/agent-mission-control/src/model'
export function useMissionControl() {
  const [workers, setWorkers] = useState<CloudWorker[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const save = useSaveStatus()
  const controller = useRef<AbortController | null>(null)
  const refreshing = useRef<Promise<CloudWorker[] | undefined> | null>(null), mutating = useRef(false), paginating = useRef(false)
  const [paging, setPaging] = useState(false)
  const page = useRef<{workerId:string; cursors:string[]} | null>(null)
  const pending = useRef(new Map<string, string>())
  const cancellations = useRef(new Map<string, string>())
  const refresh = useCallback((): Promise<CloudWorker[] | undefined> => {
    if (!controller.current || controller.current.signal.aborted) return Promise.resolve(undefined)
    if (refreshing.current) return refreshing.current
    const signal=controller.current.signal, selectedPage=page.current
    const cursor=selectedPage?.cursors[selectedPage.cursors.length-1]
    const query=cursor && page.current ? {workerId:page.current.workerId,beforeId:cursor} : undefined
    const request=(async()=>{
      try {
        let values:CloudWorker[]
        try {values=await loadMissions(signal,query)}
        catch(error){
          if(!query || (error as {code?:string})?.code!=='forbidden' || signal.aborted)throw error
          // 別台裝置可能已撤銷深頁連接；仍透過同一 owner RPC 重讀最新頁，成功才丟失效 cursor。
          values=await loadMissions(signal)
          if(!signal.aborted)page.current=null
        }
        if (!signal.aborted) {
          // 只有同一張單已確認取消才結束原 UUID；翻頁不能把未知派工當成新的意圖。
          for (const worker of values) for (const job of worker.jobs) {
            const id=`${worker.id}:${job.id}`, key=cancellations.current.get(id)
            if(key && job.status==='cancelled'){pending.current.delete(key);cancellations.current.delete(id)}
          }
          setWorkers(values);setLoadError(null);return values
        }
      } catch(error){if(!signal.aborted)setLoadError((error as {code?:string}).code??'request-failed')}
      finally {refreshing.current=null;if(!signal.aborted)setLoading(false)}
    })()
    refreshing.current=request
    return request
  }, [])
  useEffect(() => {
    const active = new AbortController(); controller.current = active
    void refresh()
    const requests = pending.current, cancelledRequests = cancellations.current
    const timer = setInterval(() => { void refresh() }, 10000)
    // 換帳號或卸載後立刻取消，工程清單不留在永久快取或寫回消失的頁面。
    return () => { active.abort(); clearInterval(timer); requests.clear(); cancelledRequests.clear(); page.current=null }
  }, [refresh])
  const mutate = async (action: string, input: Record<string, unknown>) => {
    if (mutating.current || paginating.current || !controller.current || controller.current.signal.aborted) return false
    mutating.current = true; save.begin()
    const signal = controller.current.signal
    const job = action === 'cancel' ? workers.find(worker => worker.id === input.workerId)?.jobs.find(job => job.id === input.jobId) : undefined
    const cancelledId = job ? `${input.workerId}:${job.id}` : undefined
    const cancelledKey = job ? `${input.workerId}:${job.kind}:${job.item_number}:${job.action}` : undefined
    if (cancelledId && cancelledKey) cancellations.current.set(cancelledId, cancelledKey)
    try { await missionRequest(action, input, signal);
      // 取消已被網站接受，新派工就應是新 UUID；取消回應遺失則等 refresh 確認同一張單。
      if (!signal.aborted && cancelledId && cancelledKey) { pending.current.delete(cancelledKey); cancellations.current.delete(cancelledId) } if (!signal.aborted) {
        save.succeed('saved'); await refresh()
        // 先等舊頁讀取結束，再回最新頁；撤銷後不能拿已失效 cursor 讓整份清單卡在 forbidden。
        if (['dispatch','revoke'].includes(action) && page.current?.workerId===input.workerId) {page.current=null;await refresh()}
      }; return true }
    catch (error) { if (!signal.aborted) save.fail((error as { code?: string }).code ?? 'request-failed'); return false }
    finally { mutating.current = false }
  }
  const dispatch = async (workerId: string, value: Dispatch) => {
    const key = `${workerId}:${value.kind}:${value.number}:${value.action}`
    const requestId = pending.current.get(key) ?? crypto.randomUUID()
    pending.current.set(key, requestId)
    // HTTP 回應遺失時保留 UUID；再次點同一件只查回原單，成功確認後才允許新意圖。
    if (await mutate('dispatch', { workerId, ...value, requestId })) pending.current.delete(key)
  }
  const changePage = async (worker:CloudWorker, older:boolean) => {
    if(paginating.current || mutating.current || !controller.current || controller.current.signal.aborted)return
    const signal=controller.current.signal;paginating.current=true;setPaging(true)
    try {
      // 自動 refresh 可能仍在途；等待同一個 promise 後才換 cursor，不能把較新頁覆蓋回舊頁。
      const values=await refresh()
      if(signal.aborted)return
      const fresh=values?.find(value=>value.id===worker.id)
      if(older && (!fresh?.hasMoreJobs || !fresh.jobs.length))return
      const previous=page.current, cursors=previous?.workerId===worker.id ? [...previous.cursors] : []
      // 在途 refresh 可能插入較新工作；用剛回來的頁尾，不能用點擊前的舊頁尾漏單。
      if(older)cursors.push(fresh!.jobs[fresh!.jobs.length-1].id);else cursors.pop()
      page.current=cursors.length ? {workerId:worker.id,cursors} : null
      if(await refresh()===undefined && !signal.aborted)page.current=previous
    } finally {paginating.current=false;if(!signal.aborted)setPaging(false)}
  }
  const pageNumber=(workerId:string)=>page.current?.workerId===workerId ? page.current.cursors.length+1 : 1
  return { workers, loading, loadError, paging, changePage, pageNumber, saveStatus: save.status, saveMessage: save.message, refresh, mutate, dispatch }
}
