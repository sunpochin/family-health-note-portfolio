/*
檔案用途：鎖住血壓輸入頁「按下儲存後的回饋緊貼儲存按鈕」的版面順序（issue #1093）——錯誤／家屬通知、離線待同步、
         完成摘要與本筆等級都要排在當日明細與趨勢之前；嵌入每日照護頁與獨立頁都一樣。
所在層：tests/unit；以最小 hook 執行環境呼叫 InputPage 取得元素樹，表單 hook 換成可控的替身，不啟動瀏覽器。
主要關聯：src/features/vitals/pages/InputPage.tsx、BpSaveNotices、DailyBloodPressureRecords、ModuleTrendSection。
*/
import { describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { flattenElements, textContent } from './helpers/elementTree'

installReactHookHarness()

const actualI18n = await import('../../src/lib/i18n')
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ text: (item: { id: string }) => item.id, locale: 'id', setLocale: () => {} }),
}))

mock.module('../../src/features/vitals/hooks/useBpEvaluator', () => ({
  useBpEvaluator: () => ({ evaluateNow: () => ({ level: 'normal', pulseWarning: false }), evaluateAt: () => ({ level: 'normal', pulseWarning: false }) }),
}))

mock.module('../../src/hooks/useKeyboardViewport', () => ({ useKeyboardViewport: () => false }))

const { L } = await import('../../src/features/vitals/pages/InputPage.utils')

// 一次打開所有回饋（真實流程不會同時出現完成摘要與等級卡，但這裡要的是「每一塊相對於明細的位置」）。
const formState = {
  systolic: 190, diastolic: 110, pulse: 80,
  handleSystolicChange: () => {}, handleDiastolicChange: () => {}, handlePulseChange: () => {},
  pendingAdvanceField: null, clearAutoAdvanceTimer: () => {},
  status: 'err', errMsg: 'save-error-sentinel', limitBlockedReading: null,
  notifyFailed: false, familyAlertSkipped: false, familyDelivery: 'not_sent',
  everSubmitted: true, canSubmit: true, tone: 'danger', submit: () => {},
  session: 'pagi', showRestPrompt: false, showDoneMsg: false, summary: null,
  displayedRule: { labels: { id: 'level-label-sentinel', zh: 'x', en: 'x' }, recommendations: { id: 'action-sentinel', zh: 'x', en: 'x' } },
  submittedTone: 'danger', resetMeasurementFlow: () => {},
  pendingRecords: [{ id: 'pending-1' }], pendingViewRecords: [], pendingSyncing: false, pendingSyncError: false, pendingSyncErrorTexts: [], pendingLastAttemptAt: null,
  syncPendingRecords: async () => {}, otherPatientsPendingCount: 0, otherPatientNotifyProblems: [],
  dailyRecordsVersion: 0, optimisticRecord: null,
  latest: { record: null, loading: false, error: null, refetch: () => {} },
}
mock.module('../../src/features/vitals/hooks/useBloodPressureInputForm', () => ({ useBloodPressureInputForm: () => formState }))

const { InputPage } = await import('../../src/features/vitals/pages/InputPage')
const { BpSaveNotices } = await import('../../src/features/vitals/components/BpSaveNotices')
const { PendingSyncStatus } = await import('../../src/components/ui/PendingSyncStatus')
const { DailyBloodPressureRecords } = await import('../../src/features/vitals/components/DailyBloodPressureRecords')
const { ModuleTrendSection } = await import('../../src/components/daily-care/ModuleTrendSection')

const renderPage = (embedded: boolean) => renderHook(() => InputPage({
  subject: 'patient-1', patientId: 'patient-1', availablePatients: [], onSubjectSelect: () => {}, embedded,
})).current

/** 回傳元素在深度優先（等同畫面由上而下）順序中的位置。 */
function positionOf(nodes: ReturnType<typeof flattenElements>, predicate: (node: ReturnType<typeof flattenElements>[number]) => boolean) {
  const index = nodes.findIndex(predicate)
  if (index < 0) throw new Error('element not found')
  return index
}

describe('InputPage save feedback placement (issue #1093)', () => {
  test.each([['embedded', true], ['standalone', false]] as const)('%s: all save feedback sits between the Save button and the daily records', (_mode, embedded) => {
    const nodes = flattenElements(renderPage(embedded))
    const save = positionOf(nodes, node => node.type === 'button' && textContent(node) === L.save.id)
    const notices = positionOf(nodes, node => node.type === BpSaveNotices)
    // 待同步狀態列是共用元件（issue #822），元素樹只展開到元件本身；收到的筆數就是 hook 的待送清單。
    const pending = positionOf(nodes, node => node.type === PendingSyncStatus && node.props.count === 1)
    // 用最內層的標題 span 定位，外層 div 的文字也包含它，會誤抓到整頁根節點。
    const level = positionOf(nodes, node => node.type === 'span' && textContent(node) === 'level-label-sentinel')
    const records = positionOf(nodes, node => node.type === DailyBloodPressureRecords)
    const trend = positionOf(nodes, node => node.type === ModuleTrendSection)

    expect(save).toBeLessThan(notices)
    expect(notices).toBeLessThan(pending)
    expect(pending).toBeLessThan(level)
    expect(level).toBeLessThan(records)
    expect(records).toBeLessThan(trend)
    // 回饋區收到的就是 hook 的狀態，沒有在頁面層被過濾掉。
    expect(nodes[notices].props).toMatchObject({ status: 'err', errMsg: 'save-error-sentinel', familyDelivery: 'not_sent', notifyFailed: false })
  })

  test('the done summary also renders before the daily records', () => {
    formState.showDoneMsg = true
    try {
      const nodes = flattenElements(renderPage(true))
      const done = positionOf(nodes, node => node.type === 'div' && textContent(node) === L.done.id(L.pagi.id))
      const records = positionOf(nodes, node => node.type === DailyBloodPressureRecords)
      expect(done).toBeLessThan(records)
    } finally {
      formState.showDoneMsg = false
    }
  })
})
