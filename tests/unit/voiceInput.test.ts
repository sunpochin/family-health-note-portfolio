/*
檔案用途：驗證語音草稿的錯誤退路、取消、延遲結果隔離與收音清理。
所在層：tests/unit；使用假辨識器，完全不啟動麥克風或外部服務。
主要關聯：useVoiceInput、reactHookHarness；介面整合另以 Playwright CLI 在匿名 Demo 驗證。
*/
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import type { VoiceRecognition } from '../../src/hooks/useVoiceInput'

installReactHookHarness()
const { useVoiceInput } = await import('../../src/hooks/useVoiceInput')
const originalWindow = globalThis.window
const originalDocument = globalThis.document
let instances: FakeRecognition[] = []
let throwOnStart = false
class FakeRecognition implements VoiceRecognition {
  lang = ''
  continuous = true
  interimResults = true
  onresult: VoiceRecognition['onresult'] = null
  onerror: VoiceRecognition['onerror'] = null
  onend: VoiceRecognition['onend'] = null
  aborted = 0
  stopped = 0
  constructor() { instances.push(this) }
  start() { if (throwOnStart) throw new Error('unavailable') }
  stop() { this.stopped++ }
  abort() { this.aborted++; this.onend?.() }
}
class FakeDocument extends EventTarget { hidden = false }
let fakeDocument: FakeDocument
const result = (transcript: string, isFinal = true) => ({ results: [{ isFinal, 0: { transcript } }] })

beforeEach(() => {
  instances = []
  throwOnStart = false
  fakeDocument = new FakeDocument()
  globalThis.document = fakeDocument as unknown as Document
  globalThis.window = { SpeechRecognition: FakeRecognition, isSecureContext: true } as unknown as Window & typeof globalThis
})
afterEach(() => {
  if (originalWindow) globalThis.window = originalWindow
  else delete (globalThis as { window?: Window }).window
  if (originalDocument) globalThis.document = originalDocument
  else delete (globalThis as { document?: Document }).document
})

describe('voice input text draft', () => {
  test('sets the requested language, ignores interim text, appends only final raw text and prevents duplicate results', () => {
    const view = renderHook(() => useVoiceInput('id-ID'))
    view.act(() => view.current.edit('catatan'))
    view.act(() => view.current.start())
    const recognition = instances[0]
    expect(recognition.lang).toBe('id-ID')
    expect(recognition.continuous).toBe(false)
    expect(recognition.interimResults).toBe(false)
    const callback = recognition.onresult!
    callback(result('tekanan darah 130 80', false))
    expect(view.current.draft).toBe('catatan')
    callback(result('tekanan darah 130 80'))
    callback(result('tekanan darah 130 80'))
    expect(view.current.draft).toBe('catatan tekanan darah 130 80')
    expect(view.current.status).toBe('ready')
    expect(recognition.aborted).toBe(1)
    view.unmount()
  })

  test('supports prefixed browsers and returns manual mode on unsupported or insecure contexts', () => {
    globalThis.window = { webkitSpeechRecognition: FakeRecognition } as unknown as Window & typeof globalThis
    const view = renderHook(() => useVoiceInput('zh-TW'))
    expect(view.current.supported).toBe(true)
    view.act(() => view.current.start())
    expect(instances[0].lang).toBe('zh-TW')
    view.unmount()
    for (const browser of [{}, { SpeechRecognition: FakeRecognition, isSecureContext: false }]) {
      globalThis.window = browser as unknown as Window & typeof globalThis
      const manual = renderHook(() => useVoiceInput('id-ID'))
      expect(manual.current.supported).toBe(false)
      manual.act(() => { manual.current.start(); manual.current.edit('manual') })
      expect(manual.current.draft).toBe('manual')
      manual.unmount()
    }
  })

  test.each(['not-allowed', 'service-not-allowed', 'no-speech', 'network', 'audio-capture', 'language-not-supported'])('handles %s without losing existing text or blocking manual editing', error => {
    const view = renderHook(() => useVoiceInput('id-ID'))
    view.act(() => { view.current.edit('existing'); view.current.start() })
    instances[0].onerror!({ error })
    expect(view.current.status).toBe(error.includes('not-allowed') ? 'denied' : error === 'no-speech' ? 'empty' : 'failed')
    expect(view.current.draft).toBe('existing')
    view.act(() => view.current.edit('corrected'))
    expect(view.current.draft).toBe('corrected')
    view.act(() => view.current.start())
    expect(instances).toHaveLength(2)
    view.unmount()
  })

  test('a synchronous start failure releases the session and permits retry', () => {
    throwOnStart = true
    const view = renderHook(() => useVoiceInput('id-ID'))
    view.act(() => view.current.start())
    expect(view.current.status).toBe('failed')
    expect(instances[0].aborted).toBe(1)
    throwOnStart = false
    view.act(() => view.current.start())
    expect(view.current.status).toBe('listening')
    view.unmount()
  })

  test('finish waits for final text, while cancel rejects even already queued callbacks', () => {
    const view = renderHook(() => useVoiceInput('id-ID'))
    view.act(() => view.current.start())
    const first = instances[0]
    view.act(() => view.current.stop())
    expect(first.stopped).toBe(1)
    expect(view.current.status).toBe('stopping')
    first.onresult!(result('hasil'))
    expect(view.current.draft).toBe('hasil')
    view.act(() => view.current.start())
    const late = instances[1].onresult!
    view.act(() => { view.current.cancel(); view.current.start() })
    late(result('late text'))
    expect(view.current.draft).toBe('hasil')
    expect(view.current.status).toBe('listening')
    instances[2].onend!()
    expect(view.current.status).toBe('empty')
    view.unmount()
  })

  test('manual editing takes over the draft and discards pending speech', () => {
    const view = renderHook(() => useVoiceInput('en-US'))
    view.act(() => view.current.start())
    const late = instances[0].onresult!
    view.act(() => view.current.edit('manual correction'))
    late(result('old speech'))
    expect(view.current.draft).toBe('manual correction')
    expect(instances[0].aborted).toBe(1)
    view.unmount()
  })

  test('backgrounding and unmount stop listening; a new patient instance starts empty', () => {
    const view = renderHook(() => useVoiceInput('id-ID'))
    view.act(() => { view.current.edit('patient A'); view.current.start() })
    fakeDocument.hidden = true
    fakeDocument.dispatchEvent(new Event('visibilitychange'))
    expect(view.current.status).toBe('idle')
    expect(instances[0].aborted).toBe(1)
    fakeDocument.hidden = false
    view.act(() => view.current.start())
    const late = instances[1].onresult!
    view.unmount()
    late(result('patient A late'))
    const next = renderHook(() => useVoiceInput('id-ID'))
    expect(next.current.draft).toBe('')
    expect(instances[1].aborted).toBe(1)
    next.unmount()
  })

  test('a stalled service times out and leaves manual input available', async () => {
    const realSetTimeout = globalThis.setTimeout
    // 只加速本功能的 30 秒 watchdog；不要改所有計時器，以免把測試等待也吞掉。
    const timer = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number) =>
      realSetTimeout(callback, delay === 30_000 ? 0 : delay)) as typeof setTimeout)
    const view = renderHook(() => useVoiceInput('id-ID'))
    try {
      view.act(() => view.current.start())
      await new Promise(resolve => realSetTimeout(resolve, 10))
      expect(view.current.status).toBe('failed')
      expect(instances[0].aborted).toBe(1)
      view.act(() => view.current.edit('manual'))
      expect(view.current.draft).toBe('manual')
    } finally { timer.mockRestore(); view.unmount() }
  })
})
