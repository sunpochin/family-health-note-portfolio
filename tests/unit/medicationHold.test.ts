/*
檔案用途：驗證暫停涵蓋的照護日與未回報語意，包含午夜和更正。
所在層：Bun 單元測試；只用虛構醫囑與固定時間。
主要關聯：medicationHold、careAnomalySignals；資料庫比較與授權另由 SQL 實測。
*/
import { describe, expect, test, mock, spyOn } from 'bun:test'
const rpc = mock(async () => ({ data: {} as MedicationHoldContext, error: null }))
mock.module('../../src/lib/supabase', () => ({supabase:{rpc}}))
import { heldMedicationCareDates, medicationHoldSummary, medicationHoldCoversCareDate, medicationHoldIsCurrent, medicationHoldNow, medicationServerNow, readMedicationHoldContext, resolveMedicationHoldSaveError, type MedicationHoldContext, type MedicationHoldEvent, type MedicationHoldRule } from '../../src/lib/medication/medicationHold'
import { detectMissedMedicationSignal } from '../../src/lib/careAnomalySignals'
const hold = (extra: Partial<MedicationHoldEvent> = {}) => ({ id:'hold', action:'hold',patient_id:'patient-a',medication_id:'med-a', starts_at:'2026-10-10T00:00:00+08:00', ends_at:'2026-10-11T00:00:00+08:00', created_at:'2026-10-10T01:00:00+08:00',care_date:'2026-10-09', ...extra }) as MedicationHoldEvent
describe('prescribed hold reporting', () => {
  const plan = (medication_id='med-a', extra={}) => ({patient_id:'patient-a',medication_id,created_at:'2026-10-01T00:00:00Z',active:true,as_needed:false,...extra})
  const fullDay = (extra: Partial<MedicationHoldEvent>={}) => hold({starts_at:'2026-10-10T04:00:00+08:00',ends_at:'2026-10-11T04:00:00+08:00',...extra})
  const dates = (events: MedicationHoldEvent[], plans=[plan()]) => heldMedicationCareDates(events,plans,'patient-a')
  const counts=[{date:'2026-10-09',value:0},{date:'2026-10-10',value:0},{date:'2026-10-11',value:0}]
  test('holding A never suppresses missing B/C; all fixed medications held may exempt', () => {
    const plans=[plan(),plan('med-b'),plan('med-c')]
    const partial=dates([fullDay()],plans)
    expect(detectMissedMedicationSignal(counts,1,true,null,partial)).not.toBeNull()
    const all=dates(['med-a','med-b','med-c'].map(medication_id=>fullDay({id:medication_id,medication_id})),plans)
    expect([...all]).toEqual(['2026-10-10'])
    expect(detectMissedMedicationSignal(counts,1,true,null,all)).toBeNull()
    expect(counts[1].value).toBe(0)
    expect(detectMissedMedicationSignal(counts.map(point=>({...point,value:1})),1,true,null,partial)).toBeNull()
  })
  test('partial care days are not exempt; contiguous same-medication holds can cover one day', () => {
    expect(dates([hold()]).size).toBe(0)
    expect([...dates([hold(),hold({id:'next',starts_at:'2026-10-11T00:00:00+08:00',ends_at:'2026-10-12T00:00:00+08:00'})])]).toEqual(['2026-10-10'])
  })
  test('unrelated patients and future/PRN/inactive plans cannot alter the exemption', () => {
    expect(dates([fullDay({patient_id:'patient-b'})]).size).toBe(0)
    expect([...dates([fullDay()],[plan(),plan('med-b',{as_needed:true}),plan('med-c',{active:false}),plan('med-d',{created_at:'2026-10-12T00:00:00Z'}),plan('med-e',{patient_id:'patient-b'})])]).toEqual(['2026-10-10'])
    expect(dates([fullDay()],[]).size).toBe(0)
  })
  test('explicit release removes the hold, unrelated correction does not', () => {
    expect(dates([fullDay(),hold({id:'release',action:'release',related_event_id:'hold'})]).size).toBe(0)
    expect(dates([fullDay(),hold({id:'fix',action:'correction'})]).size).toBe(1)
  })
  test('all locales explicitly retain metric, equality, validity and day boundary', () => {
    const rule={metric:'diastolic',comparison:'gte',threshold:65,max_age_minutes:45,day_start_hour:0,enabled:true} as MedicationHoldRule
    const summary=medicationHoldSummary(rule)
    for(const value of Object.values(summary)) { expect(value).toContain('≥ 65'); expect(value).toContain('45'); expect(value).toContain('00:00') }
    expect(summary.zh).toContain('舒張壓'); expect(summary.id).toContain('diastolik'); expect(summary.en).toContain('diastolic')
  })
  test('resolveMedicationHoldSaveError maps database exceptions to precise trilingual messages', () => {
    const invalidTime = resolveMedicationHoldSaveError(new Error('medication_hold_invalid_time'))
    expect(invalidTime.zh).toContain('不可早於目前時間')
    expect(invalidTime.id).toContain('tidak boleh mendahului')
    expect(invalidTime.en).toContain('cannot be earlier than current time')

    const changed = resolveMedicationHoldSaveError({ message: 'medication_hold_changed' })
    expect(changed.zh).toContain('已被更新')
    expect(changed.id).toContain('telah diperbarui')
    expect(changed.en).toContain('has been updated')

    const permission = resolveMedicationHoldSaveError({ message: 'medication_hold_permission' })
    expect(permission.zh).toContain('權限')

    const planRequired = resolveMedicationHoldSaveError({ message: 'medication_hold_fixed_plan_required' })
    expect(planRequired.zh).toContain('固定')

    const fallback = resolveMedicationHoldSaveError(new Error('network error'))
    expect(fallback.zh).toContain('尚未確認儲存成功')
  })
})

// 以伺服器時間為準，刻意模擬手機被改日期；不能把昨天睡前劑次誤算成今日完成。
async function contextAt(hour: number, serverNow = '2026-10-10T09:00:00+08:00') {
  const start = `2026-10-10T${String(hour).padStart(2, '0')}:00:00+08:00`
  const end = `2026-10-11T${String(hour).padStart(2, '0')}:00:00+08:00`
  rpc.mockResolvedValueOnce({data: {state:'held', server_now:serverNow, starts_at:start, ends_at:end, hold:hold({starts_at:start, ends_at:end})} as MedicationHoldContext, error:null})
  return readMedicationHoldContext('fixture-patient', 'fixture-medication')
}
describe('hold clock and dose day projection', () => {
  test('a response delayed past the boundary cannot revive yesterday’s hold', async () => {
    const monotonic = spyOn(performance, 'now').mockReturnValue(100)
    try {
      rpc.mockImplementationOnce(async () => {
        monotonic.mockReturnValue(2100)
        return {data:{state:'held',server_now:'2026-10-11T03:59:59+08:00',hold:hold({starts_at:'2026-10-10T04:00:00+08:00',ends_at:'2026-10-11T04:00:00+08:00'})} as MedicationHoldContext,error:null}
      })
      const context = await readMedicationHoldContext('fixture-patient', 'fixture-medication')
      expect(medicationHoldIsCurrent(context)).toBe(false)
      // 請求延遲可提前結束暫停，但不能把服用事實提前到明天。
      expect(medicationServerNow(context)).toBe(Date.parse('2026-10-11T03:59:59+08:00'))
      monotonic.mockReturnValue(2600)
      expect(medicationServerNow(context)).toBe(Date.parse('2026-10-11T03:59:59.500+08:00'))
      expect(medicationHoldCoversCareDate(context, '2026-10-10')).toBe(false)
    } finally { monotonic.mockRestore() }
  })
  test('midnight hold does not complete yesterday or an ambiguous overnight care day', async () => {
    const context = await contextAt(0, '2026-10-10T00:30:00+08:00')
    expect(medicationHoldIsCurrent(context)).toBe(true)
    expect(medicationHoldCoversCareDate(context, '2026-10-09')).toBe(false)
    expect(medicationHoldCoversCareDate(context, '2026-10-10')).toBe(false)
  })
  test('04:00 hold covers only the matching care day, independent of a newer rule', async () => {
    const context = await contextAt(4)
    context.rule = {day_start_hour:18} as MedicationHoldRule
    expect(medicationHoldCoversCareDate(context, '2026-10-10')).toBe(true)
    expect(medicationHoldCoversCareDate(context, '2026-10-09')).toBe(false)
    expect(medicationHoldCoversCareDate(context, '2026-10-11')).toBe(false)
  })
  test('18:00 custom boundary never guesses meal or bedtime hours', async () => {
    const context = await contextAt(18, '2026-10-10T19:00:00+08:00')
    expect(medicationHoldIsCurrent(context)).toBe(true)
    expect(medicationHoldCoversCareDate(context, '2026-10-10')).toBe(false)
    expect(medicationHoldCoversCareDate(context, '2026-10-11')).toBe(false)
  })
  test('clock skew cannot end or prolong a hold; server interval is half-open', async () => {
    const monotonic = spyOn(performance, 'now').mockReturnValue(100)
    const calendar = spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-12T00:00:00Z'))
    try {
      const context = await contextAt(4, '2026-10-10T04:00:00+08:00')
      expect(medicationHoldIsCurrent(context)).toBe(true)
      expect(medicationHoldNow(context)).toBe(Date.parse(context.server_now))
      calendar.mockReturnValue(Date.parse('2026-10-08T00:00:00Z'))
      monotonic.mockReturnValue(100 + 86400000)
      expect(medicationHoldIsCurrent(context)).toBe(false)
      expect(medicationHoldCoversCareDate(context, '2026-10-10')).toBe(false)
      expect(medicationHoldIsCurrent(await contextAt(4, '2026-10-10T03:59:59+08:00'))).toBe(false)
    } finally { monotonic.mockRestore(); calendar.mockRestore() }
  })
})
