/*
檔案用途：付款人 web 畫面（#1185）的三語文案（印尼文 id／繁中 zh／英文 en）；集中在這裡讓元件只管版面。
所在層：src/features/subscription/lib 文案層；沒有任何價格或配額數字——那些由後端經 PlanOffer 傳入。
主要關聯：components/SubscriptionBanner.tsx、SubscriptionSection.tsx、UpgradeDisclosure.tsx；docs/product/monetization-plan.md §6.1（購買前揭露）、§6.2（七日解除權）。
暫定文案：「七日解除權」與「條款」兩段的法律用語，正式字句由 L1（#1183）定案；L1 合併後要回來對一次字（見 PR 說明）。
*/
import type { LocalizedText } from '../../../lib/i18n'
import { GRACE_PERIOD_DAYS } from './billingAudience'

type DateText = (date: string | null) => LocalizedText

// ───── 橫幅 ─────
export const BANNER_COPY = {
  graceTitle: { id: 'Pembayaran Premium belum berhasil', zh: '這期 Premium 扣款沒有成功', en: 'This Premium payment did not go through' } satisfies LocalizedText,
  // 「基礎功能不受影響」是 ticket 指定的固定句，三語都要保留。
  graceBody: ((date) => ({
    id: date ? `Premium tetap berjalan sampai ${date}. Perbarui metode pembayaran agar tidak terputus. Fitur dasar tidak terpengaruh.` : 'Premium tetap berjalan selama masa tenggang. Perbarui metode pembayaran agar tidak terputus. Fitur dasar tidak terpengaruh.',
    zh: date ? `Premium 會照常使用到 ${date}。請更新付款方式，以免中斷；基礎功能不受影響。` : 'Premium 在寬限期內照常使用。請更新付款方式，以免中斷；基礎功能不受影響。',
    en: date ? `Premium keeps working until ${date}. Update your payment method to avoid an interruption. Basic features are not affected.` : 'Premium keeps working during the grace period. Update your payment method to avoid an interruption. Basic features are not affected.',
  })) satisfies DateText,
  updatePayment: { id: 'Perbarui metode pembayaran', zh: '更新付款方式', en: 'Update payment method' } satisfies LocalizedText,
  payerLeftTitle: { id: 'Pembayar sudah keluar', zh: '付款人已離開', en: 'The payer has left' } satisfies LocalizedText,
  // 句子沿用 issue 留言（Codex 第四輪）的字句，只補上「到期前仍可用」。
  payerLeftBody: ((date) => ({
    id: date ? `Perpanjangan otomatis akan berhenti. Premium masih berlaku sampai ${date}. Untuk melanjutkan, silakan berlangganan lagi.` : 'Perpanjangan otomatis akan berhenti. Untuk melanjutkan, silakan berlangganan lagi.',
    zh: date ? `續約將停止，Premium 可使用到 ${date}。要繼續請重新訂閱。` : '續約將停止。要繼續請重新訂閱。',
    en: date ? `Renewal will stop. Premium stays active until ${date}. To continue, subscribe again.` : 'Renewal will stop. To continue, subscribe again.',
  })) satisfies DateText,
  resubscribe: { id: 'Berlangganan lagi', zh: '重新訂閱', en: 'Subscribe again' } satisfies LocalizedText,
  renewalTitle: { id: 'Premium akan diperpanjang otomatis', zh: 'Premium 即將自動續約', en: 'Premium renews soon' } satisfies LocalizedText,
  // 續約提醒也會給不付款的 owner 看，所以不能寫「你的卡」：他們會以為是自己的卡、甚至據此取消別人的訂閱（Codex review）。
  renewalBody: ((date) => ({
    id: date ? `Pada ${date} metode pembayaran yang tersimpan akan ditagih untuk satu bulan berikutnya. Untuk berhenti, batalkan di Pengaturan › Langganan.` : 'Metode pembayaran yang tersimpan akan segera ditagih untuk satu bulan berikutnya. Untuk berhenti, batalkan di Pengaturan › Langganan.',
    zh: date ? `${date} 會用已儲存的付款方式自動扣款，續約下一個月。不想續約請到「設定 → 訂閱」取消。` : '即將用已儲存的付款方式自動扣款，續約下一個月。不想續約請到「設定 → 訂閱」取消。',
    en: date ? `The saved payment method will be charged on ${date} to renew for another month. To stop, cancel in Settings › Subscription.` : 'The saved payment method will be charged soon to renew for another month. To stop, cancel in Settings › Subscription.',
  })) satisfies DateText,
}

// ───── 設定頁「訂閱」區 ─────
export const SECTION_COPY = {
  title: { id: 'Langganan', zh: '訂閱', en: 'Subscription' } satisfies LocalizedText,
  statusNone: { id: 'Belum berlangganan (paket gratis)', zh: '尚未訂閱（免費方案）', en: 'Not subscribed (free plan)' } satisfies LocalizedText,
  statusActive: { id: 'Premium aktif', zh: 'Premium 使用中', en: 'Premium is active' } satisfies LocalizedText,
  statusGrace: { id: 'Pembayaran gagal — masa tenggang', zh: '扣款失敗，寬限中', en: 'Payment failed — grace period' } satisfies LocalizedText,
  // 「取消處理中」：藍新委託尚未確認終止，不能對付款人說「已取消」（ADR-012 D6）。
  statusCancelRequested: { id: 'Pembatalan sedang diproses', zh: '取消處理中', en: 'Cancellation in progress' } satisfies LocalizedText,
  statusCancelled: { id: 'Dibatalkan — berlaku sampai periode berakhir', zh: '已取消，使用到本期結束', en: 'Cancelled — active until the period ends' } satisfies LocalizedText,
  activeUntil: ((date) => ({
    id: date ? `Berlaku sampai ${date}` : 'Tanggal berakhir belum tersedia',
    zh: date ? `使用到 ${date}` : '到期日暫時無法顯示',
    en: date ? `Active until ${date}` : 'The end date is not available right now',
  })) satisfies DateText,
  cancelRequestedNote: {
    id: 'Kami sedang memastikan penagihan otomatis dihentikan. Selama proses ini, pembatalan masih bisa dibatalkan.',
    zh: '我們正在向金流確認終止自動扣款。這段期間仍可撤回取消。',
    en: 'We are confirming that automatic charging has stopped. Until then, the cancellation can still be undone.',
  } satisfies LocalizedText,
  onlyPayerCanResume: {
    id: 'Hanya pembayar yang dapat membatalkan pembatalan ini.',
    zh: '只有付款人本人可以撤回這次取消。',
    en: 'Only the payer can undo this cancellation.',
  } satisfies LocalizedText,
  cancel: { id: 'Batalkan langganan', zh: '取消訂閱', en: 'Cancel subscription' } satisfies LocalizedText,
  cancelConfirm: ((date) => ({
    id: date ? `Yakin ingin membatalkan? Periode yang sudah dibayar tetap bisa dipakai sampai ${date}.` : 'Yakin ingin membatalkan? Periode yang sudah dibayar tetap bisa dipakai.',
    zh: date ? `確定要取消嗎？已付費的這一期仍可使用到 ${date}。` : '確定要取消嗎？已付費的這一期仍可使用。',
    en: date ? `Cancel for sure? The period you already paid for stays active until ${date}.` : 'Cancel for sure? The period you already paid for stays active.',
  })) satisfies DateText,
  cancelYes: { id: 'Ya, batalkan', zh: '確定取消', en: 'Yes, cancel' } satisfies LocalizedText,
  cancelKeep: { id: 'Jangan dulu', zh: '先不要', en: 'Not now' } satisfies LocalizedText,
  resume: { id: 'Batalkan pembatalan', zh: '撤回取消', en: 'Undo cancellation' } satisfies LocalizedText,
  seePlan: { id: 'Lihat paket Premium', zh: '查看 Premium 方案', en: 'See the Premium plan' } satisfies LocalizedText,
  receiptsTitle: { id: 'Bukti pembayaran', zh: '收據', en: 'Receipts' } satisfies LocalizedText,
  receiptsEmpty: { id: 'Belum ada pembayaran.', zh: '還沒有付款紀錄。', en: 'No payments yet.' } satisfies LocalizedText,
  receiptPeriod: { id: 'Periode', zh: '期間', en: 'Period' } satisfies LocalizedText,
  receiptOrderNo: { id: 'Nomor pesanan', zh: '訂單編號', en: 'Order no.' } satisfies LocalizedText,
  receiptPlan: { id: 'Premium bulanan', zh: 'Premium 月繳', en: 'Premium, monthly' } satisfies LocalizedText,
}

// ───── 升級頁（購買前揭露，monetization-plan §6.1） ─────
export const UPGRADE_COPY = {
  title: { id: 'Tingkatkan ke Premium', zh: '升級 Premium', en: 'Upgrade to Premium' } satisfies LocalizedText,
  intro: {
    id: 'Fitur dasar — termasuk catatan kesehatan dan peringatan tekanan darah berbahaya — tetap gratis. Premium menambah fitur lanjutan untuk seluruh keluarga.',
    zh: '基本功能（含健康紀錄與危險血壓警報）一直免費。Premium 為全家加上進階功能。',
    en: 'Core features, including health records and dangerous blood-pressure alerts, stay free. Premium adds advanced features for the whole household.',
  } satisfies LocalizedText,
  includesTitle: { id: 'Isi paket', zh: '方案內容', en: 'What is included' } satisfies LocalizedText,
  featureAi: ((n: number) => ({
    id: `Draf resep dengan AI: hingga ${n} kali per hari untuk satu keluarga`,
    zh: `AI 藥單草稿：全家每天最多 ${n} 次`,
    en: `AI medication drafts: up to ${n} per day for the whole household`,
  })) satisfies (n: number) => LocalizedText,
  featureNotifications: {
    id: 'Notifikasi pribadi lengkap: tingkat peringatan, pengingat, dan LINE',
    zh: '完整個人通知：警告級、提醒類與 LINE',
    en: 'Full personal notifications: warning levels, reminders, and LINE',
  } satisfies LocalizedText,
  // 升級不回溯照片是 owner 5.6.3 的決定，購買前就要講清楚，否則付款人會以為舊照片也延長。
  featurePhotos: ((n: number) => ({
    id: `Foto disimpan hingga ${n} hari (berlaku untuk foto yang diunggah setelah berlangganan)`,
    zh: `照片最長保存 ${n} 天（訂閱後新上傳的照片適用）`,
    en: `Photos kept for up to ${n} days (applies to photos uploaded after you subscribe)`,
  })) satisfies (n: number) => LocalizedText,
  featureRecipients: ((n: number) => ({
    id: `Hingga ${n} orang atau hewan yang dirawat per keluarga`,
    zh: `每個家庭最多 ${n} 位被照顧者`,
    en: `Up to ${n} care recipients per household`,
  })) satisfies (n: number) => LocalizedText,
  pricePerMonth: ((price: string) => ({ id: `${price} per bulan`, zh: `${price}／月`, en: `${price} per month` })) satisfies (price: string) => LocalizedText,
  termsTitle: { id: 'Sebelum membayar', zh: '付款前請確認', en: 'Before you pay' } satisfies LocalizedText,
  autoRenew: {
    id: 'Langganan diperpanjang otomatis setiap bulan dan ditagih ke kartu kredit Anda sampai Anda membatalkan.',
    zh: '每月自動續約，從你的信用卡扣款，直到你取消為止。',
    en: 'The subscription renews every month and is charged to your credit card until you cancel.',
  } satisfies LocalizedText,
  cancelHow: {
    id: 'Anda bisa membatalkan kapan saja di Pengaturan › Langganan. Setelah dibatalkan, Premium tetap berlaku sampai periode yang sudah dibayar berakhir.',
    zh: '隨時可以在「設定 → 訂閱」取消；取消後，已付費的這一期仍可使用到結束。',
    en: 'You can cancel any time in Settings › Subscription. After cancelling, Premium stays active until the period you paid for ends.',
  } satisfies LocalizedText,
  graceAndDowngrade: (() => ({
    id: `Jika penagihan gagal, ada masa tenggang ${GRACE_PERIOD_DAYS} hari dan Premium tetap berjalan. Jika tetap belum terbayar, keluarga kembali ke paket gratis: fitur dasar dan data yang sudah ada tidak hilang.`,
    zh: `扣款失敗時有 ${GRACE_PERIOD_DAYS} 天寬限期，期間 Premium 照常；仍未補付就回到免費方案，基礎功能與既有資料都不會消失。`,
    en: `If a charge fails, there is a ${GRACE_PERIOD_DAYS}-day grace period and Premium keeps working. If it is still unpaid, the household returns to the free plan; basic features and existing data are not lost.`,
  })) satisfies () => LocalizedText,
  payOnProviderPage: {
    id: 'Pembayaran dilakukan di halaman aman penyedia pembayaran. Kami tidak melihat atau menyimpan nomor kartu Anda.',
    zh: '付款在金流業者的安全頁面完成，我們不會看到或保存你的卡號。',
    en: 'Payment is made on the payment provider’s secure page. We never see or store your card number.',
  } satisfies LocalizedText,
  termsCheckbox: ((version: string) => ({
    id: `Saya telah membaca dan menyetujui syarat paket berbayar (versi ${version}).`,
    zh: `我已閱讀並同意付費方案條款（版本 ${version}）。`,
    en: `I have read and agree to the paid-plan terms (version ${version}).`,
  })) satisfies (version: string) => LocalizedText,
  termsLink: { id: 'Baca syarat layanan', zh: '閱讀服務條款', en: 'Read the Terms of Service' } satisfies LocalizedText,
  // 獨立於條款勾選（owner 6.5.2：不得合併成一格）；字句暫定，L1 定案後回來對。
  waiverCheckbox: {
    id: 'Saya mengerti dan setuju bahwa layanan online ini langsung diberikan begitu langganan dimulai, sehingga hak pembatalan tujuh hari tidak berlaku.',
    zh: '我了解並同意：訂閱一開始就會立即提供線上服務，因此不適用七日解除權（鑑賞期）。',
    en: 'I understand and agree that this online service starts immediately once the subscription begins, so the seven-day right of withdrawal does not apply.',
  } satisfies LocalizedText,
  continue: { id: 'Lanjut ke pembayaran', zh: '前往付款', en: 'Continue to payment' } satisfies LocalizedText,
  tickBoth: { id: 'Centang kedua kotak di atas untuk melanjutkan.', zh: '請先勾選上面兩個方框。', en: 'Tick both boxes above to continue.' } satisfies LocalizedText,
}
