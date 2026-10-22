/*
檔案用途：登入後外殼用來接收 Siri／捷徑 App 語音喚起（記錄血壓、記錄服藥）的元件：只有一位照護對象時直接開對應區塊，
兩位以上時不猜對象、改停在可選擇對象的畫面並顯示一行說明（issue #868）。
所在層：src/components/system；只在外殼已就緒（登入、同意、對象解析完成）時才會被掛載，所以訂閱端出現的時間點就是「可以導航了」。
主要關聯：src/lib/nativeShortcuts.ts（解析、暫存、決策）、App.tsx（提供切換分頁與開啟區塊的 callback）、nativeAuth.ts（appUrlOpen 入口）。

隱私邊界：這個元件完全不讀、不顯示任何病人姓名或數值；提示文字是固定文案。
*/
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../ui/Icon'
import { useI18n } from '../../lib/i18n'
import { resolveNativeShortcutAction, subscribeNativeShortcut, type NativeShortcutTarget } from '../../lib/nativeShortcuts'
import type { Tab } from './BottomNav'

interface NativeShortcutNavigatorProps {
  /**
   * 這位病人的每日照護顯示偏好是否已讀完。沒讀完就不訂閱：請求會留在 nativeShortcuts 的暫存（2 分鐘內有效），
   * 等就緒再交付。否則冷啟動時會拿預設值（全部可見）判斷模組可不可見，先開到病人其實已關掉的模組，
   * 偏好讀完後照護頁又靜默把畫面切走，違反「模組被關閉時要明確帶去顯示設定」的 issue #752 規則。
   */
  ready: boolean
  /** 目前所在分頁：已在照護頁時不離開（會丟掉沒有草稿保存的輸入），提示也只跟著發起的那一頁。 */
  tab: Tab
  /** 外殼可操作的照護對象是否多於一位；多位時語音喚起不替使用者決定是誰。 */
  hasMultipleSubjects: boolean
  /** 目前對象：使用者在提示出現後選了人，提示就不再適用，要收起來。 */
  activePatientId: string
  /** 開啟照護頁的對應區塊（模組被關閉時由 App 帶去顯示設定，不靜默退到別的區塊）。 */
  onOpenModule: (moduleId: NativeShortcutTarget) => void
  /** 切到有對象選擇器的今天頁。 */
  onChooseSubject: () => void
}

export function NativeShortcutNavigator({ ready, tab, hasMultipleSubjects, activePatientId, onOpenModule, onChooseSubject }: NativeShortcutNavigatorProps) {
  // 提示綁在「發起當時顯示的那一頁」：使用者離開那一頁（例如點了今天頁的「量血壓」），
  // 「請先選擇對象」就不該再釘在別的畫面上方。
  const [noticeTab, setNoticeTab] = useState<Tab | null>(null)
  // 訂閱只在就緒時建立一次；callback、分頁與對象數量每次 render 都可能是新的，用 ref 讀最新值，
  // 否則要嘛重複訂閱（暫存請求會被第一個訂閱吃掉），要嘛讀到過期的分頁或對象數量。
  const latest = useRef({ tab, hasMultipleSubjects, onOpenModule, onChooseSubject })
  latest.current = { tab, hasMultipleSubjects, onOpenModule, onChooseSubject }

  useEffect(() => {
    if (!ready) return
    return subscribeNativeShortcut(target => {
      const current = latest.current
      const action = resolveNativeShortcutAction(target, { hasMultipleSubjects: current.hasMultipleSubjects, onCareTab: current.tab === 'dailyCare' })
      if (action.kind === 'chooseSubject') {
        // 切到今天頁時提示跟著今天頁；留在照護頁時跟著照護頁。
        setNoticeTab(action.goToToday ? 'today' : current.tab)
        if (action.goToToday) current.onChooseSubject()
        return
      }
      setNoticeTab(null)
      current.onOpenModule(action.moduleId)
    })
  }, [ready])

  // 只在「分頁真的換了」時檢查：用函式型更新，發起當下 setNoticeTab 與父層切分頁排在同一批次，
  // 即使沒有批次也不會在中間那一次 render 被誤清（此 effect 只在 tab 變動時執行）。
  useEffect(() => {
    setNoticeTab(current => (current !== null && current !== tab ? null : current))
  }, [tab])

  // 只在「對象真的換了」時收起提示；掛載當下不能重設，否則訂閱剛交付的暫存請求（冷啟動）所設的提示會被立刻清掉。
  const previousPatientId = useRef(activePatientId)
  useEffect(() => {
    if (previousPatientId.current === activePatientId) return
    previousPatientId.current = activePatientId
    setNoticeTab(null)
  }, [activePatientId])

  if (noticeTab === null || noticeTab !== tab) return null
  return <NativeShortcutSubjectNotice onDismiss={() => setNoticeTab(null)} />
}

export function NativeShortcutSubjectNotice({ onDismiss }: { onDismiss: () => void }) {
  const { text } = useI18n()
  return (
    <div role="status" className="print-hidden flex shrink-0 items-start gap-2 border-b border-sky-200 bg-sky-50 px-4 py-2.5 text-sm font-semibold text-sky-900">
      {/* 原本是 👆 emoji；介面不用 emoji 當圖示（issue #1150，noEmojiIcons.test.ts 守住），改用共用 SVG。
          選 users：這則提示的重點是「照護對象不只一位」。Icon 本身已 aria-hidden，意義由旁邊的文字表達。 */}
      <Icon name="users" className="h-5 w-5 shrink-0" />
      <p className="min-w-0 flex-1 leading-5">
        {text({
          id: 'Ada lebih dari satu orang yang dirawat. Pilih dulu siapa yang akan dicatat.',
          zh: '照護對象不只一位，請先選擇要記錄的對象。',
          en: 'There is more than one care recipient. Choose who to record for first.',
        })}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        className="min-h-11 shrink-0 rounded-lg px-2 font-bold text-sky-900 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-700"
      >
        {text({ id: 'Tutup', zh: '關閉', en: 'Close' })}
      </button>
    </div>
  )
}
