/*
欄位沿用全站高對比邊框，讓照護者能清楚辨認可輸入範圍。
檔案用途：獨立於今日卡片補記過去已吃的事實，並按照護日更正真實 intake。
所在層：medication 表單元件；病人切換時由 key 清除草稿。
主要關聯：MedicationPage、medicationHold RPC；包含停用計畫與已減少的歷史劑次。
*/
import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
// 移除先前重構後不再使用的 common 匯入，滿足 tsc -b noUnusedLocals 嚴格型別檢查。
import { useI18n } from '../../../lib/i18n'
import { supabase } from '../../../lib/supabase'
import { careDateKey } from '../../../lib/careDay'
import { useSaveStatus } from '../../../hooks/useSaveStatus'
import { medicationSlotText } from '../../../lib/medication/medicationSchedule'
import { HOLD_TEXT, readMedicationHoldContext, readMedicationHoldRules, recordMedicationHoldAction } from '../../../lib/medication/medicationHold'
import type { MedicationIntakeLog } from '../../../types/database'

type HistoricalPlan = { id: string; medication_id: string; schedule_slot: string; active: boolean; as_needed: boolean; medications: { brand_name: string } }
export function MedicationHoldFacts({ patientId, onChanged }: { patientId: string; onChanged: (logs: MedicationIntakeLog[]) => void }) {
  const { text } = useI18n()
  const [plans, setPlans] = useState<HistoricalPlan[] | null>(null)
  const [form, setForm] = useState({ planId: '', dose: '1', at: '', reason: '', date: careDateKey() })
  const [logs, setLogs] = useState<MedicationIntakeLog[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const save = useSaveStatus()
  const mounted = useRef(true)
  const request = useRef<{ signature: string; id: string } | null>(null)
  useEffect(() => { mounted.current=true; return () => { mounted.current=false } }, [])
  useEffect(() => {
    let cancelled=false
    setFailed(false); setLogs(null)
    void (async () => {
      const rules = await readMedicationHoldRules(patientId)
      const medications = [...new Set(rules.map(rule => rule.medication_id))]
      if (!medications.length) { if (!cancelled) { setPlans([]); setLogs([]) }; return }
      const [planResult, logResult] = await Promise.all([
        supabase.from('medication_plans').select('id,medication_id,schedule_slot,active,as_needed,medications(brand_name)').eq('patient_id',patientId).in('medication_id',medications).eq('as_needed',false),
        supabase.from('medication_intake_logs').select('*').eq('patient_id',patientId).eq('care_date',form.date).in('medication_id',medications).order('taken_at'),
      ])
      if (planResult.error) throw planResult.error
      if (logResult.error) throw logResult.error
      // PRN 有獨立事件流程；無 plan_id 的舊 intake 則必須保留有原因的更正入口，不能因新增醫囑就鎖死歷史錯誤。
      const fixedPlans = (planResult.data as unknown as HistoricalPlan[]).filter(plan => !plan.as_needed)
      if (!cancelled) { setPlans(fixedPlans); setLogs(logResult.data.filter(log => log.plan_id === null || fixedPlans.some(plan => plan.id === log.plan_id))) }
    })().catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled=true }
  }, [patientId,form.date,revision])
  const submit = async (log?: MedicationIntakeLog) => {
    const plan = plans?.find(value => value.id === form.planId)
    if (save.status === 'saving' || !form.reason.trim() || (!log && (!plan || !form.at))) return
    save.begin()
    try {
      const medicationId=log?.medication_id ?? plan!.medication_id
      const input = { patientId, medicationId, action: log ? 'correction' as const : 'taken' as const, reason:form.reason,
        ...(log ? { intakeId:log.id } : { planId:plan!.id,doseNumber:Number(form.dose),actualAt:dayjs.tz(form.at,'Asia/Taipei').toISOString() }) }
      const signature=JSON.stringify(input)
      if (request.current?.signature!==signature) request.current={signature,id:crypto.randomUUID()}
      const context=await readMedicationHoldContext(patientId,medicationId)
      const event = await recordMedicationHoldAction(context,{...input,requestId:request.current.id})
      // 補昨天的事實也要對帳昨天的離線佇列，不能只刷新今日而留下永久待同步。
      const { data: confirmedLogs, error } = await supabase.from('medication_intake_logs').select('*').eq('patient_id',patientId).eq('care_date',event.care_date)
      if (error) throw error
      if (mounted.current) { save.succeed(text(HOLD_TEXT.saved)); setRevision(value=>value+1); onChanged(confirmedLogs ?? []) }
    } catch { if (mounted.current) save.fail(text(HOLD_TEXT.saveError)) }
  }
  if (failed) return <p role="alert" className="text-sm font-semibold text-red-700">{text(HOLD_TEXT.loadError)}</p>
  // 讀取期間不以浮動的無樣式「載入中」佔位造成版面跳動（CLS），未載入完成或無歷史計畫皆回傳 null
  if (!plans || !logs || !plans.length) return null
  return <details className="mt-4 rounded-2xl border bg-white p-4"><summary className="min-h-11 cursor-pointer py-2 font-bold">{text({ zh:'條件用藥：補記過去事實／更正紀錄',id:'Obat bersyarat: catat kejadian terdahulu / koreksi',en:'Conditional medication: past doses / corrections' })}</summary>
    <div className="space-y-3"><p>{text(HOLD_TEXT.factWarning)}</p>
      <label className="block">{text(HOLD_TEXT.reason)}<textarea className="w-full rounded-xl border-2 border-control-border p-2" maxLength={2000} value={form.reason} onChange={event=>setForm({...form,reason:event.target.value})}/></label>
      <label className="block">{text({ zh:'藥品／時段（包含停用的藥單）',id:'Obat / jadwal (termasuk resep nonaktif)',en:'Medication / time slot (including inactive plans)' })}<select className="w-full rounded-xl border-2 border-control-border p-2" value={form.planId} onChange={event=>setForm({...form,planId:event.target.value})}><option value="">{text(HOLD_TEXT.select)}</option>{plans.map(plan=><option key={plan.id} value={plan.id}>{plan.medications.brand_name} · {text(medicationSlotText(plan.schedule_slot))}</option>)}</select></label>
      <label className="block">{text({zh:'實際第幾劑（1–9）',id:'Nomor dosis sebenarnya (1–9)',en:'Actual dose number (1–9)'})}<input className="w-full rounded-xl border-2 border-control-border p-2" type="number" min={1} max={9} value={form.dose} onChange={event=>setForm({...form,dose:event.target.value})}/></label>
      <label className="block">{text(HOLD_TEXT.actualTime)}<input className="w-full rounded-xl border-2 border-control-border p-2" type="datetime-local" value={form.at} onChange={event=>setForm({...form,at:event.target.value})}/></label>
      <button type="button" className="btn-primary w-full" disabled={save.status==='saving'||!form.reason.trim()||!form.at||!form.planId} onClick={()=>void submit()}>{text(HOLD_TEXT.fact)}</button>
      <label className="block">{text({zh:'要更正的照護日期（04:00 換日）',id:'Tanggal perawatan untuk dikoreksi (berganti pukul 04:00)',en:'Care date to correct (day starts at 04:00)'})}<input className="w-full rounded-xl border-2 border-control-border p-2" type="date" value={form.date} onChange={event=>setForm({...form,date:event.target.value})}/></label>
      {logs.map(log=><div key={log.id} className="rounded-xl border p-3"><p>{log.medication_name} · {dayjs(log.taken_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} · {log.dose_number}</p><button type="button" className="min-h-11 underline" disabled={save.status==='saving'||!form.reason.trim()} onClick={()=>void submit(log)}>{text(HOLD_TEXT.correct)}</button></div>)}
      {save.message&&<p role="status">{save.message}</p>}
    </div>
  </details>
}
