/*
檔案用途：PORTFOLIO-01 產線的第三步、也是唯一會碰 GitHub 的一步——把已通過 portfolio:check
的輸出目錄初始化成一個全新的 Git 歷史，push 到公開 repo。所在層：scripts/portfolio，由
package.json 的 `portfolio:release` 呼叫。這是整條產線風險最高的一步（一旦 push 出去，
即使事後刪除，也可能已經有人 clone／快取過），所以每一步都刻意加防呆而不是求方便。
支援兩種模式：首次發布（公開 repo 是空的）與 `--refresh`（在既有公開歷史上疊一個新快照 commit，
fast-forward push，永不 --force）；模式判定邏輯在 releaseLogic.ts。
check 指紋相同時沿用上一次 portfolio:check 的結果（checkStamp.ts）；互動環境下先印出跟公開版的差異、
問 y/N 才 push——只有明確加 `--confirm`（publish.ts 會自動帶）才會問；兩個旗標都沒有時一律是
不動 git 的 dry run。日常通常經由 publish.ts 一鍵呼叫。
主要關聯：docs/operations/portfolio-pipeline.md 第 1.2 第 6、7 點、第 4 節、第 6 節、第 7 節；
scripts/portfolio/releaseLogic.ts。
*/
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { findForbiddenHit, isHardRejectedPath, regexEscapedVariant, validateForbiddenConfig, type ForbiddenEntry } from './checkLogic'
import { computeCheckDigest, readCheckStampDigest } from './checkStamp'
import { classifyRemoteRefs, isConfirmation, resolveReleaseMode, snapshotCommitMessage, summarizeNameStatus, type ReleaseMode, type RemoteState } from './releaseLogic'

const REPO_ROOT = process.cwd()
const OUTPUT_DIR = join(REPO_ROOT, 'tmp', 'jia-jian-log-portfolio')
const FORBIDDEN_PATH = join(REPO_ROOT, 'scripts', 'portfolio', 'forbidden.local.json')
const FORBIDDEN_EXAMPLE_PATH = join(REPO_ROOT, 'scripts', 'portfolio', 'forbidden.local.json.example')
const SUMMARY_LINE_LIMIT = 200

function parseArgs(argv: string[]): { remote: string | null; yes: boolean; confirm: boolean; refresh: boolean } {
  const remoteIndex = argv.indexOf('--remote')
  const remote = remoteIndex >= 0 ? argv[remoteIndex + 1] ?? null : null
  return { remote, yes: argv.includes('--yes'), confirm: argv.includes('--confirm'), refresh: argv.includes('--refresh') }
}

// GitHub remote URL 有 https 與 ssh 兩種寫法，且可能帶或不帶 `.git`；統一抽出
// `owner/repo` 小寫字串才能可靠比較，不能直接比對原始字串。
function extractOwnerRepo(url: string): string | null {
  const match = url.match(/github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?$/i)
  return match ? match[1].toLowerCase() : null
}

async function run(command: string, args: string[], cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

// 為什麼一定要在「私有 repo」這一側檢查，而不是只檢查輸出目錄：真正的地雷是有人已經在
// 私有 repo 裡執行過 `git remote add public <公開 repo url>`，之後不小心在私有 repo
// 根目錄跑了 `git push public`，一次把全部 376 commits 的私有歷史送上公開 repo。
// 輸出目錄本身「沒有 .git」（build.ts 已斷言）擋不住這個情境，因為問題出在私有 repo 那邊，
// 不是輸出目錄。
async function assertPrivateRepoHasNoRemoteToPublicRepo(remoteUrl: string): Promise<void> {
  const targetOwnerRepo = extractOwnerRepo(remoteUrl)
  const { exitCode, stdout } = await run('git', ['remote', '-v'], REPO_ROOT)
  if (exitCode !== 0) {
    console.error('❌ PORTFOLIO RELEASE FAILED: 無法讀取私有 repo 的 git remote 清單。')
    process.exit(1)
  }
  if (!targetOwnerRepo) return // 不是 github.com 網址（例如本機測試用的 file:// 路徑）就略過這項比對

  for (const line of stdout.split('\n')) {
    const url = line.split(/\s+/)[1]
    if (!url) continue
    if (extractOwnerRepo(url) === targetOwnerRepo) {
      console.error('❌ PORTFOLIO RELEASE FAILED: 私有 repo 的 git remote 清單裡已經有指向公開 repo 的設定：')
      console.error(`   ${line.trim()}`)
      console.error('   這正是「不小心在私有 repo 根目錄 push 全部歷史」的地雷，必須移除這個 remote 才能繼續。')
      process.exit(1)
    }
  }
}

async function runPortfolioCheck(): Promise<void> {
  console.log('→ 重新執行 portfolio:check（不相信呼叫端已經跑過）')
  const proc = Bun.spawn(['bun', 'run', 'scripts/portfolio/check.ts'], { cwd: REPO_ROOT, stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error('❌ PORTFOLIO RELEASE FAILED: portfolio:check 沒有通過，不會執行任何 git 操作。')
    process.exit(1)
  }
}

function fail(message: string, detail?: string): never {
  console.error(`❌ PORTFOLIO RELEASE FAILED: ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}

// 用 ls-remote 只讀取遠端有哪些 ref，不下載任何內容、不需要本機 repo——所以 dry run 也能先
// 做這一步，讓「--refresh 加錯／漏加」在真正執行前就被抓到，而不是 push 到一半才失敗。
// 刻意列出全部 ref（不加 --heads main 過濾），判斷規則見 releaseLogic.ts 的 classifyRemoteRefs。
async function readRemoteState(remoteUrl: string): Promise<RemoteState> {
  const { exitCode, stdout, stderr } = await run('git', ['ls-remote', remoteUrl], REPO_ROOT)
  if (exitCode !== 0) fail(`無法讀取公開 repo（git ls-remote ${remoteUrl}）。請確認網址與存取權限。`, stderr.trim())
  return classifyRemoteRefs(stdout)
}

// portfolio:check 已經驗證過這份設定，這裡讀取失敗只可能是 check 之後檔案被改動，照樣 fail closed。
function loadForbiddenEntries(): ForbiddenEntry[] {
  try {
    const example = existsSync(FORBIDDEN_EXAMPLE_PATH) ? JSON.parse(readFileSync(FORBIDDEN_EXAMPLE_PATH, 'utf8')) : null
    const result = validateForbiddenConfig(JSON.parse(readFileSync(FORBIDDEN_PATH, 'utf8')), example)
    if (result.ok) return result.entries
    fail(result.reason)
  } catch (error) {
    fail('無法讀取 forbidden.local.json。', (error as Error).message)
  }
}

// 為什麼 refresh 前一定要掃「公開 repo 既有的每一個 commit」，而不是只信任 portfolio:check：
// check 只掃這次的新快照；refresh 會把新 commit 疊在既有公開歷史上，舊 commit 永遠留在祖先裡、
// 任何人都能 `git show` 取回。第 6 節規定「sanitizer 修了安全性 bug 要重新發布」——正是舊快照
// 可能已經含有漏網個資的情境，這時疊一個乾淨的新 commit 上去完全沒有清掉外洩內容，
// 只會讓人誤以為已經處理好了（Codex review 在 PR #1011 抓到）。
// 掃到任何東西就拒絕 refresh，由 owner 決定是否刪掉公開 repo 重建後改走首次發布——
// 改寫公開歷史（force push）不由這支腳本代勞。只印 commit 與檔案路徑，不印命中的真實字串。
async function assertPublicHistoryIsClean(entries: ForbiddenEntry[]): Promise<void> {
  const { stdout: revList } = await run('git', ['rev-list', 'FETCH_HEAD'], OUTPUT_DIR)
  const commits = revList.split('\n').filter(Boolean)
  const patterns = entries.flatMap(({ value }) => {
    const escaped = regexEscapedVariant(value)
    return escaped === value ? [value] : [value, escaped]
  })
  const hits: string[] = []
  for (const commit of commits) {
    const short = commit.slice(0, 7)
    const tree = await run('git', ['ls-tree', '-r', '--name-only', commit], OUTPUT_DIR)
    if (tree.exitCode !== 0) fail(`無法讀取公開歷史 commit ${short} 的檔案清單。`, tree.stderr.trim())
    for (const path of tree.stdout.split('\n').filter(Boolean)) {
      if (isHardRejectedPath(path) || findForbiddenHit(path, null, entries)) hits.push(`${short}:${path}（路徑）`)
    }
    if (patterns.length === 0) continue
    // git grep：-I 跳過二進位、-i 不分大小寫（跟 findForbiddenHit 一樣）、-F 字面比對、-l 只列檔名。
    // exit 1 代表沒有命中，其他非 0 才是真的錯誤。
    const grep = await run('git', ['grep', '-I', '-i', '-F', '-l', ...patterns.flatMap(p => ['-e', p]), commit], OUTPUT_DIR)
    if (grep.exitCode !== 0 && grep.exitCode !== 1) fail(`無法掃描公開歷史 commit ${short}。`, grep.stderr.trim())
    for (const line of grep.stdout.split('\n').filter(Boolean)) hits.push(`${short}:${line.slice(commit.length + 1)}（內容）`)
  }
  if (hits.length > 0) {
    fail(
      `公開 repo 既有歷史裡有 ${hits.length} 處命中禁字或硬性拒絕規則，refresh 無法清除舊 commit 裡的內容：`,
      hits.map(hit => `   - ${hit}`).join('\n')
        + '\n   請 owner 自行決定：刪除公開 repo 重建後，改用首次發布（不加 --refresh）；腳本不會自動改寫公開歷史。',
    )
  }
  console.log(`✓ 公開 repo 既有歷史：${commits.length} 個 commit，無禁字命中。`)
}

async function runGitSteps(steps: string[][]): Promise<void> {
  for (const args of steps) {
    const { exitCode, stderr } = await run('git', args, OUTPUT_DIR)
    if (exitCode !== 0) fail(`\`git ${args.join(' ')}\` 失敗。`, stderr.trim())
  }
}

// 在輸出目錄準備好「還沒 commit 的新快照」：git init、（refresh 時）取回公開歷史並掃過每個舊 commit、
// 再把新快照 stage 起來。這一步只動輸出目錄自己的 .git，不碰私有 repo、不 push——所以可以在
// 詢問 owner 之前先做完，讓 owner 看到的是「真的會 push 出去的內容」相對於公開版的差異。
async function stageSnapshot(remoteUrl: string, mode: ReleaseMode): Promise<void> {
  await runGitSteps([
    ['init', '-q'],
    ['checkout', '-q', '-b', 'main'],
    ['remote', 'add', 'origin', remoteUrl],
  ])

  if (mode === 'refresh') {
    // 為什麼用「fetch 公開歷史 + mixed reset」而不是 clone 公開 repo 再把檔案複製過去：
    // mixed reset 只移動 HEAD 與 index 到公開 repo 最新 commit，工作目錄保持是剛通過 check 的新快照，
    // 接著 `git add -A` 就會精確記錄「新增／修改／刪除」——包含舊快照有、新 allowlist 已排除的檔案
    // 也會被刪掉。複製檔案的做法很容易漏掉刪除，讓已經不該公開的舊檔案一直留在公開 repo 裡。
    // 抓回來的只有公開 repo 本來就公開的歷史，私有歷史完全不會進到這個 .git。
    await runGitSteps([['fetch', '-q', 'origin', 'main']])
    await assertPublicHistoryIsClean(loadForbiddenEntries())
    await runGitSteps([['reset', '-q', 'FETCH_HEAD']])
  }

  await runGitSteps([['add', '-A']])
}

// 放棄這次發布時把輸出目錄的 .git 拿掉，輸出目錄回到「剛通過 check」的狀態：
// check 指紋不含 .git，所以下次直接重跑 release 就能沿用結果，不必重跑 verify。
function discardStagedSnapshot(): void {
  rmSync(join(OUTPUT_DIR, '.git'), { recursive: true, force: true })
}

// 為什麼改成印「跟公開版的差異」而不是要求逐檔看完整個輸出目錄：輸出目錄有 500 多個檔案，
// 但兩次快照之間真正變動的通常只有幾十個，沒變的檔案上次發布前已經看過了。
// 首次發布沒有可比較的公開版，只印檔案數，仍需要人工看過整個輸出目錄。
async function printSnapshotSummary(mode: ReleaseMode): Promise<void> {
  if (mode === 'initial') {
    const { stdout } = await run('git', ['ls-files'], OUTPUT_DIR)
    console.log(`\n首次發布：共 ${stdout.split('\n').filter(Boolean).length} 個檔案。請確認已經人工看過 ${OUTPUT_DIR}。`)
    return
  }
  const { stdout } = await run('git', ['diff', '--cached', '--name-status', 'HEAD'], OUTPUT_DIR)
  const summary = summarizeNameStatus(stdout)
  console.log(`\n跟目前公開版相比：新增 ${summary.added}、修改 ${summary.modified}、刪除 ${summary.deleted} 個檔案。`)
  for (const line of summary.lines.slice(0, SUMMARY_LINE_LIMIT)) console.log(`   ${line}`)
  if (summary.lines.length > SUMMARY_LINE_LIMIT) console.log(`   …另外還有 ${summary.lines.length - SUMMARY_LINE_LIMIT} 個`)
  console.log(`看單一檔案的內容差異：git -C ${OUTPUT_DIR} diff --cached HEAD -- <檔案路徑>`)
}

async function commitAndPush(remoteUrl: string, mode: ReleaseMode): Promise<void> {
  await runGitSteps([['commit', '-q', '-m', snapshotCommitMessage(mode, new Date())]])

  console.log(`→ git push -u origin main（目標：${remoteUrl}）`)
  // 兩種模式都刻意不加 --force：首次發布時公開 repo 應該是空的；refresh 時新 commit 直接疊在
  // 剛 fetch 回來的公開 main 之上，是 fast-forward。任何一種情況 push 失敗（例如 fetch 之後
  // 有人又推了新 commit、repo 不是空的、沒有權限），都直接停下來讓 owner 判斷，
  // 絕不用 --force 覆蓋掉可能已經存在、且可能是有意義的既有內容。
  const proc = Bun.spawn(['git', 'push', '-u', 'origin', 'main'], { cwd: OUTPUT_DIR, stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    fail(
      'git push 失敗（詳見上方輸出）。',
      '   常見原因：目標 repo 狀態與預期不符、沒有 push 權限、或網路問題。\n'
        + '   不會自動改用 --force；請自行確認目標 repo 狀態後，重跑 bun run portfolio:publish。',
    )
  }
}

// check 指紋相同就沿用上一次的通過結果（見 checkStamp.ts）；不同或沒有就照舊重跑——
// 「不相信呼叫端已經跑過」的原則不變，只是改成用指紋證明「跑過的就是現在這份內容」。
async function ensurePortfolioChecked(): Promise<void> {
  const stamped = readCheckStampDigest(REPO_ROOT)
  if (stamped && stamped === computeCheckDigest(REPO_ROOT, OUTPUT_DIR)) {
    console.log('✓ 沿用上一次 portfolio:check 的通過結果（輸出內容、禁字清單、產線程式碼的指紋都相同）。')
    return
  }
  await runPortfolioCheck()
}

async function main() {
  const { remote, yes, confirm, refresh } = parseArgs(Bun.argv.slice(2))

  if (!remote) {
    console.error('用法：bun run portfolio:publish -- --remote <公開 repo 的 git url> [--refresh]')
    console.error('首次發布：bun run portfolio:publish -- --remote https://github.com/demo-xq7/jia-jian-log-portfolio.git')
    console.error('更新快照：bun run portfolio:publish -- --remote https://github.com/demo-xq7/jia-jian-log-portfolio.git --refresh')
    process.exit(1)
  }

  if (!existsSync(OUTPUT_DIR)) {
    console.error(`❌ PORTFOLIO RELEASE FAILED: 找不到輸出目錄 ${OUTPUT_DIR}。請先執行 bun run portfolio:build。`)
    process.exit(1)
  }

  // 輸出目錄已經有 .git 代表上一次 release 做到一半（或已經 release 過）；check.ts 會把 .git
  // 當成硬性拒絕項目，這裡提早給出明確的處理方式，而不是讓 owner 看到一個看似無關的 check 失敗。
  if (existsSync(join(OUTPUT_DIR, '.git'))) {
    fail('輸出目錄已經有 .git（上一次 release 留下的）。請重跑 bun run portfolio:publish（會重新產生乾淨的輸出目錄）。')
  }

  await assertPrivateRepoHasNoRemoteToPublicRepo(remote)
  const modeResult = resolveReleaseMode(await readRemoteState(remote), refresh)
  if (!modeResult.ok) fail(modeResult.reason)
  const { mode } = modeResult
  await ensurePortfolioChecked()

  // 為什麼互動確認要另外加 --confirm 才啟用，而不是「有終端機就問」：操作手冊（7.6）與既有習慣都把
  // 「不加 --yes 的 release」當成絕不會 push 的 dry run，owner 會在 dry run 之後才去看輸出目錄。
  // 如果同一個指令在終端機裡突然變成會問 y/N 並 push，照手冊操作的人可能在「以為是試跑」的步驟就發布出去
  // （Codex review 在 PR #1012 抓到）。所以：兩個旗標都沒有 → 一律 dry run；--confirm → 印差異後問 y/N。
  // --confirm 但沒有終端機可以問時也退回 dry run，不會卡住等輸入。
  if (!yes && (!confirm || !process.stdin.isTTY)) {
    console.log(`這是 dry run（沒有加 --yes${confirm ? '，也沒有可互動的終端機' : ''}）。以上檢查全部通過，模式：${mode === 'initial' ? '首次發布' : 'refresh（更新既有快照）'}。`)
    console.log(`加上 --confirm（印出差異後問 y/N）或 --yes 才會實際 push 到 ${remote}（不使用 --force）。`)
    return
  }

  await stageSnapshot(remote, mode)
  if (mode === 'refresh' && (await run('git', ['diff', '--cached', '--quiet'], OUTPUT_DIR)).exitCode === 0) {
    discardStagedSnapshot()
    console.log('✅ 新快照與公開 repo 目前內容完全相同，沒有需要發布的變更，未 push。')
    return
  }
  await printSnapshotSummary(mode)

  if (!yes) {
    const answer = prompt(`\n確定要 push 到 ${remote} 嗎？(y/N)`)
    if (!isConfirmation(answer)) {
      discardStagedSnapshot()
      console.log('已取消，沒有 push。輸出目錄保留原狀，改用 bun run portfolio:release -- <同樣參數> --confirm 重跑會沿用這次的 check 結果。')
      return
    }
  }

  await commitAndPush(remote, mode)
  console.log(`✅ portfolio:release 完成（${mode === 'initial' ? '首次發布' : 'refresh'}），已 push 到 ${remote}`)
  console.log('   下一步：到公開 repo 確認它自己的 CI（portfolio-ci.yml）綠燈。')
}

main()
