/*
檔案用途：血壓按下儲存後的即時回饋——儲存錯誤（含每日上限擋下）、家屬通知失敗／不明／未送出、通知送出中、「不會自動通知家人」說明（issue #1093），
         以及「需要通知家人的讀數還卡在離線佇列」（issue #1126）。
所在層：src/features/vitals/components；只負責呈現與「同一時間該講哪一句」的選擇，不寫入、不通知、不改 hook 狀態。
主要關聯：InputPage（儲存按鈕正下方的掛載點）、useBloodPressureInputForm（status／errMsg／notifyFailed／familyAlertSkipped／familyDelivery／queuedFamilyAlert／otherPatientNotifyProblems）、
         BpLimitBlockedNotice（被上限擋下時的等級提示，由本元件包進同一個 assertive live region）、InputPage.utils 的 L 文案、ADR-007 D9。

為什麼獨立出來：這些訊息原本放在頁面最底部，嵌進每日照護頁後落在明細與趨勢之後、離儲存按鈕好幾個螢幕高，
看護按完儲存根本看不到「家人沒收到危險血壓通知」（北極星鐵律 4）。抽成元件後頁面只決定掛在按鈕下方，
「哪些訊息互斥、哪些要搶先唸」的規則集中在這裡並有單元測試鎖住。
*/
import { useEffect, useRef } from 'react'
import type { LocalizedText } from '../../../lib/i18n'
import { useI18n } from '../../../lib/i18n'
import { L } from '../pages/InputPage.utils'
import { BpLimitBlockedNotice, type LimitBlockedReading } from './BpLimitBlockedNotice'

/**
 * ADR-007 D9-b：這一筆在共用群組（與個人化通知）的送達結果；各值的語意見 useBloodPressureInputForm 的 familyDelivery 註解。
 * 型別放在呈現端，是因為「每個值對應哪一句文案」由本元件負責；hook 只負責把結果寫進來。
 */
export type FamilyDeliveryState =
  | 'idle'
  | 'in_progress'
  | 'unconfirmed'
  | 'not_sent'
  | 'unconfirmed_personal_queued'
  | 'not_sent_personal_queued'
  | 'unconfirmed_personal_unknown'
  | 'not_sent_personal_unknown'
  | 'personal_unknown'
  | 'unconfirmed_personal_delivered'
  | 'not_sent_personal_delivered'

// 這些結果都代表「至少有一則家人通知沒送到或無法確認」，看護可能要自己打電話，所以用 assertive。
// 用 Record 窮舉：之後 hook 新增一種送達結果卻忘了配文案，typecheck 就會擋下，不會變成靜默不顯示。
const URGENT_FAMILY_DELIVERY: Record<Exclude<FamilyDeliveryState, 'idle' | 'in_progress'>, LocalizedText> = {
  unconfirmed: L.familyAlertUnconfirmed,
  not_sent: L.familyAlertNotSent,
  unconfirmed_personal_queued: L.familyAlertSharedUnconfirmedPersonalQueued,
  not_sent_personal_queued: L.familyAlertSharedNotSentPersonalQueued,
  unconfirmed_personal_unknown: L.familyAlertSharedUnconfirmedPersonalUnknown,
  not_sent_personal_unknown: L.familyAlertSharedNotSentPersonalUnknown,
  personal_unknown: L.familyAlertPersonalUnknown,
  unconfirmed_personal_delivered: L.familyAlertSharedUnconfirmedPersonalDelivered,
  not_sent_personal_delivered: L.familyAlertSharedNotSentPersonalDelivered,
}

/**
 * issue #1126：目前病人的離線佇列裡，有沒有還沒通知家人、而且需要通知的讀數。
 * - 'alert'：確定有（用個別標準判讀，或入佇列時已記下判讀）→ 請看護直接打電話。
 * - 'unknown'：有待送讀數，但個別標準讀不到、入佇列時也沒記下判讀 → 講「無法判斷」，不能拿一般成人門檻假裝判讀過。
 * - 'rejected'：需要通知家人的讀數被伺服器拒絕、再試也不會成功（issue #1125）→ 不會自動補送、家人不會收到，請看護直接打電話；
 *   'alert' 那句「連線恢復後會自動補送」對它是錯的，所以分開。
 * - 'rejected_unknown'：同上，但讀不到個別標準、無法判斷要不要通知家人 → 講「偏高偏低就打電話」，不能因為被拒絕就不講。
 * - 'none'：沒有。
 * 判斷在 useBloodPressureInputForm；型別放這裡的理由同 FamilyDeliveryState：每個值對應哪一句由本元件負責。
 */
export type QueuedFamilyAlert = 'none' | 'alert' | 'unknown' | 'rejected' | 'rejected_unknown'

// 用 Record 窮舉，理由同 URGENT_FAMILY_DELIVERY：新增狀態卻漏配文案時 typecheck 會擋下。
const QUEUED_FAMILY_ALERT_TEXT: Record<Exclude<QueuedFamilyAlert, 'none'>, LocalizedText> = {
  alert: L.queuedFamilyAlertPending,
  unknown: L.queuedFamilyAlertUnknown,
  rejected: L.queuedFamilyAlertRejected,
  rejected_unknown: L.queuedFamilyAlertRejectedUnknown,
}

export interface FamilyNotices {
  /** 要看護現在處理的那一句（assertive）；同一時間最多一句。 */
  urgent: LocalizedText | null
  /** 說明性質的狀態（polite）：通知送出中、這筆不會自動通知家人。 */
  info: LocalizedText[]
}

/**
 * 依 hook 狀態選出家屬通知相關的文案。顯示條件與搬家前的頁面完全相同：
 * notifyFailed（Edge Function 呼叫本身失敗）蓋過其他一切，因為那時送達帳本的結果都不可信；
 * familyDelivery 一次只有一個值，所以 assertive 那一句天生互斥。
 */
export function familyNotices({ notifyFailed, familyAlertSkipped, familyDelivery }: {
  notifyFailed: boolean
  familyAlertSkipped: boolean
  familyDelivery: FamilyDeliveryState
}): FamilyNotices {
  if (notifyFailed) return { urgent: L.notifyFailed, info: [] }
  const info: LocalizedText[] = []
  if (familyAlertSkipped) info.push(L.familyAlertSkipped)
  if (familyDelivery === 'in_progress') info.push(L.familyAlertInProgress)
  const urgent = familyDelivery === 'idle' || familyDelivery === 'in_progress' ? null : URGENT_FAMILY_DELIVERY[familyDelivery]
  return { urgent, info }
}

/**
 * 回饋區要不要捲進畫面、以及「內容變了沒」的判斷鍵；空字串代表不捲。
 * 只有會要看護採取行動的訊息才算：儲存錯誤、家屬通知失敗／不明、「這筆不會自動通知家人」（只對警示級讀數出現，
 * 文案要看護危險時自己聯絡家人）、「需要通知家人的讀數還卡在離線佇列」（issue #1126，同樣要看護打電話），
 * 以及另一位照護對象補送後家人通知沒確認送達（issue #1125）。「通知送出中」不算：它不需要任何動作，而離線補送會在 App 回前景時自動觸發，
 * 若連它也捲，看護正在別的區段打字時畫面會被拉回血壓區。
 */
export function noticeScrollKey({ status, errMsg, limitBlockedReading, notifyFailed, familyAlertSkipped, familyDelivery, queuedFamilyAlert, otherPatientNotifyNames = [] }: {
  status: 'idle' | 'saving' | 'ok' | 'queued' | 'err'
  errMsg: string
  limitBlockedReading: LimitBlockedReading | null
  notifyFailed: boolean
  familyAlertSkipped: boolean
  familyDelivery: FamilyDeliveryState
  queuedFamilyAlert: QueuedFamilyAlert
  otherPatientNotifyNames?: readonly string[]
}): string {
  const { urgent, info } = familyNotices({ notifyFailed, familyAlertSkipped, familyDelivery })
  const actionable = [
    status === 'err' ? `err:${errMsg}:${limitBlockedReading?.measuredAt ?? ''}` : '',
    queuedFamilyAlert === 'none' ? '' : `queued:${queuedFamilyAlert}`,
    urgent ? `urgent:${urgent.zh}` : '',
    info.includes(L.familyAlertSkipped) ? 'skipped' : '',
    otherPatientNotifyNames.length > 0 ? `other:${otherPatientNotifyNames.join(',')}` : '',
  ].filter(Boolean)
  return actionable.join('|')
}

export function BpSaveNotices({ status, errMsg, limitBlockedReading, notifyFailed, familyAlertSkipped, familyDelivery, queuedFamilyAlert, otherPatientNotifyNames = [] }: {
  status: 'idle' | 'saving' | 'ok' | 'queued' | 'err'
  errMsg: string
  limitBlockedReading: LimitBlockedReading | null
  notifyFailed: boolean
  familyAlertSkipped: boolean
  familyDelivery: FamilyDeliveryState
  queuedFamilyAlert: QueuedFamilyAlert
  /** 補送後家人通知沒確認送達、但那筆不屬於「這筆」提示的照護對象名稱（issue #1125）；只有名字，沒有數值。 */
  otherPatientNotifyNames?: readonly string[]
}) {
  const { text } = useI18n()
  const { urgent, info } = familyNotices({ notifyFailed, familyAlertSkipped, familyDelivery })
  const showError = status === 'err'
  const hasUrgent = showError || queuedFamilyAlert !== 'none' || urgent !== null || otherPatientNotifyNames.length > 0
  const containerRef = useRef<HTMLDivElement>(null)

  // 掛在按鈕正下方還不夠：首次量測後頂端會多出休息倒數，手機上這塊常落在捲動區底緣、只露出一行。
  // 家屬通知結果又是儲存後幾秒才非同步回來，看護那時可能已往下捲去看明細。所以內容一變就捲到「剛好看得到」；
  // 哪些訊息算數由 noticeScrollKey 決定（見其註解與單元測試）。
  const scrollKey = noticeScrollKey({ status, errMsg, limitBlockedReading, notifyFailed, familyAlertSkipped, familyDelivery, queuedFamilyAlert, otherPatientNotifyNames })
  useEffect(() => {
    if (!scrollKey) return
    // 刻意用瞬間捲動而非 smooth：smooth 動畫在分頁不在前景、或剛好遇上收鍵盤的版面變動時會被中斷，
    // 結果就是完全沒捲到；安全訊息寧可跳一下，也不能停在看不到的地方。
    containerRef.current?.scrollIntoView?.({ block: 'nearest' })
    // 只在訊息內容改變時捲動，所以依賴只放 scrollKey（它已涵蓋所有需要看護行動的訊息）。
  }, [scrollKey])

  return (
    // 外層容器只負責捲動定位與間距；沒有訊息時 empty:hidden 讓它不佔父層 gap。
    <div ref={containerRef} className="flex flex-col gap-2 scroll-mb-4 empty:hidden">
      {hasUrgent && (
        // 儲存錯誤與家屬通知失敗可能同時存在（例：離線補送那一筆的通知結果，在這次送出出錯之後才非同步回來）。
        // 各自掛 role="alert" 時 VoiceOver／TalkBack 常只唸最後掛上的那一個，所以合成一個 assertive region；
        // 錯誤放前面，因為它是看護剛剛那一下的直接結果。
        <div role="alert" aria-live="assertive" className="flex flex-col gap-2 text-center">
          {showError && limitBlockedReading && <BpLimitBlockedNotice reading={limitBlockedReading} limitMessage={errMsg} />}
          {showError && !limitBlockedReading && (
            <p className="text-sm font-semibold text-red-600">{errMsg}</p>
          )}
          {queuedFamilyAlert !== 'none' && (
            // issue #1126：需要通知家人（或讀不到個別標準、無法判斷）的讀數還在本機佇列，家人還沒收到。
            // 兩種都可能要看護現在打電話，所以進 assertive region；
            // 琥珀色而非紅色：讀數沒有遺失（被拒絕的 'rejected' 也還留在佇列），紅色會讓看護以為要重新輸入（重新輸入反而多一筆）。
            // 與下方 urgent 不互斥：urgent 可能是上一筆補送的送達結果，兩件事都要講。
            <p data-family-notice className="text-sm font-semibold text-amber-600">{text(QUEUED_FAMILY_ALERT_TEXT[queuedFamilyAlert])}</p>
          )}
          {urgent && (
            // 琥珀色而非紅色：血壓其實已經寫入，只有家人通知有問題；紅色會讓看護以為要重新輸入。
            <p data-family-notice className="text-sm font-semibold text-amber-600">{text(urgent)}</p>
          )}
          {otherPatientNotifyNames.map(name => (
            // issue #1125：另一位照護對象的離線紀錄在這裡補送了，家人卻可能沒收到。寫進「這筆」的提示會讓看護以為是眼前這位，
            // 不講又等於吞掉警報鏈的失敗，所以點名、不帶數值（§ 3.5）。與上方同色：紀錄已存好，只有通知有問題。
            <p key={name} data-family-notice className="text-sm font-semibold text-amber-600">{text(L.otherPatientNotifyProblem(name))}</p>
          ))}
        </div>
      )}
      {info.length > 0 && (
        // 通知送出中、這位照護對象沒有家屬通知管道：不是故障，用 polite，不搶在錯誤前面唸。
        <div role="status" aria-live="polite" className="flex flex-col gap-2 text-center">
          {info.map(entry => (
            <p key={entry.zh} data-family-notice className="text-sm font-semibold text-amber-700">{text(entry)}</p>
          ))}
        </div>
      )}
    </div>
  )
}
