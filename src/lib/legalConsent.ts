/*
檔案用途：集中版本化同意的讀取與寫入，讓登入頁、同意畫面與資料庫使用同一份契約。
所在層：src/lib 共用資料轉接層；不處理畫面呈現或照護資料寫入。
主要關聯：App.tsx 用它讀取政策／健康同意狀態，PrivacyPolicyUpdateScreen 與 HealthDataConsentScreen 在明確操作後寫入。
*/
import { supabase } from './supabase'

// 為什麼要有這兩個常數：App.tsx 要分別判斷隱私政策與健康資料同意是否最新，
// 不能把「看過隱私政策」誤當成「同意健康資料用途」，也不能讓政策升版被靜默略過。
// 升版時：先把新版本「追加在尾端」到 legal_policy_version_rank() 白名單（設計見
// supabase/migrations/20260930030932_bind_legal_consent_to_displayed_policy_version.sql；重貼時要從「最新一支」定義複製，
// 目前是 20261006040000_bind_terms_consent_to_displayed_version.sql——拿更舊的版本來改會掉了 'terms' 分支，
// 之後每一次勾選都被拒絕），用新的 migration 以 CREATE OR REPLACE 重貼，再改下面的常數；白名單沒有的版本 RPC 會拒絕。
// 伺服器不再硬編碼「當前版本」，RPC 只記錄客戶端傳入的版本（issue #925）。
// 2026-09-25 升版原因（issue #424）：隱私政策補揭露 Telegram、LINE、Resend 三家通知／寄信供應商與境外處理；
// 對應 supabase/migrations/20260925130000_bump_privacy_policy_version_for_notification_providers.sql。
// 2026-09-25.2 升版原因（issue #424 G，PR #922）：再揭露唯讀分享連結（控制者、目的、欄位、期限、境外接收者與雲端供應商）；
// 對應 supabase/migrations/20260925150000_bump_privacy_policy_version_for_share_link.sql。
// 為什麼不沿用 '2026-09-25'：那個版本已在 staging 上線且不含分享段落，沿用會讓已接受的人不必看新告知（Codex P1）。
// 「.2」是同日第二次修訂，文字比較大於 '2026-09-25'。
// 2026-10-06 升版原因（issue #1104）：到期提醒與 Google 日曆提醒新增個人私訊（付費並綁定的每位照護者都會收到），
// 私訊帶照護對象顯示名稱與行程開始時刻，提醒也會經 LINE 送出；對應
// supabase/migrations/20261005175646_bump_legal_versions_for_reminder_personal_delivery.sql。
// 2026-10-07 升版原因（issue #1183，付費方案 L1）：新增付款處理段——委外處理者藍新科技（付款頁託管、卡號由它蒐集）、
// 我們自己保存的訂單資料與保存期限，以及 Resend 另寄續約提醒信給付款人；對應
// supabase/migrations/20261007071022_bump_legal_versions_for_paid_terms.sql。健康資料同意「不」跟著升：付款不碰健康資料。
// 2026-10-09 升版原因（issue #1061 階段 D）：共用的家庭 Telegram 群組退場，通知只送到各自綁定個人通知的家人——
// 接收者範圍變了（個資法 §8 的「接收者」），notificationProviderDisclosures.ts 的「家庭群組」敘述同步移除；對應
// supabase/migrations/20261009110000_bump_privacy_for_shared_group_retirement_and_guard_reminder_delete.sql。條款與健康同意都不升。
export const CURRENT_PRIVACY_POLICY_VERSION = '2026-10-09'
// 2026-09-10 升版原因（issue #665）：AI 藥單草稿改用 Gemini 理解整張藥袋並產生醫囑欄位，
// 與既有 Cloud Vision 純文字辨識是不同的處理性質，即使收件廠商同為 Google，仍視為新蒐集目的。
// 2026-09-25 升版原因（issue #424）：血壓數值與照護對象姓名會送到 Telegram、LINE 兩家境外接收者，
// 屬於個資法 §6 健康資料的新揭露接收者，既有使用者必須重新明確同意；
// 對應 supabase/migrations/20260925130100_bump_health_consent_version_for_notification_providers.sql。
// 2026-09-25.2 升版原因（issue #424 G，PR #922）：健康資料可經唯讀分享連結給 App 外的人看，是新的利用對象；
// 對應 supabase/migrations/20260925150100_bump_health_consent_version_for_share_link.sql。
// create_patient_share_link 要求分享者的健康同意 >= '2026-09-25.2'，即以這一版為門檻；
// 不能沿用 '2026-09-25'，理由同上（該版本不含分享告知，已在 staging 被接受）。
// 2026-10-06 升版原因（issue #1104）：回診、抽血、打針等到期提醒與日曆提醒會以個人私訊送到 Telegram／LINE，
// 帶照護對象顯示名稱與時間，境外接收者收到的健康相關資訊範圍變了；同一支 migration 一起升。
// create_patient_share_link 的 >= '2026-09-25.2' 字串門檻不變：'2026-10-06' 大於它，確認過新版的人照常可分享。
export const CURRENT_HEALTH_CONSENT_VERSION = '2026-10-06'
// 服務條款版本（issue #1124）：記錄使用者勾選同意時，這個客戶端畫面上的 /terms 是哪一版，之後才能證明某人同意的是哪一份費用條款。
// 值＝TermsPage 頁首的「最後更新日期」；tests/unit/notificationProviderDisclosures.test.ts 鎖住兩者一致，
// 也鎖住它等於 legal_policy_version_rank('terms') 白名單的最後一項。改條款文字時：改頁首日期 → 改這裡 →
// 新 migration 在 terms 白名單尾端追加（做法見 supabase/migrations/20261006040000_bind_terms_consent_to_displayed_version.sql）。
// 為什麼這個常數不決定「要不要跳同意畫面」：條款升版「不」單獨跳畫面（owner 決策，2026-10-06）；
// 使用者在 PrivacyPolicyUpdateScreen 勾選「已閱讀目前適用的隱私權政策與服務條款」時一併記錄。
// useLegalConsentStatus 只拿它決定那個畫面要不要顯示「條款已更新」一段（紀錄已是這一版的人不顯示，避免不實的變動告知）。
// 坑：條款「單獨」升版（隱私政策沒有一起升）時，既有使用者不會看到任何畫面，紀錄會停在舊條款版本直到下次隱私升版；
// 這是刻意接受的取捨，不是 bug。條款變動需要既有使用者確認時，把下方的 TERMS_REQUIRES_RECONSENT 打開（#1037 §6.3 選項 c），
// 不能只升這個常數。
// 2026-10-06：#1047 改寫第 5 節（基礎功能永遠免費、部分功能有每日上限、進階功能付費，付費方案開放前先在條款頁公告）。
// 2026-10-07（issue #1183）：新增第 6 節付費方案、第 7 節退款政策，第 5 節寫明 AI 藥單辨識的每日次數以「每個家庭」計算。
// 這個值同時是「付費條款版本」：資料庫的 current_paid_terms_version() 必須回傳同一個字串，建單 RPC 只接受它
// （同一支 migration 一起改，tests/unit/paidTermsLegalVersionBump.test.ts 釘住）。
export const CURRENT_TERMS_VERSION = '2026-10-07'

// 條款升版時要不要「單獨」把既有使用者擋在同意畫面前（monetization-plan §6.3 選項 c，owner 2026-10-06 拍板）。
// 預設 false：一般條款升版搭下一次隱私升版一起記錄；付費條款由付款人在購買頁另行勾選（payment_orders.terms_version）。
// 什麼時候要改成 true：條款變動會「縮減免費功能」（例如免費次數變少、某項免費功能改收費），而且這次隱私政策「沒有」一起升版——
// 這時免費使用者必須在新條款生效前被明示並同意（消保法 §13），不能等不知何時的下一次隱私升版。打開後
// isAccountPolicyAcceptanceRequired 會讓條款版本落後的人也看到 PrivacyPolicyUpdateScreen；該次升版完成、大家都同意後可再改回 false。
// 2026-10-07 這次（第 5 節的家庭級單位對多照護對象的免費家庭是縮減）不必打開：隱私政策同日升版，所有人都會經過同一個畫面。
export const TERMS_REQUIRES_RECONSENT = false

export type ConsentType = 'self' | 'authorized_representative'
export type StoredConsentType = ConsentType | 'legacy_existing_account'

export interface LegalConsent {
  privacy_policy_version: string | null
  health_consent_version: string | null
  consent_type: StoredConsentType | null
  // 只用來決定隱私更新畫面要不要顯示「條款已更新」那一段，不參與同意閘門（見 CURRENT_TERMS_VERSION 的註解）。
  terms_version: string | null
}

// 帳號層政策（隱私政策＋必要時的服務條款）是否要先經過 PrivacyPolicyUpdateScreen。
// 抽成純函式讓「開關打開時條款落後也會擋」可以被單元測試直接驗證，不必等真的有一次需要打開開關才知道它壞了。
// consent 為 null（沒有紀錄或新帳號）一律要求，與隱私政策原本的行為相同。
export function isAccountPolicyAcceptanceRequired(
  consent: Pick<LegalConsent, 'privacy_policy_version' | 'terms_version'> | null,
  termsRequiresReconsent: boolean = TERMS_REQUIRES_RECONSENT,
): boolean {
  if (consent?.privacy_policy_version !== CURRENT_PRIVACY_POLICY_VERSION) return true
  return termsRequiresReconsent && consent.terms_version !== CURRENT_TERMS_VERSION
}

// 只有使用者完成登入頁／政策更新畫面的明確動作後才能呼叫；讀取狀態不得順便改寫稽核時間。
// 為什麼要傳版本（issue #925）：資料庫記錄的必須是「這個客戶端實際顯示給使用者的版本」，
// 而不是伺服器當下最新的版本；否則沒更新的舊客戶端會讓使用者對舊文案按同意、卻被記成新版，更新後就不會再被提示。
// 這裡傳的常數是建置時打包進客戶端的那一份，正好等於畫面上的文案版本；伺服器端另有白名單與不降版保護。
export async function recordAccountLegalAcceptance(): Promise<void> {
  const { error } = await supabase.rpc('record_account_legal_acceptance', {
    p_displayed_version: CURRENT_PRIVACY_POLICY_VERSION,
    // 同一個勾選框同時涵蓋服務條款，所以一起送條款版本（issue #1124）；不送時伺服器記成凍結的舊基準 '2026-08-26'。
    p_displayed_terms_version: CURRENT_TERMS_VERSION,
  })
  if (error) throw error
}

export async function readLegalConsent(): Promise<LegalConsent | null> {
  const { data, error } = await supabase
    .from('legal_consents')
    .select('privacy_policy_version, health_consent_version, consent_type, terms_version')
    .maybeSingle()
  if (error) throw error
  return data as LegalConsent | null
}

export async function recordHealthDataConsent(consentType: ConsentType, authorizationBasis?: string): Promise<void> {
  const { error } = await supabase.rpc('record_health_data_consent', {
    p_consent_type: consentType,
    p_authorization_basis: authorizationBasis?.trim() || null,
    // 同上：綁定使用者實際看到的健康資料同意版本（issue #925）。
    p_displayed_version: CURRENT_HEALTH_CONSENT_VERSION,
  })
  if (error) throw error
}

// 剛切換到全新的瀏覽器／PWA instance（例如 iOS 加到主畫面的新桌面捷徑，是完全獨立的 WKWebView
// 儲存容器，得整個重新走一次登入）時，Supabase 的登入 session 有時還沒完全穩定就送出第一次
// 請求，導致這裡短暫拋出例外；已經同意過的帳號因此被誤判成「尚未同意」，逼使用者重新看一次
// 同意畫面（即使資料庫裡那筆同意紀錄其實好好的在）。重試一次能撐過這種暫時性失敗；
// 這裡刻意只讀取，避免 session 恢復時在使用者沒有重新確認政策的情況下改寫 privacy_acknowledged_at。
export async function loadLegalConsentWithRetry(retryDelayMs = 800): Promise<LegalConsent | null> {
  try {
    return await readLegalConsent()
  } catch (firstAttemptError) {
    console.error('[legal consent read error, retrying once]', firstAttemptError)
    await new Promise(resolve => setTimeout(resolve, retryDelayMs))
    return readLegalConsent()
  }
}
