/*
檔案用途：驗證血壓按下儲存後的回饋區（issue #1093）——家屬通知狀態對應到正確文案、notifyFailed 蓋過其他狀態、
         錯誤與家屬通知失敗共用同一個 assertive live region、說明性質的狀態維持 polite；
         需要通知家人的讀數卡在離線佇列時，同一個 region 要看護直接打電話（issue #1126）。
所在層：tests/unit；以最小 hook 執行環境呼叫元件取得 React 元素樹，不啟動瀏覽器。
主要關聯：src/features/vitals/components/BpSaveNotices.tsx、BpLimitBlockedNotice、InputPage.utils 的 L 文案；
         形狀比照 tests/unit/bpLimitBlockedNotice.test.ts。
*/
import { describe, expect, mock, test } from 'bun:test'
import { findAll, textContent } from './helpers/elementTree'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'

// 元件內有捲動定位用的 useRef／useEffect；用最小 hook 執行環境呼叫，不必啟動 DOM renderer。
installReactHookHarness()

const actualI18n = await import('../../src/lib/i18n')
let locale: 'zh' | 'id' | 'en' = 'id'
mock.module('../../src/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({
    text: (item: { id: string; zh: string; en: string }) => item[locale],
    locale,
    setLocale: () => {},
  }),
}))

const { BpSaveNotices, familyNotices, noticeScrollKey } = await import('../../src/features/vitals/components/BpSaveNotices')
type FamilyDeliveryState = import('../../src/features/vitals/components/BpSaveNotices').FamilyDeliveryState
type QueuedFamilyAlert = import('../../src/features/vitals/components/BpSaveNotices').QueuedFamilyAlert
const { BpLimitBlockedNotice } = await import('../../src/features/vitals/components/BpLimitBlockedNotice')
const { L } = await import('../../src/features/vitals/pages/InputPage.utils')

const URGENT_CASES: Array<[FamilyDeliveryState, { id: string; zh: string; en: string }]> = [
  ['unconfirmed', L.familyAlertUnconfirmed],
  ['not_sent', L.familyAlertNotSent],
  ['unconfirmed_personal_queued', L.familyAlertSharedUnconfirmedPersonalQueued],
  ['not_sent_personal_queued', L.familyAlertSharedNotSentPersonalQueued],
  ['unconfirmed_personal_unknown', L.familyAlertSharedUnconfirmedPersonalUnknown],
  ['not_sent_personal_unknown', L.familyAlertSharedNotSentPersonalUnknown],
  ['personal_unknown', L.familyAlertPersonalUnknown],
  ['unconfirmed_personal_delivered', L.familyAlertSharedUnconfirmedPersonalDelivered],
  ['not_sent_personal_delivered', L.familyAlertSharedNotSentPersonalDelivered],
]

const base = {
  status: 'idle' as const,
  errMsg: '',
  limitBlockedReading: null,
  notifyFailed: false,
  familyAlertSkipped: false,
  familyDelivery: 'idle' as FamilyDeliveryState,
  queuedFamilyAlert: 'none' as QueuedFamilyAlert,
}
const render = (overrides: Partial<Parameters<typeof BpSaveNotices>[0]> = {}) => renderHook(() => BpSaveNotices({ ...base, ...overrides })).current
const alerts = (tree: unknown) => findAll(tree, element => element.props.role === 'alert')
const statuses = (tree: unknown) => findAll(tree, element => element.props.role === 'status')

describe('familyNotices (issue #1093)', () => {
  test.each(URGENT_CASES)('%s is an urgent notice with its own copy', (familyDelivery, expected) => {
    expect(familyNotices({ notifyFailed: false, familyAlertSkipped: false, familyDelivery })).toEqual({ urgent: expected, info: [] })
  })

  test('idle shows nothing; in_progress and skipped are informational only', () => {
    expect(familyNotices({ notifyFailed: false, familyAlertSkipped: false, familyDelivery: 'idle' })).toEqual({ urgent: null, info: [] })
    expect(familyNotices({ notifyFailed: false, familyAlertSkipped: false, familyDelivery: 'in_progress' })).toEqual({ urgent: null, info: [L.familyAlertInProgress] })
    expect(familyNotices({ notifyFailed: false, familyAlertSkipped: true, familyDelivery: 'idle' })).toEqual({ urgent: null, info: [L.familyAlertSkipped] })
  })

  test('notifyFailed overrides every delivery state and the skipped note, as before the move', () => {
    for (const familyDelivery of ['idle', 'in_progress', ...URGENT_CASES.map(([state]) => state)] as FamilyDeliveryState[]) {
      expect(familyNotices({ notifyFailed: true, familyAlertSkipped: true, familyDelivery })).toEqual({ urgent: L.notifyFailed, info: [] })
    }
  })

  test('every notice has copy in all three locales', () => {
    for (const entry of [L.notifyFailed, L.familyAlertSkipped, L.familyAlertInProgress, L.queuedFamilyAlertPending, L.queuedFamilyAlertUnknown, ...URGENT_CASES.map(([, copy]) => copy)]) {
      for (const key of ['id', 'zh', 'en'] as const) expect(entry[key].trim().length).toBeGreaterThan(0)
    }
  })
})

describe('BpSaveNotices (issue #1093)', () => {
  test('renders no live region when there is nothing to say', () => {
    const tree = render()
    expect(alerts(tree)).toHaveLength(0)
    expect(statuses(tree)).toHaveLength(0)
  })

  test('a generic save error is announced assertively', () => {
    locale = 'id'
    const tree = render({ status: 'err', errMsg: 'save-error-sentinel' })
    expect(alerts(tree)).toHaveLength(1)
    expect(textContent(alerts(tree)[0])).toContain('save-error-sentinel')
  })

  test('an error and a family-delivery failure share one assertive region, error first', () => {
    locale = 'id'
    const tree = render({ status: 'err', errMsg: 'save-error-sentinel', familyDelivery: 'not_sent' })
    const regions = alerts(tree)
    expect(regions).toHaveLength(1)
    const spoken = textContent(regions[0])
    expect(spoken).toContain(L.familyAlertNotSent.id)
    expect(spoken.indexOf('save-error-sentinel')).toBeLessThan(spoken.indexOf(L.familyAlertNotSent.id))
  })

  test('a limit-blocked reading renders the notice inside the region instead of the plain error', () => {
    const reading = { patientId: 'patient-1', systolic: 190, diastolic: 110, pulse: 80, measuredAt: '2026-10-05T13:30:00.000Z' }
    const tree = render({ status: 'err', errMsg: 'limit-sentinel', limitBlockedReading: reading, notifyFailed: true })
    const regions = alerts(tree)
    expect(regions).toHaveLength(1)
    const notices = findAll(regions[0], element => element.type === BpLimitBlockedNotice)
    expect(notices).toHaveLength(1)
    expect(notices[0].props).toMatchObject({ reading, limitMessage: 'limit-sentinel' })
    // 上限說明只透過 BpLimitBlockedNotice 唸一次，不能另外再掛一行同樣的紅字。
    expect(findAll(regions[0], element => element.type === 'p' && textContent(element) === 'limit-sentinel')).toHaveLength(0)
  })

  test.each(['id', 'zh', 'en'] as const)('notifyFailed shows the saved-but-not-notified copy in %s', next => {
    locale = next
    const tree = render({ notifyFailed: true, familyDelivery: 'not_sent', familyAlertSkipped: true })
    expect(alerts(tree)).toHaveLength(1)
    expect(textContent(alerts(tree)[0])).toBe(L.notifyFailed[next])
    expect(statuses(tree)).toHaveLength(0)
  })

  test.each(['id', 'zh', 'en'] as const)('an alert-level reading stuck in the offline queue asks the caregiver to call the family, assertively, in %s (issue #1126)', next => {
    locale = next
    const tree = render({ status: 'queued', queuedFamilyAlert: 'alert' })
    expect(alerts(tree)).toHaveLength(1)
    expect(textContent(alerts(tree)[0])).toBe(L.queuedFamilyAlertPending[next])
  })

  test.each(['id', 'zh', 'en'] as const)('when the personal standard cannot be loaded, the notice says it cannot tell instead of staying silent, in %s (Codex review on PR #1127)', next => {
    locale = next
    const tree = render({ status: 'queued', queuedFamilyAlert: 'unknown' })
    expect(alerts(tree)).toHaveLength(1)
    expect(textContent(alerts(tree)[0])).toBe(L.queuedFamilyAlertUnknown[next])
  })

  test.each([
    ['rejected', L.queuedFamilyAlertRejected],
    ['rejected_unknown', L.queuedFamilyAlertRejectedUnknown],
  ] as const)('a reading the server will never accept (%s) says the family will not be notified, assertively, in every locale (issue #1125)', (state, copy) => {
    for (const next of ['id', 'zh', 'en'] as const) {
      locale = next
      const tree = render({ status: 'idle', queuedFamilyAlert: state })
      expect(alerts(tree)).toHaveLength(1)
      expect(textContent(alerts(tree)[0])).toBe(copy[next])
    }
    // #1126 那句「連線恢復後會自動補送」對它是錯的。
    expect(copy.zh).not.toContain('連線恢復後會自動補送')
    expect(copy.zh).toContain('不會自動補送')
    expect(new Set([copy.id, copy.zh, copy.en]).size).toBe(3)
  })

  test('the queued-alert notice comes after a save error and before a family-delivery failure, in the same region', () => {
    // 三件事可以同時存在：這次送出出錯、佇列裡還卡著上一筆警示級讀數、更早一筆補送的送達結果剛回來。
    locale = 'id'
    const tree = render({ status: 'err', errMsg: 'save-error-sentinel', queuedFamilyAlert: 'alert', familyDelivery: 'not_sent' })
    const regions = alerts(tree)
    expect(regions).toHaveLength(1)
    const spoken = textContent(regions[0])
    expect(spoken.indexOf('save-error-sentinel')).toBeLessThan(spoken.indexOf(L.queuedFamilyAlertPending.id))
    expect(spoken.indexOf(L.queuedFamilyAlertPending.id)).toBeLessThan(spoken.indexOf(L.familyAlertNotSent.id))
  })

  test('informational states stay polite and never open an assertive region', () => {
    locale = 'id'
    const tree = render({ familyAlertSkipped: true, familyDelivery: 'in_progress' })
    expect(alerts(tree)).toHaveLength(0)
    const regions = statuses(tree)
    expect(regions).toHaveLength(1)
    expect(regions[0].props['aria-live']).toBe('polite')
    expect(textContent(regions[0])).toContain(L.familyAlertSkipped.id)
    expect(textContent(regions[0])).toContain(L.familyAlertInProgress.id)
  })
})

describe('noticeScrollKey (issue #1093)', () => {
  const key = (overrides: Partial<Parameters<typeof noticeScrollKey>[0]> = {}) => noticeScrollKey({ ...base, ...overrides })

  test('nothing on screen, or only the in-progress note, never scrolls', () => {
    expect(key()).toBe('')
    expect(key({ familyDelivery: 'in_progress' })).toBe('')
    expect(key({ status: 'ok' })).toBe('')
  })

  test('errors, family-delivery failures, notifyFailed and the skipped note scroll', () => {
    expect(key({ status: 'err', errMsg: 'e' })).not.toBe('')
    expect(key({ notifyFailed: true })).not.toBe('')
    expect(key({ familyAlertSkipped: true, familyDelivery: 'in_progress' })).not.toBe('')
    for (const [familyDelivery] of URGENT_CASES) expect(key({ familyDelivery })).not.toBe('')
    expect(key({ status: 'queued', queuedFamilyAlert: 'alert' })).not.toBe('')
    expect(key({ status: 'queued', queuedFamilyAlert: 'unknown' })).not.toBe('')
    // 從「無法判斷」變成「確定要通知」（例如標準讀到了）是新的內容，要再捲一次。
    expect(key({ queuedFamilyAlert: 'unknown' })).not.toBe(key({ queuedFamilyAlert: 'alert' }))
  })

  test('a queued save of a reading that needs no family alert does not scroll', () => {
    expect(key({ status: 'queued' })).toBe('')
  })

  test('the key changes whenever the actionable content changes, and only then', () => {
    expect(key({ familyDelivery: 'not_sent' })).not.toBe(key({ familyDelivery: 'unconfirmed' }))
    expect(key({ status: 'err', errMsg: 'a' })).not.toBe(key({ status: 'err', errMsg: 'b' }))
    expect(key({ status: 'err', errMsg: 'a' })).not.toBe(key({ status: 'err', errMsg: 'a', familyDelivery: 'not_sent' }))
    // 送出中 → 已排除；加上它不應讓已顯示的錯誤再捲一次。
    expect(key({ status: 'err', errMsg: 'a', familyDelivery: 'in_progress' })).toBe(key({ status: 'err', errMsg: 'a' }))
  })
})

describe('another care recipient\'s re-sent reading whose family notification was not confirmed (issue #1125)', () => {
  test('names that person in the same assertive region, after this reading\'s own messages', () => {
    locale = 'zh'
    const tree = render({ status: 'err', errMsg: 'save-error-sentinel', familyDelivery: 'not_sent', otherPatientNotifyNames: ['測試對象甲'] })
    const regions = alerts(tree)
    expect(regions).toHaveLength(1)
    const spoken = textContent(regions[0])
    expect(spoken).toContain(L.otherPatientNotifyProblem('測試對象甲').zh)
    expect(spoken.indexOf(L.familyAlertNotSent.zh)).toBeLessThan(spoken.indexOf('測試對象甲'))
  })

  test('opens the assertive region on its own, even with nothing else to say', () => {
    locale = 'zh'
    expect(alerts(render({ otherPatientNotifyNames: ['測試對象'] }))).toHaveLength(1)
  })

  test('has copy in all three locales that carries the name', () => {
    const copy = L.otherPatientNotifyProblem('Nama-Uji')
    for (const value of [copy.id, copy.zh, copy.en]) expect(value).toContain('Nama-Uji')
    expect(new Set([copy.id, copy.zh, copy.en]).size).toBe(3)
  })

  test('scrolls into view, and again when another person is added', () => {
    const key = (names: string[]) => noticeScrollKey({ ...base, otherPatientNotifyNames: names })
    expect(key([])).toBe('')
    expect(key(['A'])).not.toBe('')
    expect(key(['A', 'B'])).not.toBe(key(['A']))
  })
})
