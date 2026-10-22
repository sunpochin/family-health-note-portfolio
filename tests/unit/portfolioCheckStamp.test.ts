/*
檔案用途：驗證 PORTFOLIO-01 check 指紋的純函式——同樣內容得到同樣指紋、任何差異都會改變指紋。
所在層：tests/unit；只測 scripts/portfolio/checkStamp.ts 的 digestEntries，不碰檔案系統。
主要關聯：scripts/portfolio/checkStamp.ts、scripts/portfolio/check.ts、scripts/portfolio/release.ts。
*/
import { describe, expect, test } from 'bun:test'
import { digestEntries } from '../../scripts/portfolio/checkStamp'

const bytes = (text: string) => new TextEncoder().encode(text)

describe('digestEntries', () => {
  test('is independent of listing order', () => {
    const a = digestEntries([['output:a.ts', bytes('1')], ['output:b.ts', bytes('2')]])
    const b = digestEntries([['output:b.ts', bytes('2')], ['output:a.ts', bytes('1')]])
    expect(a).toBe(b)
  })

  test('changes when any content byte changes', () => {
    const before = digestEntries([['output:a.ts', bytes('const x = 1')]])
    const after = digestEntries([['output:a.ts', bytes('const x = 2')]])
    expect(before).not.toBe(after)
  })

  test('changes when a file is renamed, added or removed', () => {
    const base = digestEntries([['output:a.ts', bytes('x')]])
    expect(digestEntries([['output:b.ts', bytes('x')]])).not.toBe(base)
    expect(digestEntries([['output:a.ts', bytes('x')], ['output:c.ts', bytes('')]])).not.toBe(base)
    expect(digestEntries([])).not.toBe(base)
  })

  test('does not collide when the path/content boundary shifts', () => {
    const a = digestEntries([['output:ab', bytes('c')]])
    const b = digestEntries([['output:a', bytes('bc')]])
    expect(a).not.toBe(b)
  })
})
