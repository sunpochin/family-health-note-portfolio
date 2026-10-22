/*
檔案用途：守住「表單控制項邊框對白底至少 3:1」（WCAG 1.4.11，issue #1151）——token 本身的對比，加上 src 下每個原生 input／select／textarea 都用該 token 且是 2px。
所在層：tests/unit 靜態掃描測試層；不啟動瀏覽器，只讀原始碼。
主要關聯：src/index.css 的 --color-control-border、docs/product/clinical-care-ops-ui-design.md §4.5 缺陷 8。
*/
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import ts from 'typescript'

// 不是「欄位」的控制項：核取方塊、單選、檔案、隱藏、滑桿、色盤不畫文字欄位邊框，不在這條規範內。
const NON_FIELD_TYPES = /checkbox|radio|file|hidden|range|color/
// 刻意沒有邊框的控制項：嵌在別的元件裡、本身透明，外框由父層負責。
const ALLOWED_BORDERLESS: Record<string, string> = {
  'components/ui/SubjectSwitcher.tsx': '透明 select 嵌在切換列的外框裡，外框是父層的 chip，不是欄位邊框',
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05)

function readTsxFiles() {
  const sourceRoot = new URL('../../src/', import.meta.url)
  const files: Array<{ path: string; text: string }> = []
  const visit = (url: URL) => {
    for (const entry of readdirSync(url)) {
      const child = new URL(`${entry}${entry.includes('.') ? '' : '/'}`, url)
      if (statSync(child).isDirectory()) visit(child)
      else if (entry.endsWith('.tsx')) files.push({ path: child.href.slice(sourceRoot.href.length), text: readFileSync(child, 'utf8') })
    }
  }
  visit(sourceRoot)
  return files
}

describe('表單控制項邊框對比（issue #1151）', () => {
  test('--color-control-border 對白底至少 3:1', () => {
    const css = readFileSync(new URL('../../src/index.css', import.meta.url), 'utf8')
    const hex = css.match(/--color-control-border:\s*(#[0-9a-fA-F]{6})/)?.[1]
    expect(hex).toBeDefined()
    expect(contrastOnWhite(hex as string)).toBeGreaterThanOrEqual(3)
  })

  test('每個原生欄位都用 border-control-border 與 2px 邊框', () => {
    const offenders: string[] = []
    for (const { path, text } of readTsxFiles()) {
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['input', 'select', 'textarea'].includes(node.tagName.getText())) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
          const type = attrs.find(a => a.name.getText() === 'type')?.getText() ?? ''
          const className = attrs.find(a => a.name.getText() === 'className')?.initializer?.getText() ?? ''
          const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
          if (!NON_FIELD_TYPES.test(type) && !(path in ALLOWED_BORDERLESS) && !(/(?<![\w:-])border-control-border/.test(className) && /(?<![\w:-])border-2(?![\w-])/.test(className))) offenders.push(`${path}:${line}`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    expect(offenders).toEqual([])
  })

  // 為什麼另測：只檢查「className 裡有 border-control-border」會漏掉條件式（例如 PickerCard 的 pending 狀態分支
  // 換成 border-blue-400，只有 2.42:1）。這裡把欄位 className 運算式裡所有「沒有狀態前綴」的邊框色階都掃一遍，
  // 色階 400 以下（對白底不到 3:1）一律不准；要表達狀態請用 500 以上，或保留 border-control-border。
  test('欄位 className 的任何分支都沒有 400 以下的淺色邊框', () => {
    const offenders: string[] = []
    const lightBorder = /(?<![\w:-])border-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|100|200|300|400)(?![\w-])/g
    for (const { path, text } of readTsxFiles()) {
      const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const visit = (node: ts.Node) => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && ['input', 'select', 'textarea'].includes(node.tagName.getText())) {
          const attrs = node.attributes.properties.filter(ts.isJsxAttribute)
          const type = attrs.find(a => a.name.getText() === 'type')?.getText() ?? ''
          const className = attrs.find(a => a.name.getText() === 'className')?.initializer?.getText() ?? ''
          const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
          if (!NON_FIELD_TYPES.test(type) && lightBorder.test(className)) offenders.push(`${path}:${line}`)
          lightBorder.lastIndex = 0
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
    // 失敗時：把欄位的 `border border-slate-300` 換成 `border-2 border-control-border`（錯誤與 focus 狀態色用帶前綴的 class，不受影響）。
    expect(offenders).toEqual([])
  })
})
