/*
檔案用途：血壓離線佇列的常駐補送器（issue #1138）——只要登入就一直在，不管看護停在哪個分頁、哪個區段，
  連線恢復／回前景／退避重試時都會補送這個帳號所有照護對象的待送血壓並通知家屬；同一時間只有一個補送器在跑
  （同分頁靠觸發器 hook 的防重入，跨分頁靠 Web Locks），並把「家人可能沒收到」的結果放到看得到的地方。
所在層：src/features/vitals/hooks；狀態容器 hook（AGENTS.md Rule A），由 BloodPressureQueueProvider 掛在 App 殼層，
  輸入頁的表單 hook 經 context 讀它的狀態、按「現在同步」、並在掛載期間登記成「這筆」提示的主人（screen）。
主要關聯：lib/bloodPressurePendingQueue（佇列讀寫與補送）、lib/bloodPressureRecords（冪等 INSERT）、lib/telegramNotification（家屬通知）、
  hooks/usePendingWriteFlush（什麼時候補送）、useBloodPressureInputForm（畫面、「這筆」提示、線上儲存）、useBpEvaluator（畫面上這位的判讀標準）。

為什麼搬出表單 hook：補送原本住在 useBloodPressureInputForm，而那個 hook 只在每日照護頁的血壓區段掛載。看護離線存了 185/105、
切到今天頁，連線恢復時沒有任何監聽器在，家人要等有人再打開血壓區段才收到通知（issue #1138）。
*/
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useBpEvaluator } from './useBpEvaluator'
import { usePerKeyStoreState } from './usePerKeyStoreState'
import { createNotifyProblemsStore, createRejectedSavesStore } from '../lib/bloodPressureShellNoticeStores'
import { useI18n } from '../../../lib/i18n'
import { isDemoMode } from '../../../lib/demoStorage'
import { trackFirstRecordSaved } from '../../../lib/analytics'
import { hasOtherBloodPressureRecord, insertBloodPressureRecord } from '../../../lib/bloodPressureRecords'
import {
  enqueuePendingBloodPressureRecord,
  flushAllPendingBloodPressureRecords,
  isPendingBloodPressureStorageKey,
  readAllPendingBloodPressureRecords,
  readPendingBloodPressureRecords,
  type PendingBloodPressureFlushResult,
  type PendingBloodPressureRecord,
} from '../../../lib/bloodPressurePendingQueue'
import { isPermissionError } from '../../../lib/dataErrors'
import type { LocalizedText } from '../../../lib/i18n'
import { usePendingWriteFlush } from '../../../hooks/usePendingWriteFlush'
import {
  pollDirectDeliveryStatus,
  readPersonalDeliveryState,
  sendTelegramNotification,
  type PersonalDeliveryState,
  type TelegramNotificationResult,
} from '../../../lib/telegramNotification'
import type { FamilyDeliveryState } from '../components/BpSaveNotices'
import type { LimitBlockedReading } from '../components/BpLimitBlockedNotice'
import { isFamilyAlertLevelReading, queuedRejectionText } from '../pages/InputPage.utils'

// 手機自認有網路、補送卻一直暫時性失敗多久之後，改說「有網路但連不到伺服器」（issue #1125）。
// 太短會把收訊差的電梯口誤判成被擋；兩分鐘大約是退避排程的第三次嘗試（立即、30 秒、再 2 分鐘），
// 已經不是一兩次偶發的掉線。
export const PENDING_UNREACHABLE_AFTER_MS = 2 * 60_000

// 一旦連續兩次失敗之間隔了這麼久（例如 App 在背景好幾小時、這段期間沒有任何嘗試），中間的狀況不明，重新計時；
// 否則醒來後第一次偶發失敗就會被算成「已經連不到好幾小時」。比最長退避（10 分鐘）長，持續被擋時不會被誤重置。
const PENDING_UNREACHABLE_GAP_RESET_MS = 15 * 60_000

// 跨分頁的補送鎖名稱（Web Locks API）。兩個分頁各自讀到 notified: false 就會對同一筆各送一次通知請求：
// 伺服器帳本（ADR-007）會去重，家人不會收到兩則，但每個分頁都會短暫顯示「正在同步」、多打一倍請求（issue #1138）。
const FLUSH_LOCK_NAME = 'jia-jian.pending-blood-pressure.flush'

const NO_RECORDS: PendingBloodPressureRecord[] = []
/** 瀏覽器分頁在前景嗎；沒有 document（原生殼以外的測試環境）當成在前景。 */
export function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * 這個帳號的待送清單：畫面上這位直接讀她自己的桶，其他人才靠列舉。localStorage.key 不可用（舊 WebView、受限的儲存替身）時
 * 列舉會落空，眼前這位的待送清單不能因此消失（與共用佇列 flushAll 的 remaining 同一個理由）。
 */
function readQueueRecords(enabled: boolean, owner: string, patientId: string): PendingBloodPressureRecord[] {
  if (!enabled) return NO_RECORDS
  const mine = readPendingBloodPressureRecords(patientId, owner)
  const others = readAllPendingBloodPressureRecords(owner).filter(record => record.patient_id !== patientId)
  return mine.length + others.length === 0 ? NO_RECORDS : [...mine, ...others]
}

/**
 * 一筆待送讀數需不需要通知家人；undefined＝不知道（issue #1126 的判讀順序，issue #1125 抽出來共用）。
 * evaluator 只能是**這筆紀錄自己病人**的標準：畫面上那位的紀錄才傳，別人的紀錄傳 null，只看入佇列時用那位自己的標準
 * 記下的 family_alert——拿畫面上這位的標準評別人的數值，等於用 B 的目標判讀 A（§ 3.5）。
 */
export function queuedRecordAlertLevel(
  record: PendingBloodPressureRecord,
  evaluator: Pick<ReturnType<typeof useBpEvaluator>, 'evaluateAt'> | null,
): boolean | undefined {
  if (evaluator) {
    const evaluation = evaluator.evaluateAt(record.systolic, record.diastolic, record.pulse, record.measured_at)
    if (!evaluation.resolved.unavailable) return isFamilyAlertLevelReading(evaluation)
  }
  return record.family_alert
}

// 送達結果寫不進「這筆」的提示時，哪些結果要改用點名提示（issue #1125）。
// 與 BpSaveNotices 的 URGENT_FAMILY_DELIVERY 同一組，但扣掉「個人通知已送達」：那兩種畫面上的文案本來就不要看護打電話
// （家人已經收到了），點名提示卻會說「請直接聯絡家人」，等於多叫一通不必要的電話（北極星鐵律 3）。
export function familyMayNotKnow(state: FamilyDeliveryState): boolean {
  return state !== 'idle' && state !== 'in_progress' && state !== 'unconfirmed_personal_delivered' && state !== 'not_sent_personal_delivered'
}

/**
 * 兩條送出路徑（線上、離線補送）共用同一套送達結果處理：先問 isCurrent，再依 sharedDelivery 把狀態交給 onState。
 * in_progress 時回看帳本：持續重查到終局或 M 到期；回看期間畫面顯示「送出中」，不是成功。
 * onState 由呼叫端分流：寫進「這筆」的提示，或（那筆不在它的病人畫面上時）改成點名提示。
 */
export function applyFamilyDeliveryResult(
  result: TelegramNotificationResult,
  request: { recordId: string; patientId: string },
  isCurrent: () => boolean,
  onState: (state: FamilyDeliveryState) => void,
): void {
  if (!isCurrent()) return
  // 個人化通知已排入時，「沒送」「不明」只指共用群組那一則。
  // 有任何一則個人通知不明就以不明為準（PR #988 Codex P2）：混合結局（一位在路上、一位不明）不能承諾「會自動送出」。
  // 優先序：不明 > 在路上 > 已送達 > 沒有個人通知。已送達（drain 已 sent）不能說「已排入、會自動送出」（PR #988 Codex P2）。
  const notSentFor = (personal: PersonalDeliveryState) => (personal.personalUnknown ? 'not_sent_personal_unknown' : personal.personalQueued ? 'not_sent_personal_queued' : personal.personalDelivered ? 'not_sent_personal_delivered' : 'not_sent')
  const unconfirmedFor = (personal: PersonalDeliveryState) => (personal.personalUnknown ? 'unconfirmed_personal_unknown' : personal.personalQueued ? 'unconfirmed_personal_queued' : personal.personalDelivered ? 'unconfirmed_personal_delivered' : 'unconfirmed')
  if (result.sharedDelivery === 'in_progress') {
    onState('in_progress')
    // 期限用伺服器算好的剩餘時長（PR #988 Codex P2），只跟自己的時鐘比；沒帶就退回完整的 M。
    void pollDirectDeliveryStatus(request, result.sharedRemainingMs !== null ? { deadlineMs: result.sharedRemainingMs } : {}).then(async outcome => {
      if (!isCurrent()) return
      if (outcome === 'delivered') {
        onState('idle')
        return
      }
      // 回看可能長達 M，回看前的個人快照可能已被 drain 改掉（PR #988 Codex P2）：用最終共用結果重新讀一次個人狀態；
      // 讀不到就當「個人那一則不明」——不能拿舊快照承諾「會自動送出」。
      const personal = await readPersonalDeliveryState(request).catch((): PersonalDeliveryState => ({ personalQueued: false, personalUnknown: true, personalDelivered: false }))
      if (!isCurrent()) return
      onState(outcome === 'failed' ? notSentFor(personal) : unconfirmedFor(personal))
    })
    return
  }
  if (result.sharedDelivery === 'unknown') onState(unconfirmedFor(result))
  else if (result.sharedDelivery === 'failed') onState(notSentFor(result))
  // 未訂閱共用群組、個人那一則又不明：沒有任何一則被確認送達，不能什麼都不說（PR #988 Codex P2）。
  else if (result.sharedDelivery === 'not_subscribed' && result.personalUnknown) onState('personal_unknown')
}

export interface PendingRejection {
  /** 狀態列要講的原因（三語）。 */
  text: LocalizedText
  /**
   * 再試也不會成功嗎（每日上限、資料格式）。權限類（401／403／42501）不算：登入過期，或 token 換新那一下剛好失敗、
   * supabase-js 退回 anon key 送出時都長這樣，重新登入或下一輪就可能成功，所以仍照常退避重試、仍算「在等」
   * （審查發現：一律當成定局時，這種讀數就停在佇列裡等外部事件，staging 原本會自己在 30 秒／2 分鐘後再試）。
   */
  settled: boolean
}

/**
 * 一輪補送後，各待送紀錄「被伺服器拒絕的原因」（issue #1125）。
 * 這一輪被永久拒絕的寫入新原因；已不在佇列的（送到了、被移除）丟掉；這一輪沒嘗試到的保留上一輪的原因，
 * 否則前面一筆先斷線時，後面那筆的原因會一下有一下沒有。這一輪又試過、而且是暫時性失敗的丟掉舊原因：
 * 舊原因已不是現況（例如當時登入過期、現在只是斷線），留著會讓它被當成定局而不再自動重試。
 */
export function nextPendingRejections(
  previous: Readonly<Record<string, PendingRejection>>,
  result: Pick<PendingBloodPressureFlushResult, 'remaining' | 'failures'>,
): Record<string, PendingRejection> {
  const stillQueued = new Set(result.remaining.map(record => record.id))
  const retriedTemporarily = new Set(result.failures.filter(failure => failure.retryable).map(failure => failure.record.id))
  const next: Record<string, PendingRejection> = {}
  for (const [id, rejection] of Object.entries(previous)) {
    if (stillQueued.has(id) && !retriedTemporarily.has(id)) next[id] = rejection
  }
  for (const failure of result.failures) {
    if (failure.retryable || !stillQueued.has(failure.record.id)) continue
    next[failure.record.id] = { text: queuedRejectionText(failure.error), settled: !isPermissionError(failure.error) }
  }
  return next
}

/**
 * 補送期間掛著的血壓輸入畫面（issue #1138 的訂閱橋）。補送器不知道畫面上有沒有輸入頁、也不知道誰擁有「這筆」的提示，
 * 所以把兩個決定交給畫面：補送這筆的通知前先 claimNotice，畫面若判定這筆的病人就在眼前就領一個序號並回傳
 * 「結果回來時還擁有提示嗎」；沒有畫面、或畫面說不是它的，結果一律改走點名提示（flagNotifyProblem），不會被吞掉。
 */
export interface BloodPressureQueueScreen {
  /** 這筆補送的紀錄現在在畫面上嗎？是的話領「這筆」提示的序號並回傳擁有權判斷；不是回 null。 */
  claimNotice: (recordPatientId: string) => (() => boolean) | null
  onFamilyAlertSkipped: () => void
  onFamilyDelivery: (state: FamilyDeliveryState) => void
  onNotifyFailed: () => void
  /** 這一輪送到的紀錄（每筆帶自己的 patient_id）；畫面用它重抓今日清單與最新讀值、補第一筆埋點。 */
  onSynced: (records: readonly PendingBloodPressureRecord[]) => void
}

/**
 * 看護離開頁面或換了病人之後才被拒絕的線上儲存（issue #1117）。輸入頁已卸載、或畫面上已是別人，這個結果寫不進任何畫面；
 * 以前直接丟掉（一筆可能是危險讀數的紀錄無聲消失，北極星鐵律 4）。現在交給殼層保管：回到那位病人的輸入頁就接手顯示，
 * 沒開輸入頁時殼層橫幅點名提醒。每一筆各自保留、各自清（以紀錄 id 為鍵）：連續兩筆都在離開後被拒絕時，
 * 後到的結果不能把先到的（可能是危險讀數加「請打電話」）蓋掉（PR #1219 Codex 第三輪 P1）。
 */
export interface RejectedBloodPressureSave {
  /** 被拒絕那筆的 client UUID；同一筆的結果只會回來一次，拿它當鍵、也拿它清。 */
  recordId: string
  patientId: string
  /** 原始錯誤；畫面顯示時才用 saveErrorMessage 轉成當下語言，不存已翻譯的字串（換語言後也要對）。 */
  error: unknown
  /** 被每日上限擋下時保留讀數，讓畫面能用這位的標準顯示等級、危險時請看護打電話；其他拒絕不留數值。 */
  limitBlockedReading: LimitBlockedReading | null
  /**
   * 結果不明（PR #1219 Codex P1）：寫入遇到暫時性失敗（含 15 秒逾時——伺服器可能其實已經寫入）、本機佇列又存不進去。
   * 這種不能叫看護「重新輸入」：新一筆會拿新的 UUID，資料庫裡可能就多了一筆；文案改成「先看今日紀錄，沒有再輸入」。
   */
  uncertain?: boolean
  /**
   * 被上限擋下的那筆是不是「要立刻聯絡家人」的等級（在輸入頁、用那位自己的標準判定後記下）。
   * 那位不在畫面上（已封存、切不到）時橫幅不能畫數值、也不能用別人的標準重判，只能靠這個旗標講「請直接打電話」（Codex 第四輪 P1）。
   */
  callFamily?: boolean
  /** 回來的時間（epoch ms）；橫幅與接手都依先到在前。 */
  at: number
}

export interface BloodPressureQueue {
  /** 這個帳號在這台裝置上所有病人的待送血壓；畫面只能顯示目前病人的數值，別人的只能算筆數（§ 3.5）。 */
  records: readonly PendingBloodPressureRecord[]
  syncing: boolean
  lastAttemptAt: number | null
  /** 最近一輪以暫時性失敗收場（斷線、5xx）：之後會自動再試，畫面講「網路」或「連不到伺服器」。 */
  retryFailed: boolean
  /** 手機自認有網路、暫時性失敗卻持續超過 PENDING_UNREACHABLE_AFTER_MS（issue #1125）。 */
  unreachable: boolean
  /** 被伺服器永久拒絕的待送紀錄 → 真正的原因，以紀錄 id 為鍵（issue #1125）。 */
  rejections: Readonly<Record<string, PendingRejection>>
  /**
   * 家人可能沒收到通知、但寫不進「這筆」提示的病人 id（issue #1125／#1138）：那筆的病人不在畫面上、輸入頁沒掛著、
   * 或那則提示已被較新的一筆接手。下一次儲存時清掉；換病人時刻意不清（看護在 B 看到「A：…」後切到 A 去處理時，提示不能正好消失）。
   */
  notifyProblems: readonly string[]
  /** 手動「現在同步」與自動觸發共用同一個防重入入口。 */
  retryNow: () => Promise<void>
  /** 線上儲存遇到暫時性失敗、剛把一筆放進佇列：重讀清單並讓狀態列講「請確認網路」。 */
  noteQueued: () => void
  flagNotifyProblem: (patientId: string) => void
  clearNotifyProblems: () => void
  /** 輸入頁掛載期間登記自己；卸載時傳 null。同一時間只會有一個輸入頁，後登記的蓋掉先前的。 */
  setScreen: (screen: BloodPressureQueueScreen | null) => void
  /** 離開頁面或換病人後才被拒絕的線上儲存（issue #1117），先到的在前；輸入頁接手或看護按「知道了」後逐筆清掉。 */
  rejectedSaves: readonly RejectedBloodPressureSave[]
  /** 瀏覽器分頁在前景嗎（visibilitychange 同步）；背景分頁不接手殼層保管的拒絕，前景分頁才看得到。 */
  documentVisible: boolean
  reportRejectedSave: (rejection: RejectedBloodPressureSave) => void
  clearRejectedSave: (recordId: string) => void
}

/**
 * 跨分頁只讓一個分頁跑這一輪（Web Locks）。拿不到鎖＝另一個分頁正在送，這一輪直接讓給它（whenHeld）；
 * 舊 WebView 沒有 navigator.locks 時退回不鎖，行為與以前相同。
 * locks.request 本身也可能拒絕（文件不是 fully active 時，例如 bfcache 還原途中的 pageshow 觸發，Chrome／WebKit 會丟
 * InvalidStateError／SecurityError）：那不是「別人持有鎖」，一樣退回不鎖直接跑，不能讓這一輪變成沒人處理的 rejected promise
 * （觸發器的退避排程在 await 之後，promise 一掉，這一輪就沒有下一輪，佇列裡的危險讀數要等下一個外部事件；PR #1218 審查）。
 * 鎖只在一輪補送期間持有，而每筆寫入都有 15 秒逾時（#1117），所以另一個分頁卡住最多讓這邊等一輪的長度，不會永遠讓。
 */
async function withFlushLock<T>(run: () => Promise<T>, whenHeld: () => T): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return run()
  // run() 丟出的例外要照樣往外傳（呼叫端自己 catch）；只有「取鎖這個動作」失敗才退回不鎖。
  let acquired: { held: boolean } | null = null
  try {
    return await locks.request(FLUSH_LOCK_NAME, { ifAvailable: true }, lock => {
      acquired = { held: lock !== null }
      return lock ? run() : Promise.resolve(whenHeld())
    })
  } catch (error) {
    if (acquired !== null) throw error
    console.warn('[blood pressure pending queue lock unavailable]', error)
    return run()
  }
}

export function useBloodPressureQueueCoordinator({ patientId, userEmail }: {
  /** 畫面上這位；補送時優先送她、她的紀錄可以用目前載入的判讀標準評等級。 */
  patientId: string
  userEmail?: string
}): BloodPressureQueue {
  const { locale } = useI18n()
  // 畫面上這位的判讀標準（App 殼層的 BpStandardProvider）；只能拿來評**這位**的紀錄，別人的只看入佇列時記下的 family_alert。
  const evaluator = useBpEvaluator()
  const evaluatorRef = useRef(evaluator)
  evaluatorRef.current = evaluator
  // 補送是非同步流程，結束時看護可能已切到別的病人；用 ref 讓結果以「現在」畫面上的病人為準。
  const patientIdRef = useRef(patientId)
  patientIdRef.current = patientId
  const owner = userEmail?.trim().toLowerCase() ?? ''
  // demo 模式或尚未取得登入者 email 時完全不需要離線佇列。
  const enabled = Boolean(owner) && !isDemoMode()

  // 第一次 render 就從本機讀，不等 effect：觸發器掛載時會立刻探測一次並排 30 秒退避，若 records 先是空的、effect 才補讀，
  // hasPending 會在探測之後才從 false 變 true、再觸發一次立即探測，把剛排好的 30 秒計時器清掉並推進到 2 分鐘，
  // 暫時性斷線時下一次補送與家屬通知平白晚 90 秒（PR #1218 Codex P2）。
  const [records, setRecords] = useState<PendingBloodPressureRecord[]>(() => readQueueRecords(enabled, owner, patientId))
  // 同步鏡像：storage 事件回呼要拿「事件前」的清單跟重讀後的比，才知道哪些是別的分頁送走的。
  const recordsRef = useRef(records)
  recordsRef.current = records
  const [retryFailed, setRetryFailed] = useState(false)
  const [unreachable, setUnreachable] = useState(false)
  const onlineFailureRef = useRef<{ since: number; last: number } | null>(null)
  // ref 是同一份資料的同步鏡像：一輪結束時要立刻用新結果判斷「還有沒有重試能修好的紀錄」，不能等下一次 render。
  const [rejections, setRejections] = useState<Record<string, PendingRejection>>({})
  const rejectionsRef = useRef<Record<string, PendingRejection>>({})
  // 兩種提示共用逐鍵保存與事件同步；codec 保留舊 namespace 與各自的讀回順序（#1227）。
  const notifyStore = useMemo(() => createNotifyProblemsStore(owner), [owner])
  const rejectedStore = useMemo(() => createRejectedSavesStore(owner), [owner])
  const { values: notifyProblems, add: flagNotifyProblem, clearAll: clearNotifyProblems } = usePerKeyStoreState(
    notifyStore, enabled, { mergeStoredOnWrite: true },
  )
  const { values: rejectedSaves, add: reportRejectedSave, remove: clearRejectedSave } = usePerKeyStoreState(
    rejectedStore, enabled, { sortOnStorageEvent: true },
  )
  // 分頁在不在前景（visibilitychange）：背景分頁不接手殼層保管的拒絕，否則會把別的分頁也看得到的那筆收進自己的 state。
  const [documentVisible, setDocumentVisible] = useState(() => isDocumentVisible())
  useEffect(() => {
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return
    const handleVisibility = () => setDocumentVisible(isDocumentVisible())
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [])
  const screenRef = useRef<BloodPressureQueueScreen | null>(null)

  // patientId 放進依賴：換病人要立刻讀新病人的桶，不等觸發器的重探測（demo 與測試替身不會重探測）。
  const refresh = useCallback(() => {
    setRecords(readQueueRecords(enabled, owner, patientId))
  }, [enabled, owner, patientId])

  useEffect(() => {
    refresh()
  }, [refresh])

  // 另一個分頁／視窗送完（或新存了一筆）會改 localStorage；storage 事件只在**其他**分頁觸發，正好用來同步這邊的清單，
  // 不然這個分頁要等自己的下一輪（最長 10 分鐘退避）才會發現「N 筆等待同步」早就送完了。
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const handleStorage = (event: StorageEvent) => {
      // key 為 null 是另一個分頁 localStorage.clear()：佇列也被清了，清單要跟著空（PR #1218 審查）。
      if (event.key === null || isPendingBloodPressureStorageKey(event.key)) {
        const before = recordsRef.current
        const after = readQueueRecords(enabled, owner, patientId)
        setRecords(after)
        // 別的分頁把紀錄送走了（從佇列消失）：這邊掛著的輸入頁要重抓今日清單與最新讀值，否則待同步列消失、
        // 資料庫那筆又還沒抓到，看護會以為那筆不見了（第三輪 Codex P2）。清掉（localStorage.clear）的不算送走。
        if (event.key !== null) {
          const drained = before.filter(record => !after.some(candidate => candidate.id === record.id))
          if (drained.length > 0) screenRef.current?.onSynced(drained)
        }
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [enabled, owner, patientId])

  const setScreen = useCallback((screen: BloodPressureQueueScreen | null) => { screenRef.current = screen }, [])

  // 補送成功的那筆通知家人，並把結果放到看得到的地方（issue #1125／#1138）。
  // 這筆的病人就在畫面上時，才可以用目前載入的判讀標準評它的等級；其他病人的紀錄只看入佇列時用那位自己的標準記下的 family_alert
  // （拿畫面上這位的標準評別人等於用 B 的目標判讀 A，§ 3.5）。
  // 「這筆」的提示由掛著的輸入頁決定要不要接手（claimNotice）；沒有輸入頁、不是它的、或提示已被較新的一筆接手時，
  // 「家人可能沒收到」改成點名病人、不帶數值的提示，不能因為畫面不在就不講。
  const notifyQueuedRecord = useCallback((record: PendingBloodPressureRecord) => {
    const request = { recordId: record.id, patientId: record.patient_id }
    // 用量測當下（measured_at）生效的標準判讀：補送可能晚了好幾小時，期間病人標準可能已換。
    // 標準讀不到時退回入佇列時記下的判讀，不拿一般成人門檻冒充（與畫面上 queuedFamilyAlert 同一套順序）。
    // 兩者都沒有（不知道）時當成可能危險：「這筆不會自動通知家人」與點名提示的文案本來就是「若危險／可能沒收到，請聯絡家人」，
    // 而 App 一開就補送時個別標準常常還在載入，只認確定的 true 會讓這兩句在最需要時都不出現（審查發現）。
    const onScreenPatient = record.patient_id === patientIdRef.current
    const alertLevelReading = queuedRecordAlertLevel(record, onScreenPatient ? evaluatorRef.current : null) !== false
    // 送出前就問畫面要不要接手：序號要在送出當下領，較慢的舊結果回來時才分得出「已被較新的一筆接手」。
    const ownsNotice = screenRef.current?.claimNotice(record.patient_id) ?? null
    const toScreen = (apply: (screen: BloodPressureQueueScreen) => void, nameOtherwise: boolean) => {
      const screen = screenRef.current
      if (screen && ownsNotice !== null && ownsNotice()) apply(screen)
      else if (nameOtherwise) flagNotifyProblem(record.patient_id)
    }
    // 不 await，避免 Telegram 延遲拖慢佇列處理下一筆。
    void sendTelegramNotification(request).then(result => {
      // 警示級讀數、而且沒有任何家屬通知送出：寫進「這筆」的提示，寫不進就點名（以前這裡直接不講，危險讀數就沒人知道）。
      if (result.familyAlertSkipped && alertLevelReading) toScreen(screen => screen.onFamilyAlertSkipped(), true)
      // isCurrent 恆為 true：結果一定要落地，只是落在「這筆」的提示或點名提示，由 onState 分流。
      applyFamilyDeliveryResult(result, request, () => true, state => toScreen(screen => screen.onFamilyDelivery(state), familyMayNotKnow(state)))
    }).catch(err => {
      console.error('[telegram notification function error]', err)
      // notifyFailed 會蓋過其他所有通知提示，掛到較新的一筆上會把那一筆真正的送達結果藏起來；寫不進就點名。
      toScreen(screen => screen.onNotifyFailed(), true)
    })
  }, [flagNotifyProblem])

  // 實際同步一輪；回傳「佇列是否已清空」給觸發器 hook 決定要不要排程退避重試。
  // 連線恢復、分頁回前景、原生殼回前景等「何時該呼叫這個函式」的判斷完全交給觸發器 hook，這裡只負責「怎麼同步」。
  const performPendingSync = useCallback(async (): Promise<boolean> => {
    refresh()
    if (!enabled) return true
    // navigator.onLine 是 UX 提示，不是安全邊界；真正的寫入仍由 Supabase 回應確認。
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // 手機自己知道沒網路：這是單純離線，不是「有網路卻連不到伺服器」，計時歸零。
      onlineFailureRef.current = null
      setUnreachable(false)
      return false
    }
    // 另一個分頁正在送：這一輪讓給它、回「還沒清空」讓觸發器照常排下一輪；它送完會觸發 storage 事件讓這邊重讀清單。
    // 不能回 true：那會清掉退避，萬一它那一輪中途失敗，這邊就要等下一個外部事件才會再試。
    return withFlushLock(async () => {
      // 這一輪開始時先收起「連線」那一句，同步中只顯示「正在同步」；結果回來再依這一輪決定要不要講。
      // 被拒絕的原因不收：那是那一筆的狀態，不是這一輪的。
      setRetryFailed(false)
      try {
        // 這個帳號在這台裝置上所有病人的佇列都要補送（issue #1125），畫面上這位優先。
        const result = await flushAllPendingBloodPressureRecords({
          recordedBy: owner,
          firstPatientId: patientIdRef.current,
          save: async record => {
            // record 帶著自己的 patient_id；寫入與通知一律用它，不用畫面上的病人。
            // 帳號的第一筆紀錄在補送時才真正寫入：埋點不能依賴輸入頁掛著（PR #1218 Codex P2）。
            // 入佇列時輸入頁已判斷過「歷史為空」才會記 first_record；舊版 build 排進的紀錄沒有這個欄位（undefined），
            // 就在寫入成功後問一次資料庫有沒有別的紀錄（第二輪 Codex P2）。不 await：埋點不能拖慢或擋住後面的補送與通知，
            // 問不到（斷線、權限）只放棄埋點。analytics 的一次性 marker 讓輸入頁那邊再埋一次也不會重複。
            const outcome = await insertBloodPressureRecord(record)
            if (record.first_record === true) trackFirstRecordSaved({ locale, record_type: 'blood_pressure' })
            else if (record.first_record === undefined) {
              // 排除這位病人整個佇列（含自己）：兩筆舊紀錄都已在伺服器、只是回應遺失時，各自只排除自己會互相看到對方。
              const queuedIds = readPendingBloodPressureRecords(record.patient_id, owner).map(queued => queued.id)
              void hasOtherBloodPressureRecord(record.patient_id, queuedIds.includes(record.id) ? queuedIds : [...queuedIds, record.id])
                .then(exists => { if (!exists) trackFirstRecordSaved({ locale, record_type: 'blood_pressure' }) })
                .catch(error => console.warn('[blood pressure first record check failed]', error))
            }
            // 離線補送成功時也要通知家人；用 record.notified 而非 outcome 判斷是否要送，
            // 因為 'already-existed' 可能來自「這筆本來就是這次才真正寫入，只是先前伺服器
            // 回應遺失」──那種情況一樣從未通知過，只看 outcome 會讓這類紀錄永遠沒通知。
            if (!record.notified) {
              // 標記已嘗試通知要先落地：就算等一下 flush 把這筆從佇列移除時 localStorage
              // 寫入失敗而殘留，下一次重試也能靠這個欄位避免對家人重複發送同一筆通知。
              enqueuePendingBloodPressureRecord({ ...record, notified: true })
              notifyQueuedRecord(record)
            }
            return outcome
          },
        })
        refresh()
        const retryFailedNow = result.failures.some(failure => failure.retryable)
        setRetryFailed(retryFailedNow)
        const nextRejections = nextPendingRejections(rejectionsRef.current, result)
        rejectionsRef.current = nextRejections
        setRejections(nextRejections)
        if (result.synced.length > 0 || !retryFailedNow) {
          // 至少有一筆送到、或失敗都是伺服器明確拒絕：伺服器連得上，不是被擋。
          onlineFailureRef.current = null
          setUnreachable(false)
        } else {
          const now = Date.now()
          const previous = onlineFailureRef.current
          const since = previous && now - previous.last <= PENDING_UNREACHABLE_GAP_RESET_MS ? previous.since : now
          onlineFailureRef.current = { since, last: now }
          setUnreachable(now - since >= PENDING_UNREACHABLE_AFTER_MS)
        }
        // 畫面（若掛著）用「現在」畫面上的病人決定要不要重抓今日清單；這裡不替它判斷。
        if (result.synced.length > 0) screenRef.current?.onSynced(result.synced)
        // 剩下的若都是再試也不會成功的（settled），就當作這一輪已清空、不排退避重試：
        // 它們仍會在下一次連線恢復、回前景、換病人或按「現在同步」時再試一次。權限類拒絕照常退避重試。
        return result.remaining.every(record => nextRejections[record.id]?.settled === true)
      } catch (error) {
        // queue adapter 會保留原始資料；這裡只留下可診斷的 console 訊息與同步提示。
        console.error('[blood pressure pending sync error]', error)
        setRetryFailed(true)
        return false
      }
    }, () => false)
  }, [enabled, locale, notifyQueuedRecord, owner, refresh])

  // 被伺服器拒絕、再試也不會成功的紀錄（settled）仍留在佇列、仍算在畫面筆數裡，但不算「還在等自動重試」：
  // 否則一筆卡住的紀錄（任何一位病人的）會讓整個帳號永遠卡在 10 分鐘退避，
  // 另一位病人新的離線危險讀數也等不到「第一次進佇列就立刻試一次」的探測（issue #1125 審查）。
  const retryablePending = records.some(record => !rejections[record.id]?.settled)

  const { syncing, lastAttemptAt, retryNow } = usePendingWriteFlush({
    enabled,
    hasPending: retryablePending,
    sync: performPendingSync,
    // 切換病人時要立刻替新病人重探測一次（她的紀錄要優先送），不能等下一個外部事件；退避階段也從頭開始。
    resetKey: patientId,
  })

  const noteQueued = useCallback(() => {
    refresh()
    // 送出當下遇到暫時性錯誤才第一次進佇列時，navigator.onLine 多半仍是 true、不會有 online 事件；
    // 狀態列要立刻講「請確認網路」，不能等退避重試回來才講。
    setRetryFailed(true)
  }, [refresh])

  return useMemo<BloodPressureQueue>(() => ({
    records,
    syncing,
    lastAttemptAt,
    retryFailed,
    unreachable,
    rejections,
    notifyProblems,
    retryNow,
    noteQueued,
    flagNotifyProblem,
    clearNotifyProblems,
    setScreen,
    rejectedSaves,
    documentVisible,
    reportRejectedSave,
    clearRejectedSave,
  }), [records, syncing, lastAttemptAt, retryFailed, unreachable, rejections, notifyProblems, retryNow, noteQueued, flagNotifyProblem, clearNotifyProblems, setScreen, rejectedSaves, documentVisible, reportRejectedSave, clearRejectedSave])
}
