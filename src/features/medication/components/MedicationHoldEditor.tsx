/*
欄位沿用全站高對比邊框，讓照護者能清楚辨認可輸入範圍。
檔案用途：明確轉錄醫師的血壓暫停門檻、量測期限與日界，不提供醫療預設值。
所在層：medication 管理表單；新增藥單完成後才能為該病人藥品設定。
主要關聯：PlanFields、medication_hold_rules 與 save_medication_hold_rule RPC。
*/
import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { supabase } from '../../../lib/supabase'
import { useI18n, common } from '../../../lib/i18n'
import { useSaveStatus } from '../../../hooks/useSaveStatus'
import { HOLD_TEXT, readMedicationHoldRules, readMedicationHoldContext, resolveMedicationHoldSaveError, type MedicationHoldRule } from '../../../lib/medication/medicationHold'

dayjs.extend(utc)
dayjs.extend(timezone)

const empty = { metric: '', comparison: '', threshold: '', maxAge: '', dayStart: '', orderDate: '', note: '', effective: '' }
export function MedicationHoldEditor({ patientId, medicationId, onChanged }: { patientId: string; medicationId: string; onChanged?: () => void }) {
  const { text } = useI18n()
  const [form, setForm] = useState(empty)
  const [rule, setRule] = useState<MedicationHoldRule | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [revision, setRevision] = useState(0)
  const [effectiveIsNow, setEffectiveIsNow] = useState(false)
  const [syncingTime, setSyncingTime] = useState(false)
  const syncSeqRef = useRef(0)
  const save = useSaveStatus()
  useEffect(() => {
    let cancelled = false
    setLoading(true); setFailed(false)
    readMedicationHoldRules(patientId).then(rules => {
      if (cancelled) return
      const previous = rules.find(value => value.medication_id === medicationId) ?? null
      setRule(previous)
      setForm(previous ? { metric: previous.metric, comparison: previous.comparison, threshold: String(previous.threshold), maxAge: String(previous.max_age_minutes), dayStart: String(previous.day_start_hour), orderDate: previous.order_date, note: previous.order_note, effective: '' } : empty)
      setEffectiveIsNow(false)
    }).catch(() => { if (!cancelled) setFailed(true) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [patientId, medicationId, revision])
  const set = (key: keyof typeof empty, value: string) => setForm(current => ({ ...current, [key]: value }))
  const complete = !syncingTime && Object.values(form).every(value => value.trim()) && Number(form.threshold)>=30 && Number(form.threshold)<=300 && Number(form.maxAge)>=1 && Number(form.maxAge)<=1440 && Number(form.dayStart)>=0 && Number(form.dayStart)<=23

  // 為什麼點選立即生效時向伺服器對時且關閉本地回退（Fail Closed）：
  // 照護者手機時鐘可能過快或過慢；若在對時失敗時回退本機時間，
  // 過快時鐘會排至未來、過慢時鐘會被後端 1 分鐘回溯防線拒絕。
  // 因此先清空舊值並鎖定儲存與輸入欄位，對時失敗時明確提示連線錯誤，阻止表單送出不精確時間。
  const handleSetEffectiveNow = async () => {
    const syncId = ++syncSeqRef.current
    setSyncingTime(true)
    set('effective', '')
    setEffectiveIsNow(false)
    try {
      const ctx = await readMedicationHoldContext(patientId, medicationId)
      if (syncId !== syncSeqRef.current) return
      const taipeiTime = dayjs(ctx.server_now).tz('Asia/Taipei')
      set('effective', taipeiTime.format('YYYY-MM-DDTHH:mm'))
      setEffectiveIsNow(true)
    } catch {
      if (syncId === syncSeqRef.current) {
        save.fail(text(HOLD_TEXT.syncTimeError))
      }
    } finally {
      if (syncId === syncSeqRef.current) {
        setSyncingTime(false)
      }
    }
  }

  const submit = async (enabled: boolean) => {
    if (!complete || loading || failed || syncingTime || save.status === 'saving') return
    save.begin()
    try {
      // 為什麼立即生效時向資料庫傳送 'now'：
      // 在慢速或不穩定連線下，即使送出前先發查 server_now，往返延遲也可能超過 1 分鐘寬限期而被後端拒絕。
      // 照護者選取立即生效時，直接傳遞 'now' 哨兵值，由 PostgreSQL save_medication_hold_rule
      // 在同一交易內以 ('now')::timestamptz 原子指派當前時鐘，完全消除網路延遲與手機時鐘漂移。
      let effectiveIso: string
      if (effectiveIsNow) {
        effectiveIso = 'now'
      } else {
        const effectiveParsed = dayjs.tz(form.effective, 'Asia/Taipei')
        if (!effectiveParsed.isValid()) {
          save.fail(text(HOLD_TEXT.invalidTimeError))
          return
        }
        effectiveIso = effectiveParsed.toISOString()
      }

      // 為什麼前端不預先比對 orderDate：
      // 用戶端手機若時鐘落後，比對本地時間會誤判當前合法的台北當日醫囑為未來日期；
      // 由資料庫 save_medication_hold_rule 的 (clock_timestamp() AT TIME ZONE 'Asia/Taipei')::date 統一驗證，
      // 發生錯誤時由 resolveMedicationHoldSaveError 轉譯精確三語提示。

      const { error } = await supabase.rpc('save_medication_hold_rule', { p_patient_id: patientId, p_medication_id: medicationId, p_expected_rule_id: rule?.id ?? null,
        p_rule: { enabled, metric: form.metric, comparison: form.comparison, threshold: Number(form.threshold), max_age_minutes: Number(form.maxAge), day_start_hour: Number(form.dayStart), order_date: form.orderDate, order_note: form.note, effective_at: effectiveIso } })
      if (error) throw error
      save.succeed(text(HOLD_TEXT.saved)); setRevision(value => value + 1); onChanged?.()
    } catch (err) {
      save.fail(text(resolveMedicationHoldSaveError(err)))
    }
  }
  const field = (key: keyof typeof empty, label: Parameters<typeof text>[0], type = 'text', min?: number, max?: number) => (
    <label className="block">
      {text(label)}
      <input
        className="mt-1 w-full rounded-xl border-2 border-control-border p-2 disabled:bg-gray-100"
        type={type}
        min={min}
        max={max}
        disabled={key === 'effective' && syncingTime}
        value={form[key]}
        onChange={event => {
          if (key === 'effective') {
            syncSeqRef.current++
            setSyncingTime(false)
            setEffectiveIsNow(false)
          }
          set(key, event.target.value)
        }}
      />
    </label>
  )
  return <details className="rounded-xl border p-3"><summary className="min-h-11 cursor-pointer py-2 font-bold">{text(HOLD_TEXT.title)}</summary>
    {loading ? <p>{text(common.loading)}</p> : failed ? <p role="alert">{text(HOLD_TEXT.loadError)}</p> : <div className="space-y-3">
      <p className="text-sm">{text({ zh: '請依已確認的醫囑填寫所有欄位。不確定時先不要啟用；新版本生效時會取代先前登錄的版本（包含未來排程）；今天已確認的整日暫停仍須另外更正。', id: 'Isi semua kolom sesuai instruksi dokter yang sudah dipastikan. Jangan aktifkan jika belum jelas. Versi baru menggantikan versi terdahulu, termasuk jadwal mendatang, saat mulai berlaku. Penundaan hari ini tetap harus dikoreksi terpisah.', en: 'Complete every field from confirmed instructions. Do not enable if uncertain. When effective, a new version supersedes earlier entries, including scheduled ones. An existing daily hold needs a separate correction.' })}</p>
      <label className="block">{text({ zh: '血壓項目', id: 'Jenis tekanan darah', en: 'Blood pressure metric' })}<select className="w-full rounded-xl border-2 border-control-border p-2" value={form.metric} onChange={event => set('metric',event.target.value)}><option value="">{text(HOLD_TEXT.select)}</option><option value="systolic">{text({ zh: '收縮壓（高壓）', id: 'Sistolik', en: 'Systolic' })}</option><option value="diastolic">{text({ zh: '舒張壓（低壓）', id: 'Diastolik', en: 'Diastolic' })}</option></select></label>
      <label className="block">{text({ zh: '比較方式', id: 'Perbandingan', en: 'Comparison' })}<select className="w-full rounded-xl border-2 border-control-border p-2" value={form.comparison} onChange={event => set('comparison',event.target.value)}><option value="">{text(HOLD_TEXT.select)}</option>{(['lt','lte','gt','gte'] as const).map((key,index) => <option key={key} value={key}>{['<','≤','>','≥'][index]}</option>)}</select></label>
      {field('threshold',{ zh: '門檻（mmHg）', id: 'Ambang (mmHg)', en: 'Threshold (mmHg)' },'number',30,300)}
      {field('maxAge',{ zh: '服藥前量測有效期限（分鐘，依醫囑）', id: 'Masa berlaku pengukuran sebelum obat (menit, sesuai instruksi)', en: 'Reading validity before a dose (minutes, as prescribed)' },'number',1,1440)}
      {field('dayStart',{ zh: '醫囑換日時間（台北 0–23 時；日曆日請填 0）', id: 'Pergantian hari instruksi (jam Taipei 0–23; hari kalender: 0)', en: 'Prescribed day boundary (Taipei hour 0–23; calendar day: 0)' },'number',0,23)}
      {field('orderDate',{ zh: '醫囑日期', id: 'Tanggal instruksi dokter', en: 'Instruction date' },'date')}
      {field('effective',{ zh: '生效時間（台北，不可回溯）', id: 'Mulai berlaku (Taipei, tidak berlaku surut)', en: 'Effective time (Taipei, cannot be backdated)' },'datetime-local')}
      {/* 獨立全寬按鈕：滿足 44px 觸控目標、16px 字體與無障礙可讀性，不污染 input 的 label 關聯 */}
      <button
        type="button"
        disabled={syncingTime || loading || save.status === 'saving'}
        className="btn-secondary min-h-11 w-full text-base font-bold disabled:opacity-50"
        onClick={() => void handleSetEffectiveNow()}
      >
        {syncingTime ? text(HOLD_TEXT.syncingTime) : text(HOLD_TEXT.setEffectiveNow)}
      </button>
      <label className="block">{text(HOLD_TEXT.reason)}<textarea maxLength={2000} className="w-full rounded-xl border-2 border-control-border p-2" value={form.note} onChange={event => set('note',event.target.value)} /></label>
      <button type="button" className="btn-primary w-full" disabled={!complete || syncingTime || save.status==='saving'} onClick={() => void submit(true)}>{text({ zh: '確認醫囑並啟用', id: 'Konfirmasi instruksi dan aktifkan', en: 'Confirm instructions and enable' })}</button>
      {rule && <button type="button" className="btn-secondary w-full" disabled={!complete || syncingTime || save.status==='saving'} onClick={() => void submit(false)}>{text({ zh: '登錄撤銷此條件', id: 'Catat pencabutan syarat', en: 'Record revocation of this condition' })}</button>}
      {save.message && <p role="status">{save.message}</p>}
    </div>}
    {/* 發生版本衝突或回應遺失時，先明確重讀最新醫囑再重填生效時間，不能沿用舊 UUID 反覆送出或默默覆蓋別人的更新。 */}
    {!loading && (failed || save.status === 'err') && <button type="button" className="btn-secondary w-full" onClick={() => { setLoading(true); save.reset(); setRevision(value => value + 1) }}>{text(HOLD_TEXT.reload)}</button>}
  </details>
}
