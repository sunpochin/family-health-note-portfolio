/*
檔案用途：把瀏覽器語音辨識轉成可編輯文字草稿，不解析健康數值、不儲存資料。
所在層：src/hooks；只管理單次收音生命週期與手動輸入退路。
主要關聯：VoiceInputDraft、SpeechRecognition／webkitSpeechRecognition、voiceInput 測試。
*/
import { useEffect, useRef, useState } from 'react'

// ponytail: 僅描述 MVP 用到的原生 API，不加入語音 SDK 或全域 Window 宣告。
export interface VoiceRecognition {
  lang: string
  continuous: boolean
  interimResults: boolean
  onresult: ((event: { results: ArrayLike<{ isFinal: boolean; [index: number]: { transcript: string } }> }) => void) | null
  onerror: ((event: { error: string }) => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
  abort: () => void
}

type VoiceWindow = Window & {
  SpeechRecognition?: new () => VoiceRecognition
  webkitSpeechRecognition?: new () => VoiceRecognition
}
export type VoiceStatus = 'idle' | 'listening' | 'stopping' | 'ready' | 'denied' | 'failed' | 'empty'

function recognitionConstructor() {
  if (typeof window === 'undefined' || window.isSecureContext === false) return undefined
  const browser = window as VoiceWindow
  return browser.SpeechRecognition ?? browser.webkitSpeechRecognition
}

export function useVoiceInput(language: string) {
  const [draft, setDraft] = useState('')
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const recognitionRef = useRef<VoiceRecognition | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const supported = Boolean(recognitionConstructor())

  const release = () => {
    const recognition = recognitionRef.current
    // 先失效再 abort：取消時瀏覽器仍可能送來已排程的 result／end，不能污染新草稿。
    recognitionRef.current = null
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      try { recognition.abort() } catch { /* 已結束的辨識不影響手動輸入。 */ }
    }
  }
  const cancel = () => { release(); setStatus('idle') }

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden) { release(); setStatus('idle') }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    // 卸載（換病人／離開面板／儲存）先取消收音，草稿只存在這個元件的記憶體。
    return () => { document.removeEventListener('visibilitychange', onVisibilityChange); release() }
  }, [])

  const start = () => {
    const Constructor = recognitionConstructor()
    if (!Constructor || recognitionRef.current || document.hidden) return
    try {
      const recognition = new Constructor()
      recognitionRef.current = recognition
      recognition.lang = language
      recognition.continuous = false
      recognition.interimResults = false
      const current = () => recognitionRef.current === recognition
      const finish = (next: VoiceStatus) => {
        if (!current()) return
        release()
        setStatus(next)
      }
      recognition.onresult = event => {
        if (!current()) return
        const transcript = Array.from(event.results)
          .filter(result => result.isFinal)
          .map(result => result[0]?.transcript ?? '').join(' ').trim()
        if (!transcript) return
        // 僅追加原文：不能把「130 80」猜成血壓，也不能覆寫照護者已確認的文字。
        setDraft(previous => [previous.trim(), transcript].filter(Boolean).join(' '))
        finish('ready')
      }
      recognition.onerror = event => finish(
        event.error === 'not-allowed' || event.error === 'service-not-allowed' ? 'denied'
          : event.error === 'no-speech' ? 'empty' : 'failed',
      )
      recognition.onend = () => finish('empty')
      // 權限提示或辨識服務卡住也不能無限收音；超時後仍可編輯既有草稿或直接填數值。
      timerRef.current = setTimeout(() => finish('failed'), 30_000)
      setStatus('listening')
      recognition.start()
    } catch {
      release()
      setStatus('failed')
    }
  }

  const stop = () => {
    if (!recognitionRef.current) return
    setStatus('stopping')
    try { recognitionRef.current.stop() } catch { release(); setStatus('failed') }
  }
  const edit = (value: string) => {
    // 手動編輯代表接手草稿；捨棄未完成口述，避免晚到結果蓋過剛打好的內容。
    cancel()
    setDraft(value)
  }

  return { draft, status, supported, start, stop, cancel, edit }
}
