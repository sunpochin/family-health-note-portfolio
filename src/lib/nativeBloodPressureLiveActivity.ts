/*
檔案用途：橋接 iOS 原生殼內建的 BloodPressureLiveActivity plugin（ActivityKit），只提供「開始倒數」與「結束倒數」兩個動作（issue #865）。
所在層：src/lib 平台轉接層；不讀健康資料、不碰 Supabase，也不把任何東西送到伺服器。
主要關聯：ios/App/App/BloodPressureLiveActivityPlugin.swift（原生實作）、src/lib/bloodPressureLiveActivity.ts（payload 白名單）、
  src/hooks/useBloodPressureLiveActivity.ts（呼叫時機）。
*/
import { registerPlugin } from '@capacitor/core'
import type { BloodPressureLiveActivityPayload } from './bloodPressureLiveActivity'

interface BloodPressureLiveActivityPlugin {
  start(options: BloodPressureLiveActivityPayload): Promise<{ started: boolean }>
  end(): Promise<void>
}

const BloodPressureLiveActivity = registerPlugin<BloodPressureLiveActivityPlugin>('BloodPressureLiveActivity')

// 為什麼要自己排隊：量完第二次時會先 end 再可能馬上 start 下一輪；兩個 bridge 呼叫若交錯抵達原生，
// 可能變成「新的剛開就被舊的 end 關掉」或反過來留下殭屍 Activity。原生端也有排隊，這裡再保證送出順序。
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task)
  queue = next.catch(() => undefined)
  return next
}

/**
 * 在鎖屏／動態島顯示倒數。回傳 false 代表這次沒顯示（Web、Android、iOS 16.2 以下、使用者在設定關掉即時動態）；
 * App 內的 BloodPressureCountdownBanner 才是倒數的主要介面，這裡失敗不影響量測流程，所以不丟錯。
 */
export function startBloodPressureLiveActivity(payload: BloodPressureLiveActivityPayload): Promise<boolean> {
  return enqueue(async () => {
    try {
      const { started } = await BloodPressureLiveActivity.start(payload)
      return started === true
    } catch (error) {
      console.warn('[blood pressure live activity start skipped]', error)
      return false
    }
  })
}

/** 結束這個 App 開過的所有血壓倒數 Activity；沒有任何 Activity 時是安全的 no-op。 */
export function endBloodPressureLiveActivity(): Promise<void> {
  return enqueue(async () => {
    try {
      await BloodPressureLiveActivity.end()
    } catch (error) {
      console.warn('[blood pressure live activity end skipped]', error)
    }
  })
}
