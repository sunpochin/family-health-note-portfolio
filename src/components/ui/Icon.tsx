/*
檔案用途：一套共用 SVG 圖示元件，逐步取代全站的 emoji 圖示。
所在層：src/components/ui；被底部導覽、每日照護模組 chip 等狀態表達元件使用。
主要關聯：App.tsx 的 TabBtn、daily-care/DailyCareSectionTabs.tsx、CollapsibleSection、登入／服藥／軌跡等畫面的按鈕與提示；新增圖示請在 ICON_PATHS 補一組。
*/

// emoji 圖示跨平台字型不一（同一個 emoji 在 iOS／Android／Windows 畫出來可能完全不同形狀），
// 也無法用 design token 控制顏色與對比；改用 stroke SVG 後顏色跟著 currentColor 走，
// 尺寸與線寬固定，深色模式或未來換色只要改 CSS 變數，不用重畫圖示。
// A 期先收錄底部導覽用得到的圖示；G 期（issue #1150）把其餘介面 emoji 遷移過來，圖示依 Lucide 線條語言繪製
// （viewBox 24、stroke 2、圓角端點；部分路徑參考 Lucide，ISC License，https://lucide.dev/license）。
// 圖示一律 aria-hidden：意義由旁邊的三語文字表達，不能只靠圖示傳達（設計鐵律：不靠圖示或顏色單獨傳達）。
// 警示階梯（issue #1153）也收在這裡：ALERT_ICON 對照到下方 target／arrow-*-circle／alert-octagon／heart-pulse；
// bp-levels.json 標籤裡的 emoji 仍保留給推播（純文字通道畫不出 SVG），只在畫面上由 alertLabelText() 剝掉。
import type { ReactNode } from 'react'

export type IconName =
  | 'pin' | 'calendar' | 'calendar-check' | 'settings' | 'sun' | 'history' | 'stethoscope'
  | 'users' | 'user' | 'sliders' | 'sparkles' | 'pill' | 'clipboard' | 'paw' | 'camera' | 'image'
  | 'alert-triangle' | 'refresh' | 'globe' | 'lock' | 'copy' | 'download' | 'printer' | 'check' | 'check-circle'
  | 'info' | 'help-circle'
  | 'target' | 'arrow-up-circle' | 'arrow-down-circle' | 'alert-octagon' | 'heart-pulse'

const ICON_PATHS: Record<IconName, ReactNode> = {
  // B 期新增：底部導覽「今天」tab 用太陽圖示，呼應「今天要做什麼」的第一層問題，跟其餘資料表式圖示區分開來。
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <line x1="12" y1="2.5" x2="12" y2="5" />
      <line x1="12" y1="19" x2="12" y2="21.5" />
      <line x1="4.2" y1="4.2" x2="6" y2="6" />
      <line x1="18" y1="18" x2="19.8" y2="19.8" />
      <line x1="2.5" y1="12" x2="5" y2="12" />
      <line x1="19" y1="12" x2="21.5" y2="12" />
      <line x1="4.2" y1="19.8" x2="6" y2="18" />
      <line x1="18" y1="6" x2="19.8" y2="4.2" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  // D 期新增：底部導覽「軌跡」tab 用鐘面圖示，呼應「之前發生什麼、改了什麼」的時間軸語意。
  history: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
      <line x1="8" y1="3" x2="8" y2="6.5" />
      <line x1="16" y1="3" x2="16" y2="6.5" />
    </>
  ),
  'calendar-check': (
    <>
      <rect x="3.5" y="5" width="17" height="16" rx="2" />
      <line x1="3.5" y1="9.5" x2="20.5" y2="9.5" />
      <line x1="8" y1="3" x2="8" y2="6.5" />
      <line x1="16" y1="3" x2="16" y2="6.5" />
      <path d="M8.5 14.5 L11 17 L15.5 12.5" />
    </>
  ),
  // E 期新增（照護閉環 T5，issue #949）：底部導覽「門診」tab 用聽診器，直接對應「帶什麼去給醫師、問什麼」的看診語意。
  stethoscope: (
    <>
      <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" />
      <path d="M8 15v1a6 6 0 0 0 12 0v-4" />
      <circle cx="20" cy="10" r="2" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13a7.97 7.97 0 0 0 0-2l2-1.5-2-3.5-2.4 1a8.05 8.05 0 0 0-1.7-1L15 3h-4l-.3 2.5a8.05 8.05 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7.97 7.97 0 0 0 0 2l-2 1.5 2 3.5 2.4-1c.5.4 1.1.75 1.7 1L11 21h4l.3-2.5c.6-.25 1.2-.6 1.7-1l2.4 1 2-3.5-2-1.5Z" />
    </>
  ),
  // G 期新增（issue #1150）：以下取代介面裡原本用 emoji 當圖示的位置，顏色一律跟著 currentColor。
  users: (
    <>
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </>
  ),
  user: (
    <>
      <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </>
  ),
  sliders: (
    <>
      <line x1="21" y1="4" x2="14" y2="4" />
      <line x1="10" y1="4" x2="3" y2="4" />
      <line x1="21" y1="12" x2="12" y2="12" />
      <line x1="8" y1="12" x2="3" y2="12" />
      <line x1="21" y1="20" x2="16" y2="20" />
      <line x1="12" y1="20" x2="3" y2="20" />
      <line x1="14" y1="2" x2="14" y2="6" />
      <line x1="8" y1="10" x2="8" y2="14" />
      <line x1="16" y1="18" x2="16" y2="22" />
    </>
  ),
  sparkles: (
    <>
      <path d="M9.94 15.5A2 2 0 0 0 8.5 14.06l-6.14-1.58a.5.5 0 0 1 0-.96L8.5 9.94A2 2 0 0 0 9.94 8.5l1.58-6.14a.5.5 0 0 1 .96 0L14.06 8.5a2 2 0 0 0 1.44 1.44l6.14 1.58a.5.5 0 0 1 0 .96L15.5 14.06a2 2 0 0 0-1.44 1.44l-1.58 6.14a.5.5 0 0 1-.96 0Z" />
      <path d="M20 3v4" />
      <path d="M22 5h-4" />
      <path d="M4 17v2" />
      <path d="M5 18H3" />
    </>
  ),
  pill: (
    <>
      <path d="m10.5 20.5 10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7Z" />
      <path d="m8.5 8.5 7 7" />
    </>
  ),
  clipboard: (
    <>
      <rect x="8" y="2" width="8" height="4" rx="1" />
      <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
      <path d="M9 12h6" />
      <path d="M9 16h6" />
    </>
  ),
  // 爪印：寵物分類的泛用記號（具體物種的插畫另有 MengniCatMark 等，不歸這裡）。
  paw: (
    <>
      <circle cx="5.5" cy="11" r="1.8" />
      <circle cx="9.5" cy="6" r="1.8" />
      <circle cx="14.5" cy="6" r="1.8" />
      <circle cx="18.5" cy="11" r="1.8" />
      <path d="M12 12.5c-2.6 0-5.5 3.1-5.5 5.6 0 1.6 1.2 2.4 2.6 2.4 1 0 1.9-.5 2.9-.5s1.9.5 2.9.5c1.4 0 2.6-.8 2.6-2.4 0-2.5-2.9-5.6-5.5-5.6Z" />
    </>
  ),
  camera: (
    <>
      <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3Z" />
      <circle cx="12" cy="13" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21" />
    </>
  ),
  // 三角驚嘆號：一般提醒（封存提示、刪除帳號、離線、低信心辨識…），也是血壓警示階梯「偏高／偏低」兩階的圖示（#1153）。
  'alert-triangle': (
    <>
      <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </>
  ),
  refresh: (
    <>
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
      <path d="M2 12h20" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </>
  ),
  download: (
    <>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
      <path d="M12 15V3" />
    </>
  ),
  // 匯出按鈕也走共用圖示，避免複製與列印各自維護筆畫、尺寸和無障礙行為。
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </>
  ),
  printer: (
    <>
      <path d="M6 9V3h12v6" />
      <rect x="3" y="9" width="18" height="8" rx="2" />
      <path d="M7 14h10v7H7z" />
    </>
  ),
  check: <path d="M20 6 9 17l-5-5" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4" />
      <path d="M12 8h.01" />
    </>
  ),
  // 以下五個是血壓警示階梯專用（issue #1153），取代 ALERT_ICON 原本的 🎯🔺🔻🔴💓。
  // 上／下箭頭要保留「往哪邊偏」：灰階列印與紅綠色盲下顏色傳不到，方向只能靠形狀。
  // 箭頭外加圓圈而不是單獨的三角形：14px 的空心三角上下顛倒時幾乎認不出方向，帶桿的箭頭在小尺寸仍清楚。
  target: (
    <>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="6" />
      <circle cx="12" cy="12" r="2" />
    </>
  ),
  'arrow-up-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m16 12-4-4-4 4" />
      <path d="M12 16V8" />
    </>
  ),
  'arrow-down-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="m8 12 4 4 4-4" />
      <path d="M12 8v8" />
    </>
  ),
  // 八角形＝停止標誌：只給危險級（明顯偏低、極高危險），跟一般 alert-triangle 在灰階下靠外形分開。
  'alert-octagon': (
    <>
      <path d="M15.31 2a2 2 0 0 1 1.42.59l4.68 4.68A2 2 0 0 1 22 8.69v6.62a2 2 0 0 1-.59 1.42l-4.68 4.68a2 2 0 0 1-1.42.59H8.69a2 2 0 0 1-1.42-.59l-4.68-4.68A2 2 0 0 1 2 15.31V8.69a2 2 0 0 1 .59-1.42l4.68-4.68A2 2 0 0 1 8.69 2Z" />
      <path d="M12 8v4" />
      <path d="M12 16h.01" />
    </>
  ),
  'heart-pulse': (
    <>
      <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
      <path d="M3.22 12H9.5l.5-1 2 4.5 2-7 1.5 3.5h5.27" />
    </>
  ),
  'help-circle': (
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </>
  ),
}

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-6 w-6'}
    >
      {ICON_PATHS[name]}
    </svg>
  )
}
