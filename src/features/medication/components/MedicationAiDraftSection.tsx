/*
檔案用途：拍藥袋照片（或從相簿選擇既有照片）→ 呼叫 medication-ai-draft Edge Function（#663）→
顯示可核對的結構化草稿卡片，確認後把欄位預填進既有的新增用藥表單；本身不寫入任何藥單資料，
草稿永遠只預填表單。免費家庭也能每天試用少量次數（issue #683 推廣策略），用完顯示升級 Premium
提示，付費家庭用完則只顯示單純的「明天再試」；付費加值被全域暫停時（#1177 kill switch）顯示「暫停提供」、
不推銷升級。並保留基礎 Vision OCR 作為備援入口。
所在層：src/features/medication/components；掛在 MedicationAdminSection 上方，上傳與錯誤處理照抄
MedicationPhotoOcrSection.tsx 的既有慣例（壓縮預算、invoke header、invokeError.context 讀取）；
拍照／選擇既有照片雙按鈕比照 CareTimeline.tsx 的既有慣例（兩個各自獨立的隱藏 file input，
差別只在有沒有 capture="environment"）。
主要關聯：supabase/functions/medication-ai-draft、lib/careEventPhotos.ts 的 prepareSingleCompressedImage、
lib/medication/medicationPhotoInvoke.ts（invoke 的 body 與標頭，與 MedicationPhotoOcrSection 共用）、
lib/medication/medicationAiDraft.ts 的形狀驗證與 draftMatchesPatient 病人綁定判斷式、
MedicationAdminSection 掛載本元件並把 onApplyDraft 接到 useMedicationAdminForm 的 applyDraft。
*/
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../lib/supabase'
import { prepareSingleCompressedImage } from '../../../lib/careEventPhotos'
import { buildMedicationPhotoInvokeOptions } from '../../../lib/medication/medicationPhotoInvoke'
import { draftMatchesPatient, parseMedicationAiDraftResponse, type MedicationAiDraftResponse, type MedicationDraftDosageForm, type MedicationDraftItem } from '../../../lib/medication/medicationAiDraft'
import { type LocalizedText, useI18n } from '../../../lib/i18n'
import { isDemoMode } from '../../../lib/demoStorage'
import { MedicationPhotoOcrSection } from './MedicationPhotoOcrSection'
import { Icon } from '../../../components/ui/Icon'

// 跟 medication-ai-draft/index.ts 的 MAX_IMAGE_BYTES 呼應：這裡先把照片壓到遠低於 2MB 的預算，
// Function 端的上限只是防止有人繞過前端直接打 API，不是預期路徑。跟 MedicationPhotoOcrSection
// 用同一組壓縮參數，不需要縮圖，因為這張照片辨識完就丟，不會被瀏覽。
const DRAFT_PHOTO_MAX_DIMENSION = 1800
const DRAFT_PHOTO_MAX_BYTES = 600 * 1024

// 配額用完時，Edge Function 429 回應會帶 tier、freeDailyLimit 與 suspended（#1177）；
// 用一個獨立的例外類別把這些值從 invoke 錯誤處理帶到外層 catch，
// 不能只靠 Error.message（那裡已經用來放錯誤代碼字串）夾帶結構化資訊。
class DailyQuotaExceededError extends Error {
  constructor(readonly tier: string | undefined, readonly freeDailyLimit: number | undefined, readonly suspended: boolean) {
    super('daily_medication_ai_draft_limit')
  }
}

// 額度用完（不論免費或付費）當天都不可能再拍出結果，繼續顯示「拍照」「選照片」兩個按鈕只會誘使
// 照護者白白等一次失敗；用單一 union state 同時涵蓋兩種 tier，讓下方渲染只用一個條件就能決定
// 要不要整組隱藏按鈕，不用同時檢查兩個各自獨立的 boolean/物件 state。
// 'suspended'：付費加值被全域暫停、所有家庭都退回免費額度（#1177）。此時叫人「升級 Premium」是錯的——
// 付費家庭已經是 Premium，升級也拿不回次數——所以獨立一種狀態、獨立一段文案。
type QuotaExceededState = { tier: 'free'; freeDailyLimit: number } | { tier: 'paid' } | { tier: 'suspended'; freeDailyLimit: number }

// 為什麼三種語言要在同一個物件補齊：草稿可能在按鈕、處理中、空結果與每一個錯誤路徑出現，
// 不能讓切換語言後漏出另一語言或空白。錯誤碼照抄 MedicationPhotoOcrSection 的 ERROR_MESSAGES map 模式，
// 對齊 supabase/functions/medication-ai-draft/index.ts 實際會回傳的 error 欄位。
const ERROR_MESSAGES: Record<string, LocalizedText> = {
  medication_ai_draft_not_entitled: {
    id: 'Akun ini belum mengaktifkan pemindaian resep AI. Hubungi pengelola akun untuk mengaktifkannya, atau gunakan input manual di bawah.',
    zh: '此帳號尚未開通 AI 藥單辨識，請聯絡帳號管理者開通，或改用下方手動輸入。',
    en: 'This account has not enabled AI prescription scanning. Contact your account administrator to enable it, or use manual input below.',
  },
  medication_ai_draft_not_configured: {
    id: 'Pemindaian resep AI belum aktif, silakan gunakan input manual di bawah.',
    zh: 'AI 藥單辨識尚未開通，請改用下方手動輸入。',
    en: 'AI prescription scanning is not enabled yet. Please use manual input below.',
  },
  medication_ai_draft_unavailable: {
    id: 'Pemindaian resep AI gagal, silakan gunakan input manual di bawah.',
    zh: 'AI 藥單辨識失敗，請改用下方手動輸入。',
    en: 'AI prescription scanning failed. Please use manual input below.',
  },
  'not authorized for this patient': {
    id: 'Anda tidak berwenang mengelola obat untuk orang ini.',
    zh: '您沒有權限為這位病人管理藥單。',
    en: 'You are not authorized to manage medicines for this patient.',
  },
}
const FALLBACK_ERROR: LocalizedText = ERROR_MESSAGES.medication_ai_draft_unavailable

const DOSAGE_FORM_LABELS: Record<MedicationDraftDosageForm, LocalizedText> = {
  tablet: { id: 'Tablet', zh: '錠劑', en: 'Tablet' },
  capsule: { id: 'Kapsul', zh: '膠囊', en: 'Capsule' },
  liquid: { id: 'Cair', zh: '液體', en: 'Liquid' },
  powder: { id: 'Bubuk (sachet)', zh: '粉劑（一包）', en: 'Powder (sachet)' },
}

const NOT_READ_HINT: LocalizedText = {
  id: 'Tidak terbaca di kemasan, isi sendiri.',
  zh: '藥袋上沒讀到，請自行填寫。',
  en: 'Not readable on the package — please fill in yourself.',
}

const REFERENCE_ONLY_NOTE: LocalizedText = {
  id: 'Jumlah per hari dan waktu minum hanya referensi dan tidak diisi otomatis ke formulir; pilih sendiri jadwal minum untuk setiap kali di bawah.',
  zh: '「一天次數」與「服藥時機」僅供參考，不會自動填入表單；請自行依此在下方為每次服用選擇正確時段。',
  en: 'Times per day and timing are reference only and are not auto-filled into the form; choose the correct schedule slot for each dose yourself below.',
}

// 展示模式的固定示範結果：這張照片內容完全不會被讀取，選了任何圖片都套用同一份劇本。
// 內容刻意對齊 demoData.ts 既有故事裡王美玲已經在吃的降壓藥（Concor、Exforge），讓訪客切回
// 每日照護分頁時，藥單卡片上看到的名字跟這裡「AI 讀到的」是同一組，不會產生「這是另一個世界」的違和感。
// 第二筆刻意給 confidence: 'low'，順便示範低信心警示卡長什麼樣子——訪客不用真的拍到一張模糊照片才看得到。
function buildDemoScriptedDraft(patientId: string): MedicationAiDraftResponse {
  return {
    patientId,
    items: [
      { brandName: 'Concor', genericName: 'Bisoprolol', strengthLabel: '5 mg', dosageForm: 'tablet', doseAmount: 0.5, timesPerDay: 1, timingHint: 'Pagi setelah makan', confidence: 'high' },
      { brandName: 'Exforge', genericName: 'Amlodipine / Valsartan', strengthLabel: '5/80 mg', dosageForm: 'tablet', doseAmount: 0.5, timesPerDay: 1, timingHint: null, confidence: 'low' },
    ],
  }
}
// 「辨識中」到出現結果之間刻意留一小段停頓：純粹是節奏，讓這一步感覺「發生了什麼」，
// 不是照片一選就瞬間跳出結果；沒有這段停頓，示範結果的誠實標籤反而會顯得更假。
export const DEMO_SCRIPTED_DRAFT_DELAY_MS = 700

const DEMO_RESULT_BADGE: LocalizedText = {
  id: 'Hasil contoh — tidak benar-benar memanggil AI',
  zh: '示範結果，未實際呼叫 AI',
  en: 'Sample result — no AI call was made',
}

// 標題刻意寫得像「好消息」而非「壞消息」：免費用戶用完額度代表他已經體驗過 AI 辨識的價值，
// 這是轉付費的最佳時機點，文案要正向強化「這東西值得用」，不是單純道歉式的「額度用完了」。
// 正向語氣靠用字，不靠裝飾 emoji：原本標題前的 🎉 在三個語系同步拿掉（issue #1150，系統文案不放裝飾 emoji）。
const UPGRADE_TITLE: LocalizedText = {
  id: 'Anda sudah merasakan manfaat pemindaian AI!',
  zh: '今天的免費體驗已經用完囉！',
  en: "You've used up today's free AI scans!",
}

// 次數要引用 Edge Function 在 429 回應裡帶回的免費額度，不在前端另寫一份常數；#1177 起它是每個家庭
// 的免費額度（migration 常數，Function 與 trigger 讀同一個數字），之後調整時這裡的文案自動跟著變。
// 付費後的每日額度（目前每家庭 20）這裡故意不寫死具體次數，只強調「大幅提升」，避免文案跟資料庫實際值日後兜不起來。
// 為什麼不能再叫使用者去找家庭照護管理者（#1047）：目前只有系統管理者能在 /admin 開通 Premium，
// 家庭照護管理者沒有這個權限，照著提示做的人永遠完成不了升級。付費方式與價格仍在 #1037 規劃中，
// 所以這裡只陳述「付費升級後次數提升」，不放按鈕、價格或任何聯絡窗口——AGENTS.md 的
// Repository Privacy Boundary 也禁止把真實使用者 email 這類識別碼寫進程式碼。
function upgradeBodyText(freeDailyLimit: number): LocalizedText {
  return {
    id: `Anda sudah memakai ${freeDailyLimit} kali pemindaian AI gratis hari ini — hemat waktu, kan? Dengan upgrade berbayar ke Premium, kuota harian akan naik jauh lebih banyak, jadi tidak perlu menunggu sampai besok.`,
    zh: `今天已經用了 ${freeDailyLimit} 次免費 AI 藥袋辨識——是不是省了不少手動輸入的時間？付費升級 Premium 後，每日可用次數會大幅提升，不用等到明天。`,
    en: `You've used today's ${freeDailyLimit} free AI scans — saved you some typing, right? With a paid upgrade to Premium, your daily quota goes up a lot, so you don't have to wait until tomorrow.`,
  }
}

// 付費帳號用完不推銷升級，但一樣要用醒目、放大的文字告知——這是「今天真的用完了」的明確狀態，
// 不是隨手一筆小字就該交代過去的次要資訊。
const PAID_QUOTA_EXCEEDED_TEXT: LocalizedText = {
  id: 'Kuota pemindaian AI hari ini sudah habis, silakan coba lagi besok atau gunakan input manual di bawah.',
  zh: '今天的 AI 藥袋辨識次數已經用完了，請明天再試，或改用下方手動輸入。',
  en: "Today's AI scan quota has been used up. Please try again tomorrow, or use manual input below.",
}

// 暫停期間用完：照實說「加值暫停、今天的免費次數用完」，不推銷、不叫人聯絡誰；語氣與付費用完相同（中性、放大）。
function suspendedQuotaExceededText(freeDailyLimit: number): LocalizedText {
  return {
    id: `Tambahan pemindaian AI Premium sedang dihentikan sementara, dan ${freeDailyLimit} kali pemindaian gratis hari ini sudah habis. Silakan coba lagi besok atau gunakan input manual di bawah.`,
    zh: `Premium 的 AI 加值次數目前暫停提供，今天的 ${freeDailyLimit} 次免費次數已經用完。請明天再試，或改用下方手動輸入。`,
    en: `Premium's extra AI scans are temporarily unavailable, and today's ${freeDailyLimit} free scans have been used up. Please try again tomorrow, or use manual input below.`,
  }
}

export function MedicationAiDraftSection({
  patientId,
  onApplyDraft,
  onPickOcrCandidate,
}: {
  patientId: string
  onApplyDraft: (item: MedicationDraftItem) => void
  onPickOcrCandidate?: (nameGuess: string) => void
}) {
  const { text } = useI18n()
  const demo = isDemoMode()
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const libraryInputRef = useRef<HTMLInputElement>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [draft, setDraft] = useState<MedicationAiDraftResponse | null>(null)
  const [error, setError] = useState<LocalizedText | null>(null)
  // 繁體中文註解：當使用者希望使用或需要傳統基礎 Vision OCR 備援（例如 AI 額度已用完或需文字比對）時展開。
  const [showFallbackOcr, setShowFallbackOcr] = useState(false)
  // 額度用完時的獨立狀態：跟 error 分開，因為這個區塊需要依 tier 顯示不同文案／套用不同視覺樣式，
  // 而且用完當天要整組隱藏「拍照」「選照片」按鈕；quotaExceeded 與 error 永遠不會同時顯示
  // （見 handleFileChange 的 catch 分支）。
  const [quotaExceeded, setQuotaExceeded] = useState<QuotaExceededState | null>(null)

  // 為什麼要用 ref 存目前病人：非同步回應抵達時，若直接讀取 handleFileChange 閉包裡的 patientId 參數，
  // 讀到的是「發出請求那一刻」的舊值；draftMatchesPatient 必須拿「回應抵達當下」畫面上真正選取的病人比對，
  // 才擋得住「辨識還在跑、照護者已經切到別人」這種遲到結果——這是病人綁定三道防線的第一道。
  const currentPatientIdRef = useRef(patientId)
  currentPatientIdRef.current = patientId
  // 每次發出新請求就遞增；只有序號仍是最新的那次請求，才准許結束處理中狀態或寫入錯誤訊息，
  // 避免「切走又切回同一位病人」時，一個更早、其實已經過期的請求覆蓋掉新請求的處理中畫面。
  const requestSeqRef = useRef(0)

  useEffect(() => {
    // 🔴 病人綁定第二道防線：病人一旦切換，已開啟的草稿與錯誤訊息立刻清空，不保留、不等遲到的
    // 回應帶回來再判斷——即使遲到的回應真的通過了 draftMatchesPatient，也不該讓舊病人的草稿
    // 殘留在畫面上直到那個回應抵達。
    setDraft(null)
    setError(null)
    setQuotaExceeded(null)
    setIsProcessing(false)
  }, [patientId])

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const requestPatientId = currentPatientIdRef.current
    const requestSeq = ++requestSeqRef.current
    setIsProcessing(true)
    setError(null)
    setQuotaExceeded(null)
    setDraft(null)
    if (demo) {
      // 展示模式完全不讀取這張照片、不壓縮、不打任何網路請求——固定劇本，永遠同一份結果。
      // 留一小段人工延遲純粹是節奏（見 DEMO_SCRIPTED_DRAFT_DELAY_MS 的註解），不是在等任何回應。
      // 劇本內容綁 requestPatientId（選照片當下的病人），不是計時器觸發當下的病人：
      // 否則「選了 A 的照片、還沒等到結果就切到 B」時，draftMatchesPatient 會拿剛剛才用 B 現算出來的
      // scripted.patientId 去跟 B 自己比較，恆為真，等於這道防線形同虛設，B 會憑空冒出一份沒拍過的草稿。
      const scripted = buildDemoScriptedDraft(requestPatientId)
      globalThis.setTimeout(() => {
        if (requestSeq !== requestSeqRef.current) return
        // 病人綁定判斷式照樣跑一次：即使結果是假的，這條「回應抵達當下病人是否還相符」的防線
        // 不該因為展示模式而少一道，保持跟正式流程同一套規則，未來要拿掉示範開關才不會漏改行為。
        if (!draftMatchesPatient(scripted, currentPatientIdRef.current)) return
        setDraft(scripted)
        setIsProcessing(false)
      }, DEMO_SCRIPTED_DRAFT_DELAY_MS)
      return
    }
    try {
      const { blob, contentType } = await prepareSingleCompressedImage(file, DRAFT_PHOTO_MAX_DIMENSION, DRAFT_PHOTO_MAX_BYTES)
      // 標頭集中在 buildMedicationPhotoInvokeOptions：Content-Type 大小寫陷阱（#808，Gemini 依賴正確 mimeType）與
      // x-patient-id 的 CORS 允許清單（#1236）都靠「元件與測試用同一份」才鎖得住；細節見該檔註解。
      const { data, error: invokeError } = await supabase.functions.invoke('medication-ai-draft', buildMedicationPhotoInvokeOptions(requestPatientId, blob, contentType))
      if (invokeError) {
        // 為什麼要試著解析回應內容：Edge Function 回傳 4xx/5xx 時 supabase-js 只給我們一個泛用錯誤物件，
        // 真正的錯誤代碼與雙語訊息在 response body 裡，要自己再讀一次才拿得到——照抄
        // MedicationPhotoOcrSection.tsx 既有的這段處理。
        const context = (invokeError as { context?: Response }).context
        const body = context ? await context.json().catch(() => null) : null
        const code = body?.error as string | undefined
        if (code === 'daily_medication_ai_draft_limit') {
          throw new DailyQuotaExceededError(body?.tier as string | undefined, body?.freeDailyLimit as number | undefined, body?.suspended === true)
        }
        throw new Error(code ?? 'medication_ai_draft_unavailable')
      }
      const parsed = parseMedicationAiDraftResponse(data)
      // 🔴 病人綁定第一道防線：用「回應抵達當下」畫面上真正選取的病人比對，不是用 requestPatientId——
      // 照護者可能切走又切回同一人，此時應視為有效並套用；只有「現在」跟回應不同才整份丟棄，不套用、不顯示。
      if (!draftMatchesPatient(parsed, currentPatientIdRef.current)) return
      setDraft(parsed)
    } catch (cause) {
      // 已經有更新的請求正在跑（例如照護者切走又切回來後重新拍了一張），這次過期的失敗結果不該蓋掉新畫面。
      if (requestSeq !== requestSeqRef.current) return
      console.error('[medication ai draft error]', cause)
      if (cause instanceof DailyQuotaExceededError) {
        // 暫停優先判斷（Function 在暫停時一律回 tier='none'，不先判就會誤顯示升級提示）；
        // tier='ai'（付費家庭）用完不推銷升級，沿用單純的「明天再試」；只有免費家庭才顯示升級提示。
        // 三種都設進同一個 quotaExceeded state，讓下方渲染用單一條件就能整組隱藏拍照／選照片按鈕。
        const freeDailyLimit = cause.freeDailyLimit ?? 3
        setQuotaExceeded(cause.suspended
          ? { tier: 'suspended', freeDailyLimit }
          : cause.tier === 'ai' ? { tier: 'paid' } : { tier: 'free', freeDailyLimit })
        return
      }
      const code = cause instanceof Error ? cause.message : 'medication_ai_draft_unavailable'
      setError(ERROR_MESSAGES[code] ?? FALLBACK_ERROR)
    } finally {
      if (requestSeq === requestSeqRef.current) setIsProcessing(false)
    }
  }

  const handleApply = (item: MedicationDraftItem) => {
    // 🔴 病人綁定第三道防線：使用者可能在草稿已經顯示之後才切換病人；按下套用的當下要再比對一次，
    // 不能只靠草稿顯示時已經比對過一次、或上面的 useEffect 通常會先清空就假設現在一定還是同一人。
    if (!draftMatchesPatient(draft, patientId)) return
    onApplyDraft(item)
  }

  // 設計系統 #1146：AI 草稿只是「參考猜測」，不該用一個獨立主色（原 violet）搶走注意力；整塊改中性 slate，
  // 動作鈕用 brand。低信心警告仍維持 amber——那是需要「格外核對」的狀態語意，不是介面色，不能跟著換。
  return (
    <section className="mb-4 space-y-3 rounded-3xl border border-slate-200 bg-slate-50 p-4 shadow-sm">
      <div>
        <h2 className="text-lg font-black text-slate-900">{text({ id: 'Pindai resep dengan AI (draf)', zh: 'AI 藥袋辨識（草稿）', en: 'AI prescription scan (draft)' })}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-700">{text({
          id: 'Ambil foto kemasan obat, AI akan menebak nama, dosis, dan bentuk obatnya. Ini hanya tebakan AI — wajib dicocokkan dengan kemasan asli sebelum disimpan. Tebakan yang salah bisa membahayakan keselamatan minum obat, dan hasilnya tidak pernah disimpan otomatis.',
          zh: '拍藥袋照片，AI 會嘗試猜出品名、劑量與劑型；這仍然只是 AI 的猜測，套用前請務必對照藥袋原文親自核對——猜錯會直接影響服藥安全，結果永遠不會自動存檔。',
          en: 'Take a photo of the medicine package and AI will guess the name, dose, and form. This is only an AI guess — you must check it against the original package before saving. A wrong guess can directly affect medication safety, and results are never saved automatically.',
        })}</p>
        {/* 常駐標籤，不是 tooltip：訪客可能跳過導覽、直接點到這張卡，光靠導覽文字交代「這是示範」不夠，
            標籤要長在卡片本身、任何時候看到這個區塊都在。展示模式以外完全不會渲染這個節點。 */}
        {/* 展示模式標籤屬於系統訊息，依 §4.1 用 info token（sky 系），不是品牌色。 */}
        {demo && <p className="mt-2 inline-flex items-center gap-1 rounded-full border border-info-700/30 bg-info-50 px-2.5 py-1 text-xs font-bold text-info-700">{text(DEMO_RESULT_BADGE)}</p>}
      </div>
      {/* 兩個各自獨立的 hidden file input：差別只在有沒有 capture="environment"。拍照直接開相機；
          選擇照片不帶 capture，讓瀏覽器彈出原生的「相機／相簿」選擇器（或直接開相簿，依平台而定），
          照護者可以重複使用先前已經拍過、還留在手機裡的藥袋照片，不必每次都重新對著藥袋拍一張。
          比照 CareTimeline.tsx 既有的拍照／選相簿雙按鈕慣例，不自創新模式。 */}
      <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={event => void handleFileChange(event)} />
      <input ref={libraryInputRef} type="file" accept="image/*" className="hidden" onChange={event => void handleFileChange(event)} />
      {/* 額度用完當天不可能再拍出結果，但刻意用 disabled 灰階而非整組隱藏：對免費帳號來說，
          留著看得到、按不下去的按鈕本身就是一種「你剛剛才用過、很好用吧」的視覺提醒，比按鈕整個消失
          更能推動去看下面的升級文案；對付費帳號則只是單純沿用同一套視覺語言，不需要另外設計一套。
          disabled 屬性本身會阻止 onClick 觸發、並讓螢幕閱讀器正確播報「已停用」，不需要額外邏輯。 */}
      <div className="grid gap-2 sm:grid-cols-2">
        <button type="button" disabled={isProcessing || !!quotaExceeded} onClick={() => cameraInputRef.current?.click()} className="min-h-11 rounded-xl border border-brand-700 bg-white px-4 py-2 font-bold text-brand-700 transition-colors hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white">
          {isProcessing ? text({ id: 'Sedang membaca resep…', zh: '辨識中…', en: 'Reading prescription…' }) : <span className="inline-flex items-center justify-center gap-2"><Icon name="camera" className="h-4 w-4 shrink-0" />{text({ id: 'Pindai resep dengan AI', zh: 'AI 拍藥袋辨識', en: 'Scan prescription with AI' })}</span>}
        </button>
        <button type="button" disabled={isProcessing || !!quotaExceeded} onClick={() => libraryInputRef.current?.click()} className="min-h-11 rounded-xl border border-slate-300 bg-white px-4 py-2 font-bold text-slate-700 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-white">
          <span className="inline-flex items-center justify-center gap-2"><Icon name="image" className="h-4 w-4 shrink-0" />{text({ id: 'Pilih foto yang sudah ada', zh: '選擇照片', en: 'Choose existing photo' })}</span>
        </button>
      </div>
      {quotaExceeded?.tier === 'free' && <div role="alert" className="space-y-2 rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 shadow-sm">
        <p className="text-xl font-black leading-tight text-amber-950">{text(UPGRADE_TITLE)}</p>
        <p className="text-base font-semibold leading-6 text-amber-900">{text(upgradeBodyText(quotaExceeded.freeDailyLimit))}</p>
      </div>}
      {quotaExceeded?.tier === 'paid' && <div role="alert" className="rounded-2xl border-2 border-slate-300 bg-white p-5 shadow-sm">
        <p className="text-lg font-black leading-tight text-slate-900">{text(PAID_QUOTA_EXCEEDED_TEXT)}</p>
      </div>}
      {quotaExceeded?.tier === 'suspended' && <div role="alert" className="rounded-2xl border-2 border-slate-300 bg-white p-5 shadow-sm">
        <p className="text-lg font-black leading-tight text-slate-900">{text(suspendedQuotaExceededText(quotaExceeded.freeDailyLimit))}</p>
      </div>}
      {error && <div role="alert" className="rounded-xl bg-red-50 p-3 text-xs font-semibold text-red-700">{text(error)}</div>}
      {draft && draft.items.length === 0 && <p role="status" className="rounded-xl border border-dashed border-slate-300 bg-white p-3 text-xs text-slate-700">{text({ id: 'AI tidak menemukan obat yang bisa dibaca dari foto ini. Silakan gunakan input manual di bawah.', zh: 'AI 沒有從這張照片辨識出任何藥品，請改用下方手動輸入。', en: 'AI could not read any medicine from this photo. Please use manual input below.' })}</p>}
      {draft && draft.items.length > 0 && <div className="space-y-2">
        <p className="text-xs font-bold text-slate-700">{text(REFERENCE_ONLY_NOTE)}</p>
        {draft.items.map((item, index) => (
          <div key={index} className={`rounded-xl border p-3 text-xs ${item.confidence === 'low' ? 'border-amber-400 bg-amber-50' : 'border-slate-200 bg-white'}`}>
            {item.confidence === 'low' && <p role="alert" className="mb-1.5 flex items-center gap-1.5 font-black text-amber-900"><Icon name="alert-triangle" className="h-4 w-4 shrink-0" />{text({ id: 'Keyakinan rendah — periksa dengan ekstra hati-hati', zh: '低信心辨識，請格外仔細核對', en: 'Low confidence — check with extra care' })}</p>}
            {/* 直接呼叫 DraftField(...) 而非用 <DraftField ... /> JSX 標籤：兩者在瀏覽器渲染結果相同，
                但單元測試用的 tests/unit/helpers/elementTree.ts 只會攤平 host element（<p>／<span> 等），
                不會展開自訂元件節點的內部渲染結果；直接呼叫可以讓草稿卡片內容在元件測試中被斷言到。 */}
            {DraftField({ label: { id: 'Nama merek', zh: '品牌名', en: 'Brand name' }, value: item.brandName, text })}
            {DraftField({ label: { id: 'Nama generik', zh: '學名', en: 'Generic name' }, value: item.genericName, text })}
            {DraftField({ label: { id: 'Kekuatan (dari kemasan)', zh: '劑量標示（藥袋原文）', en: 'Strength (from package)' }, value: item.strengthLabel, text })}
            {DraftField({ label: { id: 'Bentuk obat', zh: '劑型', en: 'Dosage form' }, value: item.dosageForm ? text(DOSAGE_FORM_LABELS[item.dosageForm]) : null, text })}
            {DraftField({ label: { id: 'Dosis sekali minum', zh: '一次服用量', en: 'Dose per intake' }, value: item.doseAmount !== null ? String(item.doseAmount) : null, text })}
            {DraftField({ label: { id: 'Berapa kali sehari', zh: '一天次數', en: 'Times per day' }, value: item.timesPerDay !== null ? String(item.timesPerDay) : null, text })}
            {DraftField({ label: { id: 'Waktu minum (dari kemasan)', zh: '服藥時機（藥袋原文）', en: 'Timing (from package)' }, value: item.timingHint, text })}
            {/* 「套用」鈕原約 34px，半夜單手容易按偏；min-h-11 讓它到 44px（#1198）。 */}
            <button
              type="button"
              onClick={() => handleApply(item)}
              className="mt-2.5 min-h-11 w-full rounded-lg bg-brand-700 px-3 py-2 text-xs font-bold text-white transition-colors hover:bg-emerald-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 active:scale-[0.98]"
            >
              {text({ id: 'Isi ke formulir obat baru', zh: '套用到新增用藥表單', en: 'Apply to new medication form' })}
            </button>
          </div>
        ))}
      </div>}

      {/* 繁體中文註解：基礎 Vision OCR 備援入口。
          依產品憲法與使用者需求，主畫面不並列兩塊龐大的掃描器避免版面雜亂；
          但在 AI 配額用完、辨識失敗或使用者主動點擊時，提供基礎拍照辨識作為可靠備援。 */}
      {onPickOcrCandidate && (
        <div className="pt-1">
          {/* 備援入口是文字按鈕，原本只有一行字高；min-h-11 讓點擊區到 44px（#1198）。 */}
          <button
            type="button"
            onClick={() => setShowFallbackOcr(prev => !prev)}
            className="min-h-11 text-xs font-bold text-brand-700 underline transition-colors hover:text-emerald-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 rounded"
          >
            {showFallbackOcr
              ? text({ id: 'Tutup pemindaian dasar (Vision OCR)', zh: '收合基礎拍照辨識 (Vision OCR)', en: 'Hide basic scan (Vision OCR)' })
              : text({ id: 'Beralih ke pemindaian dasar (Vision OCR)', zh: '改用基礎拍照辨識 (Vision OCR 備援)', en: 'Use basic scan (Vision OCR fallback)' })}
          </button>
          {showFallbackOcr && (
            <div className="mt-3">
              <MedicationPhotoOcrSection patientId={patientId} onPickCandidate={onPickOcrCandidate} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DraftField({ label, value, text }: { label: LocalizedText; value: string | null; text: (value: LocalizedText) => string }) {
  return (
    <p className="flex flex-wrap items-baseline justify-between gap-x-2 border-b border-black/5 py-1 last:border-none">
      <span className="font-bold text-slate-700">{text(label)}</span>
      <span className={value ? 'text-slate-900' : 'italic text-red-600'}>{value ?? text(NOT_READ_HINT)}</span>
    </p>
  )
}
