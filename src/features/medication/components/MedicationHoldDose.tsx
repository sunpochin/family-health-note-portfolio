/*
欄位沿用全站高對比邊框，讓照護者能清楚辨認可輸入範圍。
檔案用途：有醫囑條件的劑次確認、整日暫停與實際服用更正入口。
所在層：medication 畫面元件；今天頁與服藥頁共用。
主要關聯：medicationHold RPC、MedicationSlotCard；以病人／藥品 key 重建，避免草稿混入別人。
*/
import { useEffect, useRef, useState } from 'react'
import dayjs from 'dayjs'
import { isPendingMedicationLog } from '../../../lib/medication/medicationPendingQueue'
import { useI18n, common } from '../../../lib/i18n'
import { useSaveStatus } from '../../../hooks/useSaveStatus'
import { HOLD_TEXT, medicationHoldSummary, medicationHoldCoversCareDate, medicationHoldIsCurrent, readMedicationHoldContext, recordMedicationHoldAction, type MedicationHoldContext, type MedicationHoldEvent } from '../../../lib/medication/medicationHold'
import { formatDoseAmountLocalized, formatMedicationLabel, type MedicationPlanView } from '../../../lib/medication/medications'
import type { MedicationIntakeLog } from '../../../types/database'
import { Icon } from '../../../components/ui/Icon'
import { MedicationAppearance } from './MedicationAppearance'
import { MedicationIntakeGuidance, medicationIntakeGuidanceProps } from './MedicationIntakeGuidance'
import { MedicationNameHeading } from './MedicationNameHeading'
import { VitalReading } from '../../vitals/components/VitalReading'

export function MedicationHoldDose({ plan, careDate, doseNumber, existing, onChanged, onRefresh, onCancelPending, nameEnglishFirst }: {
  plan: MedicationPlanView; careDate: string; doseNumber: number; existing?: MedicationIntakeLog; onChanged: (action: MedicationHoldEvent['action']) => void; nameEnglishFirst: boolean; onRefresh: () => void; onCancelPending: (button: HTMLButtonElement) => void
}) {
  const { text, locale } = useI18n()
  // 以 plan 既有的 holdContext 為初值，避免掛載瞬間閃爍未載入狀態
  const [context, setContext] = useState<MedicationHoldContext | null>(() => plan.holdContext ?? null)
  const [loadError, setLoadError] = useState(false)
  const [revision, setRevision] = useState(0)
  const [reason, setReason] = useState('')
  const pending = existing ? isPendingMedicationLog(existing) : false
  const [actualAt, setActualAt] = useState(() => pending && existing ? dayjs(existing.taken_at).tz('Asia/Taipei').format('YYYY-MM-DDTHH:mm:ss') : '')
  const save = useSaveStatus()
  const mounted = useRef(true)
  const request = useRef<{ signature: string; id: string } | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    let cancelled = false
    setLoadError(false)
    readMedicationHoldContext(plan.patient_id, plan.medication_id)
      .then(value => { if (!cancelled) setContext(value) })
      .catch(() => {
        if (!cancelled) {
          setLoadError(true)
          setContext(null) // 載入失敗時清空 context 恪守 fail-closed，防止過期臨床狀態與動作按鈕殘留
        }
      })
    return () => { cancelled = true }
  }, [plan.patient_id, plan.medication_id, revision])
  useEffect(() => {
    // 同藥另一時段剛完成確認時立即同步卡片，不能等下一分鐘仍顯示可再暫停。
    if (plan.holdContext) { setContext(plan.holdContext); setLoadError(false) }
  }, [plan.holdContext])
  useEffect(() => {
    // 不把昨天的 held 當今天；回前景與每分鐘都重新取得伺服器日期與最新量測。
    const refresh = () => setRevision(value => value + 1)
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  const act = async (action: MedicationHoldEvent['action'], factual = false) => {
    if (!context || save.status === 'saving') return
    save.begin()
    try {
      const input = { patientId: plan.patient_id, medicationId: plan.medication_id, action,
        ...(action === 'taken' ? { planId: plan.id, doseNumber, ...(!factual ? { expectedCareDate: careDate } : {}) } : {}),
        ...(factual ? { actualAt: dayjs.tz(actualAt, 'Asia/Taipei').toISOString() } : {}),
        ...(factual || action === 'correction' || action === 'release' ? { reason } : {}),
        ...(action === 'correction' ? { intakeId: existing?.id } : {}),
      }
      // 回應遺失時沿用同一個 request UUID，不能把重試變成第二筆給藥事實。
      const signature = JSON.stringify(input)
      if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() }
      await recordMedicationHoldAction(context, { ...input, requestId: request.current.id })
      if (mounted.current) { save.succeed(text(HOLD_TEXT.saved)); setRevision(value => value + 1); onChanged(action) }
    } catch {
      // 日期／版本失配也要重讀父頁，避免卡片更新了、頁面仍停在錯日。
      if (mounted.current) { save.fail(text(HOLD_TEXT.saveError)); setRevision(value => value + 1); onRefresh() }
    }
  }
  const busy = save.status === 'saving'
  const expired = context ? !medicationHoldIsCurrent(context) : false
  // 暫停的依據必須留在決定當時；後續複測或新醫囑不能改寫已確認的理由。
  const held = context?.state === 'held' ? context.hold : null
  const rule = held ? held.rule_snapshot : context?.rule
  const reading = held ? held.reading_snapshot : context?.state === 'unrestricted' ? null : context?.reading
  const checkedAt = held?.created_at ?? context?.server_now
  const ageMinutes = reading && checkedAt ? Math.floor((Date.parse(checkedAt) - Date.parse(reading.measured_at)) / 60000) : null

  const isHeld = context?.state === 'held'
  const isMatches = !expired && context?.state === 'matches'
  const isReady = !expired && (context?.state === 'ready' || context?.state === 'unrestricted')
  const needsReading = expired || context?.state === 'needs_reading'

  // 依卡片當前臨床狀態給予明確的色彩語意，取代過重冷硬的純灰色邊框
  const cardBorderClass = existing
    ? pending
      ? 'border-dashed border-emerald-600 bg-emerald-50/70'
      : 'border-emerald-600 bg-emerald-50/50'
    : isMatches
      ? 'border-amber-400 bg-amber-50/40 shadow-sm'
      : isHeld
        ? 'border-slate-300 bg-slate-50/60'
        : needsReading
          ? 'border-amber-300 bg-amber-50/20'
          : 'border-slate-200 bg-white shadow-sm'

  return (
    <article className={`space-y-3 rounded-2xl border-2 p-4 transition-colors ${cardBorderClass}`}>
      {/* 藥品基本資訊：名稱、規格、劑次 */}
      <div className="space-y-1">
        <MedicationNameHeading medication={plan.medication} locale={locale} englishFirst={nameEnglishFirst} size="lg" />
        <p className="text-sm font-bold text-slate-700">
          {formatMedicationLabel(plan.medication.brand_name, plan.medication.strength_mg, plan.medication.strength_label)}
        </p>
        <p className="text-sm font-semibold text-slate-600">
          {formatDoseAmountLocalized(plan.dose_amount, plan.medication.dosage_form, locale)} · {text({ zh: `第 ${doseNumber} 劑`, id: `Dosis ke-${doseNumber}`, en: `Dose ${doseNumber}` })}
        </p>
      </div>

      {/* 藥品外觀特徵：獨立成列並允許縮圖與說明彈性換行，避免窄螢幕下擠壓藥品名稱 */}
      {!existing && (
        <div className="min-w-0">
          <MedicationAppearance medication={plan.medication} compact showCategory={false} showAppearanceNote={false} />
        </div>
      )}

      {/* 服用方式：保留完整指示區塊（含官方劑型、家屬紀錄與衝突警告），確保照護者在按下確認前清楚看見用藥注意事項 */}
      <MedicationIntakeGuidance {...medicationIntakeGuidanceProps(plan)} className="mt-1" />

      {/* 已服用狀態列 */}
      {existing && (
        <div className="flex items-center gap-2 rounded-xl bg-emerald-100/90 px-3.5 py-2.5 text-sm font-bold text-emerald-950">
          <Icon name="check" className="h-5 w-5 shrink-0 text-emerald-700" />
          <span className="min-w-0 flex-1 truncate">
            {text(pending ? { zh: '待同步的服用紀錄', id: 'Catatan dosis belum tersinkron', en: 'Intake pending sync' } : HOLD_TEXT.recorded)}
            {' · '}
            {dayjs(existing.taken_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')}
          </span>
        </div>
      )}

      {pending && (
        <div role="alert" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <p>{text({ zh: '這筆離線服用尚未同步，不能當成已通過醫囑確認。請補記事實與原因後送出，或更正誤按。', id: 'Dosis luring ini belum tersinkron dan belum lolos pemeriksaan instruksi. Catat kejadian serta alasannya, atau koreksi salah tekan.', en: 'This offline dose has not synced or passed the instruction check. Submit it as an actual fact with a reason, or correct an accidental tap.' })}</p>
          <button type="button" className="mt-1.5 inline-block min-h-11 font-bold underline" onClick={event => onCancelPending(event.currentTarget)}>
            {text(HOLD_TEXT.correct)}
          </button>
        </div>
      )}

      {/* 臨床條件判讀與核心操作區塊 */}
      {loadError ? (
        <div role="alert" className="flex items-center justify-between rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-700">
          <span>{text(HOLD_TEXT.loadError)}</span>
          <button type="button" className="min-h-11 px-3 font-bold underline" disabled={busy} onClick={() => setRevision(value => value + 1)}>
            {text(HOLD_TEXT.reload)}
          </button>
        </div>
      ) : !context ? (
        <div role="status" className="flex items-center gap-2 rounded-xl bg-slate-100 p-3 text-sm font-semibold text-slate-600">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" aria-hidden="true" />
          <span>{text(common.loading)}</span>
        </div>
      ) : (
        <div className={`rounded-2xl border p-4 transition-colors ${
          needsReading
            ? 'border-amber-300 bg-amber-50/80 text-amber-950'
            : isMatches
              ? 'border-amber-400 bg-amber-100/60 text-amber-950'
              : isHeld
                ? 'border-slate-300 bg-slate-100/80 text-slate-900'
                : 'border-emerald-300 bg-emerald-50/80 text-emerald-950'
        }`}>
          {/* 醫囑條件摘要 */}
          {rule && (
            <div className="flex items-start gap-2">
              <Icon name="alert-triangle" className={`mt-0.5 h-4 w-4 shrink-0 ${isMatches ? 'text-amber-700' : 'text-slate-500'}`} />
              <p className="text-sm font-bold leading-snug">{text(medicationHoldSummary(rule))}</p>
            </div>
          )}

          {/* 判讀結論徽章與適用資訊 */}
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-black ${
              isMatches
                ? 'bg-amber-700 text-white'
                : isReady
                  ? 'bg-emerald-700 text-white'
                  : isHeld
                    ? 'bg-slate-700 text-white'
                    : 'bg-amber-700 text-white'
            }`}>
              {text(HOLD_TEXT[expired ? 'needs_reading' : context.state])}
            </span>
            {!expired && (
              <span className="text-xs font-medium text-slate-600">
                {text({ zh: `適用：${context.hold?.rule_day ?? context.rule_day}`, id: `Berlaku: ${context.hold?.rule_day ?? context.rule_day}`, en: `Applies: ${context.hold?.rule_day ?? context.rule_day}` })}
              </span>
            )}
          </div>

          {held && !expired && (
            <p className="mt-2 text-xs font-medium text-slate-600">
              {dayjs(held.starts_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} – {dayjs(held.ends_at).tz('Asia/Taipei').format('YYYY-MM-DD HH:mm')} ({text({zh:'台北',id:'Taipei',en:'Taipei'})})
            </p>
          )}
          {held && !expired && !medicationHoldCoversCareDate(context, careDate) && (
            <p role="note" className="mt-2 text-sm font-semibold text-amber-900">{text(HOLD_TEXT.differentDay)}</p>
          )}

          {/* 依據之血壓/生命徵象量測數值 */}
          {reading && (
            <div className="mt-2.5 flex items-center gap-2 rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm font-semibold text-slate-800">
              <VitalReading {...reading} showPulse={false} />
              <span className="text-xs text-slate-500">
                {dayjs(reading.measured_at).tz('Asia/Taipei').format('HH:mm')}
                {ageMinutes !== null && ` · ${held
                  ? text({ zh: `距確認時間 ${ageMinutes} 分鐘`, id: `${ageMinutes} menit sebelum konfirmasi`, en: `${ageMinutes}m before confirmation` })
                  : text({ zh: `${ageMinutes} 分鐘前`, id: `${ageMinutes} mnt lalu`, en: `${ageMinutes}m ago` })}`}
              </span>
            </div>
          )}

          {/* 核心操作主按鈕 */}
          {!expired && !existing && isMatches && (
            <button
              type="button"
              className="mt-3.5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-amber-700 px-4 py-3 text-base font-black text-white shadow-sm transition active:bg-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:opacity-50"
              disabled={busy}
              onClick={() => void act('hold')}
            >
              {text(HOLD_TEXT.confirmHold)}
            </button>
          )}

          {!expired && !existing && isReady && (
            <button
              type="button"
              className="mt-3.5 flex min-h-12 w-full items-center justify-center rounded-2xl bg-brand-700 px-4 py-3 text-base font-black text-white shadow-sm transition active:bg-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:opacity-50"
              disabled={busy}
              onClick={() => void act('taken')}
            >
              {text(context.state === 'unrestricted' ? HOLD_TEXT.recordTaken : HOLD_TEXT.confirmTaken)}
            </button>
          )}
        </div>
      )}

      {/* 次要更正與補記操作（收納於折疊面板，避免干擾主要服藥流程；載入失敗或重驗證中時不開放） */}
      {!loadError && context && (
        <div className="mt-2 space-y-1 border-t border-slate-100 pt-2">
          <details className="group">
            <summary className="flex min-h-11 cursor-pointer items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-800">
              <span>{text(existing && !pending ? HOLD_TEXT.correct : HOLD_TEXT.fact)}</span>
              <span className="text-slate-400 transition-transform group-open:rotate-180">⌄</span>
            </summary>
            <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="text-xs text-slate-600">{text(HOLD_TEXT.factWarning)}</p>
              <label className="block text-xs font-bold text-slate-700">
                {text(HOLD_TEXT.reason)}
                <textarea
                  className="mt-1 min-h-16 w-full rounded-xl border-2 border-control-border bg-white p-2 text-sm text-slate-900"
                  maxLength={2000}
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                />
              </label>
              {(!existing || pending) && (
                <label className="block text-xs font-bold text-slate-700">
                  {text(HOLD_TEXT.actualTime)}
                  <input
                    type="datetime-local"
                    className="mt-1 min-h-11 w-full rounded-xl border-2 border-control-border bg-white p-2 text-sm text-slate-900"
                    value={actualAt}
                    onChange={event => setActualAt(event.target.value)}
                  />
                </label>
              )}
              <button
                type="button"
                className="btn-secondary min-h-11 w-full"
                disabled={busy || !reason.trim() || ((!existing || pending) && !actualAt)}
                onClick={() => void act(existing && !pending ? 'correction' : 'taken', !existing || pending)}
              >
                {text(existing && !pending ? HOLD_TEXT.correct : HOLD_TEXT.fact)}
              </button>
            </div>
          </details>

          {!expired && context.hold && (
            <details className="group">
              <summary className="flex min-h-11 cursor-pointer items-center justify-between text-xs font-semibold text-slate-500 hover:text-slate-800">
                <span>{text(HOLD_TEXT.release)}</span>
                <span className="text-slate-400 transition-transform group-open:rotate-180">⌄</span>
              </summary>
              <div className="mt-2 space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm">
                <label className="block text-xs font-bold text-slate-700">
                  {text(HOLD_TEXT.reason)}
                  <textarea
                    className="mt-1 min-h-16 w-full rounded-xl border-2 border-control-border bg-white p-2 text-sm text-slate-900"
                    maxLength={2000}
                    value={reason}
                    onChange={event => setReason(event.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="btn-secondary min-h-11 w-full"
                  disabled={busy || !reason.trim()}
                  onClick={() => void act('release')}
                >
                  {text(HOLD_TEXT.release)}
                </button>
              </div>
            </details>
          )}
        </div>
      )}

      {save.message && (
        <p role={save.status === 'err' ? 'alert' : 'status'} className="mt-2 text-sm font-semibold">
          {save.message}
        </p>
      )}
    </article>
  )
}
