/*
檔案用途：PORTFOLIO-01 的一鍵發布指令——清掉舊輸出目錄 → build → check → release，一個指令做完；
release 會沿用剛通過的 check 指紋（不重跑第二次），印出跟公開版的差異，問 y/N 之後才 push。
所在層：scripts/portfolio，由 package.json 的 `portfolio:publish` 呼叫。參數原樣轉給 release.ts
（`--remote <url>` 必填、更新既有快照加 `--refresh`），並自動加上 `--confirm`：印出差異後問 y/N；
非互動環境要真的 push 就改加 `--yes`。
不執行 git pull——是否要先同步最新程式碼，仍由 owner 自己決定。
主要關聯：scripts/portfolio/verify.ts、build.ts、check.ts、release.ts、checkStamp.ts；
docs/operations/portfolio-pipeline.md 第 4、7.7 節。
*/
import { rmSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = process.cwd()
const OUTPUT_DIR = join(REPO_ROOT, 'tmp', 'jia-jian-log-portfolio')

// 為什麼在最前面就檢查 --remote：build＋check 要跑好幾分鐘，跑完才發現忘了帶參數最浪費時間。
function assertRemoteGiven(args: string[]): void {
  const index = args.indexOf('--remote')
  if (index < 0 || !args[index + 1]) {
    console.error('用法：bun run portfolio:publish -- --remote <公開 repo 的 git url> [--refresh]')
    console.error('更新快照：bun run portfolio:publish -- --remote https://github.com/demo-xq7/jia-jian-log-portfolio.git --refresh')
    process.exit(1)
  }
}

async function runStep(label: string, args: string[]): Promise<void> {
  console.log(`\n=== ${label} ===`)
  // stdin 要 inherit：release.ts 的 y/N 確認需要讀得到 owner 的鍵盤輸入。
  const proc = Bun.spawn(['bun', ...args], { cwd: REPO_ROOT, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    console.error(`❌ portfolio:publish 中止：${label} 失敗（exit ${exitCode}）。`)
    process.exit(1)
  }
}

async function main() {
  const args = Bun.argv.slice(2)
  assertRemoteGiven(args)

  console.log(`→ 清除舊的輸出目錄：${OUTPUT_DIR}`)
  rmSync(OUTPUT_DIR, { recursive: true, force: true })

  await runStep('portfolio:build', ['run', 'scripts/portfolio/build.ts'])
  await runStep('portfolio:check', ['run', 'scripts/portfolio/check.ts'])
  // 自動帶 --confirm：publish 的用途就是「看差異、按 y 發布」；直接呼叫 release 則維持不加旗標就是 dry run。
  const releaseArgs = args.includes('--yes') || args.includes('--confirm') ? args : [...args, '--confirm']
  await runStep('portfolio:release', ['run', 'scripts/portfolio/release.ts', ...releaseArgs])
}

main()
