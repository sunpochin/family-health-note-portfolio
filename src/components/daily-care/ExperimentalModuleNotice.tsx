/*
檔案用途：在「實驗功能」模組（目前只有紀錄、尚無跨日趨勢與門診報表）的頁面上方顯示一條預期管理提示。
所在層：src/components/daily-care 畫面層；純呈現，是否顯示由 dailyCareModules 的 experimental 旗標決定。
主要關聯：DailyCarePage（掛在失智照護與術後體液平衡面板上方）、lib/dailyCareModules（旗標來源），來自 issue #656。
*/
import { useI18n } from '../../lib/i18n'

export function ExperimentalModuleNotice() {
  const { text } = useI18n()
  // 文案刻意直說「目前只有紀錄」：照護者記了好幾週才發現沒有任何分析，比一開始就知道更傷信任。
  return (
    <p role="note" className="mx-5 mt-4 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-800">
      {text({
        id: 'Fitur eksperimental: saat ini hanya untuk mencatat. Analisis tren beberapa hari dan laporan untuk kontrol dokter sedang dikembangkan.',
        zh: '實驗功能：目前僅提供紀錄，多日趨勢分析與門診報表開發中。',
        en: 'Experimental: records only for now. Multi-day trend analysis and clinic reports are in development.',
      })}
    </p>
  )
}

// 設定卡的小徽章：在照護者決定要不要開啟的當下就讓他知道這是實驗功能，而不是開了才發現。
export function ExperimentalBadge() {
  const { text } = useI18n()
  return (
    <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 align-middle text-xs font-bold text-amber-800">
      {text({ id: 'Eksperimental', zh: '實驗', en: 'Experimental' })}
    </span>
  )
}
