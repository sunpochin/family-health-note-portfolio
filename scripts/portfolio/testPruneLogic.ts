/*
檔案用途：PORTFOLIO-01 portfolio:build 的純判斷邏輯——找出「引用了私有 repo 有、但公開輸出沒有的檔案」
的測試檔（例如讀 supabase/migrations/*.sql、import supabase/functions/* 或 scripts/*），讓 build.ts
自動從公開輸出移除，不必每新增一個這類測試就手動補進 allowlist.ts 的 EXCLUDE_WITHIN_ALLOWLIST。
所在層：scripts/portfolio；不碰檔案系統（存在與否由呼叫端注入），方便單元測試。
主要關聯：scripts/portfolio/build.ts、scripts/portfolio/allowlist.ts、
tests/unit/portfolioTestPruneLogic.test.ts、docs/operations/portfolio-pipeline.md 第 3.1 節。
*/
import { posix } from 'node:path'

// import 常省略副檔名、目錄 import 會解析到 index，這裡列的是 bun／vite 實際會嘗試的寫法。
const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx']

// 抓出字串常值（單引號、雙引號、反引號）的靜態前綴；反引號裡遇到 `${` 就截斷，
// 所以 `../../supabase/migrations/${name}` 會得到 `../../supabase/migrations/`，仍能判斷出依賴的目錄。
//
// 為什麼掃「所有」字串常值，而不是只看 import／new URL／readFileSync 這些位置：測試讀檔的寫法太多元——
// 自訂 `read(\`supabase/migrations/${name}\`)` helper、`Bun.spawnSync([bun, 'scripts/x.ts'])`、
// 先把路徑放進陣列再迴圈讀取——只看特定位置時實測漏掉 5 個，等於回到手動追清單的老問題。
// 兩種誤判的代價不對稱：漏抓 → portfolio:check 紅燈、owner 得手動追；多抓 → 只是公開版少跑一個測試，
// 而且 build 會逐一列出被移除的檔案與原因，不是默默消失。只把路徑當 fixture 的測試用下面的標記保留。
const STRING_LITERAL = /(['"`])([^'"`\n]*?)(?:\1|\$\{)/g

// 逃生口：測試只是把未公開路徑當成 fixture／斷言值（例如測這支偵測邏輯的測試），在檔案裡寫上這個標記就不會被移除
// （Codex review 在 PR #1011 指出這支測試自己會被誤刪）。
// 標記錯用也不會讓壞掉的測試溜進公開版：portfolio:check 仍會在輸出目錄實際跑 bun test。
export const KEEP_MARKER = 'portfolio-prune: keep'

// 把字串常值轉成「相對於 repo root 的路徑」；看起來不像 repo 內路徑的字串回傳 null。
// 兩種寫法都要支援：`new URL('../../supabase/...', import.meta.url)`（相對於測試檔）與
// `join(rootDir, 'supabase/functions')`（相對於 repo root）。
function toRepoPath(fileRelPath: string, literal: string): string | null {
  const value = literal.replace(/\/+$/, '')
  if (!value || value.includes(':') || value.startsWith('/')) return null
  if (value.startsWith('./') || value.startsWith('../')) {
    const resolved = posix.normalize(posix.join(posix.dirname(fileRelPath), value))
    return resolved.startsWith('..') ? null : resolved
  }
  // 沒有 `/` 的一般字串（'api'、'weight'）太容易跟路徑撞名，不當成路徑看。
  return value.includes('/') ? posix.normalize(value) : null
}

// 為什麼判斷條件是「私有 repo 存在、公開輸出不存在」，而不是 grep 特定目錄名稱：
// 1. 私有 repo 必須真的有這個路徑，隨手寫的字串（'a/b'、MIME type 'image/png'）不會誤判；
// 2. 公開輸出沒有，才代表這個測試到了公開 repo 一定會在載入或讀檔時失敗——
//    不管它依賴的是 supabase/、scripts/、ios/、api/ 還是之後新增的任何私有目錄，都不用改這支程式。
export function findUnpublishedReference(
  fileRelPath: string,
  content: string,
  existsInPrivate: (repoPath: string) => boolean,
  existsInOutput: (repoPath: string) => boolean,
): string | null {
  if (content.includes(KEEP_MARKER)) return null
  for (const match of content.matchAll(STRING_LITERAL)) {
    const repoPath = toRepoPath(fileRelPath, match[2])
    if (!repoPath) continue
    const candidates = RESOLVE_SUFFIXES.map(suffix => repoPath + suffix)
    if (candidates.some(existsInPrivate) && !candidates.some(existsInOutput)) return repoPath
  }
  return null
}

// 反覆套用直到沒有新的檔案被移除：被移除的可能是測試 helper，引用它的測試檔在下一輪
// 也會變成「引用了公開輸出沒有的檔案」，一輪掃描會漏掉這種連鎖依賴。
export function planTestPruning(
  files: Map<string, string>,
  existsInPrivate: (repoPath: string) => boolean,
  existsInOutputInitially: (repoPath: string) => boolean,
): Map<string, string> {
  const removed = new Map<string, string>()
  const existsInOutput = (repoPath: string) => !removed.has(repoPath) && existsInOutputInitially(repoPath)
  let changed = true
  while (changed) {
    changed = false
    for (const [relPath, content] of files) {
      if (removed.has(relPath)) continue
      const reference = findUnpublishedReference(relPath, content, existsInPrivate, existsInOutput)
      if (reference) {
        removed.set(relPath, reference)
        changed = true
      }
    }
  }
  return removed
}
