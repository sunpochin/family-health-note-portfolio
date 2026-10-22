/*
檔案用途：守住「系統介面不用 emoji 當圖示」——解析 src 下所有 .tsx，只檢查字串、樣板字串與 JSX 文字（註解不算），除了明列的例外檔案，不得再出現 emoji。
所在層：tests/unit 靜態掃描測試層；不啟動瀏覽器，只讀原始碼。
主要關聯：src/components/ui/Icon.tsx（emoji 的替代品）、docs/product/clinical-care-ops-ui-design.md §4.4（圖示規則）、issue #1150。
*/
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import ts from 'typescript'

// 為什麼要有這支測試：emoji 在不同平台字型不一，也無法用 design token 控制顏色與對比（設計規則 §4.4）。
// #1150 把介面 emoji 全部換成 <Icon name />；沒有機械檢查的話，之後任何人貼一個 ✨ 進 JSX 都不會有人發現。
// 只掃 .tsx：這是畫面層。.ts 裡的 emoji 多半是推播／儲存結果字串（例如血壓警示階梯），那些各有自己的規則與測試。
const ALLOWED_EMOJI_FILES: Record<string, string> = {
  'features/vitals/components/VitalReading.tsx': '♥ 是心跳識別色旁邊的指標符號，屬於血壓識別視覺規範，隨 #1152 處理',
  'features/vitals/components/RecordReport.tsx': '報告摘要裡的 ↑↓♥ 是血壓統計的簡寫符號，隨血壓呈現票處理',
  'features/vitals/components/LatestVitals.tsx': '最新讀值字串裡的 ♥ 是心跳指標符號，同 VitalReading',
  'features/vitals/components/BpLimitBlockedNotice.tsx': '📞 在「血壓危險、通知被上限擋住」的安全提示裡，屬警示階梯周邊，隨 #1153 處理，動它需要實際走過危險讀值＋上限的流程',
  'features/vitals/components/DashboardChart.tsx': '圖表 X 軸刻度是純字串，放不進 SVG 元件，隨 #1152／#1153 處理',
  'features/vitals/pages/TemperaturePage.tsx': '「✓ 體溫已記錄」的 ✓ 是儲存成功訊息的文字符號（U+2713，不是 emoji），與血壓儲存訊息（InputPage.utils.ts）同一個慣例',
}

// 碼位範圍是 issue #1150 驗收指令（\x{1F300}-\x{1FAFF}、\x{2600}-\x{27BF}）的超集：另外涵蓋國旗與麻將／圈字（1F000–1F2FF）、
// 時鐘與播放鍵（231A、23E9–23FA）、⬅⬆⬇（2B05–2B07）、⬛⬜、⭐⭕、‼⁉ 與 ℹ——三語介面最容易被貼進來的是國旗（🇮🇩🇹🇼）。
// 刻意不用 \p{Extended_Pictographic}，也不含 2190–21FF 的箭頭：外部連結的 ↗ 是純文字排版符號，不是 emoji 圖示。
// 不把變體選擇符 U+FE0F 放進字元類別（eslint no-misleading-character-class 會擋）：它只會跟在上面範圍內的 emoji 後面，不需要另外偵測。
const emojiPattern = /[\u{1F000}-\u{1FAFF}\u{231A}\u{231B}\u{23E9}-\u{23FA}\u{2600}-\u{27BF}\u{2B05}-\u{2B07}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{203C}\u{2049}\u{2139}]/u

// 為什麼用 TypeScript 解析而不是正規表示式剝註解：`accept="image/*"` 這種字串會被當成區塊註解的開頭，
// 把後面一大段程式碼（含藥品物種標籤）整段吞掉，守門測試就對最需要它的檔案失明。註解不是語法樹的節點，
// 所以只收集「字串、樣板字串、JSX 文字」這些使用者看得到的節點，註解自然被排除。
function visibleText(path: string, source: string) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX)
  const parts: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isJsxText(node)) parts.push(node.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return parts.join('\n')
}

function readTsxFiles() {
  const sourceRoot = new URL('../../src/', import.meta.url)
  const files: Array<{ path: string; text: string }> = []
  const visit = (url: URL) => {
    for (const entry of readdirSync(url)) {
      const child = new URL(`${entry}${entry.includes('.') ? '' : '/'}`, url)
      if (statSync(child).isDirectory()) visit(child)
      else if (entry.endsWith('.tsx')) {
        const path = child.href.slice(sourceRoot.href.length)
        files.push({ path, text: visibleText(path, readFileSync(child, 'utf8')) })
      }
    }
  }
  visit(sourceRoot)
  return files
}

const files = readTsxFiles()

describe('介面不用 emoji 當圖示（issue #1150）', () => {
  test('src 的 .tsx 除了明列的例外檔案，字串與 JSX 文字裡沒有 emoji', () => {
    const offenders = files
      .filter(file => !(file.path in ALLOWED_EMOJI_FILES) && emojiPattern.test(file.text))
      .map(file => file.path)
    // 失敗時請改用 <Icon name />（src/components/ui/Icon.tsx 檔頭寫了怎麼新增圖示）；
    // 使用者自己輸入的文字不會經過這裡，所以不受影響。
    expect(offenders).toEqual([])
  })

  test('例外清單沒有過期項目：清單裡的檔案都還真的含有 emoji', () => {
    const stale = Object.keys(ALLOWED_EMOJI_FILES).filter(path => {
      const file = files.find(candidate => candidate.path === path)
      return !file || !emojiPattern.test(file.text)
    })
    // 某個例外被處理掉之後，要同步把它從清單移除，清單才不會變成永久的後門。
    expect(stale).toEqual([])
  })
})

describe('掃描器本身（避免守門測試對某些檔案失明）', () => {
  test('字串裡的 /* 不會被當成區塊註解，後面的 emoji 仍然抓得到', () => {
    const text = visibleText('x.tsx', 'const a = <input accept="image/*" />\nconst b = <span>🐶 狗</span>')
    expect(emojiPattern.test(text)).toBe(true)
  })

  test('字串裡的 // 不會截掉同一行後面的內容', () => {
    const text = visibleText('x.tsx', 'const a = { url: "https://example.com", label: "✨" }')
    expect(emojiPattern.test(text)).toBe(true)
  })

  test('註解裡的 emoji 不算（行註解、區塊註解、JSX 註解）', () => {
    const text = visibleText('x.tsx', '// ✨\n/* 🐶 */\nconst a = <p>{/* 🔒 */}ok</p>')
    expect(emojiPattern.test(text)).toBe(false)
  })

  test('國旗與外部連結箭頭：國旗要擋、↗ 不擋', () => {
    expect(emojiPattern.test('🇮🇩')).toBe(true)
    expect(emojiPattern.test('GitHub ↗')).toBe(false)
  })
})
