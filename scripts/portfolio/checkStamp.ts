/*
檔案用途：PORTFOLIO-01 的「check 指紋」——portfolio:check 全部通過時，把「輸出目錄內容 + 禁字清單 +
產線程式碼」算成一個 SHA-256 存起來；portfolio:release 算出同一個指紋時就沿用結果，不再重跑一次
完整的 install／lint／tsc／test／build。任何一個位元組不同，指紋就不同，照樣重跑。
所在層：scripts/portfolio；由 check.ts 寫入、release.ts 讀取。digestEntries 是純函式，方便單元測試。
主要關聯：scripts/portfolio/check.ts、scripts/portfolio/release.ts、tests/unit/portfolioCheckStamp.test.ts、
docs/operations/portfolio-pipeline.md 第 4 節。
*/
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { isExcludedScanDir } from './checkLogic'

// 放在輸出目錄「旁邊」而不是裡面：放裡面會被當成要公開的檔案，而且寫入本身就會改變它要描述的內容。
export function checkStampPath(repoRoot: string): string {
  return join(repoRoot, 'tmp', 'jia-jian-log-portfolio.check-stamp.json')
}

// 每一筆以「路徑、長度、內容」串接：帶長度才不會讓 ('ab','c') 與 ('a','bc') 這種切法不同的輸入撞出同一個指紋；
// 先排序，讓檔案系統列舉順序不同時結果仍然一樣。
export function digestEntries(entries: Array<[string, Uint8Array]>): string {
  const hash = createHash('sha256')
  for (const [path, content] of [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    hash.update(`${path}\0${content.byteLength}\0`)
    hash.update(content)
  }
  return hash.digest('hex')
}

function listFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && isExcludedScanDir(entry.name)) continue
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...listFiles(fullPath))
    else if (entry.isFile()) files.push(fullPath)
  }
  return files
}

// 為什麼除了輸出目錄，還要把禁字清單（含範本）與 scripts/portfolio/*.ts 算進去：check 的結論取決於
// 「掃了什麼」也取決於「用什麼規則掃」。只改了禁字清單或修了 check 的 bug 而輸出內容沒變時，
// 舊結果已經不能代表新規則下的判斷，必須重跑。
// node_modules／dist／.git 不算進去（跟 check.ts 的掃描排除一致）：它們是 check 自己跑 install／build、
// release 建立 git 歷史的副產物，不是要公開的內容，算進去會讓指紋在 check 跑完之後自己改變。
export function computeCheckDigest(repoRoot: string, outputDir: string): string {
  const entries: Array<[string, Uint8Array]> = []
  for (const path of listFiles(outputDir)) {
    entries.push([`output:${relative(outputDir, path).split(sep).join('/')}`, readFileSync(path)])
  }
  const portfolioDir = join(repoRoot, 'scripts', 'portfolio')
  for (const name of readdirSync(portfolioDir)) {
    // forbidden.local.json.example 也要算：validateForbiddenConfig 用它判斷禁字清單是不是「範本沒改」，
    // 只改範本時舊指紋若還能沿用，就會跳過一個現在會失敗的 check（Codex review 在 PR #1012 抓到）。
    if (name.endsWith('.ts') || name.startsWith('forbidden.local.json')) {
      entries.push([`private:scripts/portfolio/${name}`, readFileSync(join(portfolioDir, name))])
    }
  }
  return digestEntries(entries)
}

export function writeCheckStamp(repoRoot: string, digest: string): void {
  writeFileSync(checkStampPath(repoRoot), `${JSON.stringify({ digest, checkedAt: new Date().toISOString() }, null, 2)}\n`)
}

// 讀不到、格式不對、指紋不同，一律當成「沒有可沿用的結果」——寧可多跑一次，也不要誤用舊結果。
export function readCheckStampDigest(repoRoot: string): string | null {
  const path = checkStampPath(repoRoot)
  if (!existsSync(path)) return null
  try {
    const digest = JSON.parse(readFileSync(path, 'utf8'))?.digest
    return typeof digest === 'string' ? digest : null
  } catch {
    return null
  }
}
