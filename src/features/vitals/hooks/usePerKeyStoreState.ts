/*
檔案用途：殼層逐鍵提示的 React 狀態；保管寫不進本機的提示，跨分頁事件只更新指定項目。
所在層：src/features/vitals/hooks；由血壓協調器使用的狀態容器。
主要關聯：lib/shellNoticeStore、lib/bloodPressureShellNoticeStores、useBloodPressureQueueCoordinator。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import type { PerKeyStore } from '../lib/shellNoticeStore'

export function usePerKeyStoreState<T>(store: PerKeyStore<T>, enabled: boolean, {
  mergeStoredOnWrite = false,
  sortOnStorageEvent = false,
}: { mergeStoredOnWrite?: boolean; sortOnStorageEvent?: boolean } = {}) {
  // 第一次 render 就讀；若等 effect 才補提示，輸入頁可能先接手錯誤的空狀態。
  const [values, setValues] = useState<T[]>(() => enabled ? store.readAll() ?? [] : [])
  const unpersistedRef = useRef(new Set<string>())
  const add = useCallback((value: T) => {
    const key = store.valueKey(value)
    if (enabled) {
      if (store.write(key, value)) unpersistedRef.current.delete(key)
      else unpersistedRef.current.add(key)
    }
    setValues(previous => {
      // 持久化只是可降級的一步；列舉失敗不能抹掉記憶體。點名還要合併其他分頁剛留下的提示。
      const stored = enabled && mergeStoredOnWrite ? store.readAll() ?? [] : []
      const seen = new Set(previous.map(store.valueKey))
      const added = [...stored, value].filter(item => {
        const id = store.valueKey(item)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      return added.length === 0 ? previous : [...previous, ...added]
    })
  }, [enabled, store, mergeStoredOnWrite])
  const remove = useCallback((key: string) => {
    if (enabled) store.remove(key)
    unpersistedRef.current.delete(key)
    setValues(previous => {
      const kept = previous.filter(item => store.valueKey(item) !== key)
      return kept.length === previous.length ? previous : kept
    })
  }, [enabled, store])
  const clearAll = useCallback(() => {
    if (enabled) store.clearAll()
    unpersistedRef.current.clear()
    setValues([])
  }, [enabled, store])

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return
    const handleStorage = (event: StorageEvent) => {
      if (event.key === null) {
        // 別的分頁從沒看過寫入失敗的提示；clear 只能清掉已持久化的，不能連記憶體一起抹掉。
        setValues(previous => {
          const kept = previous.filter(item => unpersistedRef.current.has(store.valueKey(item)))
          return kept.length === previous.length ? previous : kept
        })
      } else if (store.isKey(event.key)) {
        const key = store.keyOf(event.key)
        const stored = store.read(key)
        if (stored === undefined || key.length === 0) return
        setValues(previous => {
          if (stored !== null) {
            if (previous.some(item => store.valueKey(item) === key)) return previous
            const next = [...previous, stored]
            return sortOnStorageEvent && store.compare ? next.sort(store.compare) : next
          }
          // 指定 key 被清掉表示另一分頁曾看得到它；只刪這筆，不用整份快照覆蓋其他提示。
          unpersistedRef.current.delete(key)
          const kept = previous.filter(item => store.valueKey(item) !== key)
          return kept.length === previous.length ? previous : kept
        })
      }
    }
    window.addEventListener('storage', handleStorage)
    return () => window.removeEventListener('storage', handleStorage)
  }, [enabled, store, sortOnStorageEvent])

  return { values, add, remove, clearAll }
}
