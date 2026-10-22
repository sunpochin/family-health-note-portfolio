/*
檔案用途：血壓當日暫停醫囑的型別、唯讀摘要與受控 RPC 轉接。
所在層：src/lib/medication；不推導醫療門檻，不把暫停當成已服用。
主要關聯：MedicationHoldEditor、MedicationHoldDose、medication_daily_bp_hold migration。
*/
import dayjs from 'dayjs'
import { careDateKey, careDayBounds } from '../careDay'
import { supabase } from '../supabase'
import type { LocalizedText } from '../i18n'
import { isDemoPatientId } from '../demoData'
export interface MedicationHoldRule {
  id: string; patient_id: string; medication_id: string; enabled: boolean
  metric: 'systolic' | 'diastolic'; comparison: 'lt' | 'lte' | 'gt' | 'gte'; threshold: number
  max_age_minutes: number; day_start_hour: number; order_date: string; order_note: string
  effective_at: string; created_at: string
}
export interface MedicationHoldEvent {
  id: string; patient_id: string; medication_id: string; medication_name: string; intake_id: string | null; action: 'hold' | 'release' | 'taken' | 'correction'
  rule_day: string; starts_at: string; ends_at: string; care_date: string; reason: string | null
  related_event_id: string | null; created_at: string; actual_at: string | null
  rule_snapshot: MedicationHoldRule | null; reading_snapshot: MedicationHoldReading | null
}
export interface MedicationHoldReading { id: string; systolic: number; diastolic: number; measured_at: string }
export interface MedicationHoldContext {
  rule: MedicationHoldRule | null; reading: MedicationHoldReading | null; hold: MedicationHoldEvent | null
  rule_day: string; starts_at: string; ends_at: string; server_now: string
  state: 'unrestricted' | 'needs_reading' | 'matches' | 'ready' | 'held'
}
const requestedAt = new WeakMap<MedicationHoldContext, number>()
const receivedAt = new WeakMap<MedicationHoldContext, number>()
// 手機日曆可能被調快／調慢；醫囑有效性只採伺服器時間加單調計時，不用 Date.now。
export function medicationHoldNow(context: MedicationHoldContext): number {
  const anchor = requestedAt.get(context)
  return anchor === undefined ? NaN : Date.parse(context.server_now) + Math.max(0, performance.now() - anchor)
}
// 提前到期的保守時鐘不能當成服藥事實；收到回應後才累計時間，避免把往返延遲加成未來服用。
export function medicationServerNow(context: MedicationHoldContext): number {
  const anchor = receivedAt.get(context)
  return anchor === undefined ? NaN : Date.parse(context.server_now) + Math.max(0, performance.now() - anchor)
}
export function medicationHoldRemaining(context: MedicationHoldContext): number {
  return Date.parse(context.hold?.ends_at ?? context.ends_at) - medicationHoldNow(context)
}
export function medicationHoldIsCurrent(context: MedicationHoldContext): boolean {
  const now = medicationHoldNow(context)
  return Date.parse(context.hold?.starts_at ?? context.starts_at) <= now && medicationHoldRemaining(context) > 0
}
export function medicationHoldCoversCareDate(context: MedicationHoldContext, careDate: string): boolean {
  if (context.state !== 'held' || !context.hold || !medicationHoldIsCurrent(context)) return false
  // 餐前後／睡前沒有確切鐘點；只有整個照護日都被涵蓋，才能把未服劑次自動列為已處理。
  // 不用 created_at 截斷：中午確認的整日暫停仍涵蓋這一日所有尚未服用劑次。
  const { start, end } = careDayBounds(careDate)
  return Date.parse(context.hold.starts_at) <= start.valueOf() && end.valueOf() <= Date.parse(context.hold.ends_at)
}
export const HOLD_TEXT = {
  saved: { zh: '已儲存', id: 'Tersimpan', en: 'Saved' },
  select: { zh: '請選擇', id: 'Pilih', en: 'Select' },
  title: { zh: '當日暫停條件（依醫囑）', id: 'Syarat penundaan harian (sesuai instruksi dokter)', en: 'Daily hold condition (prescribed)' },
  loadError: { zh: '無法確認醫囑，請連線後重新讀取。', id: 'Instruksi belum dapat diperiksa. Sambungkan lalu muat ulang.', en: 'Unable to confirm instructions. Connect and reload.' },
  saveError: { zh: '尚未確認儲存成功。請重新讀取，核對是否已有紀錄；條件或血壓可能已更新。', id: 'Penyimpanan belum terkonfirmasi. Muat ulang dan periksa catatan; syarat atau tekanan darah mungkin berubah.', en: 'Save is not confirmed. Reload and check for a record; the condition or reading may have changed.' },
  invalidTimeError: { zh: '生效時間不可早於目前時間，且醫囑日期不可為未來日期。若要立即生效請使用「設為現在立即生效」。', id: 'Waktu mulai berlaku tidak boleh mendahului waktu saat ini, dan tanggal instruksi tidak boleh di masa depan. Gunakan "Atur berlaku sekarang" untuk segera memberlakukan.', en: 'Effective time cannot be earlier than current time, and instruction date cannot be in the future. Use "Set effective now" to apply immediately.' },
  changedError: { zh: '醫囑條件已被更新，請點擊下方「重新讀取」核對最新醫囑後再儲存。', id: 'Syarat instruksi telah diperbarui, silakan klik "Muat ulang" di bawah untuk memeriksa sebelum menyimpan.', en: 'Instruction condition has been updated, please click "Reload" below to review before saving.' },
  permissionError: { zh: '您沒有修改此受照護者藥單的權限。', id: 'Anda tidak memiliki izin untuk mengubah resep pasien ini.', en: 'You do not have permission to modify this patient’s prescription.' },
  fixedPlanRequiredError: { zh: '此藥品需要已有固定的服藥時段才能設定當日暫停條件。', id: 'Obat ini harus memiliki jadwal tetap sebelum dapat mengatur syarat penundaan harian.', en: 'This medication must have a fixed schedule before setting daily hold conditions.' },
  syncTimeError: { zh: '無法取得伺服器時間，請檢查連線後重試。', id: 'Gagal mendapatkan waktu server, periksa koneksi lalu coba lagi.', en: 'Unable to retrieve server time. Check your connection and try again.' },
  syncingTime: { zh: '正在對時…', id: 'Menyelaraskan waktu…', en: 'Synchronizing time…' },
  setEffectiveNow: { zh: '設為現在立即生效', id: 'Atur berlaku sekarang', en: 'Set effective now' },
  needs_reading: { zh: '待確認今日血壓：請先量測並同步；不沿用昨日讀數。', id: 'Tekanan darah hari ini perlu diperiksa. Ukur dan sinkronkan; hasil kemarin tidak berlaku.', en: 'Today’s blood pressure needs confirmation. Measure and sync; yesterday’s reading does not apply.' },
  matches: { zh: '符合已登錄的當日暫停條件。', id: 'Memenuhi syarat penundaan harian yang tercatat.', en: 'Meets the recorded daily hold condition.' },
  ready: { zh: '未達已登錄的暫停條件，依原藥單服用。', id: 'Tidak memenuhi syarat penundaan; ikuti resep semula.', en: 'Does not meet the recorded hold condition; follow the existing prescription.' },
  held: { zh: '今天依醫囑暫停；隔天重新量測確認。', id: 'Ditunda hari ini sesuai instruksi dokter; ukur kembali besok.', en: 'Held today as prescribed; measure again tomorrow.' },
  differentDay: { zh: '此藥在上述期間依醫囑暫停。本頁照護日與暫停期間不同；因劑次沒有確切時間，未自動列為已處理，這不表示可以給藥。', id: 'Obat ini ditunda selama periode di atas sesuai instruksi dokter. Hari perawatan halaman ini berbeda; tanpa waktu dosis yang pasti, dosis tidak otomatis ditandai selesai. Ini bukan izin pemberian obat.', en: 'This medication is held during the interval above as prescribed. This page’s care day differs; without exact dose times, doses are not automatically marked handled. This does not authorize administration.' },
  unrestricted: { zh: '目前沒有生效的暫停條件，依原藥單記錄。', id: 'Tidak ada syarat penundaan yang berlaku; catat sesuai resep.', en: 'No hold condition is currently effective; record against the prescription.' },
  reload: { zh: '重新讀取', id: 'Muat ulang', en: 'Reload' },
  confirmHold: { zh: '確認此血壓，記錄整日暫停', id: 'Konfirmasi hasil ini dan catat penundaan sehari', en: 'Confirm this reading and record a full-day hold' },
  recordTaken: { zh: '記錄已服用', id: 'Catat sudah diminum', en: 'Record taken' },
  confirmTaken: { zh: '確認此血壓，記錄已服用', id: 'Konfirmasi hasil ini dan catat sudah diminum', en: 'Confirm this reading and record taken' },
  fact: { zh: '補記已實際服用', id: 'Catat obat yang sudah benar-benar diminum', en: 'Record a dose already actually taken' },
  factWarning: { zh: '這是補記事實，不表示系統允許給藥，也不解除整日暫停。', id: 'Ini mencatat kejadian nyata, bukan izin pemberian obat dan tidak membatalkan penundaan.', en: 'This records a fact, does not authorize administration, and does not release the daily hold.' },
  reason: { zh: '原因／新的醫囑依據', id: 'Alasan / instruksi dokter yang baru', en: 'Reason / new prescribed instruction' },
  actualTime: { zh: '實際服用時間（台北）', id: 'Waktu sebenarnya diminum (Taipei)', en: 'Actual time taken (Taipei)' },
  release: { zh: '依新醫囑更正整日暫停', id: 'Koreksi penundaan sesuai instruksi baru', en: 'Correct daily hold under new instructions' },
  correct: { zh: '更正這筆服用紀錄', id: 'Koreksi catatan dosis ini', en: 'Correct this intake record' },
  recorded: { zh: '已記錄服用', id: 'Sudah tercatat diminum', en: 'Recorded as taken' },
  save: { zh: '儲存', id: 'Simpan', en: 'Save' },
} satisfies Record<string, LocalizedText>
// 為什麼需要解析特定錯誤：後端資料庫嚴格擋下不可回溯的生效時間（medication_hold_invalid_time）
// 或版本衝突（medication_hold_changed），前端若一律顯示籠統的 saveError 會誤導使用者以為是網路失敗或系統當機。
export function resolveMedicationHoldSaveError(error: unknown): LocalizedText {
  const message = typeof error === 'object' && error !== null && 'message' in error && typeof (error as { message: unknown }).message === 'string'
    ? (error as { message: string }).message
    : String(error ?? '')
  if (message.includes('medication_hold_invalid_time')) return HOLD_TEXT.invalidTimeError
  if (message.includes('medication_hold_changed')) return HOLD_TEXT.changedError
  if (message.includes('medication_hold_permission')) return HOLD_TEXT.permissionError
  if (message.includes('medication_hold_fixed_plan_required')) return HOLD_TEXT.fixedPlanRequiredError
  return HOLD_TEXT.saveError
}
export function medicationHoldSummary(rule: MedicationHoldRule): LocalizedText {
  const op = { lt: '<', lte: '≤', gt: '>', gte: '≥' }[rule.comparison]
  const hour = String(rule.day_start_hour).padStart(2, '0')
  return {
    zh: `依醫囑：${rule.metric === 'systolic' ? '收縮壓（高壓）' : '舒張壓（低壓）'} ${op} ${rule.threshold} mmHg，當日整顆藥暫停，隔日重新量測。量測有效 ${rule.max_age_minutes} 分鐘；台北 ${hour}:00 換日。${rule.enabled ? '' : '此版本已撤銷。'}`,
    id: `Sesuai instruksi dokter: ${rule.metric === 'systolic' ? 'sistolik' : 'diastolik'} ${op} ${rule.threshold} mmHg, tunda obat ini sepanjang hari, ukur lagi esok hari. Hasil berlaku ${rule.max_age_minutes} menit; pergantian hari pukul ${hour}:00 Taipei.${rule.enabled ? '' : ' Versi ini dicabut.'}`,
    en: `As prescribed: ${rule.metric === 'systolic' ? 'systolic' : 'diastolic'} ${op} ${rule.threshold} mmHg: hold this medication for the day and measure again the next day. Reading valid for ${rule.max_age_minutes} minutes; day starts at ${hour}:00 Taipei.${rule.enabled ? '' : ' This version is revoked.'}`,
  }
}
export async function readMedicationHoldRules(patientId: string): Promise<MedicationHoldRule[]> {
  if (isDemoPatientId(patientId)) return []
  const { data, error } = await supabase.from('medication_hold_rules').select('*').eq('patient_id', patientId).order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}
export async function readMedicationHoldContext(patientId: string, medicationId: string): Promise<MedicationHoldContext> {
  // 換日前送出的回應可能延遲到換日後才收到；保守計入整段往返時間，不能延長舊暫停。
  const startedAt = performance.now()
  const { data, error } = await supabase.rpc('medication_hold_context', { p_patient_id: patientId, p_medication_id: medicationId })
  if (error) throw error
  requestedAt.set(data, startedAt)
  receivedAt.set(data, performance.now())
  return data
}
export async function recordMedicationHoldAction(context: MedicationHoldContext, input: {
  requestId: string; patientId: string; medicationId: string; action: MedicationHoldEvent['action']
  planId?: string; doseNumber?: number; actualAt?: string; reason?: string; intakeId?: string; expectedCareDate?: string
}): Promise<MedicationHoldEvent> {
  const { data, error } = await supabase.rpc('record_medication_hold_action', {
    p_request_id: input.requestId, p_patient_id: input.patientId, p_medication_id: input.medicationId,
    p_action: input.action, p_expected_rule_id: context.rule?.id ?? null, p_reading: context.reading,
    p_expected_care_date: input.expectedCareDate ?? null,
    p_plan_id: input.planId ?? null, p_dose_number: input.doseNumber ?? null, p_actual_at: input.actualAt ?? null,
    p_reason: input.reason ?? null, p_related_event_id: input.action === 'release' ? context.hold?.id : null, p_intake_id: input.intakeId ?? null,
  })
  if (error) throw error
  return data
}
export async function readMedicationHoldEvents(patientId: string, since: string): Promise<MedicationHoldEvent[]> {
  if (isDemoPatientId(patientId)) return []
  const { data, error } = await supabase.from('medication_hold_events').select('*').eq('patient_id', patientId).gte('ends_at', `${since}T00:00:00+08:00`).order('created_at', { ascending: false })
  if (error) throw error
  return data ?? []
}

export interface HoldReportingPlan { patient_id: string; medication_id: string; created_at: string; active: boolean; as_needed: boolean }
// 原有觀察只找「整日零 intake」，不升級成逐藥漏服；只有所有固定藥都有完整涵蓋，hold 才能豁免整日。
export function heldMedicationCareDates(events: MedicationHoldEvent[], plans: HoldReportingPlan[], patientId: string): Set<string> {
  const patientEvents = events.filter(event => event.patient_id === patientId)
  const released = new Set(patientEvents.filter(event => event.action === 'release').map(event => event.related_event_id))
  const holds = patientEvents.filter(event => event.action === 'hold' && !released.has(event.id))
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at))
  const dates = new Set<string>()
  for (const event of holds) {
    const start = Date.parse(event.starts_at), end = Date.parse(event.ends_at) - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) continue
    const last = careDateKey(dayjs(end))
    for (let date = careDateKey(dayjs(start)); date <= last; date = dayjs(date).add(1, 'day').format('YYYY-MM-DD')) {
      const bounds = careDayBounds(date)
      const scheduled = plans.filter(plan => plan.patient_id === patientId && plan.active && !plan.as_needed && Date.parse(plan.created_at) < bounds.end.valueOf())
      if (!scheduled.length) continue
      // 不猜餐點鐘點；同藥相鄰日的 hold 可以接起來，但別顆藥或中間空隙不能補洞。
      const allHeld = scheduled.every(plan => {
        let coveredUntil = Math.max(bounds.start.valueOf(), Date.parse(plan.created_at))
        for (const hold of holds.filter(hold => hold.medication_id === plan.medication_id)) {
          if (Date.parse(hold.starts_at) > coveredUntil) break
          coveredUntil = Math.max(coveredUntil, Date.parse(hold.ends_at))
        }
        return coveredUntil >= bounds.end.valueOf()
      })
      if (allHeld) dates.add(date)
    }
  }
  return dates
}
