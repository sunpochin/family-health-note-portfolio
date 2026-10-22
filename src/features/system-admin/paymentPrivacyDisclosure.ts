/*
檔案用途：隱私權政策「付款處理（Premium 方案）」段的三語文案（issue #1183，L1；monetization-plan §6.1 的 /privacy 列）。
所在層：src/features/system-admin 公開頁面的文案資料層；純資料，不讀取任何照護資料、金額或秘密。
主要關聯：pages/PrivacyPage.tsx（呈現）、supabase/migrations/20261006183520_add_subscription_state_machine_and_payment_ledger.sql
  （payment_orders／payment_events／household_subscriptions 實際存的欄位）、notificationProviderDisclosures.ts（Resend 續約提醒信）、
  tests/unit/paymentPrivacyDisclosure.test.ts。
為什麼要分「我們保存的」與「金流服務在付款頁蒐集的」兩段（Codex 對 #1189 第一輪）：只寫「我們不收卡號」會讓委外處理者的揭露不完整——
  卡號、有效期、安全碼、持卡人姓名與 Email 確實被蒐集了，只是由藍新蒐集、依它的隱私政策處理。
為什麼這裡可以寫供應商名稱、條款頁不行：個資法 §8 的告知要讓當事人知道資料給了誰（本頁對 Telegram、LINE、Resend、Google 都具名）；
  #1047「不寫供應商名稱」約束的是條款與登入頁的費用說明。
欄位清單若與 migration 不符就是不實揭露：P1／P2 改了訂單或帳本欄位，要同步改這裡並升 CURRENT_PRIVACY_POLICY_VERSION。
*/
import type { LocalizedText } from '../../lib/i18n'

export type PaymentPrivacyItem = {
  // 測試與 React key 用的穩定代號，不顯示在畫面上。
  key: 'we-keep' | 'provider-collects' | 'purpose' | 'location' | 'retention'
  label: LocalizedText
  body: LocalizedText
}

export const PAYMENT_PRIVACY_TITLE: LocalizedText = {
  zh: '付款處理（Premium 方案）',
  id: 'Pemrosesan pembayaran (paket Premium)',
  en: 'Payment processing (Premium plan)',
}

// 「開始結帳就會產生」而不是「購買才會產生」（Codex on #1211）：create_household_premium_order 在跳到付款頁之前就建 payment_orders，
// 沒付完的訂單以 expired／superseded 保留，首期失敗的回呼也會進帳本。
export const PAYMENT_PRIVACY_INTRO: LocalizedText = {
  zh: '只有開始購買 Premium 家庭方案的家庭擁有者會產生下列資料：按下結帳時就會建立一筆訂單，即使最後沒有完成付款，這筆未完成的訂單（以及付款失敗的通知）也會保留。從未開始結帳的使用者不會產生這些資料。付款處理不涉及任何健康紀錄。',
  id: 'Hanya pemilik keluarga yang mulai membeli paket keluarga Premium yang menghasilkan data di bawah ini: satu pesanan dibuat saat checkout dimulai, dan meskipun pembayaran tidak diselesaikan, pesanan yang belum selesai itu (serta notifikasi pembayaran gagal) tetap disimpan. Pengguna yang tidak pernah memulai checkout tidak menghasilkan data ini. Pemrosesan pembayaran tidak melibatkan catatan kesehatan apa pun.',
  en: 'Only household owners who start buying the Premium household plan produce the data below: an order is created as soon as checkout starts, and even if payment is never completed, that unfinished order (and any failed-payment notification) is kept. Users who never start checkout produce none of this data. Payment processing involves no health records.',
}

export const PAYMENT_PRIVACY_ITEMS: ReadonlyArray<PaymentPrivacyItem> = [
  {
    key: 'we-keep',
    label: { zh: '我們保存的資料：', id: 'Data yang kami simpan:', en: 'What we keep:' },
    // 讀取範圍（Codex on #1211）：payment_orders_select_payer_or_owner／household_subscriptions_select_payer_or_owner 讓付款人與
    // 家庭目前每一位 owner 都能 SELECT，多 owner 家庭裡付款人的訂單資料會被其他 owner 看到，要寫出來。
    // 對照 payment_orders（id、plan_code、amount、currency、status、paid_at、provider_period_no、provider_trade_no、terms_version、
    // refund_waiver_accepted_at、locale、payer_user_id、household_id）、household_subscriptions（期別、狀態、payer_locale）、
    // payment_events（期數、金額、授權時間、告警旗標、回呼內容的 SHA-256 雜湊——不存回呼原文）、取消的申請時間與 cancel_reason。
    // 卡號類欄位在三張表都不存在（P1 表註解明文）。
    body: {
      zh: '訂單編號、方案、金額與幣別、付款結果與時間、訂閱期間與狀態、金流服務回傳的交易編號與定期定額委託編號、購買當下同意的條款版本與七日解除權例外的勾選時間、提醒信使用的語言、取消的申請時間與由誰申請（付款人、家庭擁有者或刪除帳號），以及每次金流回呼的雜湊值與異常標記，還有付款人與家庭的對應關係。付款人與同一家庭的每一位擁有者都可以讀取這些訂單與訂閱紀錄（作為收據）。我們不蒐集、也不保存信用卡號、卡號末四碼、有效期、安全碼或持卡人姓名。',
      id: 'Nomor pesanan, paket, jumlah dan mata uang, hasil dan waktu pembayaran, periode dan status langganan, nomor transaksi dan nomor mandat tagihan berulang yang dikirim kembali oleh layanan pembayaran, versi ketentuan yang disetujui saat membeli dan waktu centang pengecualian hak pembatalan tujuh hari, bahasa email pengingat, waktu dan pihak yang meminta pembatalan (pembayar, pemilik keluarga, atau penghapusan akun), nilai hash dan penanda anomali dari setiap notifikasi layanan pembayaran, serta hubungan antara pembayar dan keluarga. Pembayar dan setiap pemilik dalam keluarga yang sama dapat membaca catatan pesanan dan langganan ini (sebagai tanda terima). Kami tidak mengumpulkan atau menyimpan nomor kartu kredit, empat digit terakhir kartu, tanggal kedaluwarsa, kode keamanan, atau nama pemegang kartu.',
      en: 'The order number, plan, amount and currency, payment result and time, subscription period and status, the transaction number and recurring-payment mandate number returned by the payment service, the terms version agreed to at purchase and the time the seven-day withdrawal exception box was ticked, the language for reminder emails, when a cancellation was requested and by whom (the payer, a household owner, or account deletion), a hash and any anomaly flags for each payment-service notification, and which payer belongs to which household. The payer and every owner of the same household can read these order and subscription records (as receipts). We do not collect or keep credit card numbers, the last four digits, expiry dates, security codes, or cardholder names.',
    },
  },
  {
    key: 'provider-collects',
    label: { zh: '金流服務在付款頁蒐集的資料：', id: 'Data yang dikumpulkan layanan pembayaran di halaman pembayaran:', en: 'What the payment service collects on its payment page:' },
    // 回傳欄位對照 apply_payment_event 實際消費的值（MerchantOrderNo、AlreadyTimes、Amt、AuthDate、狀態、TradeNo、PeriodNo；Codex on #1211）。
    // 藍新定期定額首期要求 3D 驗證，付款頁會要 Email；電話視發卡行流程而定，所以寫「可能」。
    body: {
      zh: '付款頁由藍新科技（藍新科技股份有限公司，台灣）託管。您在付款頁輸入的卡號、有效期、安全碼、持卡人姓名、電子郵件（定期定額首期的 3D 驗證需要），以及可能需要的手機號碼，由藍新直接蒐集與處理，依藍新自己的隱私權政策保存，不會回傳給我們。藍新回傳給我們的只有：訂單編號、第幾期、金額、授權時間、付款結果、交易編號與委託編號。',
      id: 'Halaman pembayaran dikelola oleh NewebPay Co., Ltd. (Taiwan). Nomor kartu, tanggal kedaluwarsa, kode keamanan, nama pemegang kartu, email (diperlukan untuk verifikasi 3D pada tagihan berulang pertama), dan mungkin nomor ponsel yang Anda masukkan di halaman pembayaran dikumpulkan dan diproses langsung oleh NewebPay, disimpan sesuai kebijakan privasi NewebPay sendiri, dan tidak dikirim kembali kepada kami. Yang dikirim NewebPay kembali kepada kami hanya: nomor pesanan, periode ke berapa, jumlah, waktu otorisasi, hasil pembayaran, nomor transaksi, dan nomor mandat.',
      en: 'The payment page is hosted by NewebPay Co., Ltd. (Taiwan). The card number, expiry date, security code, cardholder name, email (required for 3D verification of the first recurring charge), and possibly a mobile number that you enter on the payment page are collected and processed directly by NewebPay, kept under NewebPay’s own privacy policy, and never sent back to us. NewebPay sends us only the order number, the installment number, the amount, the authorization time, the payment result, the transaction number, and the mandate number.',
    },
  },
  {
    key: 'purpose',
    label: { zh: '目的：', id: 'Tujuan:', en: 'Purpose:' },
    body: {
      zh: '完成付款、開通與續約 Premium、寄送續約提醒、對帳、處理取消、退款與爭議，以及依法保存帳務紀錄。',
      id: 'Menyelesaikan pembayaran, mengaktifkan dan memperpanjang Premium, mengirim pengingat perpanjangan, rekonsiliasi, menangani pembatalan, pengembalian dana, dan sengketa, serta menyimpan catatan keuangan sesuai hukum.',
      en: 'Completing payment, activating and renewing Premium, sending renewal reminders, reconciliation, handling cancellations, refunds and disputes, and keeping financial records as required by law.',
    },
  },
  {
    key: 'location',
    label: { zh: '處理地區：', id: 'Lokasi pemrosesan:', en: 'Processing location:' },
    // 只主張藍新在台灣；我們自己的資料庫區域本頁從未具名，這裡也不替它下「非境外」的結論。
    body: {
      zh: '藍新在台灣處理付款資料。我們保存的訂單紀錄與其他帳號資料放在同一個資料庫服務（Supabase）。',
      id: 'NewebPay memproses data pembayaran di Taiwan. Catatan pesanan yang kami simpan berada di layanan basis data yang sama dengan data akun lainnya (Supabase).',
      en: 'NewebPay processes payment data in Taiwan. The order records we keep sit in the same database service as other account data (Supabase).',
    },
  },
  {
    key: 'retention',
    label: { zh: '保存期限：', id: 'Masa simpan:', en: 'Retention:' },
    // payment_orders.household_id 與 payment_events 刻意不掛外鍵（家庭刪了帳務列仍在）；payment_orders.payer_user_id 是
    // REFERENCES auth.users ON DELETE SET NULL——刪帳號時正是這個外鍵把付款人設為 NULL，帳務列依稅法保留。
    // 實際年限待法務／會計師確認（#1183 停止點：不自行主張法律結論）。
    // 不承諾「期滿刪除」（Codex on #1211）：三張付款表都沒有到期欄或清除路徑，payment_events 還有擋 DELETE 的 trigger；
    // 期滿處理機制做出來之前，只能說「依法保存、處理方式確認後公告」。
    body: {
      zh: '訂單與付款紀錄屬於帳務紀錄，至少依稅法等法令規定的年限保存；實際年限與期滿後的處理方式，以確認後公告為準。刪除帳號後，這些紀錄仍會依法保存，但會解除與您帳號的連結。',
      id: 'Catatan pesanan dan pembayaran adalah catatan keuangan dan disimpan setidaknya selama jangka waktu yang diwajibkan oleh undang-undang pajak dan peraturan lainnya; jangka waktu pastinya dan penanganan setelah jangka waktu berakhir akan diumumkan setelah dikonfirmasi. Setelah akun dihapus, catatan ini tetap disimpan sesuai hukum, tetapi tidak lagi terhubung dengan akun Anda.',
      en: 'Order and payment records are financial records and are kept for at least the period required by tax and other laws; the exact period and what happens when it ends will be announced once confirmed. After you delete your account, these records are still kept as required by law, but they are no longer linked to your account.',
    },
  },
]
