/*
檔案用途：殼層提示的逐鍵本機儲存；讀取失敗與確定沒有資料分開表示，避免誤清照護提醒。
所在層：src/features/vitals/lib；純儲存模組，不包含離線佇列的補送或授權判定。
主要關聯：usePerKeyStoreState、bloodPressureShellNoticeStores、useBloodPressureQueueCoordinator。
*/
export interface PerKeyStore<T> {
  readAll: () => T[] | null
  /** undefined 是讀取失敗，null 才是確定沒有有效資料。 */
  read: (key: string) => T | null | undefined
  write: (key: string, value: T) => boolean
  remove: (key: string) => void
  clearAll: () => void
  isKey: (storageKey: string | null) => boolean
  keyOf: (storageKey: string) => string
  valueKey: (value: T) => string
  compare?: (left: T, right: T) => number
}

export function createPerKeyStore<T>({ namespace, owner, keyType, parse, serialize, valueKey, compare, valueFromKey }: {
  namespace: string
  owner: string
  keyType: string
  parse: (raw: string, key: string) => T | null
  serialize: (value: T) => string
  valueKey: (value: T) => string
  compare?: (left: T, right: T) => number
  /** 點名舊格式只以 key 表示存在；列舉時不額外讀值，以保留受限 WebView 的降級行為。 */
  valueFromKey?: (key: string) => T
}): PerKeyStore<T> {
  // 必須沿用既有 namespace、帳號與 patient／record 分隔，否則更新後看不到手機已存的提示。
  const prefix = `${namespace}-${owner}-${keyType}-`
  const storageKey = (key: string) => `${prefix}${key}`
  const isKey = (key: string | null) => key !== null && key.startsWith(prefix)
  const keyOf = (key: string) => key.slice(prefix.length)
  const read = (key: string): T | null | undefined => {
    try {
      const raw = localStorage.getItem(storageKey(key))
      return raw === null ? null : parse(raw, key)
    } catch (error) {
      console.warn('[shell notice read error]', error)
      return undefined
    }
  }
  const readAll = (): T[] | null => {
    try {
      const items: T[] = []
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index)
        if (key === null || !isKey(key)) continue
        const id = keyOf(key)
        if (valueFromKey && id.length === 0) continue
        const item = valueFromKey ? valueFromKey(id) : read(id)
        if (item !== null && item !== undefined) items.push(item)
      }
      if (compare) items.sort(compare)
      return items
    } catch (error) {
      console.warn('[shell notice read error]', error)
      return null
    }
  }
  return {
    readAll, read, isKey, keyOf, valueKey, compare,
    write: (key, value) => {
      try {
        localStorage.setItem(storageKey(key), serialize(value))
        return true
      } catch (error) {
        console.warn('[shell notice write error]', error)
        return false
      }
    },
    remove: key => {
      try {
        localStorage.removeItem(storageKey(key))
      } catch (error) {
        console.warn('[shell notice write error]', error)
      }
    },
    clearAll: () => {
      try {
        // 先列完再刪：邊走 localStorage 的索引邊刪會跳過下一把 key，且不得清到其他帳號或佇列。
        for (const value of readAll() ?? []) localStorage.removeItem(storageKey(valueKey(value)))
      } catch (error) {
        console.warn('[shell notice write error]', error)
      }
    },
  }
}
