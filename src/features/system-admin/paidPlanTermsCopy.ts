/*
檔案用途：服務條款第 6 節「付費方案（Premium）」與第 7 節「退款政策」的三語文案（issue #1183，L1）。
所在層：src/features/system-admin 公開頁面的文案資料層；純資料，不讀取任何照護資料、金額或秘密。
主要關聯：pages/TermsPage.tsx（呈現）、lib/legalConsent.ts（CURRENT_TERMS_VERSION＝付費條款版本）、
  docs/product/monetization-plan.md §5.2／§5.3（狀態機與降級效果，本檔每一句都要對得上）、§6.1～§6.3（要寫什麼）、
  supabase/migrations/20261006183520_add_subscription_state_machine_and_payment_ledger.sql（P1 實際行為）、
  tests/unit/paidPlanTermsCopy.test.ts。
規則（#1047、monetization-plan §7）：不寫價格數字、不寫金流供應商名稱；法務還沒確認的事寫「以購買頁面公告為準」，不自行下法律結論。
改這裡任何一句都等於改條款：要照 TermsPage.tsx 檔頭的升版程序走（頁首日期 → CURRENT_TERMS_VERSION → migration 白名單與
current_paid_terms_version() → PrivacyPolicyUpdateScreen 的累積摘要）。
*/
import type { LocalizedText } from '../../lib/i18n'

export type TermsClause = {
  // 測試與 React key 用的穩定代號，不顯示在畫面上。
  key: string
  label: LocalizedText
  body: LocalizedText
}

export const PAID_PLAN_SECTION_TITLE: LocalizedText = {
  zh: '付費方案（Premium）',
  id: 'Paket Berbayar (Premium)',
  en: 'Paid Plan (Premium)',
}

// 為什麼強調「家庭共用一份」與「基礎功能不必購買」：付費單位是家庭（ADR-012 D1），而照護者最怕的是「不付錢就收不到警報」——
// 危險等級血壓警報免費是 ADR-011 D3 的承諾，條款要在付費節開頭就再說一次，不能只留在第 5 節。
export const PAID_PLAN_INTRO: LocalizedText = {
  zh: '進階功能以「Premium」家庭方案提供：由家庭擁有者購買，同一個家庭的所有成員與照護對象共用一份方案。基礎功能與危險等級的血壓警報不需要購買。以下規則自付費方案開放購買時起適用。',
  id: 'Fitur lanjutan disediakan melalui paket keluarga "Premium": dibeli oleh pemilik keluarga, dan satu paket dipakai bersama oleh semua anggota serta penerima perawatan dalam keluarga yang sama. Fitur dasar dan peringatan tekanan darah tingkat bahaya tidak perlu dibeli. Ketentuan berikut berlaku sejak paket berbayar dibuka untuk dibeli.',
  en: 'Advanced features come with the "Premium" household plan: it is purchased by a household owner, and one plan is shared by every member and care recipient in that household. Core features and danger-level blood pressure alerts do not require a purchase. The following rules apply from the time the paid plan opens for purchase.',
}

// 每一條都對照 monetization-plan §5.2／§5.3 與 P1 migration；行為改了這裡要一起改並升條款版本。
export const PAID_PLAN_CLAUSES: ReadonlyArray<TermsClause> = [
  {
    key: 'contents',
    label: { zh: '方案內容：', id: 'Isi paket:', en: 'What is included:' },
    // owner 1.7.6：單一方案四項。數字（次數、天數、人數）刻意不寫：由 premium_plan_offer() 決定、購買頁顯示，條款寫死會和實際脫鉤。
    body: {
      zh: '共四項——(1) AI 藥單辨識的每日次數提高；(2) 個人化通知加值：危險等級以外的血壓通知、到期與日曆提醒的個人通知，以及 LINE 通知；(3) 照片保存期限延長；(4) 每個家庭可建立的照護對象人數上限提高。各項的實際數字以購買頁面顯示為準。',
      id: 'Empat hal — (1) jumlah pemindaian resep AI per hari ditingkatkan; (2) notifikasi pribadi tambahan: notifikasi tekanan darah selain tingkat bahaya, pengingat jatuh tempo dan pengingat kalender secara pribadi, serta notifikasi LINE; (3) masa simpan foto diperpanjang; (4) batas jumlah penerima perawatan per keluarga ditingkatkan. Angka pastinya mengikuti yang ditampilkan di halaman pembelian.',
      en: 'Four items — (1) a higher daily number of AI prescription scans; (2) extra personal notifications: blood pressure notifications below danger level, personal due and calendar reminders, and LINE notifications; (3) a longer photo retention period; (4) a higher limit on care recipients per household. The exact numbers are as shown on the purchase page.',
    },
  },
  {
    key: 'price-and-billing',
    label: { zh: '價格、幣別與週期：', id: 'Harga, mata uang, dan periode:', en: 'Price, currency, and billing period:' },
    // 價格不在條款（#1047）：以購買當時頁面為準，並寫進訂單——訂單金額只來自伺服器常數（P1 建單 RPC 沒有金額參數）。
    body: {
      zh: '以新台幣計價、按月收費。每期金額以您購買當時購買頁面顯示的價格為準，並記載於訂單紀錄；唯一例外是您依下方「價格變更」重新同意的新價格。付款以信用卡定期定額方式在第三方金流服務的付款頁完成，我們不會取得您的完整卡號。',
      id: 'Dihitung dalam Dolar Taiwan Baru (TWD) dan ditagih bulanan. Jumlah setiap periode mengikuti harga yang ditampilkan di halaman pembelian saat Anda membeli, dan dicatat dalam pesanan; satu-satunya pengecualian adalah harga baru yang Anda setujui kembali sesuai "Perubahan harga" di bawah. Pembayaran dilakukan dengan tagihan kartu kredit berulang di halaman pembayaran layanan pembayaran pihak ketiga; kami tidak menerima nomor kartu lengkap Anda.',
      en: 'Priced in New Taiwan Dollars (TWD) and billed monthly. The amount for each period is the price shown on the purchase page at the time you buy, and it is recorded in your order; the only exception is a new price you agree to again under "Price changes" below. Payment is made as a recurring credit card charge on a third-party payment service’s payment page; we never receive your full card number.',
    },
  },
  {
    key: 'auto-renewal',
    label: { zh: '自動續約：', id: 'Perpanjangan otomatis:', en: 'Automatic renewal:' },
    // 5.6.1：扣款前 7 天提醒一次（P1 的 subscription-lifecycle cron 寄 Resend 信，只寄付款人）。
    // 寫「通常」而不是「每次」（bp-reviewer）：list_renewal_reminder_candidates 只挑 active 且 next_billing_at 已知的列，
    // 寬限期、取消處理中不寄；claim_renewal_reminder 遇網路錯誤刻意不重送（寧可漏寄也不重複寄）。
    body: {
      zh: '方案每月自動續約並扣款，直到取消為止。我們通常會在續約扣款日前 7 天內寄一封提醒信給付款人（寬限期或取消處理中不寄）。',
      id: 'Paket diperpanjang dan ditagih otomatis setiap bulan sampai dibatalkan. Biasanya dalam 7 hari sebelum tanggal penagihan perpanjangan, kami mengirim satu email pengingat kepada pembayar (tidak dikirim selama masa tenggang atau saat pembatalan sedang diproses).',
      en: 'The plan renews and is charged automatically every month until cancelled. We usually send the payer one reminder email within the 7 days before the renewal charge date (not during a grace period or while a cancellation is in progress).',
    },
  },
  {
    key: 'cancellation',
    label: { zh: '取消與生效時點：', id: 'Pembatalan dan kapan berlaku:', en: 'Cancellation and when it takes effect:' },
    // §5.2：取消的真實來源是金流服務的終止確認；反悔只在終止送出前、只有付款人（resume 只檢查 payer）。
    // 寫「網站版設定頁」：原生 App 殼不放任何購買／管理入口（ADR-012 §4、P4），條款若寫「App 設定頁」在 App 裡會是假的。
    // 「確認終止後」才不再扣款（bp-reviewer）：cancel_requested／terminating 期間仍可能扣款，apply_payment_event 照樣延長權限並記
    // period_charge_after_cancel，所以要同時說「該期照常提供、可申請退款」。付款人刪帳號會把訂閱轉 cancel_requested（payer_deleted），
    // 撤回只認付款人本人，等於無法撤回——這是會影響其他家人的後果，必須寫出來。
    body: {
      zh: '付款人或家庭擁有者可隨時在網站版的設定頁取消續約。取消要等金流服務確認終止才算完成，期間畫面會顯示「取消處理中」；確認終止後就不再扣款，已付款的這一期照常使用到期末，期末後方案結束。在終止送出之前，付款人可以撤回取消。若在確認終止前仍被扣款，該期照常提供服務，您也可以依第 7 節申請退款。付款人刪除自己的帳號時，家庭的方案會一併取消，且無法撤回。',
      id: 'Pembayar atau pemilik keluarga dapat membatalkan perpanjangan kapan saja di halaman Pengaturan versi situs web. Pembatalan baru selesai setelah layanan pembayaran mengonfirmasi penghentian, dan selama itu layar menampilkan "pembatalan sedang diproses"; setelah dikonfirmasi tidak ada tagihan lagi, periode yang sudah dibayar tetap dapat dipakai sampai akhir periode, lalu paket berakhir. Sebelum penghentian dikirim, pembayar dapat menarik kembali pembatalannya. Jika masih ada tagihan sebelum penghentian dikonfirmasi, periode itu tetap dilayani seperti biasa dan Anda dapat mengajukan pengembalian dana sesuai Bagian 7. Jika pembayar menghapus akunnya sendiri, paket keluarga ikut dibatalkan dan tidak dapat ditarik kembali.',
      en: 'The payer or a household owner can cancel renewal at any time on the Settings page of the website. Cancellation is complete only once the payment service confirms the termination, and the screen shows "cancellation in progress" until then; after that no further charges are made, the period already paid for stays usable until it ends, and then the plan ends. Until the termination is sent, the payer can withdraw the cancellation. If a charge still goes through before the termination is confirmed, that period is served as usual and you can request a refund under Section 7. If the payer deletes their own account, the household’s plan is cancelled too, and this cannot be withdrawn.',
    },
  },
  {
    key: 'grace-period',
    label: { zh: '扣款失敗與寬限期：', id: 'Penagihan gagal dan masa tenggang:', en: 'Failed charges and grace period:' },
    // 5.6.2：寬限 7 天，期間 Premium 照常（entitlement premium_until 延到 grace_until）；到期由 cron 降級。
    // 「家庭擁有者」而不是「付款人」（bp-reviewer）：更新付款方式走 create_household_premium_order（p_replaces_subscription_id），
    // 那支 RPC 只接受家庭目前的 owner。
    body: {
      zh: '續約扣款失敗時，方案有 7 天寬限期，期間照常使用，家庭擁有者可在寬限期內更新付款方式。寬限期結束仍未完成付款，方案即結束。',
      id: 'Jika penagihan perpanjangan gagal, paket mendapat masa tenggang 7 hari dan tetap dapat dipakai seperti biasa; pemilik keluarga dapat memperbarui metode pembayaran selama masa tenggang. Jika pembayaran belum selesai saat masa tenggang berakhir, paket berakhir.',
      en: 'If a renewal charge fails, the plan has a 7-day grace period during which it keeps working, and a household owner can update the payment method. If payment is still not completed when the grace period ends, the plan ends.',
    },
  },
  {
    key: 'after-plan-ends',
    label: { zh: '方案結束後：', id: 'Setelah paket berakhir:', en: 'After the plan ends:' },
    // §5.3 降級落點與 ADR-011／§3.6「收回時絕不做的事」：不動健康紀錄、不封存、不解綁、不提早刪照片、不碰危險級警報。
    // 「若沒有其他有效的 Premium」（Codex on #1211 第 2 輪）：到期與退款都對 entitlement 做 compare-and-set，家庭已改由招待／試用或
    // 另一張訂閱持有 Premium 時只關閉舊訂閱、不降級，不能寫成無條件回到免費方案。
    body: {
      zh: '若家庭沒有其他仍有效的 Premium（例如招待），就回到免費方案：所有健康紀錄、基礎功能與危險等級的血壓警報都不受影響；已建立的照護對象全部保留、可以繼續記錄，但人數超過免費上限時不能再新增；已綁定的 Telegram 與 LINE 不會被解除，只停止傳送付費通知；照片依上傳當時適用的保存期限處理，不會因方案結束而提早刪除；AI 藥單辨識回到每日免費次數，當天已使用的次數照算。',
      id: 'Jika keluarga tidak memiliki Premium lain yang masih berlaku (misalnya Premium gratis dari kami), keluarga kembali ke paket gratis: semua catatan kesehatan, fitur dasar, dan peringatan tekanan darah tingkat bahaya tidak terpengaruh; semua penerima perawatan yang sudah dibuat tetap ada dan tetap dapat dicatat, tetapi jika jumlahnya melebihi batas gratis, tidak dapat menambah yang baru; Telegram dan LINE yang sudah terhubung tidak dilepas, hanya notifikasi berbayar yang berhenti dikirim; foto mengikuti masa simpan yang berlaku saat diunggah dan tidak dihapus lebih awal karena paket berakhir; pemindaian resep AI kembali ke jatah gratis harian, dan pemakaian hari itu tetap dihitung.',
      en: 'If the household has no other Premium still in effect (for example, complimentary Premium), it returns to the free plan: all health records, core features, and danger-level blood pressure alerts are unaffected; every care recipient already created is kept and can still be recorded for, but no new ones can be added while the number is above the free limit; linked Telegram and LINE accounts stay linked and only paid notifications stop; photos follow the retention period that applied when they were uploaded and are not deleted early because the plan ended; AI prescription scanning returns to the daily free quota, and scans already used that day still count.',
    },
  },
  {
    key: 'price-changes',
    label: { zh: '價格變更：', id: 'Perubahan harga:', en: 'Price changes:' },
    // 與定期定額的技術事實一致：委託金額在建立時固定，改金額必須另建委託；所以「進行中的訂閱維持原價」不是額外成本。
    // 這是對消費者有利的承諾，owner 要確認（列在 PR 的法務／owner 待確認清單）。
    body: {
      // 「預設維持原價、唯一例外是重新同意」寫成同一條規則的兩部分（Codex on #1211：原本兩句讀起來互相矛盾）。
      zh: '我們可能調整價格。新價格只適用於調整後新購買的方案；進行中的訂閱預設維持購買時的價格，直到取消或結束。唯一的例外：若必須調整進行中訂閱的價格，我們會事先通知付款人，只有在付款人明確重新同意後，才從之後的期別以新價格扣款；付款人不同意時，訂閱維持原價直到取消或結束。',
      id: 'Kami dapat mengubah harga. Harga baru hanya berlaku untuk paket yang dibeli setelah perubahan; langganan yang sedang berjalan secara bawaan tetap memakai harga saat pembelian sampai dibatalkan atau berakhir. Satu-satunya pengecualian: jika harga langganan yang sedang berjalan harus diubah, kami akan memberi tahu pembayar terlebih dahulu, dan harga baru baru ditagih untuk periode berikutnya setelah pembayar menyetujuinya kembali secara tegas; jika pembayar tidak setuju, langganan tetap memakai harga awal sampai dibatalkan atau berakhir.',
      en: 'We may change prices. A new price applies only to plans purchased after the change; by default, an ongoing subscription keeps the price it was purchased at until it is cancelled or ends. The only exception: if the price of an ongoing subscription must change, we will notify the payer in advance and charge the new price for later periods only after the payer explicitly agrees again; if the payer does not agree, the subscription keeps its original price until it is cancelled or ends.',
    },
  },
]

export const REFUND_SECTION_TITLE: LocalizedText = {
  zh: '退款政策',
  id: 'Kebijakan Pengembalian Dana',
  en: 'Refund Policy',
}

export const REFUND_CLAUSES: ReadonlyArray<TermsClause> = [
  {
    key: 'withdrawal-right',
    label: { zh: '七日解除權：', id: 'Hak pembatalan tujuh hari:', en: 'Seven-day right of withdrawal:' },
    // owner 6.5.2 拍板主張數位內容例外：購買頁獨立勾選（不得與條款勾選合併）、寫 refund_waiver_accepted_at、未勾選不得建單（P1 已強制）。
    // 「是否及於後續各期」法務尚未確認：照 #1183 停止點，寫「以購買頁面公告為準」，不自行下結論。
    body: {
      zh: 'Premium 是不以有形媒介提供、一經開通即開始提供的線上服務。購買時，購買頁會以一個獨立的勾選框，請您事先同意「開通後即開始提供服務，不適用消費者保護法第 19 條的七日無條件解除權」；沒有勾選就無法購買。這項同意是否也適用於自動續約的後續各期，以購買頁面公告為準。',
      id: 'Premium adalah layanan daring yang tidak diberikan melalui media berwujud dan mulai diberikan segera setelah diaktifkan. Saat membeli, halaman pembelian meminta persetujuan Anda terlebih dahulu melalui kotak centang tersendiri bahwa "layanan mulai diberikan segera setelah aktif, sehingga hak pembatalan tanpa syarat tujuh hari menurut Pasal 19 Undang-Undang Perlindungan Konsumen Taiwan tidak berlaku"; tanpa mencentangnya, pembelian tidak dapat dilakukan. Apakah persetujuan ini juga berlaku untuk periode perpanjangan otomatis berikutnya mengikuti pengumuman di halaman pembelian.',
      en: 'Premium is an online service that is not provided on a tangible medium and starts as soon as it is activated. When you buy, the purchase page asks for your prior consent, in a separate checkbox, that "the service starts as soon as it is activated, so the seven-day unconditional right of withdrawal under Article 19 of Taiwan’s Consumer Protection Act does not apply"; you cannot buy without ticking it. Whether this consent also covers later automatic renewal periods is as announced on the purchase page.',
    },
  },
  {
    key: 'requesting-refunds',
    label: { zh: '申請退款：', id: 'Mengajukan pengembalian dana:', en: 'Requesting a refund:' },
    // §5.2：任何狀態收到扣款都延長權限（絕不吞錢），取消後仍扣款另記事件並告警，由 L2 SOP 處理退款。
    body: {
      zh: '若發生重複扣款、取消後仍被扣款，或其他扣款錯誤，請透過本條款「聯絡方式」一節來信並附上訂單編號；確認後我們會經原付款方式退款。取消後仍被扣款的那一期，在處理完成前仍照常提供服務。申請期限以購買頁面公告為準。',
      id: 'Jika terjadi penagihan ganda, penagihan setelah pembatalan, atau kesalahan penagihan lainnya, kirim email melalui bagian "Hubungi Kami" pada Syarat ini dengan menyertakan nomor pesanan; setelah dikonfirmasi, kami mengembalikan dana melalui metode pembayaran asal. Periode yang tetap ditagih setelah pembatalan tetap dilayani seperti biasa sampai penanganan selesai. Batas waktu pengajuan mengikuti pengumuman di halaman pembelian.',
      en: 'If you are charged twice, charged after cancelling, or charged in error in any other way, email us through the "Contact" section of these Terms with your order number; once confirmed, we refund through the original payment method. A period charged after cancellation keeps being served as usual until the request is handled. The deadline for requests is as announced on the purchase page.',
    },
  },
  {
    key: 'after-refund',
    label: { zh: '退款後：', id: 'Setelah pengembalian dana:', en: 'After a refund:' },
    // §3.6：退款先終止定期定額委託、確認後才降級，而且不給寬限期（寬限是給想付但卡片出問題的人）。
    body: {
      zh: '退款會先停止之後的自動扣款；完成後，對應的方案立即結束、不另給寬限期；若家庭沒有其他仍有效的 Premium，就回到免費方案（效果同第 6 節「方案結束後」）。',
      id: 'Pengembalian dana terlebih dahulu menghentikan penagihan otomatis berikutnya; setelah selesai, paket terkait langsung berakhir tanpa masa tenggang; jika keluarga tidak memiliki Premium lain yang masih berlaku, keluarga kembali ke paket gratis (dampaknya sama dengan "Setelah paket berakhir" di Bagian 6).',
      en: 'A refund first stops future automatic charges; once it is completed, the related plan ends immediately with no grace period; if the household has no other Premium still in effect, it returns to the free plan (with the same effects as "After the plan ends" in Section 6).',
    },
  },
]
