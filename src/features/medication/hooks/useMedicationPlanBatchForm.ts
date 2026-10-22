/*
檔案用途：管理整顆藥的勾選、確認與一次批次送出，避免只停掉部分時段。
所在層：src/features/medication/hooks；排藥表單的獨立狀態容器。
主要關聯：MedicationPlanBatchForm、useMedicationAdminForm、applyMedicationPlanBatchChange。
*/
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useConfirm } from '../../../hooks/useConfirm'
import { useSaveStatus } from '../../../hooks/useSaveStatus'
import { useI18n } from '../../../lib/i18n'
import { applyMedicationPlanBatchChange, type AdminMedicationPlan, type MedicationOption, type MedicationPlanExpectedSnapshot } from '../../../lib/medication/medicationAdmin'
import { medicationErrorStatus, validDoseAmount } from '../../../lib/medication/medicationAdminFormHelpers'
import { groupPlansByMedication, type MedicationPlanGroup } from '../../../lib/medication/medicationPlanGroups'
import { formatDoseAmountLocalized, formatMedicationLabel } from '../../../lib/medication/medications'
import { medicationSlotText } from '../../../lib/medication/medicationSchedule'

interface BatchFormArgs {
  patientId: string
  plans: AdminMedicationPlan[]
  medicationById: Map<string, MedicationOption>
  canEditSubject: boolean
  saving: boolean
  setSaving: (value: boolean) => void
  refresh: () => Promise<unknown>
  onMedicationPlanChanged?: () => void
}

export function useMedicationPlanBatchForm({ patientId, plans, medicationById, canEditSubject, saving, setSaving, refresh, onMedicationPlanChanged }: BatchFormArgs) {
  const { locale, text } = useI18n()
  const { confirm, dialog } = useConfirm()
  const save = useSaveStatus()
  const [group, setGroup] = useState<MedicationPlanGroup | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  // 不猜醫師的新劑量；照護者必須明確選一次，停用則不需要劑量。
  const [dose, setDose] = useState('')
  const [reason, setReason] = useState('')
  const panelRef = useRef<HTMLDivElement>(null)
  const inFlight = useRef(false)
  const epoch = useRef(0)
  const latest = useRef({ patientId, plans, canEditSubject })
  const groups = useMemo(() => groupPlansByMedication(plans).filter(item => item.patientId === patientId), [plans, patientId])
  const resetSave = save.reset

  useLayoutEffect(() => { latest.current = { patientId, plans, canEditSubject } }, [patientId, plans, canEditSubject])
  useLayoutEffect(() => {
    // 另一筆寫入開始後，舊批次結果不能冒充新操作的結果；重讀失敗只會停用表單，不會清掉核對警示。
    if (saving && !inFlight.current) resetSave()
  }, [saving, resetSave])
  useEffect(() => {
    // 頁面用 patientId 作 key；卸載或切換病人後，舊確認／請求不能再送出或回填新畫面。
    epoch.current += 1
    return () => { epoch.current += 1 }
  }, [patientId])
  useEffect(() => {
    if (!group) return
    panelRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' })
    panelRef.current?.focus()
  }, [group])

  const open = (medicationId: string) => {
    if (saving || inFlight.current || !canEditSubject) return
    const next = groups.find(item => item.medicationId === medicationId)
    if (!next || !medicationById.has(medicationId)) return
    setGroup(next)
    setSelectedIds(next.plans.map(plan => plan.id))
    setDose('')
    setReason('')
    save.reset()
  }
  const close = () => { if (!inFlight.current) { setGroup(null); save.reset() } }
  const toggle = (id: string) => {
    if (inFlight.current) return
    setSelectedIds(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])
  }

  const submit = async (action: 'update' | 'deactivate', patientName: string) => {
    if (saving || inFlight.current || !canEditSubject || !group || group.patientId !== patientId) return
    const selected = group.plans.filter(plan => selectedIds.includes(plan.id))
    if (!selected.length || (action === 'update' && !validDoseAmount(dose))) {
      save.fail(text({ zh: '請至少勾選一個時段，並選擇有效劑量後再送出。', id: 'Pilih setidaknya satu jadwal dan dosis yang sesuai sebelum mengirim.', en: 'Select at least one schedule and a valid dose before submitting.' }))
      return
    }
    const medication = medicationById.get(group.medicationId)
    if (!medication) return
    const generation = epoch.current
    const isCurrent = () => generation === epoch.current && latest.current.patientId === patientId
    const expectAllSchedules = selected.length === group.plans.length
    // 確認前後核對本機清單，避免其他操作重讀後仍以舊劑量摘要送出；跨裝置遠端變更則由 RPC 鎖列比對 expectedPlans。
    const matchesCurrentPlans = () => {
      const currentGroup = latest.current.plans.filter(now => now.patient_id === patientId && now.medication_id === group.medicationId && now.active && !now.as_needed)
      // 全選代表這顆藥目前所有固定時段；若多出一筆，也必須重新確認，不能停掉舊時段卻留下未看見的新醫囑。
      return latest.current.canEditSubject && (!expectAllSchedules || currentGroup.length === selected.length) &&
        selected.every(before => currentGroup.some(now => now.id === before.id && now.schedule_slot === before.schedule_slot &&
          now.dose_amount === before.dose_amount && now.dose_count === before.dose_count))
    }
    const changedList = () => new Error('Medication plan batch does not match this medication')
    const stopped = text({ zh: '停用', id: 'Dihentikan', en: 'Stopped' })
    const summary = selected.map(plan => {
      const before = formatDoseAmountLocalized(plan.dose_amount, medication.dosage_form, locale)
      const after = action === 'deactivate' ? stopped : formatDoseAmountLocalized(Number(dose), medication.dosage_form, locale)
      return `${text(medicationSlotText(plan.schedule_slot))}：${before} → ${after}`
    }).join('\n')
    const actionLabel = text(action === 'deactivate'
      ? { zh: '停用勾選時段', id: 'Hentikan jadwal terpilih', en: 'Stop selected schedules' }
      : { zh: '調整勾選時段劑量', id: 'Ubah dosis jadwal terpilih', en: 'Change dose for selected schedules' })
    // 確認視窗開啟前就鎖定，快速連點也只會產生一個確認與一個 RPC。
    inFlight.current = true
    setSaving(true)
    save.begin()
    try {
      if (!matchesCurrentPlans()) throw changedList()
      const accepted = await confirm([
        patientName, formatMedicationLabel(medication.brand_name, medication.strength_mg, medication.strength_label),
        actionLabel, summary,
        text(expectAllSchedules
          ? { zh: '立即生效；今天已記錄的服藥不受影響。已全選固定時段；若時段清單有變更，這次變更會被取消，請重新核對。', id: 'Berlaku segera; catatan obat yang sudah diminum hari ini tidak berubah. Semua jadwal tetap telah dipilih. Jika daftar jadwal berubah, perubahan ini dibatalkan; periksa kembali.', en: 'Takes effect immediately; today’s recorded doses are unchanged. All scheduled times are selected. If the schedule list changes, this change will be cancelled; review it again.' }
          : { zh: '立即生效；今天已記錄的服藥不受影響。未勾選的時段維持原樣。', id: 'Berlaku segera; catatan obat yang sudah diminum hari ini tidak berubah. Jadwal yang tidak dipilih tetap sama.', en: 'Takes effect immediately; today’s recorded doses are unchanged. Unselected schedules stay the same.' }),
        reason.trim(),
      ].filter(Boolean).join('\n\n'), { danger: action === 'deactivate' })
      if (!isCurrent()) return
      if (!accepted) { save.reset(); return }
      if (!matchesCurrentPlans()) throw changedList()
      // 將當前確認的各時段醫囑快照帶入 RPC，在資料庫取列鎖時進行樂觀比對，防止覆寫其他照護者的新醫囑。
      const expectedPlans: MedicationPlanExpectedSnapshot[] = selected.map(plan => ({
        id: plan.id,
        schedule_slot: plan.schedule_slot,
        dose_amount: Number(plan.dose_amount),
        dose_count: Number(plan.dose_count ?? 1),
        active: plan.active !== false,
        as_needed: Boolean(plan.as_needed),
      }))
      const count = await applyMedicationPlanBatchChange({ action, patientId, medicationId: group.medicationId,
        planIds: selected.map(plan => plan.id), expectedPlans, expectAllSchedules, ...(action === 'update' ? { doseAmount: Number(dose) } : {}), reason })
      // 送出後可切回打卡頁；即使編輯器已卸載，父頁仍須重讀，否則會繼續顯示舊的用藥指示。
      onMedicationPlanChanged?.()
      if (!isCurrent()) return
      setGroup(null)
      const message = text(count === 0
        ? { zh: '勾選時段的劑量已相同，沒有變更。', id: 'Dosis jadwal terpilih sudah sama. Tidak ada perubahan.', en: 'The selected schedules already have this dose. Nothing changed.' }
        : { zh: `已完成 ${count} 個時段的變更。`, id: `Perubahan ${count} jadwal selesai.`, en: `Updated ${count} schedules.` })
      try {
        await refresh()
        if (isCurrent()) save.succeed(message)
      } catch {
        // 寫入成功與讀取失敗分開，不能暗示使用者再送一次已經完成的調藥。
        if (isCurrent()) save.fail(`${message} ${text({ zh: '但藥單重新讀取失敗，請重新整理後核對。', id: 'Namun daftar obat gagal dimuat ulang. Muat ulang halaman dan periksa kembali.', en: 'However, the medication list could not be reloaded. Refresh the page and check again.' })}`)
      }
    } catch (error) {
      // 回應遺失也可能已提交；失效通知不受表單生命週期限制，局部狀態則仍禁止回填。
      onMedicationPlanChanged?.()
      if (!isCurrent()) return
      setGroup(null)
      // 網路回應遺失可能發生在提交後；先重讀、通知服藥頁核對，不排入離線佇列或自動重送。
      try { await refresh() } catch { /* 下方提示已要求重新整理核對，保留原始送出錯誤。 */ }
      if (isCurrent()) save.fail(text(medicationErrorStatus(error, {
        zh: '無法確認變更結果，請重新整理藥單核對後再試。',
        id: 'Hasil perubahan belum dapat dipastikan. Muat ulang daftar obat dan periksa sebelum mencoba lagi.',
        en: 'The change result could not be confirmed. Reload and check the medication list before trying again.',
      })))
    } finally {
      inFlight.current = false
      if (isCurrent()) setSaving(false)
    }
  }

  return { group: group?.patientId === patientId ? group : null, groups, selectedIds, dose, setDose, reason, setReason,
    open, close, toggle, submit, panelRef, dialog, status: save.status, message: save.message }
}
