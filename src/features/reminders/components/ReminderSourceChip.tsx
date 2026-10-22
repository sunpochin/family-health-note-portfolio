/*
檔案用途：提醒清單項目上的「連結：來源」小標籤，讓看護一眼看出這筆提醒是為哪次看診或哪個檢驗值設的。
所在層：src/features/reminders/components；純呈現元件，標籤文字由呼叫端用 linkedSourceLabel 組好傳入。
主要關聯：CareDueRemindersPage（AttentionItem 的 meta 欄）、src/lib/reminderSources.ts。
*/
import { useI18n } from '../../../lib/i18n'

export function ReminderSourceChip({ label }: { label: string }) {
  const { text } = useI18n()
  // 刻意用中性 slate 白底細框、不用 brand 綠：標籤會出現在逾期（紅）／將到期（黃）的提醒卡裡，綠色會被讀成「已完成」。
  return (
    <p className="mt-2 inline-block max-w-full rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-bold text-slate-700">
      {text({ id: 'Tertaut', zh: '連結', en: 'Linked' })}: {label}
    </p>
  )
}
