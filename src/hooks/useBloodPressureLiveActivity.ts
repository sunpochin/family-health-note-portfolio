/*
檔案用途：讓 iOS 鎖屏／動態島的血壓倒數（Live Activity，issue #865）永遠跟 App 內的倒數 banner 同步：banner 出現就開、消失就關。
所在層：src/hooks；只由 App.tsx 呼叫一次，輸入就是 BloodPressureCountdownBanner 用的同一個 currentMeasurementSession。
主要關聯：src/hooks/useBloodPressureSession.ts（唯一的倒數狀態來源）、src/lib/bloodPressureLiveActivity.ts、src/lib/nativeBloodPressureLiveActivity.ts。
*/
import { useEffect, useRef, useState } from 'react'
import { App } from '@capacitor/app'
import type { BloodPressureMeasurementSession } from '../lib/bloodPressureMeasurementSession'
import { buildBloodPressureLiveActivityPayload, getBloodPressureLiveActivityKey } from '../lib/bloodPressureLiveActivity'
import { endBloodPressureLiveActivity, startBloodPressureLiveActivity } from '../lib/nativeBloodPressureLiveActivity'
import type { Locale } from '../lib/i18n'
import { getNativePlatform } from '../lib/platform'

interface UseBloodPressureLiveActivityParams {
  /** 與 banner 相同的輸入：已經過「目前病人＋目前時段」過濾的 session，換病人、登出、量完第二次都會變成 null。 */
  session: BloodPressureMeasurementSession | null
  locale: Locale
  /** auth／病人清單還在載入時，session 可能短暫是 null；這時不動，避免鎖屏上的倒數被關掉又立刻重開。 */
  loading: boolean
}

export function useBloodPressureLiveActivity({ session, locale, loading }: UseBloodPressureLiveActivityParams) {
  // undefined＝還沒成功同步過；第一次同步即使 session 是 null 也要送一次 end，清掉上一個 process 留下的 Activity。
  const syncedKeyRef = useRef<string | null | undefined>(undefined)
  // 每次 App 回到前景就遞增，讓下面的 effect 有機會重試上一次沒開成的 Activity。
  const [foregroundTick, setForegroundTick] = useState(0)
  const deadline = session?.deadline
  const sessionKey = session?.sessionKey

  useEffect(() => {
    if (getNativePlatform() !== 'ios') return
    let cancelled = false
    let handle: { remove: () => Promise<void> } | undefined
    void App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) setForegroundTick(tick => tick + 1)
    }).then(listener => {
      if (cancelled) void listener.remove()
      else handle = listener
    })
    return () => {
      cancelled = true
      void handle?.remove()
    }
  }, [])

  useEffect(() => {
    if (loading) return
    // 只有 iOS 原生殼有 ActivityKit；Web／Android 連 bridge 都不叫，避免每次倒數都在 console 留一筆 not implemented。
    if (getNativePlatform() !== 'ios') return

    const current = deadline !== undefined && sessionKey !== undefined ? { deadline, sessionKey } : null
    const key = getBloodPressureLiveActivityKey(current, locale)
    if (key === syncedKeyRef.current) return
    syncedKeyRef.current = key

    if (!current) {
      void endBloodPressureLiveActivity()
      return
    }
    // 原生端 start 會先結束舊的再開新的，所以換語言或換一輪量測都只會留下一個 Activity。
    void startBloodPressureLiveActivity(buildBloodPressureLiveActivityPayload(current, locale)).then(started => {
      // ActivityKit 只允許前景 request：存完第一筆就立刻鎖屏時會開不成。這時忘掉這個 key，下次回前景（foregroundTick）重試；
      // 若期間 session 已換成別的（key 不同），代表已有更新的同步，不要覆蓋（Codex review PR #1010）。
      if (!started && syncedKeyRef.current === key) syncedKeyRef.current = undefined
    })
  }, [deadline, foregroundTick, loading, locale, sessionKey])
}
