/*
檔案用途：服藥打卡分頁中「單一時段」卡片——收合標題＋進度徽章＋逐顆服藥打卡按鈕。
所在層：src/features/medication/components；由 MedicationPage 在服藥打卡分頁對每個時段各自掛載一張。
主要關聯：服藥／取消服藥的實際寫入邏輯（toggleDose／clearDose）與收合狀態都留在 MedicationPage，
本元件只負責呈現與回報操作意圖，符合 AGENTS.md「介面元件化規範」的頁面—元件分工。
*/
import dayjs from 'dayjs'
import { MedicationHoldDose } from './MedicationHoldDose'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import { formatDoseAmountLocalized, formatMedicationLabel, resolveMedicationNames, type MedicationPlanView } from '../../../lib/medication/medications'
import { isPendingMedicationLog } from '../../../lib/medication/medicationPendingQueue'
import { medicationSlotText } from '../../../lib/medication/medicationSchedule'
import { resolveMedicationCategory } from '../../../lib/medication/medicationAtcCategories'
import type { MedicationIntakeLog } from '../../../types/database'
import { useI18n, type Locale, type LocalizedText } from '../../../lib/i18n'
import { MedicationAppearance } from './MedicationAppearance'
import { MedicationIntakeGuidance, medicationIntakeGuidanceProps } from './MedicationIntakeGuidance'
import { MedicationNameHeading } from './MedicationNameHeading'
import { Icon } from '../../../components/ui/Icon'

dayjs.extend(utc)
dayjs.extend(timezone)

export type MedicationSlotProgress = { doseTaken: number; doseHeld?: number; doseTotal: number; quantity: LocalizedText }

export function MedicationSlotCard({
  slot,
  careDate,
  slotPlans,
  progress,
  collapsed,
  completed,
  busyKey,
  syncingDoseKey = null,
  refreshingDoseKeys,
  logs,
  locale,
  nameEnglishFirst,
  onHoldChanged,
  onHoldRefresh,
  onToggleCollapse,
  onToggleDose,
}: {
  slot: string
  careDate: string
  slotPlans: MedicationPlanView[]
  progress: MedicationSlotProgress
  collapsed: boolean
  completed: boolean
  busyKey: string
  /** 正在補送的那一劑（`planId:doseNumber`）；送出結果回來前不能撤回，按鈕先停用。 */
  syncingDoseKey?: string | null
  /** 別頁已補送、但本頁仍等待當日伺服器重讀；所有未確認劑次都先停用。 */
  refreshingDoseKeys?: ReadonlySet<string>
  /** 已服用紀錄，含離線佇列裡尚未同步的劑次（id 帶 pending 前綴，見 isPendingMedicationLog）。 */
  logs: MedicationIntakeLog[]
  locale: Locale
  nameEnglishFirst: boolean
  onHoldRefresh: () => void
  onHoldChanged: (plan: MedicationPlanView, doseNumber: number, action: 'hold' | 'release' | 'taken' | 'correction') => void
  onToggleCollapse: () => void
  onToggleDose: (plan: MedicationPlanView, doseNumber: number, existing: MedicationIntakeLog | undefined, trigger: HTMLButtonElement) => void
}) {
  const { text } = useI18n()

  return (
    // 完成的餐次退成淺灰，未完成餐次維持白底；視線自然先落在還需要處理的藥。
    <section className={`rounded-3xl border p-4 ${completed ? 'border-slate-300 bg-slate-100 shadow-none' : 'border-slate-200 bg-white shadow-sm'}`}>
      <h2 className="mb-3">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!collapsed}
          className="flex min-h-11 w-full flex-col gap-1 rounded-xl px-2 py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2"
        >
          <span className="flex items-center justify-between gap-3">
            <span className={`text-base font-black ${completed ? 'text-slate-700' : 'text-slate-800'}`}>{text(medicationSlotText(slot))}</span>
            <span aria-hidden="true" className={`shrink-0 text-lg font-bold ${completed ? 'text-slate-500' : 'text-slate-500'}`}>{collapsed ? '⌄' : '⌃'}</span>
          </span>
          {/* 次數（服藥打卡幾次）與顆數（實際吞下幾顆）分兩個數字標示，因為同一次服藥可能不只一顆
              （例如鉀離子藥常見單次 2 顆）；次數對不代表顆數對，照護者核對藥盒時兩個數字都要看。
              收合且整餐已完成時，這行放大成跟藥名同級並加勾勾徽章，取代點擊提示，不必展開也能一眼確認。 */}
          {collapsed && completed && !progress.doseHeld
            ? <span className="flex items-center gap-2 text-base font-black text-slate-700">
                <span aria-hidden="true" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-white"><Icon name="check" className="h-4 w-4" /></span>
                <span className="tabular-nums">
                  {text({ id: `${progress.doseTaken}/${progress.doseTotal} dosis · ${progress.quantity.id} selesai`, zh: `${progress.doseTaken}/${progress.doseTotal} 次・${progress.quantity.zh}已完成` ,en: `${progress.doseTaken}/${progress.doseTotal} doses · ${progress.quantity.en} complete` })}
                </span>
              </span>
            : <span className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span className={`text-sm font-bold tabular-nums ${completed ? 'text-slate-600' : 'text-slate-600'}`}>
                  {text({ id: `${progress.doseTaken}/${progress.doseTotal} dosis · ${progress.quantity.id}`, zh: `${progress.doseTaken}/${progress.doseTotal} 次・${progress.quantity.zh}` ,en: `${progress.doseTaken}/${progress.doseTotal} doses · ${progress.quantity.en}` })}
                </span>
                <span className={`text-xs font-semibold ${completed ? 'text-slate-500' : 'text-slate-500'}`}>
                  {/* 展開與收合按鈕的英文翻譯修正 */}
                  {collapsed ? text({ id: 'Ketuk untuk membuka daftar obat', zh: '點擊展開藥品' ,en: 'Tap to view medications' }) : text({ id: 'Ketuk untuk menutup', zh: '點擊收合' ,en: 'Tap to collapse' })}
                </span>
              </span>}
        </button>
      </h2>
      {(progress.doseHeld ?? 0) > 0 && <p className="mb-2 font-bold">{text({ zh: `已服用 ${progress.doseTaken} 劑／依醫囑暫停 ${progress.doseHeld} 劑${completed ? '；本時段已處理完成' : ''}`, id: `${progress.doseTaken} dosis diminum / ${progress.doseHeld} ditunda${completed ? '; jadwal ini sudah ditangani' : ''}`, en: `${progress.doseTaken} taken / ${progress.doseHeld} held${completed ? '; this time slot is complete' : ''}` })}</p>}
      {!collapsed && <div className="space-y-2">
        {slotPlans.flatMap(plan => Array.from({ length: plan.dose_count }, (_, index) => {
          const doseNumber = index + 1
          const existing = logs.find(log => log.plan_id === plan.id && log.dose_number === doseNumber)
          const key = `${plan.id}:${doseNumber}`
          // 離線打卡的劑次也顯示成已服用（藥已經吃了），但要看得出「還在這支手機上、沒送到伺服器」，
          // 否則看護與家屬會以為家人那邊也看得到這筆（issue #822）。
          const pendingSync = existing ? isPendingMedicationLog(existing) : false
          const syncingThis = syncingDoseKey === key || refreshingDoseKeys?.has(key) === true
          // 已服用的矮版卡片仍要保留分類，讓照護者收合後掃過整段藥單也能一眼確認「降血壓、抗凝血都吃了幾顆」。
          const category = resolveMedicationCategory(plan.medication.atc_code)
          // 條件藥也不能操作尚未對帳的投影；原生 fieldset 同時保護所有補記／更正按鈕。
          if (plan.holdContext) return <fieldset key={`${plan.patient_id}:${key}`} disabled={syncingThis}><MedicationHoldDose plan={plan} careDate={careDate} doseNumber={doseNumber} existing={existing} nameEnglishFirst={nameEnglishFirst} onRefresh={onHoldRefresh} onChanged={action => onHoldChanged(plan,doseNumber,action)} onCancelPending={button => onToggleDose(plan,doseNumber,existing,button)} /></fieldset>
          return (
            <button
              key={key}
              type="button"
              disabled={Boolean(busyKey) || syncingThis}
              aria-pressed={Boolean(existing)}
              onClick={event => onToggleDose(plan, doseNumber, existing, event.currentTarget)}
              className={existing
                // 已服用後改成單行、矮版的卡片，讓長輩滑一整段時段時不必一直看到吃藥前才需要的外觀圖／色形。
                // 待同步改用虛線框：同一個綠色語意（已服用），但一眼看得出跟已存進伺服器的不同，不只靠文字。
                ? `flex min-h-16 w-full items-center gap-3 rounded-2xl border-2 ${pendingSync ? 'border-dashed bg-emerald-50' : 'bg-emerald-100'} border-emerald-600 px-4 py-2.5 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:opacity-50`
                // 黃色代表「還要處理」；未服用仍要完整呈現外觀，讓照護者核對手上的藥是不是這顆。
                : 'flex w-full flex-col rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 text-left shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:opacity-50'}
            >
              {existing ? <>
                <span aria-hidden="true" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-white"><Icon name="check" className="h-5 w-5" /></span>
                {/* 已服用只留藥名＋分類兩行；次要名稱／外觀是吃藥前才需要核對的細節，這裡省略讓卡片維持矮版。 */}
                <span className="min-w-0 flex-1 truncate">
                  {/* 沿用同一張卡的 emerald 色階做深淺分層，藥名深、分類淺，避免另外混入紅／洋紅跟「已完成」的綠色語意打架。 */}
                  <span className="block truncate text-base font-black text-emerald-950">{resolveMedicationNames(plan.medication, locale, nameEnglishFirst).primary}</span>
                  {category && <span className="block truncate text-sm font-black text-emerald-700">{text(category)}</span>}
                </span>
                <span className="shrink-0 text-right text-sm font-black text-emerald-900">
                  {busyKey === key
                    ? text({ id: 'Membatalkan…', zh: '取消中…' ,en: 'Cancelling…' })
                    : syncingThis
                      ? text({ id: 'Menyinkronkan…', zh: '同步中…', en: 'Syncing…' })
                      : <>
                      {/* 勾勾圖示已經代表「已服用」，這裡只留時間，不重複整句「已服用於」讓行高多長一行。 */}
                      <span className="block">{dayjs(existing.taken_at).tz('Asia/Taipei').format('HH:mm')}</span>
                      {/* 取消服藥按鈕英文翻譯修正；待同步的劑次一樣可以撤回（按錯時），只是撤回的是這支手機上的那筆。 */}
                      <span className="block text-xs font-bold text-emerald-700">{pendingSync
                        ? text({ id: 'Menunggu sinkron · ketuk untuk batal', zh: '待同步・點擊取消', en: 'Waiting to sync · Tap to cancel' })
                        : text({ id: 'Ketuk untuk batalkan', zh: '點擊取消' ,en: "Tap to cancel" })}</span>
                    </>}
                </span>
              </> : <>
                <span className="min-w-0 flex-1">
                  <MedicationNameHeading medication={plan.medication} locale={locale} englishFirst={nameEnglishFirst} size="lg" />
                  <span className="block text-base font-bold text-slate-700">{formatMedicationLabel(plan.medication.brand_name, plan.medication.strength_mg, plan.medication.strength_label)}</span>
                  {/* 服藥時只留照片後的單一外觀資訊；辨識代碼留在調藥介面，避免日常卡片重複又過高。 */}
                  <MedicationAppearance
                    medication={plan.medication}
                    showAppearanceNote={false}
                    showCategory={false}
                    details={`${plan.medication.generic_name} · ${formatDoseAmountLocalized(plan.dose_amount, plan.medication.dosage_form, locale)}${plan.as_needed ? ` · ${text({ id: 'Bila perlu', zh: '需要時服用' ,en: 'As needed' })}` : ''}${plan.dose_count > 1 ? ` · ${text({ id: `Pil ke-${doseNumber}`, zh: `第 ${doseNumber} 顆` ,en: `Pill ${doseNumber}` })}` : ''}`}
                  />
                  {/* 打卡前是照護者最需要核對服用方式的時刻；已服用的矮版卡片刻意不重複顯示，避免整段藥單過長。 */}
                  <MedicationIntakeGuidance compact {...medicationIntakeGuidanceProps(plan)} className="mt-2" />
                </span>
                {/* 狀態獨立放到底部，避免右欄擠壓藥名。 */}
                <span className="mt-3 flex w-full flex-col items-end border-t border-amber-300 pt-3 text-base font-black text-amber-950">
                  {/* 記錄中與未服用操作提示英文翻譯修正 */}
                  {/* 撤回標記正在送出時也是這張「尚未服用」卡被停用；要講原因，否則看護會以為按鈕壞了。 */}
                  {busyKey === key
                    ? text({ id: 'Mencatat…', zh: '記錄中…' ,en: 'Recording…' })
                    : syncingThis
                      ? text({ id: 'Menyinkronkan…', zh: '同步中…', en: 'Syncing…' })
                      : <span><span aria-hidden="true" className="mr-1.5 inline-flex h-7 w-7 items-center justify-center rounded-full bg-amber-500 text-base text-white">!</span>{text({ id: 'Belum diminum · ketuk untuk mencatat', zh: '尚未服用・點擊記錄' ,en: 'Not taken · Tap to record' })}</span>}
                </span>
              </>}
            </button>
          )
        }))}
      </div>}
    </section>
  )
}
