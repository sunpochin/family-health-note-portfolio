/*
檔案用途：把「現在幾點」對應到血壓量測時段（pagi／siang／malam1／malam2／malam3）的純函式與型別。
所在層：src/lib；不碰 React、不碰 Supabase，供輸入頁、每日照護摘要與 Telegram 通知文案共用同一套時段定義。
主要關聯：src/features/vitals/pages/InputPage.tsx、src/lib/careDay.ts、tests/unit/session.test.ts。
*/

// 為什麼晚上要拆成三個 bucket：長輩若有夜間低血壓的傾向，照護者可能在 18:00／20:00／22:00
// 分別量測，再決定要不要跟家屬討論送醫。原本單一的 'malam'（17:00–04:59）會把整晚的讀值
// 混在一起，後面的量測點會誤沿用第一個量測點的「休息／完成」流程。這些 bucket 只用來判斷
// 現在是哪個時段，不是「每晚一定要量三次」的規則。
// （這段註解只描述通用照護情境，不記錄任何特定使用者的病況。）
export type Session = 'pagi' | 'siang' | 'malam1' | 'malam2' | 'malam3'

// Pulled out of InputPage.tsx into its own module so it's unit-testable
// without mounting React or mocking Supabase.
export function getSession(h: number): Session {
  if (h >= 5  && h < 12) return 'pagi'
  if (h >= 12 && h < 17) return 'siang'
  if (h >= 17 && h < 19) return 'malam1'  // ~18:00 checkpoint
  if (h >= 19 && h < 21) return 'malam2'  // ~20:00 checkpoint
  return 'malam3'                          // ~22:00 checkpoint (also covers overnight/early-morning stragglers)
}
