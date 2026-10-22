/*
檔案用途：守護 src 底下的 .ts／.tsx 原始碼不得含有 NUL（0x00）位元組；需要 NUL 當分隔符時一律寫成跳脫序列 '\u0000'。
所在層：tests/unit；純靜態掃描，只讀檔案位元組，不執行任何應用程式碼。
主要關聯：src/features/care-family/components/trajectory/TrajectoryEventPhotos.tsx（曾把真正的 NUL 當 join 分隔符）；
issue #1145 的 focus ring 清查曾因此漏掃該檔。
*/
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'

const SRC_ROOT = new URL('../../src/', import.meta.url)

// 原始碼只要有一個 0x00，git 與 GitHub 就會把整個檔案當二進位（PR 看不到 diff），
// rg／grep 預設也會直接跳過它，所以 repo 範圍的搜尋與清查都會悄悄漏掉這個檔案。
function findNulLines(bytes: Uint8Array): number[] {
  const lines: number[] = []
  let line = 1
  for (const byte of bytes) {
    if (byte === 0x0a) line += 1
    else if (byte === 0x00 && lines[lines.length - 1] !== line) lines.push(line)
  }
  return lines
}

function listSourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true })
    .map(entry => String(entry))
    .filter(entry => /\.(ts|tsx)$/.test(entry))
    .sort()
}

describe('src 原始碼不得含有 NUL 位元組', () => {
  test('偵測函式能找出 NUL 所在行，且乾淨內容回傳空陣列', () => {
    expect(findNulLines(new TextEncoder().encode('a\nb\nc'))).toEqual([])
    expect(findNulLines(Uint8Array.from([0x61, 0x0a, 0x62, 0x00, 0x00, 0x0a, 0x00]))).toEqual([2, 3])
  })

  test('有實際掃到檔案，避免路徑錯誤讓守護變成空轉', () => {
    expect(listSourceFiles().length).toBeGreaterThan(50)
  })

  test('每個 .ts／.tsx 都沒有 NUL；要用就寫成 \'\\u0000\' 跳脫序列', () => {
    const offenders = listSourceFiles().flatMap(path => {
      const lines = findNulLines(readFileSync(new URL(path, SRC_ROOT)))
      return lines.map(line => `src/${path}:${line}`)
    })
    expect(offenders).toEqual([])
  })
})
