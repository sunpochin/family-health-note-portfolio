/*
檔案用途：離線佇列的「N 筆紀錄等待同步」狀態列——待送筆數、同步中、最後一次嘗試時間、同步失敗提示與「現在同步」按鈕；
  呼叫端可另給其他照護對象的筆數與真正的失敗原因（issue #1125，目前只有血壓用）。
所在層：src/components/ui 共用畫面元件；血壓輸入（issue #816）與服藥打卡（issue #822）共用同一個元件與同一份三語文案，
  避免兩個畫面各留一份後慢慢走樣（AGENTS.md「介面元件化規範」）。
主要關聯：features/vitals/pages/InputPage、features/medication/pages/MedicationPage、hooks/usePendingWriteFlush（syncing／lastAttemptAt／retryNow）。
*/
import type { ReactNode } from 'react'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import { TZ } from '../../lib/timezone'
import { useI18n, type LocalizedText } from '../../lib/i18n'

dayjs.extend(utc)
dayjs.extend(timezone)

export const PENDING_SYNC_TEXT = {
  pending: (count: number) => ({ id: `${count} catatan menunggu sinkronisasi`, zh: `${count} 筆紀錄等待同步`, en: `${count} ${count === 1 ? 'record' : 'records'} waiting to sync` }),
  lastAttempt: (timeStr: string) => ({ id: `Percobaan sinkronisasi terakhir pukul ${timeStr}`, zh: `最後一次嘗試同步時間：${timeStr}`, en: `Last sync attempt at ${timeStr}` }),
  syncing: { id: 'Menyinkronkan catatan…', zh: '正在同步紀錄…', en: 'Syncing records…' },
  syncError: { id: 'Periksa koneksi lalu coba sinkronisasi lagi.', zh: '請確認網路後再重新同步。', en: 'Check your connection and try syncing again.' },
  retry: { id: 'Sinkronkan sekarang', zh: '現在同步', en: 'Sync now' },
  // 其他照護對象還有離線暫存的紀錄（issue #1125）。只講筆數、不講數值與名字：這是目前病人的畫面，
  // 另一個人的健康數值不能出現在這裡（AGENTS.md § 3.5）；但完全不提，看護會以為切過來之後那筆就不見了。
  // 不用「另有／also」：目前這位沒有待送時，這一句會單獨當標題顯示。
  otherPatients: (count: number) => ({
    id: `${count} catatan untuk orang lain yang dirawat menunggu sinkronisasi`,
    zh: `其他照護對象還有 ${count} 筆紀錄等待同步`,
    en: `${count} ${count === 1 ? 'record' : 'records'} for other care recipients waiting to sync`,
  }),
}

// 「最後一次嘗試同步」統一用照護日所在的台北時區格式化，
// 避免看護裝置系統時區跟 App 內其他時間戳（如量測時間、服藥時間）對不上。
export function formatPendingAttemptTime(epochMs: number): string {
  return dayjs(epochMs).tz(TZ).format('HH:mm')
}

export function PendingSyncStatus({
  count,
  syncing,
  lastAttemptAt,
  syncError,
  syncErrorTexts,
  otherPatientsCount = 0,
  onRetry,
  children,
}: {
  count: number
  syncing: boolean
  lastAttemptAt: number | null
  syncError: boolean
  /** 呼叫端知道失敗的真正原因時，取代通用的「請確認網路」（issue #1125）；空陣列或未提供時沿用通用那句。 */
  syncErrorTexts?: readonly LocalizedText[]
  /** 同一帳號其他照護對象還在等的筆數；只顯示筆數（§ 3.5），「現在同步」也會一起補送它們。 */
  otherPatientsCount?: number
  onRetry: () => void
  /** 各領域額外的說明（例如服藥打卡「已由其他裝置記錄」）；放在同一個 status 區塊裡，讀屏器才會一起唸。 */
  children?: ReactNode
}) {
  const { text } = useI18n()
  // 佇列空了就整塊消失；不能留一個「0 筆等待同步」讓看護以為還有東西沒送。
  // 目前這位沒有、但其他人還有時仍要顯示：失敗原因與「現在同步」按鈕對整個帳號的佇列都有效。
  const anyPending = count > 0 || otherPatientsCount > 0
  if (!anyPending && !children) return null
  const errorTexts = syncErrorTexts && syncErrorTexts.length > 0 ? syncErrorTexts : [PENDING_SYNC_TEXT.syncError]

  return (
    <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-center text-sm text-amber-900">
      {anyPending && <>
        {(count > 0 || syncing) && (
          <p className="font-semibold">{syncing ? text(PENDING_SYNC_TEXT.syncing) : text(PENDING_SYNC_TEXT.pending(count))}</p>
        )}
        {otherPatientsCount > 0 && <p className={count > 0 || syncing ? 'mt-1 text-xs' : 'font-semibold'}>{text(PENDING_SYNC_TEXT.otherPatients(otherPatientsCount))}</p>}
        {/* 繁體中文註解：看護回到有訊號的地方時，用最後嘗試時間讓她判斷佇列是不是真的還在自動重試，不必猜測。 */}
        {!syncing && lastAttemptAt !== null && (
          <p className="mt-1 text-xs text-amber-800">{text(PENDING_SYNC_TEXT.lastAttempt(formatPendingAttemptTime(lastAttemptAt)))}</p>
        )}
        {syncError && errorTexts.map(item => <p key={item.zh} className="mt-1 text-xs">{text(item)}</p>)}
      </>}
      {children}
      {anyPending && (
        // 觸控目標至少 44px（control-min）：看護單手、半夜操作時 36／40px 容易按錯，與 15 秒原則衝突（#1161）。
        <button type="button" disabled={syncing} onClick={onRetry} className="mt-2 min-h-11 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-900 disabled:opacity-50">{text(PENDING_SYNC_TEXT.retry)}</button>
      )}
    </div>
  )
}
