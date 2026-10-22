/*
檔案用途：網站 RPC 轉接層的整體中止期限與診斷遮蔽；SDK token refresh 卡住也能結束。
所在層：tests/unit；合成 query 不連任何外部服務。
主要關聯：src/lib/missionControl.ts、useMissionControl。
*/
import { expect, mock, test } from 'bun:test'
let query: Promise<{ data: unknown; error: { code: string; message: string } | null }> = Promise.resolve({ data: {}, error: null })
let lastSignal: AbortSignal | undefined
const calls: {name:string;args:{p_action:string;p_input:Record<string,unknown>}}[]=[]
mock.module('../../src/lib/supabase', () => ({ supabaseUrl: 'https://example.supabase.co', supabasePublicKey: 'sb_publishable_fixture', supabase: { rpc: (name:string,args:{p_action:string;p_input:Record<string,unknown>}) => {calls.push({name,args});return { abortSignal: (signal: AbortSignal) => { lastSignal = signal; return query } }} } }))
const { missionRequest, loadMissions, missionSetupCommand } = await import('../../src/lib/missionControl')
test('external abort ends a hung SDK query without waiting for fetch', async () => {
  query = new Promise(() => {})
  const controller = new AbortController()
  const pending = missionRequest('pause', {}, controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('mission-timeout')
  expect(lastSignal?.aborted).toBe(true)
})
test('RPC diagnostic text and pairing material never enter frontend errors', async () => {
  query = Promise.resolve({ data: null, error: { code: '42501', message: 'private pairing details' } })
  try { await missionRequest('register', { token: 'synthetic' }); throw new Error('unexpected success') }
  catch (error) { expect(String(error)).not.toContain('private pairing details'); expect((error as { code?: string }).code).toBe('forbidden') }
})

// cursor 是查詢條件而非新權限；合法欄位照送，錯誤 UUID 在 SDK 前就拒絕。
test('page cursor reaches the fixed load RPC and invalid cursor never starts a request',async()=>{
  query=Promise.resolve({data:{workers:[]},error:null});calls.length=0
  const page={workerId:'61000000-0000-4000-8000-000000000001',beforeId:'62000000-0000-4000-8000-000000000001'}
  expect(await loadMissions(undefined,page)).toEqual([])
  expect(calls[0]).toEqual({name:'mission_control_admin',args:{p_action:'load',p_input:page}})
  await expect(loadMissions(undefined,{...page,beforeId:'invalid'})).rejects.toThrow('mission-data')
  expect(calls).toHaveLength(1)
})

test.each(['zh','id','en'] as const)('website setup command carries the selected locale (%s)',locale=>{
  expect(missionSetupCommand(false,locale)).toContain(`run mission:control cloud-link --locale ${locale}`)
  expect(missionSetupCommand(true,locale)).toContain(`cloud-link --repo /path/to/your/repo --locale ${locale}`)
})
