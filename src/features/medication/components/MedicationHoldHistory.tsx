/*
檔案用途：將當日暫停與更正歷史獨立列出，不混入實際服用趨勢。
所在層：medication 唯讀元件；依病人與期間重新掛載。
主要關聯：MedicationDoseHistoryPanel、medication_hold_events 不可變帳本。
*/
import { MedicationHoldSummary } from './MedicationHoldSummary'
import { VitalReading } from '../../vitals/components/VitalReading'
import { useEffect, useState } from 'react'
import dayjs from 'dayjs'
import { useI18n, common } from '../../../lib/i18n'
import { careDateKey } from '../../../lib/careDay'
import { HOLD_TEXT, readMedicationHoldEvents, type MedicationHoldEvent } from '../../../lib/medication/medicationHold'
export function MedicationHoldHistory({ patientId, days }: { patientId: string; days: number }) {
  const { text } = useI18n()
  const [events, setEvents] = useState<MedicationHoldEvent[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    readMedicationHoldEvents(patientId, careDateKey(dayjs().subtract(days - 1, 'day'))).then(result => { if (!cancelled) setEvents(result) }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [patientId, days])
  if (failed) return <p role="alert">{text(HOLD_TEXT.loadError)}</p>
  if (!events) return <p>{text(common.loading)}</p>
  return <section className="mt-4 space-y-2"><h3 className="font-bold">{text({ zh: '醫囑確認、暫停與更正（與服用次數分開）', id: 'Konfirmasi instruksi, penundaan, dan koreksi (terpisah dari jumlah dosis)', en: 'Instruction confirmations, holds and corrections (separate from dose counts)' })}</h3>
    {events.length === 0 && <p>{text({ zh: '此期間沒有醫囑確認或更正紀錄。', id: 'Tidak ada konfirmasi instruksi atau koreksi pada periode ini.', en: 'No instruction confirmations or corrections in this period.' })}</p>}
    {events.map(event => <article key={event.id} className="rounded-xl border p-3 text-sm">
      <p>{event.medication_name} · {event.rule_day} · {text(event.action === 'hold' ? HOLD_TEXT.held : event.action === 'release' ? HOLD_TEXT.release : event.action === 'correction' ? HOLD_TEXT.correct : HOLD_TEXT.recorded)}</p>
      <p>{event.reason}</p>
      {event.action === 'taken' && event.reason && <p>{text(HOLD_TEXT.factWarning)}</p>}
      {event.actual_at && <p>{text(HOLD_TEXT.actualTime)}: {dayjs(event.actual_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')}</p>}
      {/* 顯示事件保存的依據；不能用最新門檻或來源血壓覆蓋歷史。 */}
      <MedicationHoldSummary rule={event.rule_snapshot} />
      {event.reading_snapshot && <p><VitalReading {...event.reading_snapshot} showPulse={false} /> · {dayjs(event.reading_snapshot.measured_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')}</p>}
      <p>{dayjs(event.created_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} · {event.rule_snapshot?.order_note}</p>
    </article>)}
  </section>
}
