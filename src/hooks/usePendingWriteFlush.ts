/*
檔案用途：集中離線佇列的自動觸發時機（連線恢復、分頁回前景、iOS bfcache 還原、原生殼回前景）
  與失敗退避排程，讓呼叫端只需提供「目前是否有待送紀錄」與「怎麼同步一輪」。
所在層：src/hooks 共用 hook；血壓輸入（issue #816）與服藥打卡（issue #822）的離線佇列共用同一套觸發器。
主要關聯：由 useBloodPressureInputForm、useMedicationPendingDoses 呼叫；實際佇列讀寫在 lib/pendingWriteQueue 與各領域 adapter，
  Telegram 通知、埋點、畫面清單更新等跨狀態的語意動詞留在呼叫端的 sync callback 內，避免被硬拆進這個觸發器。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { App } from '@capacitor/app'
import { isNativeApp } from '../lib/platform'

// 弱網路重試需要遞增退避，避免每次「回前景」事件都立刻狂打 Supabase；
// 30 秒／2 分鐘／10 分鐘後仍失敗就固定停在 10 分鐘，等待下一次真正的連線／前景事件再重置。
export const DEFAULT_RETRY_BACKOFF_MS = [30_000, 120_000, 600_000] as const

export interface UsePendingWriteFlushParams {
  /** 沒有登入者或處於 demo 模式時完全不掛監聽、不排程重試。 */
  enabled: boolean
  /** 目前是否還有待送紀錄；由 false 轉為 true 以外的情況不需要再排程退避重試。 */
  hasPending: boolean
  /** 實際同步一輪；回傳 true 代表佇列已清空（或本來就沒有東西要送），不需要再排程重試。 */
  sync: () => Promise<boolean>
  /** 供測試注入極短延遲；正式環境使用預設的 30s／2m／10m。 */
  retryDelaysMs?: readonly number[]
  /** 改變時強制重新探測一次（例如切換病人）；不需要每次都是新值，只在真的要重探測時變更。 */
  resetKey?: string | number
}

export interface PendingWriteFlushTrigger {
  syncing: boolean
  /** 最近一次嘗試同步的時間戳（epoch ms）；尚未嘗試過時為 null。 */
  lastAttemptAt: number | null
  /** 手動「現在同步」按鈕與自動觸發共用同一個防重入入口。 */
  retryNow: () => Promise<void>
}

export function usePendingWriteFlush({
  enabled,
  hasPending,
  sync,
  retryDelaysMs = DEFAULT_RETRY_BACKOFF_MS,
  resetKey,
}: UsePendingWriteFlushParams): PendingWriteFlushTrigger {
  const [syncing, setSyncing] = useState(false)
  const [lastAttemptAt, setLastAttemptAt] = useState<number | null>(null)

  const inFlightRef = useRef(false)
  const backoffIndexRef = useRef(0)
  const backoffTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // sync 每次 render 都可能是新的閉包（依賴 patientId／pendingRecords 等）；用 ref 讓事件監聽與
  // 排程的 effect 不必因為 sync identity 變動而重新掛載監聽器。
  const syncRef = useRef(sync)
  syncRef.current = sync
  // attempt() 是跨 await 的非同步函式；停用或卸載發生在「已送出請求、還沒等到回應」的期間時，
  // 舊呼叫捕捉到的 enabled 仍是呼叫當下的值（closure 不會因為外層 effect 重新掛載而失效），
  // 必須靠這個旗標讓回應遲到的舊呼叫知道自己已經退場，不能再排下一輪重試或動退避狀態。
  const disposedRef = useRef(true)
  // 探測世代：每次 effect 重新掛載（換 resetKey、重新啟用）就 +1。disposedRef 擋不住「換病人」：
  // 新病人的 setup 會把它重設回 false，於是上一位病人遲到的回應會誤以為自己仍是現役，
  // 而新病人在掛載時的那次探測又已經被 inFlightRef 擋掉，兩邊都沒人負責新病人的佇列（issue #1130）。
  // 每一輪 attempt 記下自己出生時的世代，結束時比對，就能分辨「我已經過期」並替現任補探測。
  const generationRef = useRef(0)
  // 追蹤上一輪的 hasPending，只在「從沒有變成有」時才需要主動探測一次；
  // 單純維持 true／false 不代表發生了新事件。
  const previousHasPendingRef = useRef(hasPending)

  const clearBackoffTimer = useCallback(() => {
    if (backoffTimerRef.current === null) return
    clearTimeout(backoffTimerRef.current)
    backoffTimerRef.current = null
  }, [])

  const attempt = useCallback(async () => {
    if (!enabled || inFlightRef.current) return
    inFlightRef.current = true
    const generation = generationRef.current
    setSyncing(true)
    setLastAttemptAt(Date.now())
    try {
      const cleared = await syncRef.current()
      // 等待期間若已停用／卸載／換了探測對象，這次遲到的結果不能再幫已經退場的那一輪排下一次重試，
      // 否則會變成停不下來的殭屍計時器，登出或切頁後還在背景重送。
      // 換了探測對象時也不能動退避狀態：backoffIndexRef 與計時器現在屬於新病人，不是這次回應的主人。
      if (disposedRef.current || generation !== generationRef.current) return
      clearBackoffTimer()
      if (cleared) {
        backoffIndexRef.current = 0
        return
      }
      const delay = retryDelaysMs[Math.min(backoffIndexRef.current, retryDelaysMs.length - 1)]
      backoffIndexRef.current = Math.min(backoffIndexRef.current + 1, retryDelaysMs.length - 1)
      backoffTimerRef.current = setTimeout(() => { void attempt() }, delay)
    } finally {
      inFlightRef.current = false
      setSyncing(false)
      // 執行順序要在釋放 inFlightRef 之後：這次補探測自己也要先取得防重入旗標。
      // 飛行期間換了病人（世代已變、仍在線上）的話，新病人掛載時的探測被這一輪擋掉了，
      // 而新病人的 hasPending 多半是 true→true，不會再觸發「第一筆待送」探測；
      // 不在這裡補一次，「30 秒內自動補送」的承諾就會落空，直到下一個外部事件或手動「現在同步」。
      // 每次補探測都只會用「當下」的世代出生，只有使用者再切一次病人才可能再過期，所以遞迴次數受切換次數限制、不會失控。
      // 開發模式的 StrictMode 會 掛載→卸載→再掛載，第一輪因此被判過期而多補探測一次（開 App 時連送兩輪同步）；
      // 佇列以固定 id／劑次當去重鍵，重送是冪等的，正式環境不會發生，看開發環境網路紀錄時別被它嚇到。
      if (!disposedRef.current && generation !== generationRef.current) void attempt()
    }
    // retryDelaysMs 在測試以外都是穩定的模組常數，不需要放進依賴陣列造成 attempt identity 反覆改變。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, clearBackoffTimer])

  useEffect(() => {
    if (!enabled) return
    disposedRef.current = false
    generationRef.current += 1
    // 換探測對象（resetKey）或重新啟用時都要從頭開始：不能沿用上一輪（可能是另一位病人）
    // 留下的退避階段，否則新對象的第一次失敗會直接套用舊對象累積到的 10 分鐘等級。
    backoffIndexRef.current = 0
    clearBackoffTimer()
    void attempt()

    const handleTrigger = () => { void attempt() }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') handleTrigger()
    }
    window.addEventListener('online', handleTrigger)
    document.addEventListener('visibilitychange', handleVisibility)
    // iOS（含 iOS Chrome，底層仍是 WebKit）從背景／多工切換器切回時走 bfcache 還原，
    // 常常不會觸發 visibilitychange，但一定會觸發 pageshow，比照 PwaUpdatePrompt 的作法補聽。
    window.addEventListener('pageshow', handleTrigger)

    // 原生殼沒有瀏覽器 tab 的 visibilitychange／pageshow 語意；appStateChange 才是 App 從背景回前景的訊號。
    let removeAppListener: (() => void) | undefined
    if (isNativeApp()) {
      const listenerHandle = App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) handleTrigger()
      })
      removeAppListener = () => { void listenerHandle.then(handle => handle.remove()) }
    }

    return () => {
      disposedRef.current = true
      window.removeEventListener('online', handleTrigger)
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('pageshow', handleTrigger)
      removeAppListener?.()
      clearBackoffTimer()
    }
    // resetKey 特意放進依賴陣列：identity 不變時 attempt／clearBackoffTimer 也不會變，
    // 但切換病人需要強制重新掛載監聽器並立刻探測一次新病人的佇列，不能等下一個外部事件才觸發。
  }, [enabled, attempt, clearBackoffTimer, resetKey])

  useEffect(() => {
    const wasPending = previousHasPendingRef.current
    previousHasPendingRef.current = hasPending
    if (!hasPending) {
      // 佇列已清空後不需要繼續倒數上一輪失敗留下的退避計時器；下一筆新的離線紀錄會重新從頭排程。
      backoffIndexRef.current = 0
      clearBackoffTimer()
      return
    }
    if (wasPending) return
    // 佇列從「沒有待送」變成「有」時（例如送出當下遇到暫時性錯誤才第一次進佇列），
    // navigator.onLine 通常仍是 true，不會有任何 online／visibilitychange 事件自然發生；
    // 沒有這次主動探測，這筆新紀錄就得等使用者切背景再回來或手動按「現在同步」才會第一次重試。
    void attempt()
  }, [hasPending, clearBackoffTimer, attempt])

  return { syncing, lastAttemptAt, retryNow: attempt }
}
