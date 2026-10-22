/*
檔案用途：在隱私政策版本更新後取得使用者明確確認，避免登入 session 恢復時靜默改寫法律稽核時間。
所在層：src/features/care-family/components 同意流程畫面層；由 App.tsx 在健康資料畫面前呈現。
主要關聯：使用 lib/legalConsent.ts 寫入帳號層政策接受，並連結公開 PrivacyPage 與 TermsPage。
2026-09-25（issue #424）：更新摘要改為說明本次新增的 Telegram／LINE／Resend 揭露與唯讀分享連結——這個畫面是既有使用者在升版後
唯一會看到的變更摘要，若仍停留在上一版的「匿名分析、不送健康數值」，會讓使用者在誤導的摘要下確認新政策。
唯讀分享連結另升為 2026-09-25.2（PR #922）；只接受過 2026-09-25 的使用者會再看到本畫面一次，
摘要與勾選文字必須同時提到兩者：從更舊版本直接升上來的人兩項都沒看過，缺一項就等於那一項沒有告知。
2026-10-06（issue #1104）：再補一句提醒的個人私訊（付費並綁定的家人會收到到期與日曆提醒，含照護對象姓名與時間）；
前面兩項照留，理由同上——從 2026-09-25.2 以前直接升上來的人也沒看過。
2026-10-06（issue #1124）：勾選時一併記錄服務條款版本（CURRENT_TERMS_VERSION）。條款升版不另外跳畫面（owner 決策），
所以這裡是使用者唯一會被告知「條款改了什麼」的地方：另起一段寫第 5 節服務費用的變動，勾選文字也點名，
否則勾選框說「已閱讀目前適用的服務條款」，卻沒有人告訴使用者條款變了。內容取自 TermsPage 第 5 節（只加連接詞），不另寫承諾。
2026-08-27 的舊條款寫「完全免費、無付費功能」，所以 10-06 版的三項變動（基礎免費、每日使用上限、進階付費）都要寫；
漏寫每日上限，使用者在「永遠免費」的告知下勾選，之後撞到上限，這份告知就撐不起「已明示」（bp-reviewer 在本 PR 抓到）。
這一段只在 showTermsUpdate（紀錄裡的 terms_version ≠ CURRENT_TERMS_VERSION，含新帳號與讀取失敗）時顯示：
已在目前條款版本的人，下次「只升隱私政策」時不會看到不實的「條款已更新」；還停在舊條款的人一定先看到變動才被記成新版。
原本寫成「每次都顯示、只升隱私時手動拿掉」，兩種做法都會對某一群人說錯（暫代審查 P2），所以改成依紀錄判斷。
條款再升版時：把這一段換成「從使用者可能停留的最舊版本到新版」的累積摘要，不是只寫最後一次的差異。
2026-10-07（issue #1183，付費方案 L1）：隱私政策再升版——隱私摘要補一句付款處理（付款頁由藍新託管、卡號由它蒐集、我們只存訂單資料、
付款人會收到續約提醒信）；條款摘要改成 2026-08-26 以來的累積版（10-06 的第 5 節三項＋10-07 的家庭級 AI 次數、第 6 節付費方案、
第 7 節退款政策與七日解除權例外）。這次隱私升版是 monetization-plan §6.3 選項 c 的「所有人被明示一次」，所以內容不能只寫隱私。
2026-10-09（issue #1061 階段 D）：隱私摘要補一句共用家庭群組退場、通知只送綁定的家人；條款不變。
*/
import { useState } from 'react'
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { recordAccountLegalAcceptance } from '../../../lib/legalConsent'
import { signOut } from '../../../lib/auth'

// showPrivacyUpdate（Codex on #1211）：TERMS_REQUIRES_RECONSENT 打開時，隱私已是最新、只有條款落後的人也會進到這個畫面；
// 這時不能再說「隱私權政策已更新」，標題改成服務條款更新、隱私摘要不顯示。預設 true 保持原本行為。
// 為什麼補足 44px：手機上的獨立操作要留出足夠點擊面，降低漏點與誤觸。
export function PrivacyPolicyUpdateScreen({ onAccepted, showTermsUpdate, showPrivacyUpdate = true }: { onAccepted: () => Promise<void>; showTermsUpdate: boolean; showPrivacyUpdate?: boolean }) {
  const { text } = useI18n()
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<LocalizedText | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!checked) return
    setSaving(true)
    setError(null)
    try {
      // 為什麼先寫入再放行：privacy_acknowledged_at 必須對應使用者按下確認的動作，不能由讀取狀態順便產生。
      await recordAccountLegalAcceptance()
      await onAccepted()
    } catch (cause) {
      console.error('[privacy policy acknowledgement error]', cause)
      // 通用措辭（Codex on #1211 第 2 輪）：條款單獨重新同意時標題是「服務條款更新」，錯誤訊息不能再只說隱私權政策。
      setError({
        id: 'Persetujuan Anda belum dapat disimpan. Silakan coba lagi.',
        zh: '您的確認暫時無法保存，請再試一次。',
        en: 'Your acknowledgement could not be saved. Please try again.',
      })
    } finally {
      setSaving(false)
    }
  }

  return <main className="mx-auto flex min-h-dvh max-w-md flex-col bg-slate-50 px-5 py-10 text-slate-900">
    <div className="flex justify-end"><button onClick={() => void signOut()} className="text-sm text-slate-600 underline min-h-11">{text({ id: 'Keluar', zh: '登出', en: 'Sign out' })}</button></div>
    <section className="mt-5 rounded-3xl bg-white p-6 shadow-sm">
      <p className="text-sm font-bold text-brand-700">{text(showPrivacyUpdate
        ? { id: 'Pembaruan kebijakan privasi', zh: '隱私權政策更新', en: 'Privacy Policy Update' }
        : { id: 'Pembaruan Syarat Layanan', zh: '服務條款更新', en: 'Terms of Service Update' })}</p>
      <h1 className="mt-2 text-2xl font-black">{text({ id: 'Sebelum melanjutkan', zh: '繼續使用前', en: 'Before you continue' })}</h1>
      {showPrivacyUpdate && <p className="mt-3 text-sm leading-6 text-slate-700">{text({
        id: 'Kebijakan Privasi telah diperbarui untuk mencantumkan layanan notifikasi dan email di luar Taiwan: Telegram dan LINE dapat menerima nama penerima perawatan dan nilai tekanan darah melalui notifikasi, dan Resend mengirim email undangan keluarga. Anggota keluarga yang berlangganan dan menghubungkan notifikasi pribadi juga menerima pengingat jatuh tempo dan pengingat Google Kalender di Telegram atau LINE miliknya, termasuk nama penerima perawatan dan tanggal jatuh tempo atau jam mulai acara. Kebijakan ini juga menjelaskan tautan berbagi baca-saja: anggota keluarga yang diberi izin dapat membuat tautan berbatas waktu (bawaan 24 jam, paling lama 7 hari) agar orang di luar aplikasi, termasuk yang berada di luar Taiwan, dapat melihat ringkasan tekanan darah atau perawatan; siapa pun yang memegang tautan dapat melihatnya, dan fitur ini belum ditinjau oleh pengacara atau petugas perlindungan data pribadi. Kebijakan ini kini juga menjelaskan pemrosesan pembayaran paket Premium: halaman pembayaran dikelola oleh NewebPay (Taiwan), yang mengumpulkan data kartu secara langsung; kami hanya menyimpan data pesanan seperti nomor pesanan, jumlah, dan hasil pembayaran, tidak pernah menyimpan nomor kartu, dan catatan pembayaran tetap disimpan sesuai hukum setelah akun dihapus; pembayar biasanya juga menerima email pengingat sebelum perpanjangan melalui Resend. Sejak 9 Oktober 2026 tidak ada lagi grup Telegram keluarga bersama: semua notifikasi hanya dikirim ke anggota keluarga yang menautkan Telegram atau LINE pribadinya. Baca Kebijakan Privasi untuk rincian data yang dikirim dan cara memilih.',
        zh: '《隱私權政策》已更新，補充列出台灣以外的通知與寄信服務：Telegram 與 LINE 會透過通知收到照護對象姓名與血壓數值，Resend 負責寄送家庭邀請信。付費並綁定個人通知的家人，也會在自己的 Telegram 或 LINE 收到到期提醒與 Google 日曆提醒，內容含照護對象姓名與到期日或行程開始時間。另外也說明「唯讀分享連結」：被授權的家屬可以建立有期限的連結（預設 24 小時、最長 7 天），讓 App 以外的人（可能在台灣以外）查看血壓或照護摘要；任何拿到連結的人都能查看，本功能也未經律師或個資專責人員審閱。這次另新增 Premium 方案的付款處理：付款頁由藍新科技（台灣）託管、卡片資料由它直接蒐集；我們只保存訂單編號、金額、付款結果等訂單資料，從不保存卡號，刪除帳號後付款紀錄仍依法保存；付款人通常另會經 Resend 收到續約前的提醒信。自 2026 年 10 月 9 日起不再有共用的家庭 Telegram 群組：所有通知只送到自己綁定個人 Telegram 或 LINE 的家人。送出哪些資料、如何選用，請閱讀《隱私權政策》。',
        en: 'The Privacy Policy has been updated to list notification and email services outside Taiwan: Telegram and LINE can receive the care recipient’s name and blood-pressure values through notifications, and Resend sends family invitation emails. Family members who have a subscription and have linked personal notifications also receive due reminders and Google Calendar reminders in their own Telegram or LINE, including the care recipient’s name and the due date or event start time. It also explains read-only share links: authorized family members can create time-limited links (24 hours by default, 7 days at most) that let people outside the app, including people outside Taiwan, view a blood-pressure or care summary; anyone holding a link can view it, and this feature has not been reviewed by a lawyer or a data-protection specialist. It now also covers payment processing for the Premium plan: the payment page is hosted by NewebPay (Taiwan), which collects card details directly; we keep only order data such as the order number, amount, and payment result, never card numbers, and payment records are still kept as required by law after an account is deleted; payers also usually receive a reminder email before renewal through Resend. Since October 9, 2026 there is no shared family Telegram group: every notification goes only to family members who linked their own Telegram or LINE. Read the Privacy Policy for what is sent and how to opt in.',
      })}</p>}
      {/* 條款與隱私分兩段：摘要是「這次改了什麼」，兩份文件的變動混在同一段，使用者分不出哪一句屬於哪一份。
          只對紀錄還不是目前條款版本的人顯示（見檔頭）。 */}
      {showTermsUpdate && <p className="mt-3 text-sm leading-6 text-slate-700">{text({
        id: 'Syarat Layanan juga diperbarui. Bagian 5 (Biaya Layanan): fitur dasar tetap gratis selamanya, tetapi untuk mencegah penyalahgunaan, sebagian fitur (misalnya jumlah catatan per hari dan jumlah pemindaian kemasan obat) memiliki batas pemakaian harian, dan jatah harian pemindaian resep AI kini dihitung per keluarga; fitur lanjutan berbayar, misalnya pemindaian resep AI yang melebihi jatah gratis harian. Bagian 6 yang baru menjelaskan paket keluarga Premium: ditagih bulanan dalam TWD dan diperpanjang otomatis sampai dibatalkan, dapat dibatalkan kapan saja, masa tenggang 7 hari jika penagihan gagal, perubahan harga secara bawaan hanya berlaku untuk pembelian baru (harga langganan yang berjalan hanya berubah jika pembayar menyetujuinya kembali), dan setelah paket berakhir catatan kesehatan serta peringatan tingkat bahaya tidak terpengaruh. Bagian 4 kini mencatat bahwa catatan pembayaran yang wajib disimpan menurut hukum tetap disimpan setelah akun dihapus. Bagian 7 yang baru adalah Kebijakan Pengembalian Dana: saat membeli, Anda diminta menyetujui secara terpisah bahwa hak pembatalan tujuh hari tidak berlaku setelah layanan aktif.',
        zh: '《服務條款》也已更新。第 5 節（服務費用）：基礎功能永遠免費，但為防止濫用，部分功能（例如每日可記錄的筆數、藥袋辨識次數）設有每日使用上限，AI 藥單辨識的每日次數改以「每個家庭」合計；進階功能需付費，例如 AI 藥單辨識超過每日免費次數的部分。新增第 6 節 Premium 家庭方案：以新台幣按月收費、取消前每月自動續約、可隨時取消、扣款失敗有 7 天寬限期、價格調整預設只適用於之後新購買的方案（調整進行中的訂閱須經付款人重新同意），方案結束後健康紀錄與危險等級警報都不受影響。第 4 節另註明刪除帳號時，依法須保存的付款紀錄會保留。新增第 7 節退款政策：購買時會請您另行勾選同意「開通後不適用七日解除權」。',
        en: 'The Terms of Service have also been updated. Section 5 (Service Fees): core features are always free, but to prevent abuse some features (for example, the number of records per day and the number of medication-bag scans) have daily usage limits, and the daily allowance for AI prescription scanning is now counted per household; advanced features are paid, for example AI prescription scanning beyond the daily free quota. A new Section 6 describes the Premium household plan: billed monthly in TWD and renewed automatically until cancelled, cancellable at any time, with a 7-day grace period if a charge fails, with price changes applying by default only to new purchases (an ongoing subscription’s price changes only if the payer agrees again), and health records and danger-level alerts are unaffected after the plan ends. Section 4 now notes that payment records required by law are kept after account deletion. A new Section 7 is the Refund Policy: when you buy, you will be asked to agree separately that the seven-day right of withdrawal does not apply once the service is activated.',
      })}</p>}
      <div className="mt-4 flex gap-3 text-sm">
        <a href="/privacy" className="font-bold text-blue-700 underline inline-flex min-h-11 items-center">{text({ id: 'Baca Kebijakan Privasi', zh: '閱讀隱私權政策', en: 'Read the Privacy Policy' })}</a>
        <a href="/terms" className="font-bold text-blue-700 underline inline-flex min-h-11 items-center">{text({ id: 'Baca Syarat Layanan', zh: '閱讀服務條款', en: 'Read the Terms of Service' })}</a>
      </div>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <label className="flex items-start gap-3 rounded-2xl border border-brand-200 bg-brand-50 p-4 text-sm leading-6 text-slate-900">
          <input required type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} className="mt-1 h-4 w-4" />
          <span>{text({
            id: 'Saya telah membaca Kebijakan Privasi dan Syarat Layanan yang berlaku, termasuk penjelasan tentang layanan notifikasi dan email pihak ketiga, tautan berbagi baca-saja, pemrosesan pembayaran, biaya layanan, paket berbayar, dan kebijakan pengembalian dana.',
            zh: '我已閱讀目前適用的《隱私權政策》與《服務條款》，包括第三方通知與寄信服務、唯讀分享連結、付款處理，以及服務費用、付費方案與退款政策的說明。',
            en: 'I have read the current Privacy Policy and Terms of Service, including the explanations of third-party notification and email services, read-only share links, payment processing, service fees, the paid plan, and the refund policy.',
          })}</span>
        </label>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-700">{text(error)}</p>}
        <button type="submit" disabled={!checked || saving} className="w-full rounded-xl bg-brand-700 active:bg-emerald-800 px-4 py-3 font-bold text-white disabled:opacity-60">
          {saving ? text({ id: 'Menyimpan…', zh: '正在保存…', en: 'Saving…' }) : text({ id: 'Setuju dan lanjutkan', zh: '確認並繼續', en: 'Acknowledge and continue' })}
        </button>
      </form>
    </section>
  </main>
}
