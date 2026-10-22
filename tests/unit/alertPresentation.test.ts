/*
檔案用途：鎖住 issue #898 §4.2／§4.3 的配色收斂——同一筆讀數在 badge、圖表、統計卡、
        列印報告與輸入頁按鈕必須取得**同一個視覺階**，而且四階紅在灰階下仍可分辨。
所在層：tests/unit 單元測試層。
主要關聯：src/lib/alertPresentation.ts、src/types/database/bpStandard.ts、
        docs/product/blood-pressure-standard-templates.md §4。

這一條是驗收條件裡「跨畫面一致，要有自動化測試，不能只靠人工看」的那一條。
*/
import { describe, expect, test } from 'bun:test'
import {
  ALERT_BAR_CLASS,
  ALERT_BUTTON_CLASS,
  ALERT_CARD_CLASS,
  ALERT_CHIP_CLASS,
  ALERT_ICON,
  ALERT_SOFT_CHIP_CLASS,
  alertLabelText,
  alertTone,
  alertToneFromLevel,
  type AlertTone,
} from '../../src/lib/alertPresentation'
import {
  CKD_DIABETES_STANDARD,
  ELDERLY_RELAXED_STANDARD,
  GENERAL_ADULT_STANDARD,
  POST_OP_STRICT_STANDARD,
  createCustomStandard,
  evaluateReading,
} from '../../src/types/database'
import BP_LEVELS from '../../src/config/bp-levels.json'

const ALL_TONES: AlertTone[] = [
  'on-target', 'normal', 'below-target', 'warning-low', 'danger-low',
  'off-target', 'pulse-warning', 'warning', 'danger', 'critical',
]

const SURFACES: Array<[string, Record<AlertTone, string>]> = [
  ['chip（badge）', ALERT_CHIP_CLASS],
  ['bar（危險級色條）', ALERT_BAR_CLASS],
  ['soft chip（報告／圖表）', ALERT_SOFT_CHIP_CLASS],
  ['card（統計卡）', ALERT_CARD_CLASS],
  ['button（輸入頁）', ALERT_BUTTON_CLASS],
  ['icon', ALERT_ICON],
]

describe('§4.3 配色落點收斂', () => {
  test('每個視覺階在每一個落點都有值——少一個就會出現「總覽紅、清單綠」', () => {
    for (const [name, map] of SURFACES) {
      for (const tone of ALL_TONES) {
        // 型別已經要求 Record<AlertTone, …>，但 JSON 之外的 map 可能被改成物件字面值後漏鍵，
        // 執行期再確認一次；空字串只有色條那一張表允許（沒有色條的階）。
        expect(`${name}:${tone}: ${typeof map[tone]}`).toBe(`${name}:${tone}: string`)
        if (name !== 'bar（危險級色條）') {
          expect(`${name}:${tone} empty: ${map[tone] === ''}`).toBe(`${name}:${tone} empty: false`)
        }
      }
      expect(Object.keys(map).sort()).toEqual([...ALL_TONES].sort())
    }
  })

  test('灰階下四階紅仍可分辨：外框 → 實心 → 實心＋色條 → 深實心＋色條', () => {
    // 這是「不靠顏色單獨傳達」的實際驗收方式（§4.2）。每一階至少要有一個**非色相**的差異。
    expect(ALERT_CHIP_CLASS['off-target']).toContain('border')      // 外框階：淺底 ＋ 外框
    expect(ALERT_CHIP_CLASS['off-target']).toContain('bg-danger-50')
    expect(ALERT_BAR_CLASS['off-target']).toBe('')

    expect(ALERT_CHIP_CLASS.warning).toContain('bg-danger-700')     // 實心
    expect(ALERT_BAR_CLASS.warning).toBe('')

    expect(ALERT_CHIP_CLASS.danger).toContain('bg-danger-700')      // 實心 ＋ 色條
    expect(ALERT_BAR_CLASS.danger).toContain('border-l-4')

    expect(ALERT_CHIP_CLASS.critical).toContain('bg-red-800')       // 深實心 ＋ 色條
    expect(ALERT_BAR_CLASS.critical).toContain('border-l-4')

    // warning 與 danger 的底色相同，所以色條是它們唯一的差別——如果哪天色條被拿掉，
    // 這兩階在畫面上會完全一樣，必須失敗。
    expect(ALERT_CHIP_CLASS.warning).toBe(ALERT_CHIP_CLASS.danger)
    expect(ALERT_BAR_CLASS.warning).not.toBe(ALERT_BAR_CLASS.danger)
    // critical 與 danger 的色條相同，靠底色深淺分辨——同樣不得兩者都一樣。
    expect(ALERT_CHIP_CLASS.critical).not.toBe(ALERT_CHIP_CLASS.danger)
  })

  test('有色條的階一律把左側兩角改直角', () => {
    // chip 是圓角，只加左邊框會被瀏覽器彎成彎月形，看起來像顏色溢出的 bug（明顯偏低 chip 回報）。
    // 色條與直角必須綁在一起：只要有 border-l-4，就必須有 rounded-l-none。
    for (const [tone, cls] of Object.entries(ALERT_BAR_CLASS)) {
      if (cls.includes('border-l-4')) expect(`${tone}: ${cls}`).toContain('rounded-l-none')
    }
  })

  test('高側是紅、低側是琥珀；上下三角讓灰階也讀得出「往哪邊調」', () => {
    expect(ALERT_CHIP_CLASS['off-target']).toContain('danger')
    expect(ALERT_CHIP_CLASS['below-target']).toContain('warn')
    // issue #1153 換成 SVG 後仍要保留方向：超出目標朝上、低於目標朝下，兩者不得是同一個圖示。
    expect(ALERT_ICON['off-target']).toBe('arrow-up-circle')
    expect(ALERT_ICON['below-target']).toBe('arrow-down-circle')
    expect(ALERT_ICON['on-target']).toBe('target')
  })

  test('危險級與警示級的圖示在灰階下靠外形分開（八角形 vs 三角形）', () => {
    // 原本 🔴 與 ⚠️ 還能靠顏色分；SVG 是 currentColor，只剩外形，所以兩組不得共用同一個圖示。
    expect(ALERT_ICON.critical).toBe('alert-octagon')
    expect(ALERT_ICON['danger-low']).toBe('alert-octagon')
    expect(ALERT_ICON.warning).toBe('alert-triangle')
    expect(ALERT_ICON['warning-low']).toBe('alert-triangle')
  })
})

describe('issue #1153：送出鈕白字對比', () => {
  // 瀏覽器實際渲染出來的色值（Tailwind v4 內建色票是 oklch，換成 sRGB 後與 v3 的 hex 不同，
  // 例如 green-700 是 #008236 不是 #15803d；brand／warn／danger 取自 src/index.css @theme）。
  // 只列 ALERT_BUTTON_CLASS 用得到的底色；新增一階卻用了這裡沒有的底色時，測試會因為查不到色值而失敗，
  // 逼人在瀏覽器量過一次再補進來。
  const HEX: Record<string, string> = {
    'brand-700': '#047857',
    'green-700': '#008236',
    'warn-700': '#b45309',
    'orange-700': '#ca3500',
    'red-600': '#e7000b',
    'danger-700': '#b91c1c',
    'red-800': '#9f0712',
  }
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const contrastOnWhite = (hex: string) => 1.05 / (luminance(hex) + 0.05)

  test('每一階的按鈕底色對白字都 ≥4.5:1', () => {
    // 按鈕字是 text-lg（18px）粗體，差一點才算 WCAG 大字（18.66px 粗體），所以要過一般字的 4.5:1。
    const failures: string[] = []
    for (const [tone, cls] of Object.entries(ALERT_BUTTON_CLASS)) {
      const bg = cls.match(/(?:^|\s)bg-([a-z]+-\d+)/)?.[1]
      const hex = bg ? HEX[bg] : undefined
      if (!hex) { failures.push(`${tone}: 色值未登錄（${cls}）`); continue }
      const ratio = contrastOnWhite(hex)
      if (ratio < 4.5) failures.push(`${tone}: ${bg} ${ratio.toFixed(2)}:1`)
    }
    expect(failures).toEqual([])
  })

  test('normal 與 on-target 的按鈕都是深綠，但不會出現在同一個標準裡', () => {
    // green-700 與 brand-700 明度相近；這是可以接受的，前提是同一位病人永遠只會看到其中一種。
    // normal 只來自一般成人九級表，on-target 只來自目標制模板。哪天有模板同時產生兩者，這裡要失敗，
    // 按鈕就得重新選色。
    const standards = [
      GENERAL_ADULT_STANDARD, POST_OP_STRICT_STANDARD, ELDERLY_RELAXED_STANDARD, CKD_DIABETES_STANDARD, createCustomStandard(),
    ]
    const mixed: string[] = []
    for (const standard of standards) {
      const tones = new Set<AlertTone>()
      for (let sys = 70; sys <= 210; sys += 1) {
        for (let dia = 40; dia <= 130; dia += 5) tones.add(alertTone(evaluateReading(sys, dia, null, standard)))
      }
      if (tones.has('normal') && tones.has('on-target')) mixed.push(standard.key)
    }
    expect(mixed).toEqual([])
  })
})

describe('issue #1153：畫面標籤剝除推播用 emoji', () => {
  test('bp-levels.json 每一級的三語標籤剝完都沒有 emoji、也沒有殘留空白', () => {
    const leftovers: string[] = []
    for (const [key, level] of Object.entries(BP_LEVELS)) {
      const plain = alertLabelText(level.labels)
      for (const [locale, value] of Object.entries(plain)) {
        if (/\p{Extended_Pictographic}|️/u.test(value) || value !== value.trim() || value === '') {
          leftovers.push(`${key}.${locale}: "${value}"`)
        }
      }
    }
    expect(leftovers).toEqual([])
  })

  test('只剝 emoji，文字（含行動指示）一個字都不少', () => {
    expect(alertLabelText(BP_LEVELS.danger_high.labels)).toEqual({
      zh: '極高危險，需立即複測',
      id: 'Bahaya Sangat Tinggi, ukur ulang segera',
      en: 'Extremely high — measure again immediately',
    })
    expect(alertLabelText(BP_LEVELS.tinggi.labels).zh).toBe('偏高')
  })

  test('血壓＋心跳的串接標籤中間那顆 ⚠️ 也會被剝掉', () => {
    // evaluateReading 會把兩段標籤接起來，emoji 不只出現在開頭。
    const joined = alertLabelText(evaluateReading(150, 95, 130, GENERAL_ADULT_STANDARD).labels)
    expect(joined.zh).not.toMatch(/\p{Extended_Pictographic}/u)
    expect(joined.zh).toContain('心跳 >120')
  })

  test('推播與匯出用的原始標籤沒有被改動', () => {
    // 剝除只發生在畫面；bp-levels.json 本身（會同步成推播文字）必須保留 emoji。
    expect(BP_LEVELS.danger_high.labels.zh.startsWith('🔴')).toBe(true)
  })
})

describe('alertTone 的推導', () => {
  const evaluate = (sys: number, dia: number, pulse: number | null, strict = false) =>
    evaluateReading(sys, dia, pulse, strict ? POST_OP_STRICT_STANDARD : GENERAL_ADULT_STANDARD)

  test('hard floor 的最高階自成一階，不與「明顯偏高」共用同一個紅', () => {
    // 185/120 與 165/95 的 webAlertLevel 都是 danger，但一個是「現在就打電話」、
    // 一個是「今天內回報醫師」。用同一個紅講這兩件事就是 §4.1 要避免的警報疲乏。
    expect(alertTone(evaluate(185, 120, null))).toBe('critical')
    expect(alertTone(evaluate(165, 95, null))).toBe('danger')
  })

  test('目標制模板的「在目標內」與一般成人的「正常」是不同的視覺階', () => {
    // 兩者的 webAlertLevel 都是 normal，但目標制要看得出醫囑有被達成。
    expect(alertTone(evaluate(115, 70, null, true))).toBe('on-target')
    expect(alertTone(evaluate(115, 70, null))).toBe('normal')
  })

  test('術後嚴格控制下，一般成人標準判為正常的 128 會顯示為「超出目標」', () => {
    // 這就是這張票存在的理由：同一組數值在兩位病人身上必須有不同的顏色。
    expect(alertTone(evaluate(128, 78, null))).toBe('normal')
    expect(alertTone(evaluate(128, 78, null, true))).toBe('off-target')
  })

  test('血壓正常但心跳 >120 時用心跳自己的琥珀，不借用血壓的紅', () => {
    // 「紅＝血壓高」是全 app 一致的語彙；心跳快也變紅會讓照護者以為血壓出事。
    const pulseOnly = evaluate(115, 72, 130)
    expect(pulseOnly.level).toBe('warning')
    expect(alertTone(pulseOnly)).toBe('pulse-warning')
    // 血壓本身就到警示級時，紅色的理由成立，不得被心跳降級成琥珀。
    expect(alertTone(evaluate(150, 95, 130))).toBe('warning')
  })

  test('alertToneFromLevel 是退化版本：分不出 critical 與 on-target', () => {
    // 它的存在是為了 DashboardSummary.alertCounts 那種「先分桶再上色」的既有資料流；
    // 這一條把它的限制寫死，避免有人誤以為它和 alertTone 等價。
    expect(alertToneFromLevel('danger')).toBe('danger')
    expect(alertToneFromLevel('normal')).toBe('normal')
    expect(alertToneFromLevel('off-target')).toBe('off-target')
  })
})

describe('跨畫面一致性', () => {
  test('同一筆讀數在五個落點取得的樣式都由同一個 tone 決定', () => {
    // 收斂的定義不是「所有地方長得一樣」（按鈕是動作、chip 是狀態，刻意不同），
    // 而是「同一筆讀數在每個地方都由同一個 tone 查表」。這裡逐一掃過整個值域，
    // 確認沒有任何一組數值會在某個落點查不到樣式而靜默落到預設值。
    const missing: string[] = []
    for (let sys = 70; sys <= 210; sys += 1) {
      for (const dia of [45, 50, 55, 60, 70, 80, 85, 90, 100, 110, 120, 125]) {
        for (const standard of [GENERAL_ADULT_STANDARD, POST_OP_STRICT_STANDARD]) {
          const tone = alertTone(evaluateReading(sys, dia, null, standard))
          for (const [name, map] of SURFACES) {
            if (map[tone] === undefined) missing.push(`${standard.key} ${sys}/${dia} → ${tone} @ ${name}`)
          }
        }
      }
    }
    expect(missing).toEqual([])
  })

  test('每一個模板都用得到「在目標內」以外的階，沒有模板會整片同色', () => {
    const tones = new Set<AlertTone>()
    for (let sys = 70; sys <= 210; sys += 1) {
      tones.add(alertTone(evaluateReading(sys, 75, null, POST_OP_STRICT_STANDARD)))
    }
    // 只掃收縮壓軸就該出現這八階：術後嚴格控制在收縮壓上是一條完整的階梯，
    // 從 <90 的明顯偏低一路到 ≥180 的極高危險，中間沒有任何一段是「整片同色」。
    expect([...tones].sort()).toEqual(
      ['below-target', 'critical', 'danger', 'danger-low', 'off-target', 'on-target', 'warning', 'warning-low'].sort(),
    )
  })
})
