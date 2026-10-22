/*
檔案用途：把「血壓第二次量測休息倒數」投影成 iOS Live Activity（鎖屏／動態島）可以顯示的白名單 payload（issue #865）。
所在層：src/lib 純函式；不碰 Capacitor、不讀 storage，讓隱私邊界能被 bun test 直接鎖住。
主要關聯：src/lib/nativeBloodPressureLiveActivity.ts（送進原生）、src/hooks/useBloodPressureLiveActivity.ts（何時送）、
  ios/App/BloodPressureLiveActivity/（SwiftUI 只負責畫）、docs/adr/010-live-activity-privacy-boundary.md。
*/
import { localized, type Locale, type LocalizedText } from './i18n'
import type { BloodPressureMeasurementSession } from './bloodPressureMeasurementSession'

/**
 * 鎖屏上會出現的全部內容。刻意只有「時間」與「固定文案」兩種欄位：
 * 鎖屏在未解鎖時就看得到，撿到或瞄到手機的人都能讀，所以病人 ID、姓名、第一次血壓數值一律不進這個型別。
 * 新增欄位前先讀 ADR-010；tests/unit/bloodPressureLiveActivity.test.ts 會鎖住欄位清單。
 */
export interface BloodPressureLiveActivityPayload {
  /** 倒數區間起點（epoch ms）；只用來讓 SwiftUI 的系統計時器有合法區間，不代表量測時間。 */
  startedAt: number
  /** 可以量第二次的時間（epoch ms）。 */
  deadline: number
  /** 倒數中的標題，例如「血壓複測倒數中」。 */
  countingTitle: string
  /** 歸零後的標題，與 App 內 banner 的「現在可以再量一次」一致。 */
  readyTitle: string
  /** 動態島展開時的副標，提醒回 App 量第二次。 */
  hint: string
}

export const BLOOD_PRESSURE_LIVE_ACTIVITY_PAYLOAD_KEYS = ['startedAt', 'deadline', 'countingTitle', 'readyTitle', 'hint'] as const

// 為什麼文案放在 TypeScript 而不是 Swift 的 .lproj：語言要跟 App 內切換器走（看護常把手機設中文、App 設印尼文），
// 而且 AGENTS.md § 3.6 的三語檢查只看得到這裡。原生 plugin 另有一份逐字相同的封閉允許清單（ApprovedCopy），只用來拒絕清單外的字串；
// 改這裡的任何一句都要同步改 BloodPressureLiveActivityPlugin.swift，否則鎖屏倒數會整筆被拒（測試會先擋下漂移）。
const LIVE_ACTIVITY_TEXT = {
  countingTitle: { id: 'Hitung mundur ukur ulang tensi', zh: '血壓複測倒數中', en: 'Blood pressure re-check countdown' },
  readyTitle: { id: 'Sekarang boleh ukur lagi', zh: '現在可以再量一次', en: 'You can measure again now' },
  hint: { id: 'Buka aplikasi untuk mencatat pengukuran kedua', zh: '回到 App 記錄第二次量測', en: 'Open the app to log the second reading' },
} as const satisfies Record<string, LocalizedText>

export function buildBloodPressureLiveActivityPayload(
  session: Pick<BloodPressureMeasurementSession, 'deadline'>,
  locale: Locale,
  now = Date.now(),
): BloodPressureLiveActivityPayload {
  return {
    // 重新整理後恢復的 session 可能已經過了 deadline；起點不能晚於終點，否則 SwiftUI 的 ClosedRange 會直接讓 extension 當掉。
    startedAt: Math.min(now, session.deadline),
    deadline: session.deadline,
    countingTitle: localized(LIVE_ACTIVITY_TEXT.countingTitle, locale),
    readyTitle: localized(LIVE_ACTIVITY_TEXT.readyTitle, locale),
    hint: localized(LIVE_ACTIVITY_TEXT.hint, locale),
  }
}

/**
 * 同一個 key 代表鎖屏上已經是正確內容，不必重建 Activity。
 * 包含 sessionKey 是為了「同一毫秒 deadline 但換了時段」這種極端情況也會重建；包含 locale 是因為文案寫在 Activity 的靜態屬性裡，換語言只能重建。
 * sessionKey 內含 patient_id，但這個 key 只留在 JS 記憶體裡比對，不會送進原生。
 */
export function getBloodPressureLiveActivityKey(
  session: Pick<BloodPressureMeasurementSession, 'deadline' | 'sessionKey'> | null,
  locale: Locale,
): string | null {
  return session ? `${session.sessionKey}|${session.deadline}|${locale}` : null
}
