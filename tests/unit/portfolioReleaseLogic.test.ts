/*
檔案用途：驗證 PORTFOLIO-01 portfolio:release 的純判斷邏輯——首次發布／refresh 模式判定的
fail-closed 規則，以及快照 commit 訊息格式。
所在層：tests/unit；不觸網、不碰檔案系統，只測 scripts/portfolio/releaseLogic.ts 的純函式。
主要關聯：scripts/portfolio/releaseLogic.ts、scripts/portfolio/release.ts、
docs/operations/portfolio-pipeline.md 第 4、7 節。
*/
import { describe, expect, test } from 'bun:test'
import { classifyRemoteRefs, isConfirmation, resolveReleaseMode, snapshotCommitMessage, summarizeNameStatus } from '../../scripts/portfolio/releaseLogic'

describe('classifyRemoteRefs', () => {
  test('no refs at all is an empty repo', () => {
    expect(classifyRemoteRefs('')).toBe('empty')
    expect(classifyRemoteRefs('\n')).toBe('empty')
  })

  test('refs/heads/main present is hasMain', () => {
    expect(classifyRemoteRefs('abc123\tHEAD\nabc123\trefs/heads/main\n')).toBe('hasMain')
  })

  test('a repo with only master, develop or tags is not empty', () => {
    expect(classifyRemoteRefs('abc123\trefs/heads/master\n')).toBe('otherRefsOnly')
    expect(classifyRemoteRefs('abc123\trefs/tags/v1.0.0\n')).toBe('otherRefsOnly')
    expect(classifyRemoteRefs('abc123\trefs/heads/main-old\n')).toBe('otherRefsOnly')
  })
})

describe('resolveReleaseMode', () => {
  test('empty remote without --refresh is an initial release', () => {
    expect(resolveReleaseMode('empty', false)).toEqual({ ok: true, mode: 'initial' })
  })

  test('remote with history plus --refresh is a refresh release', () => {
    expect(resolveReleaseMode('hasMain', true)).toEqual({ ok: true, mode: 'refresh' })
  })

  test('remote with history but no --refresh fails closed', () => {
    const result = resolveReleaseMode('hasMain', false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('--refresh')
  })

  test('--refresh against an empty remote fails closed', () => {
    const result = resolveReleaseMode('empty', true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('空 repo')
  })

  test('a non-empty repo without main fails closed in both modes', () => {
    expect(resolveReleaseMode('otherRefsOnly', false).ok).toBe(false)
    expect(resolveReleaseMode('otherRefsOnly', true).ok).toBe(false)
  })
})

describe('snapshotCommitMessage', () => {
  test('initial release keeps the v1 fixed message', () => {
    expect(snapshotCommitMessage('initial', new Date('2026-09-29T12:00:00Z'))).toBe('chore: sanitized portfolio snapshot')
  })

  test('refresh release includes the UTC date', () => {
    expect(snapshotCommitMessage('refresh', new Date('2026-09-29T23:30:00Z'))).toBe('chore: sanitized portfolio snapshot (2026-09-29)')
  })
})

describe('summarizeNameStatus', () => {
  test('counts additions, modifications, deletions and renames', () => {
    const summary = summarizeNameStatus('A\tsrc/new.ts\nM\tsrc/main.tsx\nD\tdocs/old.md\nR100\tsrc/a.ts\tsrc/b.ts\n')
    expect(summary).toEqual({
      added: 1,
      modified: 2,
      deleted: 1,
      lines: ['新增  src/new.ts', '修改  src/main.tsx', '刪除  docs/old.md', '改名  src/a.ts → src/b.ts'],
    })
  })

  test('empty diff yields zero counts', () => {
    expect(summarizeNameStatus('')).toEqual({ added: 0, modified: 0, deleted: 0, lines: [] })
  })
})

describe('isConfirmation', () => {
  test('only an explicit y or yes confirms', () => {
    expect(isConfirmation('y')).toBe(true)
    expect(isConfirmation(' YES ')).toBe(true)
  })

  test('empty input, other words and Ctrl-D all cancel', () => {
    expect(isConfirmation('')).toBe(false)
    expect(isConfirmation('n')).toBe(false)
    expect(isConfirmation('yep')).toBe(false)
    expect(isConfirmation(null)).toBe(false)
  })
})
