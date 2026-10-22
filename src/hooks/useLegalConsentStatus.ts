/*
檔案用途：讀取目前登入使用者的隱私政策與健康資料使用同意版本狀態。
所在層：src/hooks；封裝 App.tsx 原本內嵌的法遵同意狀態與讀取 effect。
主要關聯：由 App.tsx 呼叫，決定是否顯示 PrivacyPolicyUpdateScreen／HealthDataConsentScreen；
依賴 lib/legalConsent 的 loadLegalConsentWithRetry 與版本常數。
termsUpdateRequired（issue #1124）只決定隱私更新畫面要不要顯示「條款已更新」那一段，不是同意閘門；
條款要不要成為閘門由 legalConsent.ts 的 TERMS_REQUIRES_RECONSENT 決定（issue #1183，預設 false）。
*/
import { useEffect, useState } from 'react'
import { CURRENT_HEALTH_CONSENT_VERSION, CURRENT_PRIVACY_POLICY_VERSION, CURRENT_TERMS_VERSION, isAccountPolicyAcceptanceRequired, loadLegalConsentWithRetry } from '../lib/legalConsent'

export type ConsentStatus = 'idle' | 'loading' | 'required' | 'ready'

export function useLegalConsentStatus(userId: string | undefined) {
  const [privacyPolicyStatus, setPrivacyPolicyStatus] = useState<ConsentStatus>('idle')
  const [healthConsentStatus, setHealthConsentStatus] = useState<ConsentStatus>('idle')
  // 預設 true：讀不到紀錄時寧可多告知一次條款變動，也不要讓還停在舊條款的人在沒被告知的情況下被記成新版。
  const [termsUpdateRequired, setTermsUpdateRequired] = useState(true)
  // 隱私本身是否落後（Codex on #1211）：TERMS_REQUIRES_RECONSENT 打開時，只有條款落後的人也會看到同意畫面，
  // 畫面要靠這個值決定是否說「隱私權政策已更新」。預設與讀取失敗都視為落後，寧可多告知。
  const [privacyUpdateRequired, setPrivacyUpdateRequired] = useState(true)

  useEffect(() => {
    if (!userId) {
      setPrivacyPolicyStatus('idle')
      setHealthConsentStatus('idle')
      setTermsUpdateRequired(true)
      setPrivacyUpdateRequired(true)
      return
    }
    let cancelled = false
    setPrivacyPolicyStatus('loading')
    setHealthConsentStatus('loading')
    void loadLegalConsentWithRetry().then(consent => {
      // 為什麼分開比對：隱私政策更新只需要重新確認政策，不應被誤當成健康資料用途同意；
      // 兩者都必須等使用者明確操作，不能由讀取狀態靜默升版。
      if (!cancelled) {
        // 隱私政策落後一律要求；條款落後只在 TERMS_REQUIRES_RECONSENT 打開時才要求（#1037 §6.3 選項 c，issue #1183）。
        setPrivacyPolicyStatus(isAccountPolicyAcceptanceRequired(consent) ? 'required' : 'ready')
        setHealthConsentStatus(consent?.health_consent_version === CURRENT_HEALTH_CONSENT_VERSION ? 'ready' : 'required')
        // 預設不影響 privacyPolicyStatus：條款升版不單獨跳畫面（owner 決策，2026-10-06），例外是上面的 TERMS_REQUIRES_RECONSENT。
        // 這裡只讓已在目前條款版本的人，在之後「只升隱私政策」時不會看到一則不實的「條款已更新」；
        // 還停在舊條款（含新帳號）的人則一定看得到這次的變動摘要，勾選後才被記成新版（#1124 暫代審查 P2）。
        // 用 !== 而不是排序：客戶端沒有白名單順序；唯一的誤差是過期客戶端對已在更新條款的人多顯示一次舊摘要，伺服器也不會降版。
        setTermsUpdateRequired(consent?.terms_version !== CURRENT_TERMS_VERSION)
        setPrivacyUpdateRequired(consent?.privacy_policy_version !== CURRENT_PRIVACY_POLICY_VERSION)
      }
    }).catch(error => {
      console.error('[legal consent load error after retry]', error)
      if (!cancelled) {
        setPrivacyPolicyStatus('required')
        setHealthConsentStatus('required')
        setTermsUpdateRequired(true)
        setPrivacyUpdateRequired(true)
      }
    })
    return () => { cancelled = true }
  }, [userId])

  return { privacyPolicyStatus, setPrivacyPolicyStatus, healthConsentStatus, setHealthConsentStatus, termsUpdateRequired, privacyUpdateRequired }
}
