/*
檔案用途：把 React 元素樹攤平成可查詢的節點，讓元件測試不必啟動瀏覽器就能檢查文字、按鈕與無障礙標籤。
所在層：tests/unit/helpers 測試支援層；只讀取 React 元素結構，不進行任何渲染。
主要關聯：DailyBloodPressureRecords、LatestVitals 等以函式呼叫方式測試的元件。
*/

type ReactElementLike = { type: unknown; props: Record<string, unknown> }

function isElement(node: unknown): node is ReactElementLike {
  return Boolean(node) && typeof node === 'object' && 'props' in (node as object) && 'type' in (node as object)
}

/** 深度優先攤平所有元素節點（含 Fragment 與陣列子節點）。 */
export function flattenElements(node: unknown): ReactElementLike[] {
  if (Array.isArray(node)) return node.flatMap(flattenElements)
  if (!isElement(node)) return []
  return [node, ...flattenElements(node.props.children)]
}

/** 取出整棵樹上的可見文字，順序與畫面一致。 */
export function textContent(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (isElement(node)) return textContent(node.props.children)
  return ''
}

/** 找出所有符合條件的元素節點。 */
export function findAll(node: unknown, predicate: (element: ReactElementLike) => boolean): ReactElementLike[] {
  return flattenElements(node).filter(predicate)
}

/** 依可見文字找按鈕；測試要按的是照護者看到的那顆按鈕，不是內部 class name。 */
export function findButton(node: unknown, label: string): ReactElementLike {
  const button = findAll(node, element => element.type === 'button' && textContent(element.props.children) === label)[0]
  if (!button) throw new Error(`Button "${label}" is not on screen.`)
  return button
}

/** 依 aria-label 找輸入欄位，確保雙語無障礙標籤真的存在。 */
export function findInput(node: unknown, ariaLabel: string): ReactElementLike {
  const input = findAll(node, element => element.type === 'input' && element.props['aria-label'] === ariaLabel)[0]
  if (!input) throw new Error(`Input labelled "${ariaLabel}" is not on screen.`)
  return input
}

/** 觸發元素上的事件處理器，例如 onClick 或 onChange。 */
export function fire(element: ReactElementLike, handler: string, event?: unknown) {
  const callback = element.props[handler]
  if (typeof callback !== 'function') throw new Error(`Element has no ${handler} handler.`)
  return (callback as (event?: unknown) => unknown)(event)
}

/**
 * 在 renderHook 的 body 裡呼叫：遞迴展開「函式元件」元素（例如 <ReceiptList />），讓 textContent／findAll 看得到子元件輸出的文字。
 * 為什麼要在 body 內執行：子元件裡的 useI18n 等 hook 只有在 harness 的 host 仍 active 時才拿得到 context；
 * 出了 renderHook 才展開會丟出「must be used inside LocaleProvider」。只展開純函式元件，host 元素（'div' 等）原樣保留。
 */
export function expandFunctionComponents(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expandFunctionComponents)
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    return expandFunctionComponents((node.type as (props: Record<string, unknown>) => unknown)(node.props))
  }
  const children = node.props.children
  if (children === undefined) return node
  return { ...node, props: { ...node.props, children: expandFunctionComponents(children) } }
}
