/*
檔案用途：血壓頁的選用語音文字草稿；使用者核對後手動填入量測欄位。
所在層：src/features/vitals/components；獨立視覺區塊，不接觸儲存或判讀。
主要關聯：InputPage 以 patient_id／語系隔離本元件，useVoiceInput 管理收音。
*/
import { useId, useState } from 'react'
import { useVoiceInput, type VoiceStatus } from '../../../hooks/useVoiceInput'
import { useI18n, type LocalizedText } from '../../../lib/i18n'

const M = {
  title: { zh: '語音輸入（文字草稿）', id: 'Input suara (draf teks)', en: 'Voice input (text draft)' },
  language: { zh: '口述語言', id: 'Bahasa ucapan', en: 'Spoken language' },
  indonesian: { zh: '印尼文', id: 'Bahasa Indonesia', en: 'Indonesian' },
  chinese: { zh: '中文', id: 'Bahasa Mandarin', en: 'Chinese' },
  english: { zh: '英文', id: 'Bahasa Inggris', en: 'English' },
  disclosure: { zh: '開始即同意由瀏覽器處理音訊，可能傳送至其辨識服務。請勿口述姓名等個人資料。', id: 'Dengan memulai, Anda menyetujui pemrosesan audio oleh peramban, yang mungkin mengirimkannya ke layanan pengenalan suara. Jangan ucapkan nama atau data pribadi.', en: 'Starting allows your browser to process audio, which may be sent to its speech service. Do not speak names or personal details.' },
  instruction: { zh: '請核對文字，再手動填入收縮壓、舒張壓和心跳欄位。草稿不會儲存。', id: 'Periksa teks, lalu isi kolom sistolik, diastolik, dan denyut nadi secara manual. Draf tidak disimpan.', en: 'Check the text, then manually fill in systolic pressure, diastolic pressure and pulse. The draft is not saved.' },
  start: { zh: '同意並開始口述', id: 'Setuju dan mulai berbicara', en: 'Agree and start speaking' },
  stop: { zh: '結束口述', id: 'Selesai berbicara', en: 'Finish speaking' },
  cancel: { zh: '取消口述', id: 'Batalkan ucapan', en: 'Cancel dictation' },
  clear: { zh: '清除草稿', id: 'Hapus draf', en: 'Clear draft' },
  draft: { zh: '口述文字（請確認）', id: 'Teks ucapan (periksa dahulu)', en: 'Dictated text (please check)' },
  unsupported: { zh: '此裝置不支援語音輸入，請直接手動填寫量測欄位。', id: 'Perangkat ini tidak mendukung input suara. Isi kolom pengukuran secara manual.', en: 'This device does not support voice input. Fill in the measurement fields manually.' },
} satisfies Record<string, LocalizedText>

const STATUS: Record<VoiceStatus, LocalizedText> = {
  idle: { zh: '可隨時改用手動輸入。', id: 'Anda dapat mengetik secara manual kapan saja.', en: 'You can type manually at any time.' },
  listening: { zh: '正在聆聽，請說出量測內容…', id: 'Sedang mendengarkan. Ucapkan hasil pengukuran…', en: 'Listening. Speak your measurement…' },
  stopping: { zh: '正在完成辨識，可取消並改用手動輸入。', id: 'Sedang menyelesaikan pengenalan suara. Anda dapat membatalkan dan mengetik manual.', en: 'Finishing recognition. You can cancel and type manually.' },
  ready: { zh: '文字已放入草稿，請先核對。', id: 'Teks telah masuk ke draf. Periksa dahulu.', en: 'Text added to the draft. Please check it first.' },
  denied: { zh: '未取得麥克風或辨識服務許可，請手動輸入。', id: 'Izin mikrofon atau layanan suara tidak diberikan. Ketik secara manual.', en: 'Microphone or speech service permission was not granted. Please type manually.' },
  failed: { zh: '語音辨識未完成，請重試或手動輸入。原有草稿仍保留。', id: 'Pengenalan suara belum selesai. Coba lagi atau ketik manual. Draf sebelumnya tetap ada.', en: 'Voice recognition did not finish. Retry or type manually. Your existing draft is kept.' },
  empty: { zh: '未辨識到文字，請重試或手動輸入。', id: 'Tidak ada teks yang dikenali. Coba lagi atau ketik manual.', en: 'No text was recognized. Retry or type manually.' },
}

export function VoiceInputDraft() {
  const { locale, text } = useI18n()
  const [language, setLanguage] = useState(locale === 'id' ? 'id-ID' : locale === 'zh' ? 'zh-TW' : 'en-US')
  const voice = useVoiceInput(language)
  const id = useId()
  const busy = voice.status === 'listening' || voice.status === 'stopping'
  const controlClass = 'min-h-11 rounded-xl border-2 border-control-border bg-white px-3 py-2 text-base font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:opacity-60'

  return (
    <details className="rounded-2xl border border-slate-200 bg-white p-3" onToggle={event => {
      // 收起區塊後不能繼續在看不到的地方收音；保留同一人的已完成草稿。
      if (!event.currentTarget.open) voice.cancel()
    }}>
      <summary className="min-h-11 cursor-pointer py-2 text-base font-semibold text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700">{text(M.title)}</summary>
      <div className="mt-2 space-y-3">
        <p id={`${id}-instructions`} className="text-sm text-slate-600">{text(M.instruction)}</p>
        {voice.supported ? <>
          <label className="block text-base font-medium text-slate-800">
            {text(M.language)}
            {/* 欄位需 2px 高對比邊框，讓手機上也能辨認可輸入範圍；明列 token 供既有靜態守門檢查。 */}
            <select value={language} onChange={event => { voice.cancel(); setLanguage(event.target.value) }} className={`${controlClass} mt-1 w-full border-2 border-control-border`}>
              <option value="id-ID">{text(M.indonesian)}</option>
              <option value="zh-TW">{text(M.chinese)}</option>
              <option value="en-US">{text(M.english)}</option>
            </select>
          </label>
          <p id={`${id}-disclosure`} className="text-sm text-slate-600">{text(M.disclosure)}</p>
          <div className="flex flex-wrap gap-2">
            {!busy ? <button type="button" className={controlClass} aria-describedby={`${id}-disclosure`} onClick={voice.start}>{text(M.start)}</button>
              : <>
                <button type="button" className={controlClass} disabled={voice.status === 'stopping'} onClick={voice.stop}>{text(M.stop)}</button>
                <button type="button" className={controlClass} onClick={voice.cancel}>{text(M.cancel)}</button>
              </>}
            <button type="button" className={controlClass} disabled={!voice.draft && !busy} onClick={() => voice.edit('')}>{text(M.clear)}</button>
          </div>
        </> : <p className="text-sm text-slate-600">{text(M.unsupported)}</p>}
        <p role="status" aria-live="polite" className="text-sm text-slate-700">{text(STATUS[voice.status])}</p>
        <label htmlFor={`${id}-draft`} className="block text-base font-medium text-slate-800">{text(M.draft)}</label>
        <textarea id={`${id}-draft`} value={voice.draft} onChange={event => voice.edit(event.target.value)} rows={3} aria-describedby={`${id}-instructions`}
          className="min-h-24 w-full rounded-xl border-2 border-control-border bg-white p-3 text-base text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700" />
      </div>
    </details>
  )
}
