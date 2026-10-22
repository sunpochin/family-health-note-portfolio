/*
檔案用途：鎖住 MedicationPage 裡服藥離線佇列的四個安全分支（issue #1131，延續 #822）：
  (1) 打卡失敗只有「可重送的錯誤」才排進佇列，權限／資料錯誤與本機存不下來都必須顯示錯誤、不能假裝已記錄；
  (2) 撤回「待同步」的劑次絕不呼叫伺服器刪除（withdrawn／syncing／storage-error／not-pending 四種結果都一樣）；
  (3) 確認視窗開著時，那一劑補送完成或被伺服器那筆取代，視窗要自己關掉；
  (4) 讀取當天紀錄的期間回來的補送結果，要在讀取完成後重新套上去。
  這四處壞掉的後果是「遺失一筆打卡」或「刪掉看護從沒確認過的伺服器紀錄」，而 lib 層與 hook 層的測試看不到頁面這一層的決策。
所在層：tests/unit；用最小 hook 執行環境呼叫 MedicationPage 取得元素樹，寫入／讀取函式與離線佇列 hook 換成可控替身，不啟動瀏覽器、不連網。
  注意：bun 的 mock.module 在同一個程序內是共用的，本檔替換了 lib/medication/medications 與離線佇列 hook 兩個模組，
  所以跟 repo 內其他 mock.module 測試一樣必須用 `--isolate` 跑（CI、`bun run test:unit`、`bun run test:quiet` 都已帶；見 AGENTS.md § 4）。
  不帶時跨檔外洩是既有的已知狀況（外洩方向反過來也成立：別的檔案裝的 lib/platform 局部替身會讓本檔 import 失敗）。
主要關聯：src/features/medication/pages/MedicationPage.tsx、src/features/medication/hooks/useMedicationPendingDoses.ts
  （hook 本身的行為見 useMedicationPendingDoses.test.ts）、src/lib/medication/medicationPendingQueue.ts。
*/
import { afterEach, beforeEach, describe, expect, mock, setSystemTime, spyOn, test } from 'bun:test'
import { installReactHookHarness, renderHook, type HookHandle } from './helpers/reactHookHarness'
import { findAll, fire, textContent } from './helpers/elementTree'
import type { MedicationIntakeLog } from '../../src/types/database'
import type { useMedicationPendingDoses } from '../../src/features/medication/hooks/useMedicationPendingDoses'
import type { MedicationPlanView } from '../../src/lib/medication/medications'
import type { PendingMedicationDose } from '../../src/lib/medication/medicationPendingQueue'

installReactHookHarness()

// ── 寫入／讀取替身：只換掉會連到 Supabase 的三個函式，其餘（完成時段判斷、畫面身分比對）用真的 ───────────
const actualMedications = await import('../../src/lib/medication/medications')
type DayResult = Awaited<ReturnType<typeof actualMedications.readMedicationDay>>

const readMedicationDay = mock<typeof actualMedications.readMedicationDay>(async () => dayResult())
const saveMedicationDose = mock<typeof actualMedications.saveMedicationDose>(async () => SAVED_LOG)
const clearMedicationDose = mock<typeof actualMedications.clearMedicationDose>(async () => {})
mock.module('../../src/lib/medication/medications', () => ({ ...actualMedications, readMedicationDay, saveMedicationDose, clearMedicationDose }))

// ── 離線佇列 hook 替身：回傳值每次 render 都從 pendingHook 讀，測試改它再 rerender 就能模擬「補送完成」等狀態 ───
type PendingDoses = ReturnType<typeof useMedicationPendingDoses>
type PendingOptions = Parameters<typeof useMedicationPendingDoses>[0]
const queueDose = mock<PendingDoses['queueDose']>(() => true)
const cancelPendingDose = mock<PendingDoses['cancelPendingDose']>(() => 'withdrawn')
const discardWithdrawal = mock<PendingDoses['discardWithdrawal']>(async () => true)
const prepareRecheck = mock<PendingDoses['prepareRecheck']>(async () => 'no-withdrawal')
const reconcileWithServer = mock<PendingDoses['reconcileWithServer']>(() => {})
const pendingHook = {
  pendingLogs: [] as MedicationIntakeLog[],
  withdrawnDoses: [] as PendingMedicationDose[],
  syncingDoseKey: null as string | null,
  cleanupError: false,
  // 頁面每次 render 傳進來的選項；onSynced 要用它模擬「補送結果回來」。
  options: null as PendingOptions | null,
}
mock.module('../../src/features/medication/hooks/useMedicationPendingDoses', () => ({
  useMedicationPendingDoses: (options: PendingOptions): PendingDoses => {
    pendingHook.options = options
    return {
      enabled: true,
      pendingCount: pendingHook.pendingLogs.length + pendingHook.withdrawnDoses.length,
      pendingLogs: pendingHook.pendingLogs,
      withdrawnDoses: pendingHook.withdrawnDoses,
      syncingDoseKey: pendingHook.syncingDoseKey,
      refreshingDoseKeys: new Set<string>(),
      syncing: false,
      lastAttemptAt: null,
      syncError: false,
      cleanupError: pendingHook.cleanupError,
      supersededCount: 0,
      controlledCorrectionCount: 0,
      dismissSuperseded: () => {},
      retryNow: async () => {},
      queueDose,
      cancelPendingDose,
      discardWithdrawal,
      prepareRecheck,
      reconcileWithServer,
      confirmExternalRefresh: () => {},
    }
  },
}))

const { MedicationPage } = await import('../../src/features/medication/pages/MedicationPage')
const { MedicationSlotCard } = await import('../../src/features/medication/components/MedicationSlotCard')
const { MedicationCancelDoseDialog } = await import('../../src/features/medication/components/MedicationCancelDoseDialog')
const { MedicationCompletionDialog } = await import('../../src/features/medication/components/MedicationCompletionDialog')
const { buildPendingMedicationDose, pendingMedicationDoseToLog } = await import('../../src/lib/medication/medicationPendingQueue')

// ── 固定時間與資料 ──────────────────────────────────────────────────────────
// 台北 10:00：照護日 2026-10-06，離 04:00 換日很遠，測試不會碰到跨日。
const NOW = '2026-10-06T02:00:00.000Z'
const TODAY = '2026-10-06'
const MORNING = '2026-10-06T00:00:00.000Z'
const OWNER = 'care@example.com'

// 只排一劑：打卡這一劑就會讓整個時段完成，才看得出「完成提示」有沒有在不該跳的時候跳出來。
const PLAN = {
  id: 'plan-morning', account_email: 'owner@example.com', patient_id: 'patient-a', medication_id: 'norvasc-5',
  schedule_slot: 'morning', as_needed: false, dose_amount: 1, dose_count: 1, display_order: 10, active: true,
  created_at: '2026-07-11T00:00:00.000Z',
  medication: { id: 'norvasc-5', brand_name: 'Norvasc', brand_name_zh: '脈優', generic_name: 'amlodipine', strength_mg: 5, dosage_form: 'tablet', atc_code: null },
  instruction: null,
} as unknown as MedicationPlanView
const OTHER_PLAN = { ...PLAN, id: 'plan-noon', schedule_slot: 'noon', display_order: 20 } as unknown as MedicationPlanView

const pendingDose = (plan = PLAN, takenAt = MORNING, withdrawn = false): PendingMedicationDose => ({ ...buildPendingMedicationDose(plan, 1, OWNER, takenAt), ...(withdrawn ? { withdrawn: true } : {}) })
const PENDING_LOG = pendingMedicationDoseToLog(pendingDose())
const OTHER_PENDING_LOG = pendingMedicationDoseToLog(pendingDose(OTHER_PLAN))
const SERVER_LOG: MedicationIntakeLog = { ...PENDING_LOG, id: 'row-server' }
const SAVED_LOG: MedicationIntakeLog = { ...PENDING_LOG, id: 'row-saved', taken_at: NOW }

function dayResult(overrides: Partial<DayResult> = {}): DayResult {
  return { plans: [PLAN, OTHER_PLAN], logs: [], prnEvents: [], prnAssessments: [], ...overrides } as DayResult
}

// supabase-js 的錯誤形狀（與 medicationPendingQueue.test.ts 同一套）：離線時是 status 0 的 'TypeError: Failed to fetch'，不是原生 TypeError。
const offlineError = () => ({ message: 'TypeError: Failed to fetch', details: '', hint: '', code: '', status: 0 })

// ── 頁面執行環境 ────────────────────────────────────────────────────────────
type PageProps = Parameters<typeof MedicationPage>[0]
let props: PageProps
const context = { defaultContext: { locale: 'zh' as const, setLocale: () => {} } }
const mounted: Array<{ unmount: () => void }> = []
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

/** 掛上頁面並等第一次讀取完成（readMedicationDay 若被測試卡住，就停在讀取中）。 */
async function mount() {
  const handle = renderHook(() => MedicationPage(props), context)
  mounted.push(handle)
  await settle()
  return handle
}
type Page = HookHandle<ReturnType<typeof MedicationPage>>

const slotCards = (tree: unknown) => findAll(tree, element => element.type === MedicationSlotCard)
const cancelDialog = (tree: unknown) => findAll(tree, element => element.type === MedicationCancelDoseDialog)[0]
const completionDialog = (tree: unknown) => findAll(tree, element => element.type === MedicationCompletionDialog)[0]
const alertText = (tree: unknown) => {
  const alert = findAll(tree, element => element.type === 'p' && element.props.role === 'alert')[0]
  return alert ? textContent(alert) : null
}
/** 藥卡實際拿到的服藥紀錄（伺服器讀回的＋待同步的），也就是畫面上「已服用」的依據。每張藥卡拿到的是同一份整天清單，取第一張即可。 */
const cardLogIds = (tree: unknown) => ((slotCards(tree)[0]?.props.logs ?? []) as MedicationIntakeLog[]).map(log => log.id)
const cancellationPending = (tree: unknown) => cancelDialog(tree).props.pending as { existing: MedicationIntakeLog } | null

/** 點某一劑的藥卡按鈕：沒有 existing 是打卡，有 existing 是開啟取消確認視窗。 */
async function tapDose(handle: Page, plan: MedicationPlanView, existing?: MedicationIntakeLog) {
  const card = slotCards(handle.current).find(item => (item.props.slotPlans as MedicationPlanView[]).some(slotPlan => slotPlan.id === plan.id))
  if (!card) throw new Error(`No slot card for ${plan.id}`)
  handle.act(() => { (card.props.onToggleDose as (...args: unknown[]) => void)(plan, 1, existing, undefined) })
  await settle()
}
async function confirmCancel(handle: Page) {
  handle.act(() => { fire(cancelDialog(handle.current), 'onConfirm') })
  await settle()
}
/** 模擬補送一輪結束後 hook 回報結果；頁面要判斷這些結果是不是屬於目前畫面。 */
async function emitSynced(result: { recorded?: MedicationIntakeLog[]; withdrawn?: PendingMedicationDose[] }) {
  pendingHook.options?.onSynced({ recorded: result.recorded ?? [], withdrawn: result.withdrawn ?? [] })
  await settle()
}

let consoleError: ReturnType<typeof spyOn>
beforeEach(() => {
  setSystemTime(new Date(NOW))
  // 頁面在每個失敗分支都會 console.error；測試要驗的是畫面，不要讓輸出淹掉真正的失敗訊息。
  consoleError = spyOn(console, 'error').mockImplementation(() => {})
  for (const fn of [readMedicationDay, saveMedicationDose, clearMedicationDose, queueDose, cancelPendingDose, discardWithdrawal, prepareRecheck, reconcileWithServer]) fn.mockClear()
  readMedicationDay.mockImplementation(async () => dayResult())
  saveMedicationDose.mockImplementation(async () => SAVED_LOG)
  clearMedicationDose.mockImplementation(async () => {})
  queueDose.mockImplementation(() => true)
  cancelPendingDose.mockImplementation(() => 'withdrawn')
  discardWithdrawal.mockImplementation(async () => true)
  prepareRecheck.mockImplementation(async () => 'no-withdrawal')
  pendingHook.pendingLogs = []
  pendingHook.withdrawnDoses = []
  pendingHook.syncingDoseKey = null
  pendingHook.cleanupError = false
  pendingHook.options = null
  props = {
    manageablePatients: [], ownPatientId: 'patient-a', selectedPatientId: 'patient-a', availablePatients: [],
    userEmail: OWNER, onSubjectSelect: () => {}, embedded: true,
  }
})
afterEach(() => {
  // 卸載才會清掉頁面每秒檢查換日的計時器，否則測試程序會被它拖住。
  while (mounted.length) mounted.pop()?.unmount()
  consoleError.mockRestore()
  setSystemTime()
})

// ════════════════════════════════════════════════════════════════════════════
describe('MedicationPage toggleDose: only a retryable failure is queued (issue #1131)', () => {
  test('a dose without a withdrawal saves online once after checking the queue and is shown immediately', async () => {
    // 只比對「有呼叫」抓不到順序調換；必須確認佇列檢查早於一般線上寫入。
    // 舊撤回另走持久佇列；這個控制組沒有撤回，確認檢查先於一般線上寫入。
    let preparesSeenWhenSaveStarted = -1
    saveMedicationDose.mockImplementation(async () => {
      preparesSeenWhenSaveStarted = prepareRecheck.mock.calls.length
      return SAVED_LOG
    })
    const handle = await mount()
    await tapDose(handle, PLAN)

    expect(preparesSeenWhenSaveStarted).toBe(1)
    expect(prepareRecheck).toHaveBeenCalledWith(PLAN, 1, NOW)
    expect(saveMedicationDose).toHaveBeenCalledTimes(1)
    expect(queueDose).not.toHaveBeenCalled()
    expect(cardLogIds(handle.current)).toEqual(['row-saved'])
    expect(alertText(handle.current)).toBeNull()
    expect(completionDialog(handle.current).props.slot).toBe('morning')
  })

  test('a peer-held withdrawal prevents an online save and leaves a clear waiting message', async () => {
    prepareRecheck.mockImplementation(async () => 'blocked')
    const handle = await mount()
    await tapDose(handle, PLAN)
    expect(saveMedicationDose).not.toHaveBeenCalled()
    expect(queueDose).not.toHaveBeenCalled()
    expect(alertText(handle.current)).toContain('尚未確認上一筆撤回')
    expect(slotCards(handle.current)[0].props.busyKey).toBe('')
  })

  test('waiting for withdrawal cleanup disables repeat taps and does not save after an account switch', async () => {
    let release = (_value: 'no-withdrawal') => {}
    prepareRecheck.mockImplementation(() => new Promise<'no-withdrawal'>(resolve => { release = resolve }))
    const handle = await mount()
    await tapDose(handle, PLAN)
    expect(slotCards(handle.current)[0].props.busyKey).toBe('plan-morning:1')
    await tapDose(handle, PLAN)
    expect(prepareRecheck).toHaveBeenCalledTimes(1)
    props = { ...props, userEmail: 'other@example.com' }
    handle.rerender()
    release('no-withdrawal'); await settle()
    expect(saveMedicationDose).not.toHaveBeenCalled()
    expect(queueDose).not.toHaveBeenCalled()
  })

  test('a persisted re-check intent never falls through to an unqueued foreground POST', async () => {
    prepareRecheck.mockImplementation(async () => 'queued')
    const handle = await mount(); await tapDose(handle, PLAN)
    expect(saveMedicationDose).not.toHaveBeenCalled()
    expect(queueDose).not.toHaveBeenCalled()
    expect(alertText(handle.current)).toBeNull()
    expect(completionDialog(handle.current).props.slot).toBe('morning')
  })

  test('failed re-check persistence keeps the withdrawal and shows a storage error', async () => {
    prepareRecheck.mockImplementation(async () => 'storage-error')
    const handle = await mount(); await tapDose(handle, PLAN)
    expect(saveMedicationDose).not.toHaveBeenCalled()
    expect(queueDose).not.toHaveBeenCalled()
    expect(alertText(handle.current)).toContain('撤回標記仍保留')
  })

  test('post-RPC cleanup refreshes confirmed facts immediately and surfaces local cleanup failure', async () => {
    let release = (_value: boolean) => {}
    discardWithdrawal.mockImplementation(() => new Promise<boolean>(resolve => { release = resolve }))
    const handle = await mount()
    handle.act(() => { (slotCards(handle.current)[0].props.onHoldChanged as (plan: MedicationPlanView, number: number, action: string) => void)(PLAN, 1, 'taken') })
    await settle()
    expect(readMedicationDay).toHaveBeenCalledTimes(2)
    pendingHook.cleanupError = true
    release(false); await settle(); handle.rerender()
    expect(alertText(handle.current)).toContain('服藥確認或更正結果已儲存')
    expect(readMedicationDay).toHaveBeenCalledTimes(2)
  })

  test.each([
    ['dropped connection (supabase-js error shape, status 0)', offlineError()],
    ['server unavailable (503)', { message: 'upstream unavailable', code: '', status: 503 }],
    ['rate limited (429)', { message: 'too many requests', code: '', status: 429 }],
  ])('%s is queued with the very moment the button was pressed, and the caregiver is not shown an error', async (_name, error) => {
    saveMedicationDose.mockRejectedValue(error)
    const handle = await mount()
    await tapDose(handle, PLAN)

    expect(queueDose).toHaveBeenCalledTimes(1)
    // 補送要沿用按下去的那一刻，照護日才不會因為晚送而被算到另一天，補送讀回「其實已寫入」的那筆時也才認得出是自己。
    expect(saveMedicationDose.mock.calls[0][4]).toBe(NOW)
    expect(queueDose.mock.calls[0]).toEqual([PLAN, 1, NOW])
    expect(alertText(handle.current)).toBeNull()
    // 排進佇列也算完成這一劑：藥確實吃了，完成提示照常出現。
    expect(completionDialog(handle.current).props.slot).toBe('morning')
    // 結果回來前藥卡不能一直卡在忙碌狀態。
    expect(slotCards(handle.current)[0].props.busyKey).toBe('')
  })

  test.each([
    ['row-level security refusal', { message: 'new row violates row-level security policy', code: '42501', status: 403 }],
    ['expired login (401)', { message: 'JWT expired', code: '', status: 401 }],
    ['data rule violation', { message: 'check constraint violated', code: '23514', status: 400 }],
    ['unknown column (PGRST204)', { message: 'Could not find the column in the schema cache', code: 'PGRST204', status: 400 }],
  ])('%s shows the error and is NOT queued, because resending it can never succeed', async (_name, error) => {
    saveMedicationDose.mockRejectedValue(error)
    const handle = await mount()
    await tapDose(handle, PLAN)

    expect(queueDose).not.toHaveBeenCalled()
    expect(alertText(handle.current)).not.toBeNull()
    // 沒有寫進任何地方，就不能出現「已服用」或「這一餐完成了」。
    expect(cardLogIds(handle.current)).toEqual([])
    expect(completionDialog(handle.current).props.slot).toBeNull()
    expect(slotCards(handle.current)[0].props.busyKey).toBe('')
  })

  test('when this phone cannot store the queued dose either, the error is shown instead of pretending it was recorded', async () => {
    saveMedicationDose.mockRejectedValue(offlineError())
    queueDose.mockImplementation(() => false)
    const handle = await mount()
    await tapDose(handle, PLAN)

    expect(queueDose).toHaveBeenCalledTimes(1)
    expect(alertText(handle.current)).toBe('同步失敗，請確認網路後再試。')
    expect(cardLogIds(handle.current)).toEqual([])
    expect(completionDialog(handle.current).props.slot).toBeNull()
    // 看護可以馬上再按一次，不會被卡死。
    expect(slotCards(handle.current)[0].props.busyKey).toBe('')
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('MedicationPage clearDose: cancelling a pending dose never deletes on the server (issue #1131)', () => {
  test.each([
    ['withdrawn', null],
    ['not-pending', null],
    ['syncing', '正在送出'],
    ['storage-error', '本機儲存無法寫入'],
  ] as const)('outcome %s', async (outcome, expectedAlert) => {
    cancelPendingDose.mockImplementation(() => outcome)
    pendingHook.pendingLogs = [PENDING_LOG]
    const handle = await mount()
    await tapDose(handle, PLAN, PENDING_LOG)
    expect(cancellationPending(handle.current)?.existing).toBe(PENDING_LOG)

    await confirmCancel(handle)

    // 走佇列撤回，用的是那一劑自己的照護日；絕不碰伺服器——伺服器上那筆（若有）可能是別人記錄的，看護確認的只是她自己那一筆。
    expect(cancelPendingDose.mock.calls).toEqual([['plan-morning', 1, TODAY]])
    expect(clearMedicationDose).not.toHaveBeenCalled()
    expect(cancellationPending(handle.current)).toBeNull()
    if (expectedAlert) expect(alertText(handle.current)).toContain(expectedAlert)
    else expect(alertText(handle.current)).toBeNull()
  })

  test('a successful withdrawal clears an earlier error message', async () => {
    saveMedicationDose.mockRejectedValue({ message: 'JWT expired', code: '', status: 401 })
    pendingHook.pendingLogs = [PENDING_LOG]
    const handle = await mount()
    await tapDose(handle, OTHER_PLAN)
    expect(alertText(handle.current)).not.toBeNull()

    await tapDose(handle, PLAN, PENDING_LOG)
    await confirmCancel(handle)
    expect(alertText(handle.current)).toBeNull()
  })

  test('control: a dose already saved on the server IS deleted there (so the assertions above are not vacuous)', async () => {
    readMedicationDay.mockImplementation(async () => dayResult({ logs: [SERVER_LOG] }))
    const handle = await mount()
    expect(cardLogIds(handle.current)).toEqual(['row-server'])
    await tapDose(handle, PLAN, SERVER_LOG)
    await confirmCancel(handle)

    expect(clearMedicationDose.mock.calls).toEqual([['plan-morning', 'patient-a', TODAY, 1]])
    expect(cancelPendingDose).not.toHaveBeenCalled()
    expect(cardLogIds(handle.current)).toEqual([])
    expect(alertText(handle.current)).toBeNull()
  })

  test('the confirm button is disabled and ignored while the dose it is about is being sent', async () => {
    pendingHook.pendingLogs = [PENDING_LOG]
    pendingHook.syncingDoseKey = 'plan-morning:1'
    const handle = await mount()
    await tapDose(handle, PLAN, PENDING_LOG)
    expect(cancelDialog(handle.current).props.busy).toBe(true)

    await confirmCancel(handle)
    expect(cancelPendingDose).not.toHaveBeenCalled()
    expect(clearMedicationDose).not.toHaveBeenCalled()
    // 視窗維持開著：送出結果回來前，撤回本機那筆不代表伺服器沒收到。
    expect(cancellationPending(handle.current)).not.toBeNull()

    // 正在送出的是另一劑時，這一劑不受影響。
    pendingHook.syncingDoseKey = 'plan-noon:1'
    expect(cancelDialog(handle.rerender()).props.busy).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('MedicationPage cancel dialog closes itself when its pending dose is gone (issue #1131)', () => {
  test('the dose syncs while the dialog is open: dialog closes, the card shows the server row, nothing is deleted', async () => {
    // 佇列裡還有別的待同步劑次：視窗要看的是「它那一劑」還在不在，不是佇列空了沒有。
    pendingHook.pendingLogs = [PENDING_LOG, OTHER_PENDING_LOG]
    const handle = await mount()
    await tapDose(handle, PLAN, PENDING_LOG)
    expect(cancellationPending(handle.current)).not.toBeNull()

    pendingHook.pendingLogs = [OTHER_PENDING_LOG]
    await emitSynced({ recorded: [SERVER_LOG] })

    expect(cancellationPending(handle.current)).toBeNull()
    expect(cardLogIds(handle.current)).toEqual(['row-server', OTHER_PENDING_LOG.id])
    expect(cancelPendingDose).not.toHaveBeenCalled()
    expect(clearMedicationDose).not.toHaveBeenCalled()
  })

  test('the server already had that dose and replaced the pending copy: dialog closes without a sync result', async () => {
    pendingHook.pendingLogs = [PENDING_LOG]
    const handle = await mount()
    await tapDose(handle, PLAN, PENDING_LOG)
    expect(cancellationPending(handle.current)).not.toBeNull()

    // 對帳把佇列裡那筆移掉（server-wins）；頁面沒有收到 onSynced，只看得到 pendingLogs 變了。
    pendingHook.pendingLogs = []
    handle.rerender()

    expect(cancellationPending(handle.current)).toBeNull()
    expect(clearMedicationDose).not.toHaveBeenCalled()
  })

  test('control: other pending doses changing does not close a dialog whose dose is still pending', async () => {
    pendingHook.pendingLogs = [PENDING_LOG, OTHER_PENDING_LOG]
    const handle = await mount()
    await tapDose(handle, PLAN, PENDING_LOG)

    pendingHook.pendingLogs = [PENDING_LOG]
    handle.rerender()
    expect(cancellationPending(handle.current)?.existing).toBe(PENDING_LOG)
  })

  test('control: a dialog about a dose already saved on the server stays open although the pending queue is empty', async () => {
    readMedicationDay.mockImplementation(async () => dayResult({ logs: [SERVER_LOG] }))
    const handle = await mount()
    await tapDose(handle, PLAN, SERVER_LOG)

    expect(pendingHook.pendingLogs).toEqual([])
    expect(cancellationPending(handle.current)?.existing).toBe(SERVER_LOG)
    handle.rerender()
    expect(cancellationPending(handle.current)?.existing).toBe(SERVER_LOG)
  })
})

// ════════════════════════════════════════════════════════════════════════════
describe('MedicationPage re-applies sync results that arrive while the day is still loading (issue #1131)', () => {
  /** 讓 readMedicationDay 卡住，測試自己決定什麼時候讓伺服器回應；每次讀取（含換病人）各有一個開關。 */
  function gateLoads() {
    const releases: Array<(result: DayResult) => void> = []
    readMedicationDay.mockImplementation(() => new Promise<DayResult>(resolve => { releases.push(resolve) }))
    return releases
  }

  test('a dose synced during the load stays taken even though the (older) server response does not have it yet', async () => {
    const releases = gateLoads()
    const handle = await mount()
    expect(releases).toHaveLength(1)

    await emitSynced({ recorded: [SERVER_LOG] })
    releases[0](dayResult({ logs: [] }))
    await settle()

    expect(cardLogIds(handle.current)).toEqual(['row-server'])
    // 對帳用的是伺服器原始回應，不是補上補送結果之後的版本。
    expect(reconcileWithServer.mock.calls).toEqual([[[], 'patient-a']])
  })

  test('background refresh replays a different medication synced after its stale read started', async () => {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    let onFocus: (() => void) | undefined
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {
      setTimeout, addEventListener: (name: string, callback: () => void) => { if (name === 'focus') onFocus = callback }, removeEventListener: () => {},
    } })
    try {
      // A 藥啟動背景確認；B 藥仍可正常離線補送，不能被晚到的舊讀取覆蓋。
      const guarded = { ...OTHER_PLAN, holdContext: { state: 'unrestricted', rule: null, reading: null, hold: null, rule_day: TODAY, starts_at: NOW, ends_at: '2026-10-07T00:00:00Z', server_now: NOW } } as MedicationPlanView
      readMedicationDay.mockImplementation(async () => dayResult({ plans: [PLAN, guarded] }))
      const handle = await mount()
      const releases = gateLoads()
      onFocus?.()
      await settle()
      expect(releases).toHaveLength(1)
      await emitSynced({ recorded: [SERVER_LOG] })
      releases[0](dayResult({ plans: [PLAN, guarded], logs: [] }))
      await settle()
      expect(cardLogIds(handle.current)).toContain('row-server')
    } finally {
      while (mounted.length) mounted.pop()?.unmount()
      if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  })

  test('a recovered controlled intake remains recorded when a stale full-day read returns empty', async () => {
    const releases = gateLoads()
    const handle = await mount()
    // 受控 guard 回讀交棒的是服藥事實；完整日讀取已開始時不能把這個確定結果蓋成未服用。
    await emitSynced({ recorded: [{ ...SERVER_LOG, hold_event_id: 'taken-event' } as typeof SERVER_LOG] })
    releases[0](dayResult({ logs: [] }))
    await settle()
    expect(cardLogIds(handle.current)).toContain('row-server')
  })

  test('a withdrawal delivered during the load hides the caregiver\'s own server row that the load still returned', async () => {
    const releases = gateLoads()
    const handle = await mount()

    await emitSynced({ withdrawn: [pendingDose(PLAN, MORNING, true)] })
    releases[0](dayResult({ logs: [SERVER_LOG] }))
    await settle()

    expect(cardLogIds(handle.current)).toEqual([])
  })

  test('results for another patient or another care day are not mixed into this screen', async () => {
    const handle = await mount()
    expect(cardLogIds(handle.current)).toEqual([])

    await emitSynced({ recorded: [{ ...SERVER_LOG, patient_id: 'patient-b' }, { ...SERVER_LOG, id: 'row-yesterday', care_date: '2026-10-05' }] })
    expect(cardLogIds(handle.current)).toEqual([])
  })

  test('a result that arrived before switching patients is not replayed onto the new patient\'s load', async () => {
    const releases = gateLoads()
    const handle = await mount()
    await emitSynced({ recorded: [SERVER_LOG] })

    props = { ...props, selectedPatientId: 'patient-b' }
    handle.rerender()
    await settle()
    expect(releases).toHaveLength(2)
    releases[0](dayResult({ logs: [] }))
    releases[1](dayResult({ logs: [] }))
    await settle()

    expect(cardLogIds(handle.current)).toEqual([])
  })

  test('control: a result that arrives after the load is applied straight onto the cards', async () => {
    const handle = await mount()
    expect(cardLogIds(handle.current)).toEqual([])

    await emitSynced({ recorded: [SERVER_LOG] })
    expect(cardLogIds(handle.current)).toEqual(['row-server'])
  })
})
