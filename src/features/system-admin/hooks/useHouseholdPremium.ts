/*
檔案用途：後台「家庭 Premium」分頁（issue #1180，H6）的狀態容器 hook：家庭清單與 kill switch 現況的讀取、
         每個家庭的開關草稿（目標狀態、理由、試用到期日）與送出、單一家庭稽核列的按需讀取、kill switch 切換；
         家庭有進行中的訂閱時記下衝突，並提供「招待並終止訂閱」的送出（issue #1202）。
所在層：src/features/system-admin/hooks；feature-specific 狀態容器 hook（AGENTS.md Rule A／B／C）。
主要關聯：src/features/system-admin/components/HouseholdPremiumPanel.tsx（唯一呼叫端）、src/lib/adminHouseholds.ts、
         supabase/functions/admin-set-household-entitlement/adminSetHouseholdEntitlement.ts（理由與開關的相容規則必須一致）、
         src/features/system-admin/householdPremiumLabels.ts（premium_until ↔ 台灣到期日的換算）。
*/
import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalizedText } from '../../../lib/i18n'
import {
  type AdminHousehold,
  type AdminHouseholdsResponse,
  HOUSEHOLD_GRANT_REASONS,
  HOUSEHOLD_REVOKE_REASONS,
  type HouseholdEntitlementChange,
  type HouseholdEntitlementReason,
  type PaidFeature,
  type PaidFeatureSuspension,
  fetchAdminHouseholds,
  fetchHouseholdEntitlementChanges,
  isSubscriptionInProgressError,
  isTrialEndsBeforePaidPeriodError,
  setHouseholdPremium,
  setPaidFeatureSuspension,
} from '../../../lib/adminHouseholds'
import { describeReadError, describeSaveError } from '../../../lib/dataErrors'
import { premiumUntilToTrialEndsOn } from '../householdPremiumLabels'

export type HouseholdDraft = {
  premium: boolean
  reason: HouseholdEntitlementReason
  trialEndsOn: string
}

// 送出時撞到「家庭有進行中的訂閱」：grant＝想給招待／試用（可以改走「招待並終止訂閱」）、
// revoke＝想關閉（付費來源只能經終止委託＋退款撤銷，後台這裡不提供）。
export type HouseholdSubscriptionConflict = 'grant' | 'revoke'

// 「招待並終止訂閱」只接受招待與試用：原子 RPC 的稽核理由固定是來源本身，更正（correction）不能走這條（Function 也會拒絕）。
export function canGrantAndCancel(draft: HouseholdDraft): boolean {
  return draft.premium && (draft.reason === 'complimentary' || draft.reason === 'trial')
}

export type HouseholdAuditState = {
  open: boolean
  loading: boolean
  error: LocalizedText | null
  changes: HouseholdEntitlementChange[]
  truncated: boolean
}

export interface UseHouseholdPremiumOptions {
  // 注入資料與假函式方便單元測試；正式畫面一律用預設的 Edge Function adapter。
  initialData?: AdminHouseholdsResponse
  fetcher?: typeof fetchAdminHouseholds
  changesFetcher?: typeof fetchHouseholdEntitlementChanges
  premiumMutator?: typeof setHouseholdPremium
  suspensionMutator?: typeof setPaidFeatureSuspension
  autoFetch?: boolean
}

const LOAD_ERROR: LocalizedText = {
  id: 'Daftar keluarga sementara tidak dapat dimuat. Periksa internet lalu coba lagi.',
  zh: '暫時無法讀取家庭清單，請確認網路後重試。',
  en: 'The household list could not be loaded right now. Check your internet connection and try again.',
}

// 寫入已成功、只是之後的重新讀取失敗：清單保留在畫面上，並明講「已儲存」，避免管理者以為沒存而重按、多寫一筆稽核。
export const REFRESH_ERROR: LocalizedText = {
  id: 'Perubahan tersimpan, tetapi daftar belum bisa dimuat ulang. Tekan "Muat ulang" untuk melihat status terbaru.',
  zh: '變更已儲存，但重新讀取清單失敗。請按「重新讀取」查看最新狀態。',
  en: 'The change was saved, but the list could not be reloaded. Press "Reload" to see the latest status.',
}

export const TRIAL_DATE_REQUIRED: LocalizedText = {
  id: 'Pilih tanggal berakhir uji coba terlebih dahulu.',
  zh: '請先選擇試用到期日。',
  en: 'Choose the trial end date first.',
}

// 「招待並終止訂閱」的試用比付款人已付費的期間先到期：資料庫拒絕、什麼都沒改（Codex review on PR #1210 P1）。
export const TRIAL_ENDS_BEFORE_PAID_PERIOD: LocalizedText = {
  id: 'Tanggal berakhir uji coba lebih awal dari masa yang sudah dibayar pembayar, jadi tidak ada yang diubah. Pilih tanggal yang lebih lambat atau pilih "Gratis (hadiah)".',
  zh: '試用到期日早於付款人已付費的期間，所以沒有做任何變更。請選更晚的到期日，或改選「招待」。',
  en: 'The trial would end before the period the payer already paid for, so nothing was changed. Choose a later end date or choose "Complimentary".',
}

// 「現在是不是 Premium」以資料庫的 premium_effective 為準：過期但排程還沒降級的試用，畫面要當成已失效。
export function isPremiumNow(household: AdminHousehold): boolean {
  return household.premiumTier === 'premium' && household.premiumEffective
}

// 預設草稿＝原封不動的現狀，連來源與到期日都對上（bp-reviewer 第一點）：若預設一律是「開＋招待」，
// 管理者只是打開卡片看稽核、順手按「套用」，就會把 30 天試用變成永久招待（日後也會蓋掉訂閱的來源 id）。
// 後台表達不了的來源（訂閱）也先填「開＋招待」；下面的 canApplyDraft 對它例外放行「沒改過也能送出」，
// 因為訂閱持有時資料庫一定先回 subscription_in_progress，不會被誤套用（#1202）。
export function defaultDraft(household: AdminHousehold): HouseholdDraft {
  if (!isPremiumNow(household)) return { premium: false, reason: 'revoked', trialEndsOn: '' }
  if (household.premiumSource === 'trial' && household.premiumUntil) {
    return { premium: true, reason: 'trial', trialEndsOn: premiumUntilToTrialEndsOn(household.premiumUntil) ?? '' }
  }
  return { premium: true, reason: 'complimentary', trialEndsOn: '' }
}

type EntitlementShape = { tier: 'premium' | 'none'; source: string; validThrough: string | null }

// 列上的狀態（不看是否生效：過期的試用列仍是 premium，關掉它是一次真的清理）。
function rowShape(household: AdminHousehold): EntitlementShape {
  if (household.premiumTier !== 'premium') return { tier: 'none', source: 'none', validThrough: null }
  return { tier: 'premium', source: household.premiumSource, validThrough: household.premiumUntil ? premiumUntilToTrialEndsOn(household.premiumUntil) : null }
}

// 草稿送出後會寫成的狀態；來源推導與 Function 的 validateHouseholdEntitlementChange 相同。
function draftShape(draft: HouseholdDraft): EntitlementShape {
  if (!draft.premium) return { tier: 'none', source: 'none', validThrough: null }
  const trial = draft.reason === 'trial' || (draft.reason === 'correction' && draft.trialEndsOn !== '')
  return { tier: 'premium', source: trial ? 'trial' : 'complimentary', validThrough: trial ? (draft.trialEndsOn || null) : null }
}

// 只有「管理者真的改過表單」而且「送出後會和現在不一樣」才給送出：
// 沒改過就按套用、或改了又改回原樣，都只會多寫一筆什麼都沒變的稽核列（H1 每次呼叫都寫 premium_tier 列）。
// 例外：列上的來源是訂閱時，「沒改過」也可以送出（Codex review on PR #1210 P2）。後台表達不了訂閱，預設草稿只能填成「開＋招待」，
// 而選回已經選著的「招待」不會觸發 change 事件——不放行的話，管理者根本走不到 409 與「招待並終止訂閱」。
// 放行是安全的：資料庫守門會預設拒絕（不會默默把訂閱換成招待），而且送出前還有確認框。
export function canApplyDraft(household: AdminHousehold, draft: HouseholdDraft, edited: boolean): boolean {
  const heldBySubscription = household.premiumTier === 'premium' && household.premiumSource === 'subscription'
  if (!edited && !heldBySubscription) return false
  const current = rowShape(household)
  const next = draftShape(draft)
  return current.tier !== next.tier || current.source !== next.source || current.validThrough !== next.validThrough
}

export function useHouseholdPremium(options: UseHouseholdPremiumOptions = {}) {
  const {
    initialData,
    fetcher = fetchAdminHouseholds,
    changesFetcher = fetchHouseholdEntitlementChanges,
    premiumMutator = setHouseholdPremium,
    suspensionMutator = setPaidFeatureSuspension,
    autoFetch = initialData === undefined,
  } = options

  const [households, setHouseholds] = useState<AdminHousehold[]>(initialData?.households ?? [])
  const [suspensions, setSuspensions] = useState<PaidFeatureSuspension[]>(initialData?.suspensions ?? [])
  // Rule C：讀取狀態與送出狀態分開；整頁 loading／loadError 只屬於第一次與手動重試，
  // 送出後的安靜重讀失敗另記在 refreshError，不把清單與 kill switch 從畫面拿掉。
  const [loading, setLoading] = useState(autoFetch)
  const [loadError, setLoadError] = useState<LocalizedText | null>(null)
  const [refreshError, setRefreshError] = useState<LocalizedText | null>(null)

  // Rule B：每個家庭各自的草稿、送出中、錯誤與「已儲存」提示，以 householdId 為鍵，互不干擾。
  const [drafts, setDrafts] = useState<Record<string, HouseholdDraft>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saveErrors, setSaveErrors] = useState<Record<string, LocalizedText | null>>({})
  const [savedNotices, setSavedNotices] = useState<Record<string, boolean>>({})
  // 衝突是「這個家庭現在有訂閱」的事實，不是草稿的錯誤：改草稿不清掉它（改成招待後仍要看得到「招待並終止訂閱」），
  // 只有寫入成功才清。
  const [subscriptionConflicts, setSubscriptionConflicts] = useState<Record<string, HouseholdSubscriptionConflict | null>>({})
  const [cancelRequestedNotices, setCancelRequestedNotices] = useState<Record<string, boolean>>({})
  const [audits, setAudits] = useState<Record<string, HouseholdAuditState>>({})

  const [killSwitchSaving, setKillSwitchSaving] = useState<Partial<Record<PaidFeature, boolean>>>({})
  const [killSwitchError, setKillSwitchError] = useState<LocalizedText | null>(null)
  const [killSwitchSaved, setKillSwitchSaved] = useState(false)

  // 注入的讀取函式放進 ref：呼叫端（測試或 hookOptions）常傳行內箭頭函式，每次 render 都是新的參照；
  // 若直接放進 useCallback 的依賴，讀取函式每次 render 都會換一個，掛載時的 effect 就會「讀完 → setState → 重繪 → 又讀」無限循環。
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const changesFetcherRef = useRef(changesFetcher)
  changesFetcherRef.current = changesFetcher
  // 連按兩次套用（或 kill switch）會有兩個重讀同時在飛；只採用最後發出的那一個，舊的回應晚到也不能蓋掉新的。
  const loadSequenceRef = useRef(0)
  // 稽核列表同樣會有多個讀取同時在飛（收合又展開、寫入成功後的重讀）；序號以家庭為單位，
  // 不同家庭的請求互不作廢，同一家庭只採用最後發出的那一個（#1196）。
  const auditSequenceRef = useRef<Record<string, number>>({})

  const loadHouseholds = useCallback(async (quiet: boolean) => {
    const sequence = ++loadSequenceRef.current
    if (!quiet) {
      setLoading(true)
      setLoadError(null)
    }
    try {
      const data = await fetcherRef.current()
      if (sequence !== loadSequenceRef.current) return
      setHouseholds(data.households)
      setSuspensions(data.suspensions)
      setLoadError(null)
      setRefreshError(null)
    } catch (err) {
      if (sequence !== loadSequenceRef.current) return
      console.error('[admin household premium read error]', err)
      if (quiet) setRefreshError(REFRESH_ERROR)
      else setLoadError(describeReadError(err, LOAD_ERROR))
    } finally {
      // 整頁 loading 一定要收：就算這次的資料因為較新的請求而被丟掉，也不能讓畫面卡在「載入中」。
      if (!quiet) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (autoFetch) void loadHouseholds(false)
  }, [autoFetch, loadHouseholds])

  const reload = useCallback(() => loadHouseholds(false), [loadHouseholds])
  const refresh = useCallback(() => loadHouseholds(true), [loadHouseholds])

  const draftFor = (household: AdminHousehold): HouseholdDraft => drafts[household.householdId] ?? defaultDraft(household)
  const canApply = (household: AdminHousehold): boolean =>
    canApplyDraft(household, draftFor(household), drafts[household.householdId] !== undefined)

  const updateDraft = (household: AdminHousehold, patch: Partial<HouseholdDraft>) => {
    setDrafts(current => {
      const previous = current[household.householdId] ?? defaultDraft(household)
      const next = { ...previous, ...patch }
      // 切換目標狀態時，若原本選的理由和新方向不相容（例如從「開＋試用」切成「關」），改成新方向的預設理由，
      // 不讓管理者送出一個一定會被 Function 拒絕的組合；更正（correction）兩個方向都可以，保留。
      if (patch.premium !== undefined) {
        const allowed = next.premium ? HOUSEHOLD_GRANT_REASONS : HOUSEHOLD_REVOKE_REASONS
        if (!allowed.includes(next.reason)) next.reason = next.premium ? 'complimentary' : 'revoked'
        if (!next.premium) next.trialEndsOn = ''
      }
      // 招待一律不到期：選回招待時清掉日期，避免畫面上留著一個不會被送出的日期而讓人誤會。
      if (next.reason === 'complimentary') next.trialEndsOn = ''
      return { ...current, [household.householdId]: next }
    })
    setSaveErrors(current => ({ ...current, [household.householdId]: null }))
    setSavedNotices(current => ({ ...current, [household.householdId]: false }))
    setCancelRequestedNotices(current => ({ ...current, [household.householdId]: false }))
  }

  const loadChanges = useCallback(async (householdId: string) => {
    const sequence = (auditSequenceRef.current[householdId] ?? 0) + 1
    auditSequenceRef.current[householdId] = sequence
    setAudits(current => ({
      ...current,
      [householdId]: { open: true, loading: true, error: null, changes: current[householdId]?.changes ?? [], truncated: current[householdId]?.truncated ?? false },
    }))
    try {
      const response = await changesFetcherRef.current(householdId)
      // 較新的讀取已發出：這份舊回應（成功或失敗）都丟掉，loading 由較新的那個收，剛寫入的稽核列才不會被蓋掉。
      if (sequence !== auditSequenceRef.current[householdId]) return
      setAudits(current => ({ ...current, [householdId]: { open: current[householdId]?.open ?? true, loading: false, error: null, changes: response.changes, truncated: response.truncated } }))
    } catch (err) {
      if (sequence !== auditSequenceRef.current[householdId]) return
      console.error('[admin household changes read error]', err)
      setAudits(current => ({
        ...current,
        [householdId]: { open: current[householdId]?.open ?? true, loading: false, error: describeReadError(err), changes: [], truncated: false },
      }))
    }
  }, [])

  // 第一次展開才讀；收合後再展開會重新讀，確保看到的是最新稽核（剛剛自己改過的那一筆也在）。
  const toggleAudit = (householdId: string) => {
    if (audits[householdId]?.open) {
      setAudits(current => ({ ...current, [householdId]: { ...current[householdId], open: false } }))
      return
    }
    void loadChanges(householdId)
  }

  // 送出前的確認由畫面負責（useConfirm）；這裡假設已經確認過。回傳 true 代表寫入成功。
  // cancelSubscription 只由「招待並終止訂閱」按鈕帶 true；一般的「套用」永遠不帶，讓資料庫的守門預設拒絕。
  const applyDraft = async (household: AdminHousehold, options: { cancelSubscription?: boolean } = {}): Promise<boolean> => {
    const id = household.householdId
    const draft = draftFor(household)
    const cancelSubscription = options.cancelSubscription === true
    // 防呆：按鈕只在招待／試用時出現，這裡再擋一次，不送出一定被 Function 拒絕的組合。
    if (cancelSubscription && !canGrantAndCancel(draft)) return false
    if (draft.premium && draft.reason === 'trial' && !draft.trialEndsOn) {
      setSaveErrors(current => ({ ...current, [id]: TRIAL_DATE_REQUIRED }))
      return false
    }
    setSaving(current => ({ ...current, [id]: true }))
    setSaveErrors(current => ({ ...current, [id]: null }))
    setSavedNotices(current => ({ ...current, [id]: false }))
    setCancelRequestedNotices(current => ({ ...current, [id]: false }))
    try {
      await premiumMutator({
        householdId: id,
        premiumTier: draft.premium ? 'premium' : 'none',
        reason: draft.reason,
        trialEndsOn: draft.premium && draft.reason !== 'complimentary' && draft.trialEndsOn ? draft.trialEndsOn : null,
        ...(cancelSubscription ? { cancelSubscription: true } : {}),
      })
    } catch (err) {
      console.error('[admin set household premium error]', err)
      if (isSubscriptionInProgressError(err)) {
        // 不是失敗而是「需要管理者再決定一次」：不顯示紅字，改由卡片的衝突區說明並給（或不給）「招待並終止訂閱」。
        setSubscriptionConflicts(current => ({ ...current, [id]: draft.premium ? 'grant' : 'revoke' }))
        setSaving(current => ({ ...current, [id]: false }))
        return false
      }
      if (isTrialEndsBeforePaidPeriodError(err)) {
        setSaveErrors(current => ({ ...current, [id]: TRIAL_ENDS_BEFORE_PAID_PERIOD }))
        setSaving(current => ({ ...current, [id]: false }))
        return false
      }
      setSaveErrors(current => ({
        ...current,
        [id]: describeSaveError(err, { id: 'Gagal menyimpan status Premium keluarga.', zh: '無法儲存家庭 Premium 狀態。', en: 'Unable to save the household Premium status.' }),
      }))
      setSaving(current => ({ ...current, [id]: false }))
      return false
    }
    // 寫入成功之後的每一步都不能再把它報成失敗：清掉草稿、標「已儲存」，再安靜地重讀清單（失敗只記 refreshError）；
    // 稽核若開著也重讀，剛寫的那一筆要立刻看得到。
    setDrafts(current => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setSavedNotices(current => ({ ...current, [id]: true }))
    setCancelRequestedNotices(current => ({ ...current, [id]: cancelSubscription }))
    setSubscriptionConflicts(current => ({ ...current, [id]: null }))
    setSaving(current => ({ ...current, [id]: false }))
    await loadHouseholds(true)
    if (audits[id]?.open) await loadChanges(id)
    return true
  }

  const toggleSuspension = async (feature: PaidFeature, suspended: boolean): Promise<void> => {
    setKillSwitchSaving(current => ({ ...current, [feature]: true }))
    setKillSwitchError(null)
    setKillSwitchSaved(false)
    try {
      await suspensionMutator(feature, suspended)
    } catch (err) {
      console.error('[admin set paid feature suspension error]', err)
      setKillSwitchError(describeSaveError(err, { id: 'Gagal mengubah sakelar darurat.', zh: '無法切換全域暫停開關。', en: 'Unable to change the global suspension switch.' }))
      setKillSwitchSaving(current => ({ ...current, [feature]: false }))
      return
    }
    setKillSwitchSaved(true)
    setKillSwitchSaving(current => ({ ...current, [feature]: false }))
    // 重讀清單拿到資料庫記下的暫停時間；Function 回傳的清單只有功能名稱。
    await loadHouseholds(true)
  }

  return {
    households,
    suspensions,
    loading,
    loadError,
    refreshError,
    reload,
    refresh,
    draftFor,
    canApply,
    updateDraft,
    saving,
    saveErrors,
    savedNotices,
    subscriptionConflicts,
    cancelRequestedNotices,
    applyDraft,
    audits,
    toggleAudit,
    killSwitchSaving,
    killSwitchError,
    killSwitchSaved,
    toggleSuspension,
  }
}
