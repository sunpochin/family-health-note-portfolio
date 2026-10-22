/*
檔案用途：讓照護者勾選同一顆藥的固定時段，再依醫囑一次停用或調整劑量。
所在層：src/features/medication/components；排藥頁的批次操作面板。
主要關聯：useMedicationPlanBatchForm、MedicationAdminSection、共用劑量選單。
*/
import { useI18n } from '../../../lib/i18n'
import type { MedicationOption } from '../../../lib/medication/medicationAdmin'
import { DOSE_OPTIONS, validDoseAmount } from '../../../lib/medication/medicationAdminFormHelpers'
import { formatDoseAmountLocalized, formatMedicationLabel } from '../../../lib/medication/medications'
import { medicationSlotText } from '../../../lib/medication/medicationSchedule'
import type { useMedicationPlanBatchForm } from '../hooks/useMedicationPlanBatchForm'
import { MedicationSnapshotNameHeading } from './MedicationNameHeading'

export function MedicationPlanBatchForm({ batch, medicationById, patientName, disabled, nameEnglishFirst }: {
  batch: ReturnType<typeof useMedicationPlanBatchForm>
  medicationById: Map<string, MedicationOption>
  patientName: string
  disabled: boolean
  nameEnglishFirst: boolean
}) {
  const { locale, text } = useI18n()
  const medication = batch.group && medicationById.get(batch.group.medicationId)
  return <>
    {batch.dialog}
    {/* 送出反饋獨立於表單 disabled/載入狀態（Rule C）：即使寫入後重讀失敗或處於唯讀狀態，仍須明確顯示調藥結果或核對警示，避免吞掉錯誤導致照護者重複操作。 */}
    {(batch.status === 'ok' || batch.status === 'err') && <p role={batch.status === 'err' ? 'alert' : 'status'} className={`rounded-xl border p-3 text-sm ${batch.status === 'err' ? 'border-red-300 bg-red-50 text-red-900' : 'border-emerald-200 bg-white text-slate-900'}`}>{batch.message}</p>}
    {batch.group && medication && <div ref={batch.panelRef} tabIndex={-1} className="space-y-3 rounded-2xl border-2 border-emerald-700 bg-white p-4 outline-offset-4" aria-label={text({ zh: '整顆藥', id: 'Semua jadwal obat ini', en: 'All schedules for this medication' })}>
      <h3 className="text-lg font-black text-emerald-950">{text({ zh: '整顆藥', id: 'Semua jadwal obat ini', en: 'All schedules for this medication' })}</h3>
      <p className="text-sm font-bold">{patientName}</p>
      {/* 目錄允許缺本地化名稱；保留原始藥名，才不會在關閉英文優先後失去醒目的識別。 */}
      <MedicationSnapshotNameHeading englishName={formatMedicationLabel(medication.brand_name, medication.strength_mg, medication.strength_label)} localizedName={medication.brand_name_zh || medication.brand_name} englishFirst={nameEnglishFirst} />
      <p className="text-sm text-slate-700">{text({ zh: '請依最新醫囑勾選要變更的時段；未勾選的時段維持原樣。全選時若固定時段清單有變更，請重新核對。', id: 'Pilih jadwal yang akan diubah sesuai resep terbaru. Jadwal yang tidak dipilih tetap sama. Jika semua dipilih dan daftar jadwal tetap berubah, periksa kembali.', en: 'Select schedules to change according to the latest prescription. Unselected schedules stay the same. When all are selected, review again if the scheduled times change.' })}</p>
      <fieldset disabled={disabled} className="space-y-2">
        <legend className="text-sm font-bold">{text({ zh: '選擇時段（預設全選）', id: 'Pilih jadwal (awalnya semua dipilih)', en: 'Select schedules (all selected by default)' })}</legend>
        {batch.group.plans.map(plan => <label key={plan.id} className="flex min-h-11 items-center gap-3 rounded-xl border border-slate-200 p-3 text-sm">
          <input type="checkbox" checked={batch.selectedIds.includes(plan.id)} onChange={() => batch.toggle(plan.id)} className="h-5 w-5 shrink-0 accent-emerald-700" />
          <span>{text(medicationSlotText(plan.schedule_slot))} · {formatDoseAmountLocalized(plan.dose_amount, medication.dosage_form, locale)}</span>
        </label>)}
      </fieldset>
      <label className="block space-y-1 text-sm font-bold">
        <span>{text({ zh: '勾選時段的新單次劑量', id: 'Dosis baru per kali untuk jadwal terpilih', en: 'New dose per administration for selected schedules' })}</span>
        {/* 原生欄位採共用高對比邊框，讓視力較弱的照護者能辨識可輸入範圍。 */}
        <select value={batch.dose} disabled={disabled} onChange={event => batch.setDose(event.target.value)} className="min-h-11 w-full rounded-xl border-2 border-control-border bg-white px-3 py-2">
          <option value="">{text({ zh: '請選擇劑量（停用不需選）', id: 'Pilih dosis (tidak perlu untuk penghentian)', en: 'Select a dose (not needed when stopping)' })}</option>
          {DOSE_OPTIONS.map(amount => <option key={amount} value={amount}>{formatDoseAmountLocalized(amount, medication.dosage_form, locale)}</option>)}
        </select>
      </label>
      <label className="block space-y-1 text-sm font-bold">
        <span>{text({ zh: '變更原因（選填）', id: 'Alasan perubahan (opsional)', en: 'Reason for change (optional)' })}</span>
        <textarea value={batch.reason} disabled={disabled} onChange={event => batch.setReason(event.target.value)} maxLength={2000} rows={2} className="w-full rounded-xl border-2 border-control-border p-3" />
      </label>
      <p className="text-sm text-slate-700">{text({ zh: '立即生效；今天已記錄的服藥不受影響。送出前會再逐時段確認。', id: 'Berlaku segera; catatan obat yang sudah diminum hari ini tidak berubah. Setiap jadwal akan dikonfirmasi sebelum dikirim.', en: 'Takes effect immediately; today’s recorded doses are unchanged. Review each schedule before submitting.' })}</p>
      {/* 手機改用直排並保留 44px 觸控高度，讓停用與調劑量兩個不同動作不易誤按。 */}
      <div className="flex flex-col gap-2 sm:flex-row">
        <button type="button" disabled={disabled || !batch.selectedIds.length || !validDoseAmount(batch.dose)} onClick={() => void batch.submit('update', patientName)} className="min-h-11 rounded-xl bg-emerald-700 px-4 py-3 text-sm font-bold text-white disabled:opacity-50">{text({ zh: '調整勾選時段劑量', id: 'Ubah dosis jadwal terpilih', en: 'Change dose for selected schedules' })}</button>
        <button type="button" disabled={disabled || !batch.selectedIds.length} onClick={() => void batch.submit('deactivate', patientName)} className="min-h-11 rounded-xl border border-red-300 px-4 py-3 text-sm font-bold text-red-700 disabled:opacity-50">{text({ zh: '停用勾選時段', id: 'Hentikan jadwal terpilih', en: 'Stop selected schedules' })}</button>
        <button type="button" disabled={disabled} onClick={batch.close} className="min-h-11 rounded-xl border border-slate-300 px-4 py-3 text-sm font-bold disabled:opacity-50">{text({ zh: '取消', id: 'Batal', en: 'Cancel' })}</button>
      </div>
    </div>}
  </>
}
