/*
檔案用途：集中 Telegram、LINE、Resend 三家通知／寄信供應商的隱私揭露文案（zh／id／en），
供 /privacy 與 /health-data-notice 共用，並讓單元測試逐項鎖住「送了什麼、為什麼、境外、是否選用」。
所在層：src/features/system-admin 公開頁面的文案資料層；純資料，不讀取任何照護資料或秘密。
主要關聯：PrivacyPage.tsx、HealthDataNoticePage.tsx、tests/unit/notificationProviderDisclosures.test.ts；
資料流依據 supabase/functions/blood-pressure-notifier、personal-notification-drain、care-due-reminders、
calendar-notifier、telegram-webhook、line-webhook、send-invitation-email（issue #424 第三方供應商盤點）。
*/
import type { LocalizedText } from '../../lib/i18n'

// 為什麼抽成獨立檔而不直接寫在 PrivacyPage.tsx：同一時間另一個 #424 工作（分享連結告知）也在改 PrivacyPage，
// 文案放這裡可以把兩邊的 merge 衝突壓到只剩一行元件插入；同時讓測試直接 import 資料逐項檢查，
// 不用對 TSX 原始碼做字串比對。
export type ProviderDisclosure = {
  // 測試與 React key 用的穩定代號，不顯示在畫面上。
  key: 'telegram' | 'line' | 'resend'
  title: LocalizedText
  // 每一項都是獨立一句，對應個資法 §8 告知事項：送了哪些欄位、目的、境外處理、是否由使用者選用。
  sent: LocalizedText
  purpose: LocalizedText
  location: LocalizedText
  optIn: LocalizedText
}

// 欄位清單逐字對照程式實際送出的內容（盤點日 2026-09-25）：
// - 血壓通知：bloodPressureNotifier.ts 的 buildBloodPressureNotificationFields —— 照護對象顯示名稱、收縮壓、舒張壓、
//   心跳、量測時間與時段、判讀狀態與所用標準，以及「提交者名稱」（取自提交者電子郵件 @ 前的帳號名稱，不是完整信箱）。
// - 到期提醒：個人私訊版（buildPersonalDueReminderText，issue #1104，盤點日 2026-10-06）送提醒類型、到期日與剩餘／逾期天數，
//   另帶照護對象的顯示名稱；刻意不帶藥名或自由文字。
// - 日曆提醒：個人私訊版（buildPersonalCalendarReminderText）送照護對象的顯示名稱與行程開始的日期時刻（台北時間）；
//   刻意不帶行程標題、地點或說明。
// - 共用的家庭 Telegram 群組已於 2026-10-09 退場（issue #1061 階段 D）：三支 Function 不再送任何群組，收件人只剩各自綁定個人通知的家人；
//   這份揭露因此不得再提「家庭群組」或「服務維護者開通」，隱私政策同日升版 2026-10-09。
// - 提醒的個人私訊收件人：enqueue_reminder_personal_notifications 對「該照護對象所有有 care_access、付費且已綁定」的家人扇出，
//   管道含 LINE（原本 LINE 只承載血壓）；已封存的照護對象不送。
// - 個人通知的收件人：enqueue_blood_pressure_personal_notifications_v2 對「該照護對象所有有 care_access、付費且已綁定」的家人扇出；
//   危險等級另對所有已綁 Telegram 的 care_access 成員免費扇出（issue #1059、ADR-011 D3），LINE 仍只限付費，
//   不只記錄者本人；所以文案必須說清楚「別的家人綁定，就會收到這位照護對象的數值（含記錄者名稱）」，不能寫成只有「您」綁定才送。
//   但 LINE 例外：personal-notification-drain 為了共用的 LINE 月額度，同一輪只放行第一位 LINE 收件人、其餘標記失敗
//   （跨輪不去重，所以寫「通常只送一位」）；文案不得宣稱每位綁定 LINE 的家人都會收到，否則家人會依賴一則不會來的警報。
// - 續約提醒信（issue #1183 揭露；寄送程式是 P1 #1182 的 subscription-lifecycle）：只寄付款人，內容是續約日期、金額與 App 網址，
//   沒有家庭 id、token 或健康資料（buildRenewalReminderEmail）。
// 若之後改動任何一支 Function 的訊息欄位或收件人範圍，必須同步改這裡並升版，否則就是不實揭露。
export const NOTIFICATION_PROVIDER_DISCLOSURES: ReadonlyArray<ProviderDisclosure> = [
  {
    key: 'telegram',
    title: { zh: 'Telegram（即時通訊通知）', id: 'Telegram (notifikasi pesan)', en: 'Telegram (messaging notifications)' },
    sent: {
      zh: '血壓通知會送出：照護對象的顯示名稱、收縮壓、舒張壓、心跳、量測時間與時段、判讀狀態與所用的判讀標準，以及提交者名稱（取自提交者電子郵件 @ 前面的帳號名稱）。回診、抽血、打針、疫苗、藥量等到期提醒送出提醒類型、到期日與剩餘或逾期天數。所有通知都只送到各自綁定個人通知的家人（2026 年 10 月 9 日起不再有共用的家庭群組）。個人通知中的到期提醒與日曆提醒另帶照護對象的顯示名稱，日曆提醒另寫行程開始的日期與時刻（台北時間）；兩者都不含藥名、行程標題、地點或說明。綁定個人通知時，Telegram 會把您的 Telegram 對話 ID 傳給我們，用來指定收件人。',
      id: 'Notifikasi tekanan darah mengirim: nama tampilan penerima perawatan, sistolik, diastolik, denyut nadi, waktu dan sesi pengukuran, status penilaian beserta standar yang dipakai, serta nama pengirim (diambil dari bagian sebelum @ pada email pengirim). Pengingat jatuh tempo (kontrol dokter, ambil darah, suntikan, vaksin, sisa obat, dll.) mengirim jenis pengingat, tanggal jatuh tempo, dan jumlah hari tersisa atau terlambat. Semua notifikasi hanya dikirim ke anggota keluarga yang menautkan notifikasi pribadinya sendiri (sejak 9 Oktober 2026 tidak ada lagi grup keluarga bersama). Dalam notifikasi pribadi, pengingat jatuh tempo dan pengingat kalender juga memuat nama tampilan penerima perawatan, dan pengingat kalender juga memuat tanggal dan jam mulai acara (waktu Taipei); keduanya tidak memuat nama obat, judul, lokasi, atau deskripsi acara. Saat Anda menghubungkan notifikasi pribadi, Telegram mengirimkan ID obrolan Telegram Anda kepada kami untuk menentukan penerima.',
      en: 'Blood-pressure notifications send: the care recipient’s display name, systolic, diastolic, heartbeat, measurement time and session, the assessed status with the standard used, and the submitter’s name (taken from the part of the submitter’s email before the @). Due reminders (follow-up visits, blood draws, injections, vaccinations, medication supply, etc.) send the reminder type, due date and days remaining or overdue. Every notification goes only to family members who linked their own personal notifications (since October 9, 2026 there is no shared family group). In personal notifications, due reminders and calendar reminders also include the care recipient’s display name, and calendar reminders also include the event’s start date and time (Taipei time); neither includes medication names or the event’s title, location or description. When you link personal notifications, Telegram sends us your Telegram chat ID so we know where to deliver.',
    },
    purpose: {
      zh: '目的：讓家屬與看護即時知道剛量到的血壓與即將到期的照護事項。',
      id: 'Tujuan: agar keluarga dan pengasuh segera mengetahui tekanan darah yang baru diukur dan jadwal perawatan yang akan jatuh tempo.',
      en: 'Purpose: letting family members and caregivers know right away about a new blood-pressure reading and upcoming care tasks.',
    },
    location: {
      zh: '處理地區：Telegram 由 Telegram Messenger Inc. 提供；依其隱私權政策（2026 年 9 月查證），資料可能與其位於英屬維京群島與杜拜的關係企業共享，訊息會在台灣以外的地區處理與保存。訊息一旦送達就留在 Telegram 對話紀錄中；在本 App 刪除紀錄或帳號，不會刪除已送出的 Telegram 訊息。',
      id: 'Lokasi pemrosesan: Telegram disediakan oleh Telegram Messenger Inc.; menurut kebijakan privasinya (diperiksa September 2026), data dapat dibagikan dengan perusahaan grupnya di Kepulauan Virgin Britania Raya dan Dubai, dan pesan diproses serta disimpan di luar Taiwan. Setelah terkirim, pesan tetap ada di riwayat obrolan Telegram; menghapus catatan atau akun di aplikasi ini tidak menghapus pesan Telegram yang sudah terkirim.',
      en: 'Processing location: Telegram is provided by Telegram Messenger Inc.; per its privacy policy (checked September 2026), data may be shared with its group companies in the British Virgin Islands and Dubai, and messages are processed and stored outside Taiwan. Once delivered, a message stays in the Telegram chat history; deleting records or your account in this app does not delete Telegram messages that were already sent.',
    },
    optIn: {
      zh: '是否選用：沒有共用的家庭群組，通知只會送到自己綁定的帳號。個人通知中，危險等級的血壓免費，其他等級需付費：只要有任何一位對這位照護對象有照護權限的家人在「設定」中綁定了自己的 Telegram 帳號，這位照護對象的新血壓紀錄（含記錄者的提交者名稱；未付費的家人只會收到危險等級，系統暫時讀不到判讀標準時也可能收到警告等級）就會送到那位家人的 Telegram，即使記錄的人自己沒有綁定。到期提醒與 Google 日曆提醒的個人通知需付費：對這位照護對象有照護權限、已付費並綁定的家人會各自收到；已封存的照護對象不再提醒。綁定與解除綁定只決定是否送到您自己的帳號，可隨時解除；沒有任何家人綁定時，就不會送出個人通知。',
      id: 'Opsional atau tidak: tidak ada grup keluarga bersama; notifikasi hanya dikirim ke akun yang Anda tautkan sendiri. Untuk notifikasi pribadi, tekanan darah tingkat bahaya gratis, tingkat lainnya berbayar: jika ada anggota keluarga yang memiliki akses perawatan ke penerima perawatan ini dan menghubungkan akun Telegram miliknya di "Pengaturan", catatan tekanan darah baru untuk penerima perawatan ini (termasuk nama pengirim; anggota keluarga yang tidak berlangganan hanya menerima tingkat bahaya, dan mungkin juga tingkat peringatan saat standar penilaian sementara tidak bisa dibaca) akan dikirim ke Telegram anggota keluarga tersebut, meskipun orang yang mencatat tidak menghubungkan akunnya. Notifikasi pribadi untuk pengingat jatuh tempo dan pengingat Google Kalender berbayar: setiap anggota keluarga yang memiliki akses perawatan ke penerima perawatan ini, berlangganan, dan terhubung akan menerimanya; penerima perawatan yang diarsipkan tidak lagi diingatkan. Menghubungkan atau melepas hanya menentukan apakah notifikasi dikirim ke akun Anda sendiri, dan dapat dilepas kapan saja; jika tidak ada anggota keluarga yang terhubung, notifikasi pribadi tidak dikirim.',
      en: 'Opt-in: there is no shared family group; notifications go only to the account you linked yourself. Personal notifications for danger-level blood pressure are free and other levels are paid: if any family member with care access to this care recipient links their own Telegram account in Settings, new blood-pressure records for this care recipient (including the submitter’s name; family members without a subscription receive only danger-level readings, and possibly warning-level readings while the assessment standard is temporarily unreadable) are sent to that family member’s Telegram, even if the person recording has not linked anything. Personal due reminders and Google Calendar reminders are paid: every family member with care access to this care recipient who has a subscription and has linked receives them; archived care recipients are no longer reminded. Linking or unlinking only controls delivery to your own account, and you can unlink at any time; if no family member has linked, no personal notifications are sent.',
    },
  },
  {
    key: 'line',
    title: { zh: 'LINE（即時通訊通知）', id: 'LINE (notifikasi pesan)', en: 'LINE (messaging notifications)' },
    sent: {
      zh: '個人血壓通知會送出與 Telegram 相同的內容：照護對象的顯示名稱、收縮壓、舒張壓、心跳、量測時間與時段、判讀狀態與所用的判讀標準，以及提交者名稱（取自提交者電子郵件 @ 前面的帳號名稱）。付費帳號的到期提醒與 Google 日曆提醒也會送到 LINE，內容與 Telegram 的個人通知相同（照護對象的顯示名稱、提醒類型、到期日與剩餘或逾期天數；日曆提醒為行程開始的日期與時刻），不含藥名、行程標題、地點或說明。綁定時，LINE 會把您的 LINE 使用者 ID 傳給我們，用來指定收件人。',
      id: 'Notifikasi tekanan darah pribadi mengirim isi yang sama seperti Telegram: nama tampilan penerima perawatan, sistolik, diastolik, denyut nadi, waktu dan sesi pengukuran, status penilaian beserta standar yang dipakai, serta nama pengirim (diambil dari bagian sebelum @ pada email pengirim). Untuk akun berbayar, pengingat jatuh tempo dan pengingat Google Kalender juga dikirim ke LINE dengan isi yang sama seperti notifikasi pribadi Telegram (nama tampilan penerima perawatan, jenis pengingat, tanggal jatuh tempo, dan jumlah hari tersisa atau terlambat; untuk pengingat kalender, tanggal dan jam mulai acara), tanpa nama obat, judul, lokasi, atau deskripsi acara. Saat menghubungkan, LINE mengirimkan ID pengguna LINE Anda kepada kami untuk menentukan penerima.',
      en: 'Personal blood-pressure notifications send the same content as Telegram: the care recipient’s display name, systolic, diastolic, heartbeat, measurement time and session, the assessed status with the standard used, and the submitter’s name (taken from the part of the submitter’s email before the @). For paid accounts, due reminders and Google Calendar reminders are also sent to LINE with the same content as Telegram personal notifications (the care recipient’s display name, reminder type, due date and days remaining or overdue; for calendar reminders, the event’s start date and time), without medication names or the event’s title, location or description. When you link, LINE sends us your LINE user ID so we know where to deliver.',
    },
    purpose: {
      zh: '目的：讓選用個人通知的家屬在自己的 LINE 即時收到剛量到的血壓，以及到期與行程提醒。',
      id: 'Tujuan: agar anggota keluarga yang memilih notifikasi pribadi langsung menerima tekanan darah yang baru diukur, serta pengingat jatuh tempo dan jadwal, di LINE mereka sendiri.',
      en: 'Purpose: letting family members who choose personal notifications receive a new blood-pressure reading, and due and calendar reminders, right away in their own LINE.',
    },
    location: {
      zh: '處理地區：LINE Messaging API 由 LY Corporation（日本）提供，訊息會在台灣以外的地區處理與保存。訊息一旦送達就留在 LINE 對話紀錄中；在本 App 刪除紀錄或帳號，不會刪除已送出的 LINE 訊息。',
      id: 'Lokasi pemrosesan: LINE Messaging API disediakan oleh LY Corporation (Jepang); pesan diproses dan disimpan di luar Taiwan. Setelah terkirim, pesan tetap ada di riwayat obrolan LINE; menghapus catatan atau akun di aplikasi ini tidak menghapus pesan LINE yang sudah terkirim.',
      en: 'Processing location: the LINE Messaging API is provided by LY Corporation (Japan), and messages are processed and stored outside Taiwan. Once delivered, a message stays in the LINE chat history; deleting records or your account in this app does not delete LINE messages that were already sent.',
    },
    optIn: {
      zh: '是否選用：這是付費功能。只要有對這位照護對象有照護權限的家人在「設定」中綁定了自己的 LINE 帳號，這位照護對象的新血壓紀錄（含記錄者的提交者名稱）與到期、行程提醒就會送到 LINE，即使記錄的人自己沒有綁定。目前 LINE 每筆紀錄通常只送給其中一位已綁定的家人，其他已綁定 LINE 的家人不一定會收到，請不要把 LINE 當成每位家人都會收到的警報。綁定與解除綁定只決定您自己的帳號是否可能收到，可隨時解除；沒有任何家人綁定 LINE 時，就不會有資料送到 LINE。',
      id: 'Opsional atau tidak: ini adalah fitur berbayar. Jika ada anggota keluarga yang memiliki akses perawatan ke penerima perawatan ini dan menghubungkan akun LINE miliknya di "Pengaturan", catatan tekanan darah baru untuk penerima perawatan ini (termasuk nama pengirim) serta pengingat jatuh tempo dan jadwal akan dikirim ke LINE, meskipun orang yang mencatat tidak menghubungkan akunnya. Saat ini LINE biasanya hanya mengirim setiap catatan ke salah satu anggota keluarga yang terhubung; anggota keluarga lain yang menghubungkan LINE belum tentu menerimanya, jadi jangan mengandalkan LINE sebagai peringatan yang diterima setiap anggota keluarga. Menghubungkan atau melepas hanya menentukan apakah akun Anda sendiri dapat menerimanya, dan dapat dilepas kapan saja; jika tidak ada anggota keluarga yang menghubungkan LINE, tidak ada data yang dikirim ke LINE.',
      en: 'Opt-in: this is a paid feature. If family members with care access to this care recipient link their own LINE accounts in Settings, new blood-pressure records for this care recipient (including the submitter’s name) and due and calendar reminders are sent to LINE, even if the person recording has not linked anything. For now, LINE usually delivers each record to only one of the linked family members; other family members who linked LINE may not receive it, so do not rely on LINE as an alert that reaches every family member. Linking or unlinking only controls whether your own account can receive it, and you can unlink at any time; if no family member has linked LINE, no data is sent to LINE.',
    },
  },
  {
    key: 'resend',
    title: { zh: 'Resend（邀請信與續約提醒信寄送）', id: 'Resend (pengiriman email undangan dan pengingat perpanjangan)', en: 'Resend (invitation and renewal reminder emails)' },
    sent: {
      zh: '邀請家人或照護對象時會送出：受邀者的電子郵件地址、固定的三語邀請說明，以及一次性的邀請連結。邀請信不含任何健康數值、照護對象姓名或照片。購買 Premium 的付款人，通常另會在續約扣款日前 7 天內收到一封提醒信：送出付款人的電子郵件地址、續約日期、金額與 App 網址，同樣不含任何健康數值或照護對象姓名。',
      id: 'Saat mengundang anggota keluarga atau penerima perawatan, yang dikirim adalah: alamat email orang yang diundang, teks undangan tetap dalam tiga bahasa, dan tautan undangan sekali pakai. Email undangan tidak memuat data kesehatan, nama penerima perawatan, atau foto. Pembayar yang membeli Premium biasanya juga menerima satu email pengingat dalam 7 hari sebelum tanggal penagihan perpanjangan: yang dikirim adalah alamat email pembayar, tanggal perpanjangan, jumlah tagihan, dan alamat aplikasi, juga tanpa data kesehatan atau nama penerima perawatan.',
      en: 'When you invite a family member or care recipient, we send: the invitee’s email address, a fixed trilingual invitation text, and a one-time invitation link. Invitation emails contain no health values, care-recipient names, or photos. Payers who buy Premium also usually receive one reminder email within the 7 days before the renewal charge date: we send the payer’s email address, the renewal date, the amount, and the app address, again with no health values or care-recipient names.',
    },
    purpose: {
      zh: '目的：把家庭照護邀請寄到受邀者的信箱；提醒付款人即將自動續約。',
      id: 'Tujuan: mengirim undangan perawatan keluarga ke kotak masuk orang yang diundang, dan mengingatkan pembayar tentang perpanjangan otomatis yang akan datang.',
      en: 'Purpose: delivering the family care invitation to the invitee’s inbox, and reminding the payer of an upcoming automatic renewal.',
    },
    location: {
      zh: '處理地區：Resend（Resend, Inc.，美國）是境外的電子郵件寄送服務，資料會在台灣以外的地區處理。',
      id: 'Lokasi pemrosesan: Resend (Resend, Inc., Amerika Serikat) adalah layanan pengiriman email di luar negeri; data diproses di luar Taiwan.',
      en: 'Processing location: Resend (Resend, Inc., United States) is an overseas email delivery service, and data is processed outside Taiwan.',
    },
    optIn: {
      zh: '何時使用：只有在您主動用電子郵件邀請某人，或您是 Premium 的付款人時才會寄出。',
      id: 'Kapan digunakan: hanya dikirim ketika Anda sendiri mengundang seseorang melalui email, atau ketika Anda adalah pembayar Premium.',
      en: 'When it is used: only when you choose to invite someone by email, or when you are the payer for Premium.',
    },
  },
]

// 為什麼健康資料告知頁只列 Telegram 與 LINE：個資法 §6 特種個資的接收者揭露只涉及真正收到健康數值的對象；
// Resend 的邀請信不含任何健康資料，放進「健康資料接收者」反而會誤導使用者以為血壓會被寄到信箱。
export const HEALTH_DATA_NOTIFICATION_RECIPIENTS: LocalizedText = {
  zh: '血壓通知會把照護對象的顯示名稱、收縮壓、舒張壓、心跳、量測時間與時段、判讀狀態與所用的判讀標準（可能反映該照護對象的個別目標），以及提交者名稱（取自提交者電子郵件 @ 前面的帳號名稱）送到兩家境外即時通訊服務：Telegram（Telegram Messenger Inc.），以及 LINE（LY Corporation，日本），資料會在台灣以外的地區處理與保存。沒有共用的家庭群組（2026 年 10 月 9 日起停用），通知只送到自己綁定的家人帳號。個人通知中，危險等級的血壓免費、其他等級需付費：對這位照護對象有照護權限、並在「設定」中綁定自己 Telegram 的家人，每一位都會收到這位照護對象的新血壓紀錄（未付費的家人只收到危險等級，系統暫時讀不到判讀標準時也可能收到警告等級）；綁定 LINE 的家人中，目前每筆紀錄通常只送給其中一位。即使記錄的人自己沒有綁定也會送出；綁定與解除綁定只決定您自己的帳號是否可能收到。回診、抽血、打針、疫苗、藥量等到期提醒送出提醒類型、到期日與剩餘或逾期天數；付費並綁定個人通知的家人，也會在自己的 Telegram 或 LINE 收到這位照護對象的到期提醒與 Google 日曆提醒，內容另帶照護對象的顯示名稱（日曆提醒另含行程開始的日期與時刻），不含藥名、行程標題、地點或說明。已送達的訊息會留在收件人的對話紀錄中，在本 App 刪除資料不會一併刪除這些訊息。',
  id: 'Notifikasi tekanan darah mengirim nama tampilan penerima perawatan, sistolik, diastolik, denyut nadi, waktu dan sesi pengukuran, status penilaian beserta standar yang dipakai (dapat mencerminkan target pribadi penerima perawatan), serta nama pengirim (diambil dari bagian sebelum @ pada email pengirim) ke dua layanan pesan di luar negeri: Telegram (Telegram Messenger Inc.), dan LINE (LY Corporation, Jepang); data diproses dan disimpan di luar Taiwan. Tidak ada grup keluarga bersama (dihentikan sejak 9 Oktober 2026); notifikasi hanya dikirim ke akun anggota keluarga yang menautkannya sendiri. Untuk notifikasi pribadi, tekanan darah tingkat bahaya gratis, tingkat lainnya berbayar: setiap anggota keluarga yang memiliki akses perawatan ke penerima perawatan ini dan menghubungkan akun Telegram miliknya di "Pengaturan" akan menerima catatan tekanan darah baru penerima perawatan ini (anggota keluarga yang tidak berlangganan hanya menerima tingkat bahaya, dan mungkin juga tingkat peringatan saat standar penilaian sementara tidak bisa dibaca); di antara anggota keluarga yang menghubungkan LINE, saat ini setiap catatan biasanya hanya dikirim ke salah satunya. Notifikasi tetap dikirim meskipun orang yang mencatat tidak menghubungkan akunnya; menghubungkan atau melepas hanya menentukan apakah akun Anda sendiri dapat menerimanya. Pengingat jatuh tempo (kontrol dokter, ambil darah, suntikan, vaksin, sisa obat, dll.) mengirim jenis pengingat, tanggal jatuh tempo, dan jumlah hari tersisa atau terlambat; anggota keluarga yang berlangganan dan menghubungkan notifikasi pribadi juga menerima pengingat jatuh tempo dan pengingat Google Kalender untuk penerima perawatan ini di Telegram atau LINE miliknya, dengan tambahan nama tampilan penerima perawatan (pengingat kalender juga memuat tanggal dan jam mulai acara), tanpa nama obat, judul, lokasi, atau deskripsi acara. Pesan yang sudah terkirim tetap ada di riwayat obrolan penerima; menghapus data di aplikasi ini tidak ikut menghapus pesan tersebut.',
  en: 'Blood-pressure notifications send the care recipient’s display name, systolic, diastolic, heartbeat, measurement time and session, the assessed status with the standard used (which may reflect the care recipient’s personal target), and the submitter’s name (taken from the part of the submitter’s email before the @) to two overseas messaging services: Telegram (Telegram Messenger Inc.), and LINE (LY Corporation, Japan); the data is processed and stored outside Taiwan. There is no shared family group (retired on October 9, 2026); notifications go only to the accounts family members linked themselves. Personal notifications for danger-level blood pressure are free and other levels are paid: every family member with care access to this care recipient who links their own Telegram account in Settings receives this care recipient’s new blood-pressure records (family members without a subscription receive only danger-level readings, and possibly warning-level readings while the assessment standard is temporarily unreadable); among family members who link LINE, each record is currently usually delivered to only one of them. Notifications are sent even if the person recording has not linked anything; linking or unlinking only controls whether your own account can receive them. Due reminders (follow-up visits, blood draws, injections, vaccinations, medication supply, etc.) send the reminder type, due date and days remaining or overdue; family members who have a subscription and have linked personal notifications also receive this care recipient’s due reminders and Google Calendar reminders in their own Telegram or LINE, with the care recipient’s display name added (calendar reminders also include the event’s start date and time), without medication names or the event’s title, location or description. Delivered messages stay in the recipient’s chat history; deleting data in this app does not delete those messages.',
}
