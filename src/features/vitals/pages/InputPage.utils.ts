/*
檔案用途：提供血壓輸入頁的驗證、錯誤訊息、數值範圍與近期摘要工具。
所在層：src/components 的輔助模組；不直接呈現畫面。
主要關聯：InputPage 與 DailyBloodPressureRecords 共用此處的輸入安全規則。
*/
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { supabase } from '../../../lib/supabase'
import { TZ } from '../../../lib/timezone'
import { getSession, type Session } from '../../../lib/session'
import { localized, type Locale, type LocalizedText } from '../../../lib/i18n'
import { describeSaveError, isConnectionError, isPermissionError, matchesConstraint } from '../../../lib/dataErrors'
import { isDemoPatientId } from '../../../lib/demoData'
import { getDemoBpRecords, isDemoMode } from '../../../lib/demoStorage'
import { careDateKey, careDayWindow } from '../../../lib/careDay'
import type { AlertLevel } from '../../../types/database'
import { PENDING_SYNC_TEXT } from '../../../components/ui/PendingSyncStatus'

dayjs.extend(utc)
dayjs.extend(timezone)

export { TZ }

// 上限隨帳號方案而變，前端不猜數字，避免特權照護者被錯誤告知免費額度。
const BP_DAILY_LIMIT_TEXT = {
  id: 'Hari ini sudah mencapai batas penambahan catatan tekanan darah untuk akun ini. Jika salah input, ubah atau hapus catatan hari ini.',
  zh: '今天已達到此帳號的血壓新增上限；若有輸入錯誤，可修改或刪除今天的紀錄。', en: 'The blood pressure limit for this account has been reached today; if there is a typing error, you can modify or delete today’s record.',
} as const

/**
 * 這次儲存是不是被資料庫的每日血壓上限擋下（issue #1060）。
 * 錯誤訊息與「被擋讀數的危險等級提示」必須用同一個判斷：只有一邊認得出來時，畫面會出現
 * 「上限說明」卻沒有等級 badge（或反過來），看護會看不懂這筆到底存了沒。
 * 權限與連線錯誤先排除，因為它們的錯誤字串偶爾會夾帶觸發器名稱，卻不是真的被配額擋下。
 */
export function isDailyBpLimitError(error: unknown): boolean {
  return matchesConstraint(error, 'daily_blood_pressure_limit') && !isPermissionError(error) && !isConnectionError(error)
}

/**
 * 繁體中文註解：把常見的登入/RLS/設定錯誤分開，讓看護知道可採取的下一步，而不是被同一句泛用錯誤卡住。
 * 通用的判斷（權限、連線）已移到 lib/dataErrors 共用，這裡只保留血壓特有的配額訊息，
 * 避免同一份 unknown 錯誤解析在體溫、血壓、PRN 各留一份副本後慢慢漂移。
 */
export function saveErrorMessage(error: unknown, locale: Locale = 'id'): string {
  if (isDailyBpLimitError(error)) {
    return localized(BP_DAILY_LIMIT_TEXT, locale)
  }
  return localized(describeSaveError(error), locale)
}

// 補送時被伺服器拒絕、又不是權限或上限的情況（例如資料格式、欄位不符）：看護按幾次「現在同步」都不會好，
// 所以不沿用「儲存失敗，請再試一次」，改說重試沒用、請通知家屬（能修的人）。
const QUEUED_REJECTED_FALLBACK_TEXT = {
  id: 'Server tidak menerima data ini, dan mencoba lagi tidak akan berhasil. Beri tahu keluarga.',
  zh: '伺服器不接受這筆資料，重試也不會成功，請通知家屬。',
  en: 'The server did not accept this record, and retrying will not help. Tell the family.',
} as const

/**
 * 離線佇列補送時被永久拒絕的那一筆，狀態列該講的真正原因（issue #1125）。
 * 以前一律顯示「請確認網路後再重新同步」：權限過期要重新登入、超過每日上限要改今天的紀錄，
 * 看護照著檢查網路只會一直按同步，那筆血壓始終沒存進去，家人也一直沒收到通知。
 * 判斷順序與 saveErrorMessage 相同（上限 → 權限 → 其他），兩邊對同一個錯誤講同一件事。
 */
export function queuedRejectionText(error: unknown): LocalizedText {
  const reason = isDailyBpLimitError(error) ? BP_DAILY_LIMIT_TEXT : describeSaveError(error, QUEUED_REJECTED_FALLBACK_TEXT)
  return {
    id: `Ada catatan yang gagal disinkronkan: ${reason.id}`,
    zh: `有紀錄沒有同步成功：${reason.zh}`,
    en: `A record could not be synced: ${reason.en}`,
  }
}

// ── Bilingual string table (Indonesian first, Chinese second) ──────────────
// 繁體中文註解：放置印尼文與中文的雙語字典，便於維護與翻譯擴充。
export const L = {
  title:     { id: 'Tekanan Darah',       zh: '血壓紀錄' ,en: 'Blood Pressure Record' },
  systolic:  { id: 'Sistolik',            zh: '高壓' ,en: 'Systolic' },
  diastolic: { id: 'Diastolik',           zh: '低壓' ,en: 'Diastolic' },
  pulse:     { id: 'Jantung',             zh: '心跳' ,en: 'Heart rate' },
  save:      { id: 'Simpan',              zh: '儲存' ,en: 'Save' },
  saving:    { id: 'Menyimpan…',          zh: '儲存中…' ,en: 'Saving...' },
  saved:     { id: '✓ Tersimpan!',        zh: '✓ 已記錄！' ,en: 'Recorded' },
  queued:    { id: 'Tersimpan di perangkat', zh: '已暫存於本機' ,en: "Saved on this device" },
  // 佇列裡有「需要通知家人」等級的讀數還沒送出時顯示（issue #1126）。離線儲存不再是紅字失敗，
  // 只剩琥珀色「已暫存」，看護沒有理由打電話；但家人要等補送成功才會收到通知（北極星鐵律 3、4）。
  queuedFamilyAlertPending: {
    id: 'Ada tekanan darah yang perlu diberitahukan ke keluarga, tetapi belum terkirim. Keluarga belum tahu. Telepon keluarga langsung. Data akan dikirim otomatis saat koneksi kembali, tidak perlu memasukkan ulang.',
    zh: '有需要通知家人的血壓還沒送出，家人還不知道。請直接打電話給家人；連線恢復後會自動補送，不用重新輸入。',
    en: 'A reading the family needs to know about has not been sent yet, so the family does not know. Call the family directly. It will be sent automatically when the connection is back; no need to enter it again.',
  },
  // 同上，但讀不到這位的個別血壓標準、入佇列時也沒記下判讀（Codex review on PR #1127）：一般成人門檻可能漏掉
  // 長輩標準下的偏低警示，所以不能說「不用通知」，改講無法判斷、數值偏高偏低就打電話。
  queuedFamilyAlertUnknown: {
    id: 'Ada tekanan darah yang belum terkirim, jadi keluarga belum tahu. Standar tekanan darah pribadi belum bisa dimuat, jadi belum bisa dipastikan apakah keluarga perlu diberi tahu. Jika angkanya tinggi atau rendah, telepon keluarga langsung. Data akan dikirim otomatis saat koneksi kembali, tidak perlu memasukkan ulang.',
    zh: '有血壓還沒送出，家人還不知道。目前讀不到這位的個人血壓標準，無法判斷是否需要通知家人；若數值偏高或偏低，請直接打電話給家人。連線恢復後會自動補送，不用重新輸入。',
    en: 'A reading has not been sent yet, so the family does not know. This person\'s blood pressure targets cannot be loaded right now, so it is not clear whether the family needs to know. If the numbers are high or low, call the family directly. It will be sent automatically when the connection is back; no need to enter it again.',
  },
  // 需要通知家人的讀數補送時被伺服器拒絕、再試也不會成功（每日上限、資料格式；issue #1125）：不會自動補送，家人不會收到通知。
  // 上面兩句都說「連線恢復後會自動補送」，對這筆是錯的，看護會以為等一下就好而不打電話。被拒絕的原因在狀態列。
  queuedFamilyAlertRejected: {
    id: 'Ada tekanan darah yang perlu diberitahukan ke keluarga, tetapi ditolak sistem. Data ini tidak akan dikirim otomatis dan keluarga tidak akan menerima notifikasi. Telepon keluarga langsung.',
    zh: '有需要通知家人的血壓沒有被系統接受，不會自動補送，家人不會收到通知。請直接打電話給家人。',
    en: 'A reading the family needs to know about was not accepted by the system. It will not be sent automatically, and the family will not be notified. Call the family directly.',
  },
  // 同上，但讀不到這位的個別血壓標準、入佇列時也沒記下判讀：說不準要不要通知家人，但不能因此什麼都不講（issue #1125 審查）。
  queuedFamilyAlertRejectedUnknown: {
    id: 'Ada tekanan darah yang ditolak sistem, jadi tidak akan dikirim otomatis dan keluarga tidak akan menerima notifikasi. Standar tekanan darah pribadi belum bisa dimuat, jadi belum bisa dipastikan apakah keluarga perlu diberi tahu. Jika angkanya tinggi atau rendah, telepon keluarga langsung.',
    zh: '有血壓沒有被系統接受，不會自動補送，家人不會收到通知。目前讀不到這位的個人血壓標準，無法判斷是否需要通知家人；若數值偏高或偏低，請直接打電話給家人。',
    en: "A reading was not accepted by the system. It will not be sent automatically, and the family will not be notified. This person's blood pressure targets cannot be loaded right now, so it is not clear whether the family needs to know. If the numbers are high or low, call the family directly.",
  },
  // 儲存進行中鎖住「切換對象」時顯示的說明（issue #1103）；禁用控制項若不講原因，看護只會以為按鈕壞了。
  // 寫入結果不明（暫時性失敗或逾時後本機佇列又存不了，issue #1117）：伺服器可能已經寫入，叫看護重新輸入會多一筆（新 UUID），
  // 所以請她先看今日紀錄再決定。
  saveOutcomeUnknown: {
    id: 'Tekanan darah tadi belum pasti tersimpan (penyimpanan HP tidak tersedia). Periksa catatan hari ini dulu; kalau belum ada, masukkan lagi.',
    zh: '剛才的血壓不確定有沒有存進去（手機暫存空間不可用），請先看今日紀錄，沒有的話再重新輸入。',
    en: 'It is not certain the blood pressure just entered was saved (phone storage unavailable). Check today\'s records first; enter it again only if it is missing.',
  },
  switchLockedWhileSaving: { id: 'Tekanan darah sedang disimpan. Tunggu sebentar sebelum berganti ke orang lain.', zh: '血壓儲存中，請稍候再切換對象。' ,en: 'Saving blood pressure. Please wait a moment before switching to someone else.' },
  // 待同步狀態列的文案住在共用元件（服藥打卡也用同一塊，issue #822）；這裡只留別名讓既有呼叫與測試不必改。
  pending: PENDING_SYNC_TEXT.pending,
  pendingLastAttempt: PENDING_SYNC_TEXT.lastAttempt,
  pendingSyncing: PENDING_SYNC_TEXT.syncing,
  pendingSyncError: PENDING_SYNC_TEXT.syncError,
  retryPending: PENDING_SYNC_TEXT.retry,
  // 手機自認有網路（navigator.onLine），補送卻持續失敗超過一段時間（issue #1125）：DNS、內容攔截器、
  // 公共 Wi-Fi 登入頁或 CSP 擋掉請求時都長這樣，看護「檢查網路」只會看到網路明明是通的。
  // 給她一個自己做得到的動作（換網路），做不到就交給家屬；不寫「稍後會自動重試」，因為卡住的原因常常不會自己消失。
  pendingUnreachable: {
    id: 'HP terlihat terhubung ke internet, tetapi server tetap tidak bisa dihubungi. Coba ganti jaringan (misalnya matikan Wi-Fi), lalu tekan "Sinkronkan sekarang". Jika masih gagal, beri tahu keluarga.',
    zh: '手機顯示有網路，但一直連不到伺服器。請換個網路（例如關掉 Wi-Fi）再按「現在同步」；還是不行請通知家屬。',
    en: 'The phone shows a connection, but the server still cannot be reached. Try another network (for example, turn off Wi-Fi), then tap "Sync now". If it still fails, tell the family.',
  },
  // 另一位照護對象的待送紀錄被伺服器拒絕（issue #1125）。原因（權限、那位的每日上限）屬於那位，
  // 這裡只說去那位的畫面看；不講的話，這個畫面只會一直顯示「其他照護對象還有 N 筆」卻永遠不會少。
  // 那位的照護權限被收回或已封存時，切換清單裡根本沒有她，所以要附上做不到時的退路（通知家屬）。
  otherPatientsRejected: {
    id: 'Ada catatan orang lain yang dirawat yang gagal disinkronkan. Pindah ke orang tersebut untuk melihat alasannya; jika orang itu tidak ada di daftar, beri tahu keluarga.',
    zh: '其他照護對象有紀錄沒有同步成功，請切換到該對象查看原因；切換清單裡找不到該對象時，請通知家屬。',
    en: 'A record for another care recipient could not be synced. Switch to that person to see why; if they are not in the list, tell the family.',
  },
  // 下一句的名字查不到時（例如那位已封存、不在已授權清單）的代稱；查不到名字也必須提醒。
  anotherCareRecipient: { id: 'Orang lain yang dirawat', zh: '另一位照護對象', en: 'Another care recipient' },
  // 某筆血壓存進去了，但家屬通知可能沒到（沒送出、無法確認、或沒有任何通知管道），而且寫不進「這筆」的提示（issue #1125／#1138）：
  // 那筆屬於另一位照護對象、看護已切到別人或別的分頁、或提示已被較新的一筆接手。用「這筆」的提示會讓看護以為是眼前這位，
  // 所以改成點名是誰、不顯示數值。離線補送與線上儲存都走這句，文案不寫「離線」。
  // 寫「可能沒有收到」而不是「無法確認」：沒送出與沒有管道是確定沒收到，「無法確認」會講得太輕。
  otherPatientNotifyProblem: (name: string) => ({
    id: `${name}: tekanan darah sudah tersimpan, tetapi keluarga mungkin belum menerima notifikasi. Hubungi keluarga langsung.`,
    zh: `${name}：血壓已存檔，但家人可能沒有收到通知，請直接聯絡家人。`,
    en: `${name}: a blood pressure reading was saved, but the family may not have been notified. Contact the family directly.`,
  }),
  normal:      { id: 'Normal',              zh: '正常' ,en: 'Normal' },
  warning:     { id: 'Agak Tinggi',         zh: '略高' ,en: 'Slightly high' },
  danger:      { id: '⚠️ Terlalu Tinggi!',  zh: '⚠️ 血壓偏高！' ,en: '⚠️ High blood pressure!' },
  'warning-low': { id: 'Agak Rendah',       zh: '偏低' ,en: 'Slightly low' },
  'danger-low':  { id: '⚠️ Terlalu Rendah!', zh: '⚠️ 血壓過低！' ,en: '⚠️ Low blood pressure!' },
  pagi:      { id: 'Pagi',               zh: '早上' ,en: 'Morning' },
  siang:     { id: 'Siang',              zh: '下午' ,en: 'Afternoon' },
  malam1:    { id: '18:00+',             zh: '晚上18點' ,en: '6 PM' },
  malam2:    { id: '20:00+',             zh: '晚上20點' ,en: '8 PM' },
  // 晚間分類仍供流程判斷，但不把時段標籤塞回紀錄摘要，避免畫面資訊重複。
  malam3:    { id: '',                   zh: '' ,en: '' },
  rest: {
    id: () =>
      // 固定寫 60 秒，避免「大約 1 分鐘」讓看護無法判斷何時能安全重測。
      '✓ Catatan 1 tercatat. Istirahat selama 60 detik, lalu ukur lagi ya 🙏',
    zh: () =>
      '✓ 第一筆已記錄。請休息 60 秒，再量一次 🙏', en: () =>
      '✓ First reading recorded. Rest for 60 seconds, then measure again 🙏',
  },
  done: {
    // 沒有顯示時段名時，完成訊息也不應留下假的時段或多餘空白。
    id: (session: string) => session ? `✓ 2 catatan tersimpan untuk ${session}` : '✓ 2 catatan tersimpan',
    zh: () => `✓ 此時段雙筆已記錄`, en: (session: string) => session ? `✓ Two readings recorded for ${session}` : '✓ Two readings recorded',
  },
  // issue #1060：被每日上限擋下的那一筆沒有進資料庫，也不會觸發任何家屬通知。
  // 標籤要明講「沒存」，否則 badge 看起來像一筆成功紀錄的判讀結果。
  limitBlockedLabel: { id: 'Hasil ukur ini tidak tersimpan:', zh: '這筆沒有存進去：', en: 'This reading was not saved:' },
  // 危險級才出現的大字提示。重點是「家人不會知道，要你打電話」：上限是防濫用，被擋就是被擋，
  // 系統不會偷偷暫存或重送；能把危險讀數送到家人手上的只剩看護本人的一通電話。
  limitBlockedDanger: {
    id: 'Tensi ini berbahaya dan tidak tersimpan, jadi keluarga tidak akan menerima notifikasi. Telepon keluarga sekarang.',
    zh: '這筆血壓危險，而且沒有存進系統，家人不會收到通知。請直接打電話給家屬。',
    en: 'This reading is dangerous and was not saved, so the family will not be notified. Call the family directly now.',
  },
  // 血壓已存進資料庫，只有 Telegram 通知失敗；用警示色而非紅色錯誤，避免看護誤以為血壓沒存到。
  notifyFailed: {
    id: '✓ Tekanan darah tersimpan, tapi notifikasi Telegram ke keluarga gagal terkirim.',
    zh: '✓ 血壓已存檔，但 Telegram 通知家人失敗，請截圖回報。', en: "✓ Blood pressure saved, but failed to send Telegram notification to family.",
  },
  // 通知服務正常，但這位照護對象沒有訂閱共用家屬群組、也沒有個人化通知；家人不會自動收到。
  // 只陳述事實，不寫「尚未設定」：看護在 app 裡沒有開通的入口，暗示要去設定只會讓人找不到。
  // 附上「危險值請直接聯絡家人」這個看護能立刻做的動作。
  familyAlertSkipped: {
    id: '✓ Tekanan darah tersimpan. Catatan ini tidak dikirim otomatis ke keluarga. Jika angkanya berbahaya, hubungi keluarga langsung.',
    zh: '✓ 血壓已存檔。這筆紀錄不會自動通知家人；若數值危險，請直接聯絡家人。',
    en: '✓ Blood pressure saved. This reading was not sent to the family automatically. If it is dangerous, contact the family directly.',
  },
  // ADR-007 D9-b：共用群組那一則的送達結果。三種都先說「血壓已存」，看護不必重新輸入；
  // 「送出中」不是成功；「無法確認」與「沒有送出」都要看護直接聯絡家人。
  // 「沒有送出」刻意寫明不會自動重試（D9-c）：說「稍後重試」會讓看護以為系統還在努力，於是不打電話。
  familyAlertInProgress: {
    id: '✓ Tekanan darah tersimpan. Notifikasi ke keluarga sedang dikirim, hasilnya belum pasti…',
    zh: '✓ 血壓已存檔。家人通知送出中，結果尚未確定…',
    en: '✓ Blood pressure saved. The family notification is being sent, result not yet confirmed…',
  },
  familyAlertUnconfirmed: {
    id: '✓ Tekanan darah tersimpan, tapi tidak bisa dipastikan apakah notifikasi sampai ke keluarga. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但無法確認家人是否收到通知；請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but it could not be confirmed whether the family received the notification. Contact the family directly to confirm.',
  },
  familyAlertNotSent: {
    id: '✓ Tekanan darah tersimpan, tapi notifikasi ke keluarga tidak terkirim dan tidak akan dicoba ulang otomatis. Hubungi keluarga langsung.',
    zh: '✓ 血壓已存檔，但家人通知沒有送出，也不會自動重試；請直接聯絡家人。',
    en: '✓ Blood pressure saved, but the family notification was not sent and will not be retried automatically. Contact the family directly.',
  },
  // 個人化通知已排入 outbox（有自己的重試者）時，「沒送」「不明」只指共用群組那一則；說「家人通知沒送出、不會重試」
  // 就是對個人那條路徑說謊（PR #988 Codex P2）。仍請看護直接確認：群組那一則確實沒到／不明。
  familyAlertSharedUnconfirmedPersonalQueued: {
    id: '✓ Tekanan darah tersimpan, tapi tidak bisa dipastikan apakah notifikasi grup keluarga sampai. Notifikasi pribadi sudah masuk antrean dan akan dikirim otomatis. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但無法確認家人群組是否收到通知；個人通知已排入佇列，會自動送出。請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but it could not be confirmed whether the family group received the notification. Personal notifications are queued and will be sent automatically. Contact the family directly to confirm.',
  },
  familyAlertSharedNotSentPersonalQueued: {
    id: '✓ Tekanan darah tersimpan, tapi notifikasi ke grup keluarga tidak terkirim dan tidak akan dicoba ulang otomatis. Notifikasi pribadi sudah masuk antrean dan akan dikirim otomatis. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但家人群組通知沒有送出，也不會自動重試；個人通知已排入佇列，會自動送出。請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but the family group notification was not sent and will not be retried automatically. Personal notifications are queued and will be sent automatically. Contact the family directly to confirm.',
  },
  // 個人化通知沒有在路上、但有一則可能已送達（delivery_unknown，不會重送）：兩邊都只能說「無法確認」，不能講成「沒有個人通知」
  // 也不能說「會自動送出」（PR #988 Codex P2）。
  familyAlertSharedUnconfirmedPersonalUnknown: {
    id: '✓ Tekanan darah tersimpan, tapi tidak bisa dipastikan apakah notifikasi grup keluarga maupun notifikasi pribadi sampai. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但無法確認家人群組與個人通知是否送達；請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but it could not be confirmed whether the family group or the personal notifications were delivered. Contact the family directly to confirm.',
  },
  // 未訂閱共用群組（沒有群組那一則）、個人那一則不明：只剩「無法確認」可說，仍要請看護聯絡家人（PR #988 Codex P2）。
  familyAlertPersonalUnknown: {
    id: '✓ Tekanan darah tersimpan, tapi tidak bisa dipastikan apakah notifikasi pribadi ke keluarga sampai. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但無法確認家人的個人通知是否送達；請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but it could not be confirmed whether the personal notifications reached the family. Contact the family directly to confirm.',
  },
  // 個人化通知已送達（drain 已 sent）：只能說「個人通知已送達」，不能說「已排入、會自動送出」（PR #988 Codex P2）。
  familyAlertSharedUnconfirmedPersonalDelivered: {
    id: '✓ Tekanan darah tersimpan. Notifikasi pribadi ke keluarga sudah terkirim, tapi tidak bisa dipastikan apakah notifikasi grup keluarga sampai.',
    zh: '✓ 血壓已存檔。家人的個人通知已送達，但無法確認家人群組是否收到通知。',
    en: '✓ Blood pressure saved. The personal notifications reached the family, but it could not be confirmed whether the family group received the notification.',
  },
  familyAlertSharedNotSentPersonalDelivered: {
    id: '✓ Tekanan darah tersimpan. Notifikasi pribadi ke keluarga sudah terkirim, tapi notifikasi ke grup keluarga tidak terkirim dan tidak akan dicoba ulang otomatis.',
    zh: '✓ 血壓已存檔。家人的個人通知已送達，但家人群組通知沒有送出，也不會自動重試。',
    en: '✓ Blood pressure saved. The personal notifications reached the family, but the family group notification was not sent and will not be retried automatically.',
  },
  familyAlertSharedNotSentPersonalUnknown: {
    id: '✓ Tekanan darah tersimpan, tapi notifikasi ke grup keluarga tidak terkirim dan tidak akan dicoba ulang otomatis; notifikasi pribadi tidak bisa dipastikan sampai. Hubungi keluarga langsung untuk memastikan.',
    zh: '✓ 血壓已存檔，但家人群組通知沒有送出，也不會自動重試；個人通知無法確認是否送達。請直接聯絡家人確認。',
    en: '✓ Blood pressure saved, but the family group notification was not sent and will not be retried automatically; the personal notifications could not be confirmed as delivered. Contact the family directly to confirm.',
  },
}

// 「沒有任何家屬通知送出」的提示只對需要現在行動的讀數顯示（北極星鐵律 3：警報分級、寧缺勿濫）。
// 多數病人沒有訂閱共用群組也沒有個人化通知，若每一筆都提示，看護很快就會忽略它，
// 真正危險的那一筆反而沒人看。納入與排除的理由：
// - 納入 danger／danger-low／warning-low 與 warning：九級表對這些等級都有「重測／回報」的行動建議，
//   心跳 >120 也會把 level 推上 warning，一併納入。
// - 排除 warning 裡的「偏高觀察」（observasi）：九級表本身寫明「記錄即可，無須警報」，但它的
//   webAlertLevel 也是 warning，所以要用規則 key 排除，不能只看 level；心跳 >120 時仍要提示。
// - 排除 normal、off-target、below-target：後兩者的建議是「記錄、回診時一併回報」，不是現在行動。
export interface FamilyAlertEvaluation {
  level: AlertLevel
  pulseWarning: boolean
  bpRule: { key: string }
}

export function isFamilyAlertLevelReading(evaluation: FamilyAlertEvaluation): boolean {
  switch (evaluation.level) {
    case 'danger':
    case 'danger-low':
    case 'warning-low':
      return true
    case 'warning':
      return evaluation.pulseWarning || evaluation.bpRule.key !== 'observasi'
    default:
      return false
  }
}

export const BP_INPUT_LIMITS = {
  systolic: { min: 60, max: 300 },
  diastolic: { min: 30, max: 200 },
  pulse: { min: 20, max: 300 },
} as const

export type BpField = keyof typeof BP_INPUT_LIMITS

/** 兩位數輸入等待後續數字的時間；照護者抄血壓計時打完兩位數常會停頓一下。 */
export const BP_AUTO_ADVANCE_DELAY_MS = 600

/**
 * 決定輸入某一格後要不要自動跳到下一格。
 *
 * 修正前三格用兩套規則：收縮壓要滿三位數才跳，舒張壓與心跳滿兩位數且 >= 40 就跳。
 * 結果是外觀相同的三個框行為不同——收縮壓 98 不會跳、舒張壓 85 會跳——
 * 照護者無法建立穩定預期。
 *
 * 現在三格共用同一條規則，並把兩位數的情況改成延遲跳轉：
 * 三位數在血壓情境已是完整讀值，可以立刻跳；兩位數則可能只是三位數打到一半
 * （例如 105 會先經過 10），必須留一段時間讓使用者補完，否則焦點會在打字中途被搶走。
 */
export function bpAutoAdvance(field: BpField, value: number | ''): 'immediate' | 'delayed' | 'none' {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return 'none'

  const digits = String(value).length
  // 三格上限都是三位數，因此第三位數輸入完必定是完整讀值。
  if (digits >= 3) return 'immediate'
  // 兩位數只有在已達該欄位下限時才可能是完整讀值；10（打 105 的中途）不符合，會繼續等待。
  if (digits === 2 && value >= BP_INPUT_LIMITS[field].min) return 'delayed'
  return 'none'
}

// 繁體中文註解：送進資料庫前先用同一組邊界擋掉假值，避免只靠 DB constraint 才發現錯誤而讓畫面卡在儲存流程。
export function isValidBpInput(sys: unknown, dia: unknown, pul: unknown): boolean {
  return (
    typeof sys === 'number' &&
    typeof dia === 'number' &&
    Number.isInteger(sys) &&
    Number.isInteger(dia) &&
    sys >= BP_INPUT_LIMITS.systolic.min &&
    sys <= BP_INPUT_LIMITS.systolic.max &&
    dia >= BP_INPUT_LIMITS.diastolic.min &&
    dia <= BP_INPUT_LIMITS.diastolic.max &&
    // 舊紀錄可能尚未量心跳；容許 null 才能修正血壓，而新輸入頁的空字串仍會轉成 0 並維持必填。
    (pul === null || (typeof pul === 'number' && Number.isInteger(pul) && pul >= BP_INPUT_LIMITS.pulse.min && pul <= BP_INPUT_LIMITS.pulse.max)) &&
    dia < sys
  )
}

// ── Style maps keyed by alert tone ────────────────────────────────────────
// 繁體中文註解：輸入當下的即時回饋面板底色。等級對照表在 src/lib/alertPresentation.ts（§4.3 收斂），
// 這裡只保留「輸入頁專屬」的淺底面板樣式——它比 chip 大得多，實心深紅會整塊蓋住下方文字。
// 送出按鈕的底色與圖示直接用 alertPresentation 的 ALERT_BUTTON_CLASS／ALERT_ICON，不在本檔另建一份。
import type { AlertTone } from '../../../lib/alertPresentation'

export const alertCls: Record<AlertTone, string> = {
  'on-target':   'bg-brand-50  text-brand-700  border-brand-200',
  normal:        'bg-green-50  text-green-800  border-green-200',
  'below-target':'bg-warn-50   text-warn-700   border-amber-200',
  'warning-low': 'bg-orange-50 text-orange-800 border-orange-200',
  'danger-low':  'bg-red-50    text-red-800    border-red-200',
  'off-target':  'bg-danger-50 text-danger-700 border-red-200',
  'pulse-warning':'bg-orange-50 text-orange-800 border-orange-200',
  warning:       'bg-danger-50 text-danger-700 border-red-300',
  danger:        'bg-red-100   text-red-800    border-red-300',
  critical:      'bg-red-200   text-red-900    border-red-400',
}

export const sessionIcon  = { pagi: '🌅', siang: '☀️', malam1: '🌙', malam2: '🌙', malam3: '🌙' } as const
export const sessionColor = {
  pagi:   'bg-amber-100 text-amber-800',
  siang:  'bg-sky-100   text-sky-800',
  malam1: 'bg-indigo-100 text-indigo-800',
  malam2: 'bg-indigo-100 text-indigo-800',
  malam3: 'bg-indigo-100 text-indigo-800',
} as const



// ── One row in the 3-day summary (one date+session group) ─────────────────
export interface SessionSummary {
  dateStr: string   // e.g. "6/14"
  timeStr: string   // e.g. "20:15"
  session: Session
  avgSys:  number
  avgDia:  number
  avgPul:  number
}

const RECENT_SUMMARY_GROUP_LIMIT = 9

// ── Query Supabase for last 3 days *for one subject*, group by date+session ─
// 繁體中文註解：查詢最近 3 日該量測對象之紀錄並做時段平均計算，以利 UI 渲染簡介表格。
export async function fetchRecentSummary(patientId: string): Promise<SessionSummary[]> {
  const { start, end } = careDayWindow(3, dayjs().tz(TZ))
  const since = start.toISOString()
  const until = end.toISOString()
  const data = isDemoMode() && isDemoPatientId(patientId)
    ? getDemoBpRecords(90, patientId).filter(record => Date.parse(record.measured_at) >= Date.parse(since) && Date.parse(record.measured_at) < Date.parse(until))
    : (await supabase
      .from('blood_pressure_records')
      .select('systolic, diastolic, pulse, measured_at')
      .eq('patient_id', patientId)
      .gte('measured_at', since)
      .order('measured_at', { ascending: false })).data

  if (!data || data.length === 0) return []

  // Group rows by "date string + session" key
  const groups = new Map<string, { sys: number[]; dia: number[]; pul: number[]; session: Session; dateStr: string; latestTimeStr: string }>()
  for (const r of data) {
    const dt      = dayjs(r.measured_at).tz(TZ)
    const careDate = careDateKey(dt)
    const dateStr = `${Number(careDate.slice(5, 7))}/${Number(careDate.slice(8, 10))}`
    const timeStr = dt.format('HH:mm')
    const session = getSession(dt.hour())
    const key     = `${careDate}-${session}`
    if (!groups.has(key)) {
      groups.set(key, { sys: [], dia: [], pul: [], session, dateStr, latestTimeStr: timeStr })
    }
    const g = groups.get(key)!
    g.sys.push(r.systolic)
    g.dia.push(r.diastolic)
    if (r.pulse != null) g.pul.push(r.pulse)
  }

  const avg = (arr: number[]) =>
    arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0

  return Array.from(groups.values())
    .map(g => ({
      dateStr: g.dateStr,
      timeStr: g.latestTimeStr,
      session: g.session,
      avgSys: avg(g.sys),
      avgDia: avg(g.dia),
      avgPul: avg(g.pul)
    }))
    .slice(0, RECENT_SUMMARY_GROUP_LIMIT)
}
