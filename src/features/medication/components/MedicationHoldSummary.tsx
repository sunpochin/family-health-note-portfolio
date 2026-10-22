/*
檔案用途：唯讀藥單與列印共用的醫囑摘要，避免以最後讀數推論應否服藥。
所在層：medication 元件層；不查詢血壓、不產生給藥建議。
主要關聯：MedicationWeekView、MedicationDetailDialog、CareHandbookPage、RecordReport。
*/
import dayjs from 'dayjs'
import { useI18n } from '../../../lib/i18n'
import { medicationHoldSummary, type MedicationHoldRule } from '../../../lib/medication/medicationHold'
export function MedicationHoldSummary({ rule }: { rule?: MedicationHoldRule | null }) {
  const { text } = useI18n()
  if (!rule) return null
  return <span className="mt-2 block text-sm font-semibold text-slate-700">
    <span className="block">{text(medicationHoldSummary(rule))}</span>
    <span className="block">{text({ zh: `醫囑 ${rule.order_date}；生效 ${dayjs(rule.effective_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')}（台北）`, id: `Instruksi ${rule.order_date}; berlaku ${dayjs(rule.effective_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} (Taipei)`, en: `Instruction ${rule.order_date}; effective ${dayjs(rule.effective_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} (Taipei)` })}</span>
    <span className="block whitespace-pre-wrap">{rule.order_note}</span>
  </span>
}
