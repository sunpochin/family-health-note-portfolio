/*
檔案用途：顯示家健錄公開的服務條款與聯絡、版本資訊。
所在層：src/features/system-admin/pages 公開頁面層；未登入也能閱讀，不會讀取照護資料。
主要關聯：由 App.tsx 依 /terms 路徑呈現，使用 appInfo.ts 的統一版本與發布代號。
  頁首「最後更新日期」＝ lib/legalConsent.ts 的 CURRENT_TERMS_VERSION，也就是同意紀錄裡的 terms_version（issue #1124）。
  改本頁任何條款文字（不只第 5 節）都要：改三語頁首日期 → 照 CURRENT_TERMS_VERSION 的註解升版與加 migration →
  在 PrivacyPolicyUpdateScreen 換上累積的變動摘要。漏改日期，之後的同意都會把新文字記成舊版本；測試只比對日期，看不到文字改動。
  注意：條款單獨升版不會讓既有使用者看到那個畫面（owner 決策），摘要要等下次隱私政策升版才會出現。
  縮減免費功能、而且隱私政策沒有同時升版時：把 lib/legalConsent.ts 的 TERMS_REQUIRES_RECONSENT 設成 true，
  讓條款落後的人也必須先看過那個畫面（monetization-plan §6.3 選項 c）；只升條款、不縮減免費功能時維持 false。
  2026-10-07（issue #1183）：第 6 節付費方案、第 7 節退款政策的文案在 ../paidPlanTermsCopy.ts；頁首日期同時是付費條款版本，
  資料庫的 current_paid_terms_version() 要在同一支 migration 跟著改（建單 RPC 只接受它）。
*/
import { useI18n, type LocalizedText } from '../../../lib/i18n'
import { LanguageSwitcher } from '../../../components/ui/LanguageSwitcher'
import { APP_NAME, APP_AUTHOR_URL } from '../../../lib/appInfo'
import { ReleaseVersion } from '../../../components/system/ReleaseVersion'
import { Icon } from '../../../components/ui/Icon'
import { CURRENT_TERMS_VERSION } from '../../../lib/legalConsent'
import {
  PAID_PLAN_CLAUSES,
  PAID_PLAN_INTRO,
  PAID_PLAN_SECTION_TITLE,
  REFUND_CLAUSES,
  REFUND_SECTION_TITLE,
  type TermsClause,
} from '../paidPlanTermsCopy'

// 第 6、7 節共用：粗體標籤＋一句內容，與 PrivacyPage 的條列寫法一致，長段落拆成可掃讀的小條。
// 刻意寫成普通函式而不是 <ClauseList /> 元件：單元測試以函式呼叫 render TermsPage、不展開子元件，
// 包成元件後第 6、7 節的條款文字在測試裡會整段消失（tests/unit/paidPlanTermsCopy.test.ts 逐語言檢查這些文字）。
function renderClauseList(clauses: ReadonlyArray<TermsClause>, text: (value: LocalizedText) => string) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
      {clauses.map(clause => (
        <li key={clause.key}>
          <span className="font-semibold">{text(clause.label)}</span>{' '}
          {text(clause.body)}
        </li>
      ))}
    </ul>
  )
}

// 為什麼補足 44px：手機上的獨立操作要留出足夠點擊面，降低漏點與誤觸。
export function TermsPage() {
  const { text } = useI18n()

  const goHome = () => {
    window.location.href = '/'
  }

  return (
    <div className="min-h-dvh bg-slate-50 text-slate-900">
      <header className="sticky top-0 z-10 border-b border-slate-200 bg-white px-4 py-3 shadow-xs">
        <div className="mx-auto flex max-w-2xl items-center justify-between">
          <button
            onClick={goHome}
            className="flex items-center gap-1 text-sm font-bold text-slate-700 hover:text-slate-900 active:text-brand-700 min-h-11"
          >
            <span>←</span>
            <span>{text({ id: 'Kembali ke Beranda', zh: '返回首頁' ,en: 'Back to Home' })}</span>
          </button>
          <LanguageSwitcher />
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-5 py-8">
        <article className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8 space-y-6">
          <div>
            <span className="inline-block rounded-lg bg-emerald-50 px-2.5 py-1 text-xs font-extrabold text-emerald-700">
              {text({ id: 'Syarat & Ketentuan Layanan', zh: '服務條款與合規說明', en: 'Terms of Service and Compliance Instructions' })}
            </span>
            <h1 className="mt-2 text-2xl font-black tracking-tight text-slate-900 md:text-3xl">
              {text({ id: 'Syarat & Ketentuan', zh: '服務條款', en: 'Terms of Service' })}
            </h1>
            <p className="text-xs text-slate-500">
              {/* 這個日期就是同意紀錄的條款版本（#1124）：改任何條款文字都要改它，程序見檔頭。 */}
              {text({ id: 'Terakhir diperbarui: 7 Oktober 2026', zh: '最後更新日期：2026 年 10 月 7 日', en: 'Last updated: October 7, 2026' })}
            </p>
          </div>

          <hr className="border-slate-100" />

          {/* 1. Penerimaan Syarat */}
          <section className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              1. {text({ id: 'Penerimaan Syarat', zh: '條款接受', en: 'Terms Acceptance' })}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              {/* 繁體中文註解：條款必須與首頁使用同一個品牌常數，印尼文與英文同步更新為新英文識別 Family Health Note。 */}
              {text({
                id: 'Dengan melanjutkan dari halaman masuk, Anda menyetujui untuk terikat oleh Syarat & Ketentuan Family Health Note ini. Data kesehatan dan medis memerlukan persetujuan tegas terpisah berdasarkan Pemberitahuan Pengumpulan Data Pribadi.',
                zh: `當您從登入頁繼續使用「${APP_NAME}」時，即代表您同意並遵守本服務條款。健康與醫療資料另依《個人資料蒐集告知事項》取得明確同意。`,
                en: 'By continuing from the sign-in page, you agree to be bound by these Family Health Note Terms of Service. Health and medical data requires separate explicit consent under the Health Data Privacy Notice.',
              })}
            </p>
          </section>

          {/* 2. Penolakan Medis (Medical Disclaimer) */}
          <section className="space-y-2">
            <h2 className="text-base font-bold font-extrabold text-amber-800">
              2. {text({ id: 'Penolakan Medis (PENTING)', zh: '醫療免責聲明（重要）' ,en: 'Medical Disclaimer (IMPORTANT)' })}
            </h2>
            <div className="rounded-2xl bg-amber-50 p-4 border border-amber-200 text-sm leading-relaxed text-amber-900 space-y-2">
              <p className="font-bold">
                <Icon name="alert-triangle" className="mr-1.5 inline-block h-4 w-4 align-text-bottom" />{text({
                  id: 'Layanan ini BUKAN perangkat medis dan BUKAN pengganti saran medis profesional.',
                  zh: '本服務非醫療器材，亦不可取代專業醫師之診斷與醫療建議。' ,en: 'This service is not a medical device, nor can it replace the diagnosis and medical advice of a professional doctor.'
                })}
              </p>
              <p>
                {text({
                  id: 'Aplikasi ini hanya berfungsi sebagai alat bantu pencatatan kesehatan mandiri dan perawatan keluarga. Evaluasi sistem atau label peringatan bukan merupakan diagnosis medis. Selalu konsultasikan dengan dokter sebelum mengubah dosis obat.',
                  zh: '本應用程式僅供自主健康紀錄與家庭照護對照之用。系統提示與分級警示並非醫療診斷。在調整任何藥物劑量或療程前，請務必諮詢專業醫師。' ,en: 'This app is only for autonomous health records and home care matching. System prompts and grading alerts are not medical diagnostics. Always consult a specialist before adjusting any medication dose or course of treatment.'
                })}
              </p>
            </div>
          </section>

          {/* 3. Keamanan Akun */}
          <section className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              3. {text({ id: 'Keamanan Akun Pengguna', zh: '帳號與資料安全' ,en: 'Account and data security' })}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Pengguna bertanggung jawab untuk menjaga kerahasiaan akun Google mereka. Setiap tindakan yang dilakukan menggunakan akun Anda akan dianggap sebagai tindakan Anda.',
                zh: '使用者有責任妥善保管其 Google 登入帳號安全。任何透過該帳號進行之操作均視為使用者本人之行為。' ,en: 'It is the user’s responsibility to keep their Google sign in account secure. Any action taken through that account is considered to be the user’s own action.'
              })}
            </p>
          </section>

          {/* 4. Hak Pembatalan & Penghapusan */}
          <section className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              4. {text({ id: 'Penghapusan Akun & Layanan', zh: '帳號刪除與服務變更' ,en: 'Account deletion and service changes' })}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                // 「依法須保存的付款紀錄除外」（issue #1183）：payment_orders 的 household_id 與 payment_events 刻意不掛外鍵，
                // payer_user_id 是 ON DELETE SET NULL——刪帳號後帳務列依稅法保留、只解除與帳號的連結；不加這句，「清除所有個人紀錄」對付款人就是不實承諾。
                id: 'Anda dapat menghentikan penggunaan layanan dan menghapus seluruh akun serta data pribadi kapan saja melalui menu Pengaturan di dalam aplikasi, kecuali catatan pembayaran yang wajib disimpan menurut hukum (lihat Kebijakan Privasi).',
                zh: '您可隨時於應用程式內之「設定」選單自主刪除帳號並清除所有個人紀錄，立即終止服務；依法須保存的付款紀錄除外（見《隱私權政策》）。' ,en: 'You can terminate the service immediately by deleting your account and clearing all personal records at any time from the Settings menu in the app, except payment records that must be kept by law (see the Privacy Policy).'
              })}
            </p>
          </section>

          {/* 5. Biaya Layanan：對應登入頁費用說明區塊（issue #444、#1047）。
              為什麼不再寫「完全免費、無付費功能」：app 內已有付費升級提示（AI 藥袋辨識超過免費次數），
              條款說沒有付費功能就是對外承諾與實際行為矛盾。免費清單對照 docs/adr/011-paywall-safety-boundary.md D2
              （owner 已定「永遠免費」範圍），不要在這裡自行增減；也不寫價格與金流供應商，那些仍在 #1037 規劃中。
              條款版本自 #1124 起會記進同意紀錄：頁首「最後更新日期」＝ lib/legalConsent.ts 的 CURRENT_TERMS_VERSION
              ＝ legal_policy_version_rank('terms') 白名單最後一項，三者由 tests/unit/notificationProviderDisclosures.test.ts 鎖住。
              改這頁任何條款文字都要一起改頁首日期並照該常數的註解升版，否則同意紀錄會把新文字記成舊版本。
              條款升版不單獨跳同意畫面（owner 決策），變動摘要要寫進 PrivacyPolicyUpdateScreen。
              免費清單只列「現在真的用得到」的功能：基礎 Vision OCR 的前端入口自 2026-09-11 起隱藏（production 沒有
              Vision key，見 docs/features/medication.md），所以只用一句「目前暫停、恢復後仍免費」交代，不放進清單；
              恢復入口時要同步拿掉這句。每日上限也只說「部分功能」：用藥紀錄、CSV 匯出、刪除帳號都沒有計量。
              2026-10-07（issue #1183）：補「AI 藥單辨識的每日次數以每個家庭合計」——只有 llm_draft 改成家庭級（monetization-plan §2.5）；
              每日記錄筆數仍按記錄者、基礎辨識仍按照護對象，所以不能寫成「所有上限都以家庭計算」。這句的行為由 H2 #1177 實作，
              本條款不得早於 H2 上 production（見 PR 說明的發布前提）。付費方案的價格與供應商名稱仍不寫，細節在第 6、7 節。
              id="fees" 只給測試定位第 5 節的免費清單（第 6、7 節也有條列）。 */}
          <section id="fees" className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              5. {text({ id: 'Biaya Layanan', zh: '服務費用', en: 'Service Fees' })}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Fitur dasar layanan ini gratis selamanya, meliputi:',
                zh: '本服務的基礎功能永遠免費，包括：',
                en: 'The core features of this service are always free, including:',
              })}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-600">
              <li>
                {text({
                  id: 'Catatan kesehatan seperti tekanan darah, suhu, dan berat badan, serta penilaian tekanan darah dan peringatan tekanan darah tingkat bahaya',
                  zh: '血壓、體溫、體重等健康紀錄，以及血壓判讀與危險等級的血壓警報',
                  en: 'Health records such as blood pressure, temperature, and weight, plus blood pressure assessment and danger-level blood pressure alerts',
                })}
              </li>
              <li>
                {text({
                  id: 'Jadwal obat dan catatan minum obat',
                  zh: '用藥計畫與用藥紀錄',
                  en: 'Medication plans and medication records',
                })}
              </li>
              <li>
                {text({
                  id: 'Ekspor CSV dan penghapusan akun',
                  zh: 'CSV 匯出與刪除帳號',
                  en: 'CSV export and account deletion',
                })}
              </li>
            </ul>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Pembacaan teks kemasan obat versi dasar (OCR) saat ini dihentikan sementara; setelah tersedia kembali, fitur ini tetap gratis.',
                zh: '基礎版藥袋文字辨識（OCR）目前暫停提供；恢復提供後仍為免費功能。',
                en: 'Basic medication-bag text recognition (OCR) is currently paused; it remains a free feature once it returns.',
              })}
            </p>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Untuk mencegah penyalahgunaan, sebagian fitur (misalnya jumlah catatan per hari dan jumlah pemindaian kemasan obat) memiliki batas pemakaian harian.',
                zh: '為防止濫用，部分功能（例如每日可記錄的筆數、藥袋辨識次數）設有每日使用上限。',
                en: 'To prevent abuse, some features (for example, the number of records per day and the number of medication-bag scans) have daily usage limits.',
              })}
            </p>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Jatah harian pemindaian resep AI dihitung per keluarga: semua penerima perawatan dalam keluarga yang sama berbagi satu jatah harian.',
                zh: 'AI 藥單辨識的每日次數以「每個家庭」合計：同一個家庭的所有照護對象共用同一份每日次數。',
                en: 'The daily allowance for AI prescription scanning is counted per household: all care recipients in the same household share one daily allowance.',
              })}
            </p>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                // #1047 承諾「開放前先在本頁公告」：第 6、7 節就是這份公告；價格仍只在購買頁（以購買當時顯示為準）。
                id: 'Fitur lanjutan bersifat berbayar, misalnya pemindaian resep AI yang melebihi jatah gratis harian. Isi dan ketentuan paket berbayar dijelaskan di Bagian 6 dan 7; harga mengikuti yang ditampilkan di halaman pembelian saat membeli.',
                zh: '進階功能需付費，例如 AI 藥單辨識超過每日免費次數的部分。付費方案的內容與規則見第 6、7 節；價格以購買當時購買頁面顯示為準。',
                en: 'Advanced features are paid, for example AI prescription scanning beyond the daily free quota. The paid plan’s contents and rules are set out in Sections 6 and 7; the price is as shown on the purchase page at the time of purchase.',
              })}
            </p>
          </section>

          {/* 6. 付費方案（issue #1183）：版本字串＝CURRENT_TERMS_VERSION＝current_paid_terms_version()，購買頁的獨立勾選記的就是它。 */}
          <section id="paid-plan" className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              6. {text(PAID_PLAN_SECTION_TITLE)}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">{text(PAID_PLAN_INTRO)}</p>
            {renderClauseList(PAID_PLAN_CLAUSES, text)}
            <p className="text-xs text-slate-500">
              {text({
                id: `Versi ketentuan paket berbayar: ${CURRENT_TERMS_VERSION}. Saat membeli, Anda akan diminta menyetujui versi ini secara terpisah.`,
                zh: `付費方案條款版本：${CURRENT_TERMS_VERSION}。購買時會請您另行勾選同意這一版。`,
                en: `Paid plan terms version: ${CURRENT_TERMS_VERSION}. When you buy, you will be asked to agree to this version separately.`,
              })}
            </p>
          </section>

          {/* 7. 退款政策（issue #1183）：七日解除權立場是 owner 6.5.2 的決定；法務未確認的部分只寫「以購買頁面公告為準」。 */}
          <section id="refund" className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              7. {text(REFUND_SECTION_TITLE)}
            </h2>
            {renderClauseList(REFUND_CLAUSES, text)}
          </section>

          {/* 8. Hubungi Kami */}
          <section className="space-y-2">
            <h2 className="text-base font-bold text-slate-900">
              8. {text({ id: 'Hubungi Kami', zh: '聯絡方式', en: 'Contact' })}
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              {text({
                id: 'Untuk pertanyaan atau saran mengenai Syarat & Ketentuan ini, silakan hubungi:',
                zh: '若對本服務條款有任何疑問，請聯繫：',
                en: 'If you have any questions or suggestions regarding these Terms of Service, please contact:',
              })}
            </p>
            <p className="text-sm font-semibold text-brand-700">
              admin@careapp.local
            </p>
          </section>

          <section className="border-t border-slate-100 pt-5 text-sm text-slate-600">
            <h2 className="font-bold text-slate-900">{text({ id: 'Kontak & Versi', zh: '聯絡方式與版本', en: 'Contact & Version' })}</h2>
            {/* 將聯絡我導向作者個人網站，提供完整簡介與聯繫方式 */}
            <p className="mt-2">{text({ id: 'Hubungi saya', zh: '聯絡我', en: 'Contact me' })}: <a className="font-semibold text-brand-700 underline" href={APP_AUTHOR_URL} target="_blank" rel="noreferrer">https://demo-xq7.github.io/</a></p>
            <p className="mt-1"><a className="text-brand-700 underline" href="https://github.com/demo-xq7" target="_blank" rel="noreferrer">GitHub / demo-xq7</a> · <ReleaseVersion /></p>
          </section>
        </article>
      </main>
    </div>
  )
}
