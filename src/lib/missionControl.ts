/*
檔案用途：既有 Supabase session 到工程派工 RPC 的薄轉接層；不持有 Mac 或 CLI 登入。
所在層：src/lib；只由受限管理頁呼叫。
主要關聯：useMissionControl、cloud-model.ts、mission_control_admin RPC。
*/
import { supabase, supabasePublicKey, supabaseUrl } from './supabase'
import { cloudWorkers, object, uuid } from '../../packages/agent-mission-control/src/cloud-model'
export type { CloudWorker, CloudJob } from '../../packages/agent-mission-control/src/cloud-model'
async function rpc(action: string, input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let aborted: (() => void) | undefined
  // session refresh 可能不接收 abort；整個呼叫也要有期限，手機才不會永遠停在送出中。
  const deadline = new Promise<never>((_, reject) => {
    const fail = () => { controller.abort(); reject(new Error('mission-timeout')) }
    timer = setTimeout(fail, 10000); aborted = fail
    if (signal?.aborted) fail(); else signal?.addEventListener('abort', fail, { once: true })
  })
  const attempt = Promise.resolve(supabase.rpc('mission_control_admin', { p_action: action, p_input: input }).abortSignal(controller.signal)).then(({ data, error }) => {
    // 權限與網路失敗只回固定代碼，不能把 RPC 診斷／配對密鑰顯示在畫面。
    if (error) throw Object.assign(new Error('mission-request'), { code: error.code === '42501' ? 'forbidden' : 'request-failed' })
    return data
  })
  attempt.catch(() => {})
  try { return await Promise.race([attempt, deadline]) }
  finally { clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted) }
}
export async function missionRequest(action: string, input: Record<string, unknown> = {}, signal?: AbortSignal) {
  const value = object(await rpc(action, input, signal))
  if (['register', 'dispatch'].includes(action) ? !uuid(value.id) : value.ok !== true) throw new Error('mission-data')
  return value
}
// 每頁最多 100 張；cursor 只選位置，owner／worker 權限仍由 RPC 重驗，不能改成瀏覽器自行讀表。
export async function loadMissions(signal?: AbortSignal, page?: { workerId: string; beforeId: string }) {
  if (page && (!uuid(page.workerId) || !uuid(page.beforeId))) throw new Error('mission-data')
  return cloudWorkers(await rpc('load', page ?? {}, signal))
}
const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'"
// repo script 與解包後的檔案入口都能直接執行，不能假設使用者已全域安裝 bin。
// 這是公開連線參數，不是 worker 配對密鑰；真正派工權限仍由登入及 capability 決定。
export const missionSetupCommand = (standalone = false, locale: 'zh' | 'id' | 'en' = 'en') => `${standalone ? 'bun --no-env-file /path/to/package/src/cli.ts cloud-link --repo /path/to/your/repo' : 'bun --no-env-file run mission:control cloud-link'} --locale ${locale} --cloud-url ${quote(supabaseUrl)} --cloud-key ${quote(supabasePublicKey)}`
