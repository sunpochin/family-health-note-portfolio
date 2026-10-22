/*
檔案用途：讓新增寵物與本人邀請表單各自讀取正確家庭的名額，送出前再確認一次。
所在層：care-family/hooks；讀取提示與原有表單寫入狀態分離。
主要關聯：householdCareRecipientCapacity、CareRecipientManagement。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchHouseholdCareRecipientCapacity, HOUSEHOLD_CARE_RECIPIENT_LIMIT, householdCareRecipientLimitText, isHouseholdCareRecipientLimitError, type HouseholdCareRecipientCapacity } from '../../../lib/householdCareRecipientCapacity'
import { isNativeApp } from '../../../lib/platform'

export function useCareRecipientCapacity(ownerOnly: boolean, enabled: boolean, refreshKey: unknown) {
  const [capacity, setCapacity] = useState<HouseholdCareRecipientCapacity | null>(null)
  const generation = useRef(0)
  const invalidate = useCallback(() => { generation.current++ }, [])
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const next = await fetchHouseholdCareRecipientCapacity(ownerOnly)
      if (current === generation.current) setCapacity(next)
      return next
    } catch (error) {
      if (current === generation.current) setCapacity(null)
      throw error
    }
  }, [ownerOnly])
  useEffect(() => {
    if (enabled) void refresh().catch(() => { /* 送出前會再次讀取；讀取失敗不冒充額滿。 */ })
    // 畫面換人或離開後丟棄舊讀取；不能讓晚回來的數字蓋掉新家庭的提示。
    return invalidate
  }, [enabled, refreshKey, refresh, invalidate])
  const check = async () => {
    const next = await refresh()
    if (next && next.activeCount >= next.limit) throw new Error(HOUSEHOLD_CARE_RECIPIENT_LIMIT)
  }
  const describeError = async (cause: unknown) => {
    if (!isHouseholdCareRecipientLimitError(cause)) return null
    // trigger 是最後裁決；其他裝置可能剛占走空位，重新讀取後再顯示數量。
    const latest = await refresh().catch(() => null)
    return householdCareRecipientLimitText(isNativeApp(), latest)
  }
  return {
    check, describeError,
    notice: enabled && capacity && capacity.activeCount >= capacity.limit ? householdCareRecipientLimitText(isNativeApp(), capacity) : null,
  }
}
