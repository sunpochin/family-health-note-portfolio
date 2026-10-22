/*
檔案用途：原生殼收到 Siri／捷徑 App 意圖（記錄血壓、記錄服藥）後送來的 jia-jian-log://record/… 網址的白名單解析、暫存與一次性投遞，
並決定要開哪個畫面或停在對象選擇（issue #868）。
所在層：src/lib；純解析＋記憶體內的小型訂閱機制，不碰 Supabase、不寫任何值、不帶任何病人資料。
主要關聯：ios/App/App/SiriShortcutRouter.swift（送出網址）、nativeAuth.ts 的 appUrlOpen 分派（OAuth 之後、https app link 之前）、
         components/system/NativeShortcutNavigator.tsx（訂閱端）、App.tsx（實際切換分頁）、docs/features/siri-shortcuts.md。

為什麼只開畫面、不存值：語音辨識不夠準確到可以直接寫入健康資料；意圖只負責「導航」，數值一律由使用者在畫面上自己輸入確認。
為什麼網址不帶病人：對象一律由 App 內既有的「目前對象」決定（AGENTS.md § 3.5 對象綁定）；多位照護對象時不替使用者選，
改停在可選擇的畫面（見 resolveNativeShortcutAction）。
為什麼用記憶體訂閱而不是重新導向 WebView：重新載入會丟掉畫面上還沒存的草稿，冷啟動也會多載入一次；
而且 URL 沒有進網址列，reload 之後不會重放。
*/

export type NativeShortcutTarget = 'bloodPressure' | 'medication'

// 必須跟 ios/App/App/SiriShortcutRouter.swift 的 Destination 逐字相同。
export const NATIVE_SHORTCUT_URLS: Readonly<Record<NativeShortcutTarget, string>> = {
  bloodPressure: 'jia-jian-log://record/blood-pressure',
  medication: 'jia-jian-log://record/medication',
}

const TARGET_BY_URL: ReadonlyMap<string, NativeShortcutTarget> = new Map(
  (Object.entries(NATIVE_SHORTCUT_URLS) as [NativeShortcutTarget, string][]).map(([target, url]) => [url, target]),
)

// 登入畫面、同意畫面或 App 鎖時外殼還沒掛載，請求先留著；超過這段時間就丟掉，
// 避免使用者在登入畫面停了很久之後，App 突然自己跳到血壓輸入。
export const NATIVE_SHORTCUT_PENDING_TTL_MS = 2 * 60 * 1000

/**
 * 白名單解析：把網址正規化後必須「逐字等於」兩個固定網址之一，其餘一律 null（由呼叫端靜默忽略）。
 * 用正規化後的 href 比對而不是逐欄檢查，query、fragment、帳密、port、結尾斜線、多餘路徑會一次全部被擋掉。
 * 自訂 scheme 任何 App 或網頁都能呼叫，所以這個入口只能做「開畫面」這種不寫資料、不洩漏資料的事。
 */
export function parseNativeShortcutLink(rawUrl: string): NativeShortcutTarget | null {
  try {
    return TARGET_BY_URL.get(new URL(rawUrl).href) ?? null
  } catch {
    return null
  }
}

export type NativeShortcutAction =
  | { kind: 'openModule', moduleId: NativeShortcutTarget }
  // goToToday：要不要把畫面切到今天頁（有對象選擇器、也有「量血壓」入口）。
  | { kind: 'chooseSubject', goToToday: boolean }

/**
 * 決定這次語音喚起要做什麼：只有一位可操作的對象時直接開對應模組；兩位以上時不猜，改停在可選擇對象的畫面。
 * 即使「上次用的對象」是明確的，語音喚起也跳過了使用者平常會看到對象名稱的那一步，所以多位時寧可多一步確認。
 *
 * 為什麼已經在照護頁時不離開（onCareTab）：照護頁的血壓等輸入畫面沒有草稿保存，切走分頁會丟掉打到一半的數字；
 * 而照護頁自己就有對象選擇器，留在原地加上提示就夠了。
 */
export function resolveNativeShortcutAction(
  target: NativeShortcutTarget,
  context: { hasMultipleSubjects: boolean, onCareTab: boolean },
): NativeShortcutAction {
  if (!context.hasMultipleSubjects) return { kind: 'openModule', moduleId: target }
  return { kind: 'chooseSubject', goToToday: !context.onCareTab }
}

type NativeShortcutListener = (target: NativeShortcutTarget) => void

let pending: { target: NativeShortcutTarget, receivedAt: number } | null = null
const listeners = new Set<NativeShortcutListener>()

/** 投遞一次語音喚起：有人在聽就立刻交出去，沒人在聽（外殼還沒掛載）就只保留最新一個。 */
export function publishNativeShortcut(target: NativeShortcutTarget, now: number = Date.now()): void {
  if (listeners.size === 0) {
    pending = { target, receivedAt: now }
    return
  }
  pending = null
  for (const listener of [...listeners]) listener(target)
}

/** 訂閱語音喚起；訂閱當下若有尚未過期的暫存請求會立刻交付一次。回傳取消訂閱函式。 */
export function subscribeNativeShortcut(listener: NativeShortcutListener, now: number = Date.now()): () => void {
  listeners.add(listener)
  const waiting = pending
  pending = null
  if (waiting && now - waiting.receivedAt <= NATIVE_SHORTCUT_PENDING_TTL_MS) listener(waiting.target)
  return () => { listeners.delete(listener) }
}

/**
 * 處理 appUrlOpen／getLaunchUrl 收到的網址；回傳這個網址是不是語音喚起網址（是就代表已被這條路徑認領，不必再交給其他處理）。
 *
 * 為什麼 getLaunchUrl 認領但不投遞：iOS 的 getLaunchUrl 回傳「最後一個」開啟過的網址，WebView reload 後每次初始化都會再回傳；
 * 語音喚起是一次性的手勢，重放會讓使用者在 reload（例如載入失敗後的自動重試）之後又被帶到血壓輸入。
 * 冷啟動不會因此漏掉：原生端在 bridge 載入後才投遞，appUrlOpen 事件會保留到 listener 註冊（retainUntilConsumed）。
 */
export function handleNativeShortcutUrl(rawUrl: string, options: { fromLaunch?: boolean } = {}): boolean {
  const target = parseNativeShortcutLink(rawUrl)
  if (!target) return false
  if (!options.fromLaunch) publishNativeShortcut(target)
  return true
}

/** 只給測試用：清掉模組層級的暫存與訂閱，模擬 WebView 重新載入。 */
export function resetNativeShortcutsForTests(): void {
  pending = null
  listeners.clear()
}
