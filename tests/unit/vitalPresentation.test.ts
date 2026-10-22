/*
檔案用途：鎖住血壓／心跳識別色的色值，以及「沒有暗色表面就不套用暗色值」的規則（issue #1152）。
所在層：tests/unit 單元測試層；只讀原始碼字串，不渲染畫面。
主要關聯：src/lib/vitalPresentation.ts、src/index.css 的 .vital-*、src/features/vitals 的圖表與輸入卡。
*/
import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { VITAL_COLORS } from '../../src/lib/vitalPresentation'

const SRC_DIR = join(import.meta.dir, '../../src')

// 連 .ts 一起掃：VITAL_VALUE_CLASSES 這類共用 class 對照表放在 .ts，漏掃就守不住所有讀值（#1175 Codex 審查）。
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : []
  })
}

describe('vital sign presentation tokens', () => {
  test('keeps indicator colors distinct from alert semantics', () => {
    expect(VITAL_COLORS).toEqual({
      systolic: { light: '#C23B3B', dark: '#F87171' },
      diastolic: { light: '#2563EB', dark: '#60A5FA' },
      pulse: { light: '#7C3AED', dark: '#C084FC' },
    })
  })

  // app 只有亮色表面：OS 切深色模式時卡片仍是白底，暗色值在白底只有 2.5～2.8:1。
  // 這兩條斷言擋的是「有人以為要支援深色模式就把暗色值接回去」——要接，得先有暗色表面並一起改這裡。
  test('does not swap vital colors to dark values via prefers-color-scheme', () => {
    const css = readFileSync(join(SRC_DIR, 'index.css'), 'utf8')
    expect(css).not.toMatch(/@media\s*\(\s*prefers-color-scheme:\s*dark\s*\)/)
    for (const { dark } of Object.values(VITAL_COLORS)) {
      expect(css.toUpperCase()).not.toContain(`COLOR: ${dark}`)
    }
  })

  // 冒號後緊接 class 字元（字母、[、!、-）才算 Tailwind 變體；VITAL_COLORS 的 `dark: '#…'` 物件鍵後面是空白，不能被誤抓。
  // 前面也接受 `:`：疊加變體（`sm:dark:…`、`hover:dark:…`）的 dark 前面是另一個變體的冒號，漏掉就守不住（#1175 Codex 第 2 輪）。
  const TAILWIND_DARK_VARIANT = /(^|[\s"'`:])dark:[a-z[!-]/

  test('no source file uses Tailwind dark: variants while the app has no dark surface', () => {
    const offenders = sourceFiles(SRC_DIR).filter(file => TAILWIND_DARK_VARIANT.test(readFileSync(file, 'utf8')))
    expect(offenders).toEqual([])
  })
})
