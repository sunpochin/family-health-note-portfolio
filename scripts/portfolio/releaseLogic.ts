/*
檔案用途：PORTFOLIO-01 portfolio:release 的純判斷邏輯——依「公開 repo 的 main 是否已有歷史」與
呼叫端是否明確加了 `--refresh`，決定這次是「首次發布」還是「在既有公開歷史上疊一個新快照」，
以及產生快照 commit 訊息。
所在層：scripts/portfolio；不觸網、不碰檔案系統，方便單元測試（release.ts 一被 import 就會執行 main）。
主要關聯：scripts/portfolio/release.ts、tests/unit/portfolioReleaseLogic.test.ts、
docs/operations/portfolio-pipeline.md 第 4、6、7 節。
*/

export type ReleaseMode = 'initial' | 'refresh'

// 'otherRefsOnly'：遠端沒有 main，但有其他分支或 tag——既不是空 repo，也不是我們發布過的作品集 repo。
export type RemoteState = 'empty' | 'hasMain' | 'otherRefsOnly'

// 為什麼要讀「全部 ref」而不是只問 main：`git ls-remote --heads <url> main` 只回傳符合的 head，
// 遠端只有 master／develop／tag 時會回傳空字串，被誤判成空 repo，接著首次發布的 push 就會在一個
// 其實不是空的、很可能是指錯的 repo 上新建 main 分支（Codex review 在 PR #1011 抓到）。
export function classifyRemoteRefs(lsRemoteOutput: string): RemoteState {
  const refs = lsRemoteOutput.split('\n').map(line => line.split('\t')[1]?.trim()).filter(Boolean)
  if (refs.length === 0) return 'empty'
  return refs.includes('refs/heads/main') ? 'hasMain' : 'otherRefsOnly'
}

export type ReleaseModeResult = { ok: true; mode: ReleaseMode } | { ok: false; reason: string }

// 為什麼「遠端已有歷史」時必須明確加 --refresh，而不是自動偵測後直接疊上去：
// 遠端有歷史也可能代表 --remote 打錯（指到另一個不相干的 repo），自動疊上去會把作品集快照
// 推進錯的地方。要求 owner 明確說「我知道這是更新既有快照」，打錯網址時才會停下來。
// 反過來，加了 --refresh 但遠端是空的，同樣代表認知跟現況不符（repo 被刪過重建、或網址打錯），也要停下來。
export function resolveReleaseMode(remoteState: RemoteState, refresh: boolean): ReleaseModeResult {
  if (remoteState === 'otherRefsOnly') {
    return {
      ok: false,
      reason: '公開 repo 沒有 main，但已經有其他分支或 tag——這不是空 repo，也不是作品集產線發布過的 repo。請確認 --remote 沒有指錯 repo。',
    }
  }
  const remoteHasMain = remoteState === 'hasMain'
  if (remoteHasMain && !refresh) {
    return {
      ok: false,
      reason: '公開 repo 的 main 已經有歷史。若這次是要更新既有作品集快照，請加上 --refresh；若不是，請確認 --remote 沒有指錯 repo。',
    }
  }
  if (!remoteHasMain && refresh) {
    return {
      ok: false,
      reason: '加了 --refresh，但公開 repo 的 main 不存在（空 repo）。首次發布請拿掉 --refresh；否則請確認 --remote 沒有指錯 repo。',
    }
  }
  return { ok: true, mode: remoteHasMain ? 'refresh' : 'initial' }
}

// 首次發布沿用 v1 固定訊息（公開 repo 既有第一個 commit 就是這個訊息，保持一致）；
// refresh 在訊息裡帶日期，讓公開 repo 的 `git log` 直接讀得出「Sep 2026 snapshot」這種漸進歷史
// （第 6 節的更新節奏），面試官不用點進 diff 就知道每次快照的時間點。
// 刻意用 UTC 日期字串而不是本機時區：同一天不同時區執行不會產生不同訊息，測試也可重現。
export function snapshotCommitMessage(mode: ReleaseMode, now: Date): string {
  if (mode === 'initial') return 'chore: sanitized portfolio snapshot'
  return `chore: sanitized portfolio snapshot (${now.toISOString().slice(0, 10)})`
}

export type NameStatusSummary = { added: number; modified: number; deleted: number; lines: string[] }

// 解析 `git diff --name-status` 的輸出（每行「狀態<TAB>路徑」，改名是「R100<TAB>舊<TAB>新」），
// 統計新增／修改／刪除，並轉成好讀的一行一個檔案。改名算成修改：對 review 來說重點是「這個檔案變了」。
export function summarizeNameStatus(output: string): NameStatusSummary {
  const summary: NameStatusSummary = { added: 0, modified: 0, deleted: 0, lines: [] }
  for (const raw of output.split('\n')) {
    if (!raw.trim()) continue
    const [status, ...paths] = raw.split('\t')
    const kind = status[0]
    if (kind === 'A') summary.added += 1
    else if (kind === 'D') summary.deleted += 1
    else summary.modified += 1
    const label = kind === 'A' ? '新增' : kind === 'D' ? '刪除' : kind === 'R' ? '改名' : '修改'
    summary.lines.push(`${label}  ${paths.join(' → ')}`)
  }
  return summary
}

// 只有明確的 y／yes（不分大小寫）才算同意；直接按 Enter、打錯字、Ctrl-D（prompt 回傳 null）一律當成取消，
// 因為 push 出去就收不回來，預設必須是「不發布」。
export function isConfirmation(answer: string | null): boolean {
  return answer !== null && /^(y|yes)$/i.test(answer.trim())
}
