/*
檔案用途：集中管理後台「通知訂閱」分頁的狀態容器 hook，包含病人與訂閱現況載入、獨立開關狀態、樂觀更新與失敗復原。
所在層：src/features/system-admin/hooks；feature-specific 狀態容器 hook（AGENTS.md Rule A／B／C）。
主要關聯：src/features/system-admin/components/NotificationSubscriptionsPanel.tsx、
         src/lib/notificationSubscriptions.ts。
*/
import { useCallback, useEffect, useState } from 'react'
import type { LocalizedText } from '../../../lib/i18n'
import {
  type AdminAccessiblePatient,
  type NotificationChannel,
  fetchAdminNotificationSubscriptions,
  setNotificationSubscription,
  subscriptionKey,
} from '../../../lib/notificationSubscriptions'

export interface UseNotificationSubscriptionsOptions {
  // 注入初始資料與 mock 函式方便單元測試
  initialPatients?: AdminAccessiblePatient[]
  initialSubscriptions?: Record<string, boolean>
  fetcher?: typeof fetchAdminNotificationSubscriptions
  mutator?: typeof setNotificationSubscription
  autoFetch?: boolean
}

export function useNotificationSubscriptions(options: UseNotificationSubscriptionsOptions = {}) {
  const {
    initialPatients,
    initialSubscriptions,
    fetcher = fetchAdminNotificationSubscriptions,
    mutator = setNotificationSubscription,
    autoFetch = initialPatients === undefined,
  } = options

  const [patients, setPatients] = useState<AdminAccessiblePatient[]>(initialPatients ?? [])
  const [subscriptions, setSubscriptions] = useState<Record<string, boolean>>(initialSubscriptions ?? {})
  const [loading, setLoading] = useState(autoFetch)
  const [loadError, setLoadError] = useState<LocalizedText | null>(null)

  // Rule B：以 `${patientId}:${channel}` 為鍵分離儲存中狀態與錯誤，互不干擾
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({})
  const [errorMap, setErrorMap] = useState<Record<string, LocalizedText | null>>({})

  const loadData = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetcher()
      setPatients(data.patients)
      setSubscriptions(data.subscriptions)
    } catch (err) {
      console.error('[useNotificationSubscriptions] fetch error:', err)
      setLoadError({
        id: 'Daftar langganan notifikasi sementara tidak dapat dimuat. Periksa internet lalu coba lagi.',
        zh: '暫時無法讀取通知訂閱清單，請確認網路後重試。',
        en: 'The notification subscription list could not be loaded right now. Check your network and try again.',
      })
    } finally {
      setLoading(false)
    }
  }, [fetcher])

  useEffect(() => {
    if (autoFetch) {
      void loadData()
    }
  }, [autoFetch, loadData])

  const toggleSubscription = useCallback(async (
    patientId: string,
    channel: NotificationChannel,
    nextEnabled: boolean,
  ) => {
    const key = subscriptionKey(patientId, channel)
    const previousValue = subscriptions[key] ?? false

    // 樂觀更新：立即更新畫面開關狀態提供即時反饋
    setSubscriptions(prev => ({ ...prev, [key]: nextEnabled }))
    setSavingMap(prev => ({ ...prev, [key]: true }))
    setErrorMap(prev => ({ ...prev, [key]: null }))

    try {
      const result = await mutator({ patientId, channel, enabled: nextEnabled })
      if (!result.ok) {
        // 失敗時必須回滾至伺服器前值，不能讓管理者誤認開通成功（issue #994 驗收要求）
        setSubscriptions(prev => ({ ...prev, [key]: previousValue }))
        setErrorMap(prev => ({ ...prev, [key]: result.error }))
      }
    } catch (err) {
      console.error('[useNotificationSubscriptions] toggle error:', err)
      setSubscriptions(prev => ({ ...prev, [key]: previousValue }))
      setErrorMap(prev => ({
        ...prev,
        [key]: {
          id: 'Gagal mengubah langganan notifikasi. Periksa koneksi lalu coba lagi.',
          zh: '變更通知訂閱失敗，請確認網路後重試。',
          en: 'Failed to update notification subscription. Check your network and try again.',
        },
      }))
    } finally {
      setSavingMap(prev => ({ ...prev, [key]: false }))
    }
  }, [subscriptions, mutator])

  return {
    patients,
    subscriptions,
    loading,
    loadError,
    savingMap,
    errorMap,
    reload: loadData,
    toggleSubscription,
  }
}
