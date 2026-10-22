/*
檔案用途：讓使用者查看並管理自己的 Telegram／LINE 個人化通知綁定狀態；Telegram 對所有人開放（危險等級免費，issue #1059），
LINE、其他等級與到期提醒（issue #1104）仍限付費。
所在層：src/components/settings；自給自足元件，不接 props、自己管狀態、自己呼叫 lib，比照 ReadingScaleSettings 慣例。
主要關聯：SettingsPage、src/lib/messagingLinks.ts 與 current_messaging_link_status／create_messaging_link_token／
unlink_messaging_channel RPC（issue #599）。LINE 那一列（issue #604）沿用同一組狀態與 handler，只換 channel 名稱、
env 設定 key 與訊息文案；webhook／push sender 本身不在這支檔案的範圍內。
*/
import { useCallback, useEffect, useState } from 'react'
import { useI18n, type LocalizedText } from '../../lib/i18n'
import { useSaveStatus } from '../../hooks/useSaveStatus'
import { describeReadError, describeSaveError, matchesConstraint } from '../../lib/dataErrors'
import { isDemoMode } from '../../lib/demoStorage'
import { createMessagingLinkUrl, fetchMessagingLinkStatus, normalizeLineOaBasicId, normalizeTelegramBotUsername, unlinkMessagingChannel, type MessagingChannel, type MessagingLinkStatus } from '../../lib/messagingLinks'

const TITLE: LocalizedText = { id: 'Notifikasi pribadi', zh: '個人化通知', en: 'Personal notifications' }
// issue #1104 review：說明文字對免費帳號也會顯示，所以提醒要標明是 Premium，而且只寫「到期提醒」——
// 寫成泛稱的「照護提醒」會讓人以為也有日曆提醒（目前只有共用群組所屬的家庭啟用得了日曆來源）。
const HELP: LocalizedText = {
  id: 'Hubungkan Telegram Anda untuk peringatan bahaya gratis bagi orang yang Anda rawat. Jika keluarga orang tersebut memiliki Premium, Anda juga dapat menerima semua tingkat peringatan, pengingat jatuh tempo, dan memakai LINE. Tautan berlaku 10 menit.',
  zh: '綁定你的 Telegram，就能收到你有照護權限的病人的免費危險級警報；病人所屬家庭有 Premium 時，還能收到所有等級、到期提醒並使用 LINE。連結有效期 10 分鐘。',
  en: 'Link your Telegram for free danger-level alerts about people you care for. When a patient’s household has Premium, you can also receive every alert level, due-date reminders, and use LINE. The link is valid for 10 minutes.',
}
// issue #1059（ADR-011 D3）：免費帳號也能綁 Telegram，但只會收到危險等級；要先講清楚，
// 否則家人綁好之後收不到普通讀數，會以為通知壞了。
// issue #1104：照護到期提醒有了個人送達路徑（只給付費），Premium 那一句才寫上「到期提醒」。
// 刻意**不寫**日曆提醒：日曆來源由維護者建立，而且 #1061 的閘門只允許共用群組所屬的那一個家庭啟用，
// 其他家庭付了費也收不到——寫了等於賣一個不存在的功能（issue #1059 review M1）。#1061 第二步拆掉閘門後再補上。
// 免費那一句仍然不能寫提醒。
const FREE_TIER_NOTICE: LocalizedText = {
  id: 'Gratis: peringatan tekanan darah tingkat bahaya lewat Telegram. Jika keluarga pasien memiliki Premium: semua tingkat, pengingat jatuh tempo, dan LINE.',
  zh: '免費：透過 Telegram 收到危險等級的血壓警報。病人所屬家庭已開通 Premium 時：所有等級、到期提醒，以及 LINE。',
  en: 'Free: danger-level blood pressure alerts on Telegram. When the patient’s household has Premium: every level, due-date reminders, and LINE.',
}
// 沒有任何照護對象的帳號：按鈕仍可按（Telegram 不再看付費），但 RPC 會拒絕；給一句看得懂的原因，而不是通用的儲存失敗。
const NO_CARE_ACCESS: LocalizedText = {
  id: 'Anda belum memiliki orang yang dirawat di akun ini. Minta anggota keluarga menambahkan Anda terlebih dahulu.',
  zh: '這個帳號還沒有任何照護對象，請先請家人把你加入照護名單。',
  en: 'This account does not care for anyone yet. Ask a family member to add you first.',
}
const DEMO_NOTICE: LocalizedText = {
  id: 'Notifikasi pribadi tidak tersedia dalam mode demo.',
  zh: '展示模式不提供個人化通知。',
  en: 'Personal notifications is not available in demo mode.',
}
const BOT_NOT_CONFIGURED: LocalizedText = { id: 'Bot Telegram belum dikonfigurasi.', zh: 'Telegram bot 尚未設定', en: 'Telegram bot is not configured yet.' }
const LINE_OA_NOT_CONFIGURED: LocalizedText = { id: 'Akun LINE resmi belum dikonfigurasi.', zh: 'LINE 官方帳號尚未設定', en: 'LINE official account is not configured yet.' }
// 為什麼特別提醒「加入好友」：line.me 的 oaMessage 連結不需要先加好友就能打開對話、送出 /link 並綁定成功，
// 但 LINE 對「沒加好友或已封鎖」的收件人推播時一樣回 HTTP 200、訊息卻不會送達——outbox 會記成已送出，
// 使用者卻永遠收不到血壓通知，而且系統看不出來。這裡在綁定當下就把前提講清楚，是目前唯一擋得住的地方。
const LINE_LINK_OPENED: LocalizedText = {
  id: 'Buka LINE dan kirim pesan yang sudah terisi untuk menyelesaikan koneksi, lalu pastikan akun resmi sudah ditambahkan sebagai teman — tanpa berteman, notifikasi tidak akan sampai.',
  zh: '請在開啟的 LINE 對話中送出已預填的訊息完成綁定，並確認已把官方帳號加入好友——沒有加好友將收不到通知。',
  en: 'Open LINE and send the prefilled message to finish linking, and make sure the official account is added as a friend — otherwise notifications will not arrive.',
}

// 兩個管道共用同一組 label／文案 key，只差 channel 字串與各自的「未設定」訊息；
// 集中在這裡避免 JSX 裡出現兩份幾乎一樣但容易悄悄長歪的區塊。
const CHANNEL_LABEL: Record<MessagingChannel, string> = { telegram: 'Telegram', line: 'LINE' }
const NOT_CONFIGURED_NOTICE: Record<MessagingChannel, LocalizedText> = { telegram: BOT_NOT_CONFIGURED, line: LINE_OA_NOT_CONFIGURED }

function linkedAtText(linkedAt: string, locale: 'id' | 'zh' | 'en'): string {
  const date = new Date(linkedAt)
  if (Number.isNaN(date.getTime())) return linkedAt
  return date.toLocaleString(locale === 'zh' ? 'zh-TW' : locale === 'id' ? 'id-ID' : 'en-US')
}

// 為什麼補足 44px：手機上的獨立操作要留出足夠點擊面，降低漏點與誤觸。
export function PersonalNotificationSettings() {
  const { text, locale } = useI18n()
  const demo = isDemoMode()
  const [loading, setLoading] = useState(!demo)
  const [loadError, setLoadError] = useState<LocalizedText | null>(null)
  const [statuses, setStatuses] = useState<MessagingLinkStatus[]>([])
  const save = useSaveStatus()

  const reload = useCallback(() => {
    if (demo) { setLoading(false); return }
    setLoading(true)
    setLoadError(null)
    fetchMessagingLinkStatus()
      .then(setStatuses)
      .catch(error => {
        console.error('[fetch messaging link status error]', error)
        setLoadError(describeReadError(error))
      })
      .finally(() => setLoading(false))
  }, [demo])

  useEffect(reload, [reload])

  // 為什麼要重新查一次：使用者按下連結後會離開這個分頁去 Telegram 完成 /start，
  // 回到這裡時（切回分頁或 App 恢復前景）畫面仍停在「未綁定」的舊狀態，
  // 沒有任何自然的時機點會重新呼叫 RPC；用 focus／visibilitychange 補上這個缺口。
  useEffect(() => {
    if (demo) return
    const handleRefocus = () => {
      if (document.visibilityState === 'hidden') return
      reload()
    }
    window.addEventListener('focus', handleRefocus)
    document.addEventListener('visibilitychange', handleRefocus)
    return () => {
      window.removeEventListener('focus', handleRefocus)
      document.removeEventListener('visibilitychange', handleRefocus)
    }
  }, [demo, reload])

  // 通用化成單一函式，Telegram／LINE 共用同一套「開彈窗 → 等 RPC → 導頁」流程，只有 channel 與
  // 完成後的三語提示不同；LINE 走 line.me 深連結，一樣受同一個彈窗時機限制（見下方註解）。
  const handleLink = async (channel: MessagingChannel) => {
    save.begin()
    // 為什麼在 await 之前就先開視窗：手機版 Safari／PWA 的「使用者剛點過」授權視窗很短，
    // 等 RPC 這種需要打網路的非同步操作跑完才呼叫 window.open 常常已經超出那個視窗，
    // 導致彈窗被封鎖——使用者看到「成功」訊息，卻沒有分頁能完成綁定，token 也在 10 分鐘後失效。
    // 先同步開一個空白分頁佔住彈窗許可，等 URL 準備好了再導頁；不用 noopener 才能保留參照改寫網址，
    // 改用「導頁後清空 opener」達到等同 noopener 的效果（對方頁面無法透過 window.opener 操控本頁）。
    const popup = window.open('about:blank', '_blank')
    try {
      const url = await createMessagingLinkUrl(channel)
      if (popup) {
        popup.location.href = url
        popup.opener = null
      } else {
        // 彈窗還是被封鎖（例如使用者關掉了跳出視窗權限）：退回原本的做法，至少不會整個失敗。
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      const message = channel === 'telegram'
        ? { id: 'Buka Telegram untuk menyelesaikan koneksi.', zh: '請在開啟的 Telegram 對話中按下 Start 完成綁定。', en: 'Open Telegram and tap Start to finish linking.' }
        : LINE_LINK_OPENED
      save.succeed(text(message))
    } catch (error) {
      popup?.close()
      console.error('[create messaging link error]', error)
      // 字串對應 migration 20261005145950 的 create_messaging_link_token 例外訊息。
      save.fail(text(matchesConstraint(error, 'require care access') ? NO_CARE_ACCESS : describeSaveError(error)))
    }
  }

  const handleUnlink = async (channel: MessagingChannel) => {
    save.begin()
    try {
      await unlinkMessagingChannel(channel)
      setStatuses(previous => previous.map(status => (status.channel === channel ? { ...status, linked: false, linkedAt: null } : status)))
      const message = channel === 'telegram'
        ? { id: 'Telegram telah dilepas.', zh: '已解除 Telegram 綁定。', en: 'Telegram has been unlinked.' }
        : { id: 'LINE telah dilepas.', zh: '已解除 LINE 綁定。', en: 'LINE has been unlinked.' }
      save.succeed(text(message))
    } catch (error) {
      console.error('[unlink messaging channel error]', error)
      save.fail(text(describeSaveError(error)))
    }
  }

  const getStatus = (channel: MessagingChannel) => statuses.find(status => status.channel === channel) ?? null
  const telegram = getStatus('telegram')
  const line = getStatus('line')
  // RPC 回傳此刻 LINE 是否可綁：由病人家庭 Premium／舊旗標並讀，且 kill switch 會蓋過兩者。
  // 任取一列即可；RPC 找不到資料時保守視為不可用，避免顯示假可用的 LINE 按鈕。
  const paidTier = (telegram ?? line)?.notificationTier === 'personal'
  // 管道別閘門（issue #1059、ADR-011 D3）：create_messaging_link_token 對 telegram 不再要求付費，LINE 仍要；
  // 這裡跟著後端分開判斷，不能再用單一 paidTier 同時停用兩顆按鈕——免費家庭會綁不了唯一免費的管道。
  const channelEntitled: Record<MessagingChannel, boolean> = { telegram: true, line: paidTier }
  const botConfigured = Boolean(normalizeTelegramBotUsername(import.meta.env.VITE_TELEGRAM_BOT_USERNAME))
  // 與 createMessagingLinkUrl 用同一個正規化：只填了「@」也算未設定，不顯示一顆按了必定失敗的按鈕。
  const lineOaConfigured = Boolean(normalizeLineOaBasicId(import.meta.env.VITE_LINE_OA_BASIC_ID))
  const busy = save.status === 'saving'

  const channelConfigured: Record<MessagingChannel, boolean> = { telegram: botConfigured, line: lineOaConfigured }

  return (
    <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-4" aria-labelledby="personal-notification-settings-title">
      <h2 id="personal-notification-settings-title" className="font-bold text-slate-900">{text(TITLE)}</h2>
      <p className="mt-1 text-sm text-slate-500">{text(HELP)}</p>

      {demo && <p className="mt-3 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">{text(DEMO_NOTICE)}</p>}

      {!demo && loading && <p className="mt-3 text-sm text-slate-500">{text({ id: 'Memuat…', zh: '載入中…', en: 'Loading…' })}</p>}

      {!demo && !loading && loadError && (
        <p role="alert" className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{text(loadError)}</p>
      )}

      {!demo && !loading && !loadError && (
        <>
          {!paidTier && <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800">{text(FREE_TIER_NOTICE)}</p>}

          {(['telegram', 'line'] as const).map(channel => {
            const status = getStatus(channel)
            const configured = channelConfigured[channel]
            return (
              <div key={channel} className="mt-3 flex min-h-12 items-center justify-between gap-3 rounded-xl bg-slate-50 px-3 py-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-900">{CHANNEL_LABEL[channel]}</span>
                  {status?.linked && status.linkedAt && (
                    <span className="mt-0.5 block text-xs text-slate-500">
                      {text({ id: 'Terhubung sejak', zh: '綁定於', en: 'Linked since' })} {linkedAtText(status.linkedAt, locale)}
                    </span>
                  )}
                  {!configured && <span className="mt-0.5 block text-xs text-slate-500">{text(NOT_CONFIGURED_NOTICE[channel])}</span>}
                </span>
                {status?.linked ? (
                  <button
                    type="button"
                    onClick={() => void handleUnlink(channel)}
                    disabled={busy}
                    className="shrink-0 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 disabled:opacity-50 min-h-11"
                  >
                    {text({ id: 'Lepas', zh: '解除綁定', en: 'Unlink' })}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void handleLink(channel)}
                    disabled={busy || !channelEntitled[channel] || !configured}
                    className="shrink-0 rounded-lg bg-brand-700 active:bg-emerald-800 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50 min-h-11"
                  >
                    {text({ id: 'Hubungkan', zh: '連結', en: 'Link' })}
                  </button>
                )}
              </div>
            )
          })}
        </>
      )}

      {save.status === 'ok' && <p className="mt-2 text-xs font-semibold text-emerald-700">{save.message}</p>}
      {save.status === 'err' && <p role="alert" className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-xs font-semibold text-red-700">{save.message}</p>}
    </section>
  )
}
