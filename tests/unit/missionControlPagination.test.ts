/*
檔案用途：以真 hook／元件驗證舊工作可取消、慢讀取及翻頁不重複派工。
所在層：tests/unit；合成 203 張單與延遲 RPC，不接模型、GitHub 或照護資料。
主要關聯：MissionControlPanel、useMissionControl、Issue #1303。
*/
import { beforeEach, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'
import type { CloudJob, CloudWorker } from '../../src/lib/missionControl'
type Page = {workerId:string;beforeId:string}
const workerId='61000000-0000-4000-8000-000000000001', at='2026-10-14T00:00:00Z'
const jobId=(number:number)=>`62000000-0000-4000-8000-${String(number).padStart(12,'0')}`
const job=(number:number):CloudJob=>({id:jobId(number),item_number:number,kind:'issue',action:'implement',title:`Paged ${number}`,status:number===1?'claimed':'finished',cancel_requested:false,retry_requested:false,summary:'',reason:null,pr_url:null,created_at:at,updated_at:at})
let jobs:CloudJob[]=[], failPage=false, loseOnce=false, revoked=false
let extraWorkers:CloudWorker[]=[]
let nextLoad:((signal?:AbortSignal,page?:Page)=>Promise<CloudWorker[]>)|undefined
const reads:(Page|undefined)[]=[], submitted:{action:string;input:Record<string,unknown>}[]=[]
function snapshot(page?:Page):CloudWorker[] {
  if(revoked){if(page)throw Object.assign(new Error('forbidden'),{code:'forbidden'});return extraWorkers}
  const start=page ? jobs.findIndex(value=>value.id===page.beforeId)+1 : 0
  return [{id:workerId,repository:'example/fixture',base:'staging',name:'Fixture Mac',paused:false,localPaused:false,heartbeatAt:new Date().toISOString(),syncedAt:at,hasMoreJobs:jobs.length>start+100,jobs:jobs.slice(start,start+100).map(value=>({...value})),items:[{number:9000,kind:'pr',title:'Fixture PR',state:'open',url:'https://github.com/example/fixture/pull/9000',labels:[],updatedAt:at}]},...extraWorkers]
}
mock.module('../../src/lib/missionControl',()=>({
  loadMissions:async(signal?:AbortSignal,page?:Page)=>{reads.push(page?{...page}:undefined);const delayed=nextLoad;nextLoad=undefined;if(delayed)return delayed(signal,page);if(failPage&&page)throw new Error('offline');return snapshot(page)},
  missionRequest:async(action:string,input:Record<string,unknown>)=>{submitted.push({action,input});if(loseOnce){loseOnce=false;throw new Error('response lost')}if(action==='cancel')jobs=jobs.map(value=>value.id===input.jobId?{...value,cancel_requested:true}:value);if(action==='revoke')revoked=true;return {ok:true}},
  missionSetupCommand:()=> 'fixture-command',
}))
installReactHookHarness()
const {MissionControlPanel}=await import('../../src/features/system-admin/components/MissionControlPanel')
const {missionCopy:c}=await import('../../src/features/system-admin/missionControlCopy')
const tick=()=>new Promise(resolve=>setTimeout(resolve,0))
const button=(tree:unknown,label:string)=>findAll(tree,el=>el.type==='button'&&textContent(el)===label)[0]
const context=(locale:'zh'|'id'|'en')=>({locale,setLocale:()=>{}})
const click=(view:ReturnType<typeof renderHook>,label:string)=>view.act(()=>{(button(view.current,label).props.onClick as ()=>void)()})
beforeEach(()=>{jobs=Array.from({length:203},(_,i)=>job(203-i));failPage=false;loseOnce=false;revoked=false;extraWorkers=[];nextLoad=undefined;reads.length=0;submitted.length=0})

test.each(['zh','id','en'] as const)('old claimed work remains reachable and cancellable in the selected locale (%s)',async locale=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context(locale)});await tick()
  expect(button(view.current,c.newerJobs[locale]).props.disabled).toBe(true)
  click(view,c.olderJobs[locale]);await tick();click(view,c.olderJobs[locale]);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage[locale]} 3`)
  expect(textContent(view.current)).toContain('Paged 1')
  expect(button(view.current,c.olderJobs[locale]).props.disabled).toBe(true)
  click(view,c.cancel[locale]);await tick()
  expect(submitted[0]).toEqual({action:'cancel',input:{workerId,jobId:jobId(1)}})
  expect(textContent(view.current)).toContain(c.cancelPending[locale])
  expect(textContent(view.current)).toContain(`${c.jobPage[locale]} 3`)
  click(view,c.newerJobs[locale]);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage[locale]} 2`)
  view.unmount()
})

test('an insertion during the in-flight read cannot skip the old page boundary',async()=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick()
  let release!:(values:CloudWorker[])=>void
  nextLoad=()=>new Promise(resolve=>{release=resolve})
  click(view,c.refresh.zh);await tick();click(view,c.olderJobs.zh);await tick()
  expect(reads).toHaveLength(2)
  expect(button(view.current,c.dispatch.zh).props.disabled).toBe(true)
  jobs.unshift(job(204));release(snapshot());await tick()
  expect(reads[2]).toEqual({workerId,beforeId:jobId(105)})
  expect(textContent(view.current)).toContain('Paged 104')
  expect(textContent(view.current)).not.toContain('Paged 105')
  view.unmount()
})

test('a failed page read keeps the shown rows and cursor together and can recover',async()=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick();failPage=true
  click(view,c.olderJobs.zh);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 1`)
  expect(textContent(view.current)).toContain('Paged 203')
  expect(textContent(view.current)).toContain(c.loadError.zh)
  failPage=false;click(view,c.olderJobs.zh);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 2`)
  expect(textContent(view.current)).toContain('Paged 103')
  view.unmount()
})

test('paging preserves the UUID for an unacknowledged dispatch and a confirmed dispatch returns to the latest page',async()=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick();loseOnce=true
  click(view,c.dispatch.zh);await tick();click(view,c.olderJobs.zh);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 2`)
  click(view,c.dispatch.zh);await tick()
  expect(submitted).toHaveLength(2);expect(submitted[1].input.requestId).toBe(submitted[0].input.requestId)
  expect(reads[reads.length-1]).toBeUndefined()
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 1`)
  view.unmount()
})

test('revoking the paged worker drops its invalid cursor before loading the remaining connections',async()=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick();click(view,c.olderJobs.zh);await tick()
  click(view,c.revoke.zh);await tick()
  expect(submitted[0]).toEqual({action:'revoke',input:{workerId}})
  expect(reads[reads.length-1]).toBeUndefined()
  expect(textContent(view.current)).toContain(c.empty.zh)
  expect(textContent(view.current)).not.toContain(c.loadError.zh)
  view.unmount()
})

test('unmount aborts a late page read without requesting another page',async()=>{
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick()
  let release!:(values:CloudWorker[])=>void, signal:AbortSignal|undefined
  nextLoad=value=>{signal=value;return new Promise(resolve=>{release=resolve})}
  click(view,c.olderJobs.zh);await tick();view.unmount()
  expect(signal?.aborted).toBe(true);release(snapshot());await tick()
  expect(reads).toHaveLength(2);expect(submitted).toHaveLength(0)
})

// 別台手機撤銷深頁連接時，不能讓它的失效 cursor 鎖住其他仍有效的電腦。
test('an externally revoked deep-page connection recovers the latest owner list without losing another unknown dispatch UUID',async()=>{
  const other={...snapshot()[0],id:'61000000-0000-4000-8000-000000000002',name:'Fixture B',jobs:[],hasMoreJobs:false}
  extraWorkers=[other]
  const view=renderHook(()=>MissionControlPanel(),{defaultContext:context('zh')});await tick()
  const select=(id:string)=>view.act(()=>{const element=findAll(view.current,el=>el.type==='select'&&Array.isArray(el.props.children)&&el.props.children.some((child:{props?:{value?:string}})=>child?.props?.value===id))[0];(element.props.onChange as (event:unknown)=>void)({target:{value:id}})})
  select(other.id);loseOnce=true;click(view,c.dispatch.zh);await tick();select(workerId)
  click(view,c.olderJobs.zh);await tick();click(view,c.olderJobs.zh);await tick()
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 3`)
  revoked=true;click(view,c.refresh.zh);await tick()
  expect(reads[reads.length-1]).toBeUndefined()
  expect(textContent(view.current)).not.toContain(c.forbidden.zh)
  expect(textContent(view.current)).toContain(`${c.jobPage.zh} 1`)
  expect(button(view.current,c.dispatch.zh).props.disabled).toBe(false)
  click(view,c.dispatch.zh);await tick()
  expect(submitted).toHaveLength(2);expect(submitted[0].input.workerId).toBe(other.id);expect(submitted[1].input.requestId).toBe(submitted[0].input.requestId)
  view.unmount()
})
