/*
檔案用途：提供病人級資料異動歷史（record_change_logs）的型別化讀取層（ADR-008 AUDIT-3，issue #969）。
包含 before ⊕ diff 整列合成、系統推導欄位過濾、操作者（actor）三語解析（含已刪除帳號處理）與查詢函式。
所在層：src/lib 共用資料層；封裝 audit 表的讀取與純邏輯轉換，由 RLS 保護，不包含任何 UI 元件與文案按鈕。
主要關聯：docs/adr/008-audit-coverage-boundary.md、docs/architecture/audit-coverage-design.md §8.1／§10、
supabase/migrations/20260925222525_create_record_change_logs_audit.sql、src/lib/database.types.ts、
未來 2027-Q1 AUDIT-4 的異動歷史抽屜與最近 30 天異動清單。
*/
import type { SupabaseClient } from '@supabase/supabase-js'
import { supabase as defaultClient } from './supabase'
import type { Database } from './database.types'
import type { Locale, LocalizedText } from './i18n'

export type RecordChangeLogRow = Database['public']['Tables']['record_change_logs']['Row']
export type AuditAction = 'insert' | 'update' | 'delete'
export type AuditActorKind = 'user' | 'service_role' | 'system'

export interface ResolvedActor {
  kind: AuditActorKind
  userId: string | null
  source: string | null
  displayName: string | null
  label: LocalizedText
  // 只有 kind = 'user' 且 actor_source 是已知的「規則／流程代為執行」來源時才有值（其餘為 null）。
  // label 在 user 列永遠是寫入者的名字，這個註記是另外一行說明「這筆其實是規則代刪／帳號刪除連帶」，
  // 讓 UI 能把兩件事分開顯示，而不是把使用者誤標成系統、或讓使用者看起來像自己動手刪。
  sourceNote: LocalizedText | null
}

// 這兩個字串必須與資料庫 SET LOCAL app.audit_source 寫入的值逐字相同：
// supabase/migrations/20261005040913_attach_tier_b_record_change_audit.sql（體重保留規則）、
// supabase/migrations/20260925222525_create_record_change_logs_audit.sql（delete_user_account）。
export const WEIGHT_RETENTION_AUDIT_SOURCE = 'enforce_patient_weight_daily_retention'
export const ACCOUNT_DELETION_AUDIT_SOURCE = 'delete_user_account'

/**
 * `actor_kind = 'user'` 的列上，哪些 actor_source 值得另外註記（ADR-008 §5.3、§8.2）。
 * 為什麼 user 列要看 source：
 * - 體重保留規則：寫入「過去日期」的體重會把當天原本的量測擠掉，那筆 DELETE 刻意不 bypass、照常留 audit
 *   （AUDIT-2 migration 內註解），actor 是發出寫入的人。只顯示名字會讓人以為是他自己刪了體重。
 * - delete_user_account：刪帳號的人就是操作者，所以授權列記成 user（設計文件 §5.3、§6.4 明確否決記成 system），
 *   原因只靠 actor_source 說明；對象帳號已不存在，名字本身也解析不出來。
 * 用 Map 而不是物件字面量：actor_source 是資料庫來的任意字串，`constructor` 之類的值不能命中原型鏈。
 * 沒列在這裡的 source（例如 set_notification_subscription）刻意不給註記，也不把原始函式名直接當文字顯示給使用者。
 */
const USER_ACTOR_SOURCE_NOTES: ReadonlyMap<string, LocalizedText> = new Map([
  [
    WEIGHT_RETENTION_AUDIT_SOURCE,
    {
      zh: '由保留規則代刪',
      id: 'Dihapus oleh aturan penyimpanan data',
      en: 'Deleted by retention rule',
    },
  ],
  [
    ACCOUNT_DELETION_AUDIT_SOURCE,
    {
      zh: '因帳號刪除而連帶異動',
      id: 'Berubah akibat penghapusan akun',
      en: 'Changed by account deletion',
    },
  ],
])

export interface RecordChangeEntry {
  id: string
  tableName: string
  rowId: string
  patientId: string | null
  householdId: string | null
  action: AuditAction
  actorKind: AuditActorKind
  actorUserId: string | null
  actorSource: string | null
  actor: ResolvedActor
  changedAt: string
  expiresAt: string | null
  // 經由過濾推導欄位後，由使用者實際修改的欄位清單
  changedColumns: string[]
  // 被過濾掉的系統推導欄位清單（如 answered_at, updated_at, care_date）
  derivedChangedColumns: string[]
  // 資料庫原始記下的 changed_columns（若 action 為 update；insert/delete 為空陣列）
  rawChangedColumns: string[]
  beforeRow: Record<string, unknown> | null
  afterDiff: Record<string, unknown> | null
  // 合成後的整列（insert: afterDiff; update: beforeRow ⊕ afterDiff; delete: null）
  afterRow: Record<string, unknown> | null
}

/**
 * 系統推導欄位清單（ADR-008 §4.4 第 2 點）。
 * 資料庫 trigger 執行後會自動產生/更新這些欄位（例如 answered_at、updated_at、care_date），
 * 讀取層需能將其與使用者手動修改的欄位區分開來，避免 UI 將系統自動打上的時間戳誤報為使用者修改。
 */
export const DEFAULT_DERIVED_COLUMNS: ReadonlySet<string> = new Set([
  'answered_at',
  'updated_at',
  'care_date',
])

export interface FilterColumnsResult {
  userChangedColumns: string[]
  derivedColumns: string[]
}

/**
 * 從 changed_columns 中過濾掉推導欄位，分出使用者修改的欄位與系統推導欄位。
 */
export function filterDerivedColumns(
  changedColumns: readonly string[] | null | undefined,
  customDerivedColumns: ReadonlySet<string> = DEFAULT_DERIVED_COLUMNS
): FilterColumnsResult {
  if (!changedColumns || changedColumns.length === 0) {
    return { userChangedColumns: [], derivedColumns: [] }
  }
  const userChanged: string[] = []
  const derived: string[] = []
  for (const col of changedColumns) {
    if (customDerivedColumns.has(col)) {
      derived.push(col)
    } else {
      userChanged.push(col)
    }
  }
  return { userChangedColumns: userChanged, derivedColumns: derived }
}

/**
 * 依據 action 合成改動後的完整資料列（before_row ⊕ after_diff）。
 * - insert: 資料列為全新建立，afterDiff 即為整列快照，beforeRow 為 null。
 * - update: 以 beforeRow 舊列為基底，合併 afterDiff 變更欄位，還原出更新後的完整列。
 * - delete: 資料列已被刪除，故回傳 null。
 */
export function synthesizeAfterRow(
  action: AuditAction | string,
  beforeRow: Record<string, unknown> | null | undefined,
  afterDiff: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (action === 'delete') {
    // 刪除後資料列在該時間點之後已不存在，故回傳 null
    return null
  }
  if (action === 'insert') {
    // 新增時 beforeRow 為 null，afterDiff 即為整列快照
    return afterDiff ? { ...afterDiff } : null
  }
  if (action === 'update') {
    // 更新時以 beforeRow 舊列為底，將 afterDiff 變更欄位覆蓋上去合成整列
    if (!beforeRow && !afterDiff) return null
    return {
      ...(beforeRow ?? {}),
      ...(afterDiff ?? {}),
    }
  }
  // 未知或防禦性回傳
  if (afterDiff && beforeRow) {
    return { ...beforeRow, ...afterDiff }
  }
  return afterDiff ? { ...afterDiff } : (beforeRow ? { ...beforeRow } : null)
}

export interface ResolveActorParams {
  actorKind: AuditActorKind | string
  actorUserId: string | null
  actorSource: string | null
  profileMap?: Map<string, string> | Record<string, string>
}

/**
 * 解析操作者（actor）的顯示標籤與名稱（ADR-008 §8.2）。
 * - user: 若在 profileMap 中查得名稱則使用其顯示名稱；若無（例如帳號已刪除的 dangling uid），顯示中性的「未知成員」（三語；無法分辨已刪除或 RLS 看不到）。
 *   label 永遠是寫入者；若 actor_source 是已知的規則／流程來源（體重保留規則、帳號刪除），另外在 sourceNote 帶出註記，
 *   不改 kind 也不改 label——寫入者確實是這個人，只是那一筆不是他主動要刪的。
 * - system: 依據 actorSource 組合標籤，如「系統（自動清理）」、「系統（權限規則）」等，不顯示為空白。
 *   `delete_user_account` 不會出現在這裡：該函式內 auth.uid() 全程存在、也沒設 app.audit_actor_kind，永遠記成 user。
 * - service_role: 顯示「服務角色」（三語）。
 * 依循安全原則：任何地方都不得輸出或填入 email，只解析 displayName 或 uid。
 */
export function resolveActor(params: ResolveActorParams): ResolvedActor {
  const { actorKind, actorUserId, actorSource, profileMap } = params

  if (actorKind === 'user') {
    const sourceNote = (actorSource && USER_ACTOR_SOURCE_NOTES.get(actorSource.trim())) || null
    let displayName: string | null = null
    if (actorUserId && profileMap) {
      if (profileMap instanceof Map) {
        displayName = profileMap.get(actorUserId) ?? null
      } else {
        displayName = profileMap[actorUserId] ?? null
      }
    }

    if (displayName && displayName.trim()) {
      const trimmed = displayName.trim()
      return {
        kind: 'user',
        userId: actorUserId,
        source: actorSource,
        displayName: trimmed,
        label: {
          zh: trimmed,
          id: trimmed,
          en: trimmed,
        },
        sourceNote,
      }
    }

    // 解析不到名稱時無法分辨「帳號已刪除」與「一般 can_record 照護者看不到他人 profile」
    //（app_profiles 只回自己、fetch_household_members 僅限 owner），
    // 因此用中性的「未知成員」，避免把仍在使用的帳號誤標成已刪除而誤導稽核軌跡。
    return {
      kind: 'user',
      userId: actorUserId,
      source: actorSource,
      displayName: null,
      label: {
        zh: '未知成員',
        id: 'Anggota tidak diketahui',
        en: 'Unknown member',
      },
      sourceNote,
    }
  }

  if (actorKind === 'system') {
    let label: LocalizedText
    // 體溫清理（purge_expired_body_temperature_records）整段在 app.audit_bypass 下，根本不寫 audit 列，
    // 所以不會有這個 source；體重保留規則在 system 之下則只剩沒有 JWT 的情境（維運直接執行）才會出現，
    // 登入者觸發的那種會記成 user，由上面的 sourceNote 處理。
    if (
      actorSource === 'purge_expired_record_change_logs' ||
      actorSource === WEIGHT_RETENTION_AUDIT_SOURCE ||
      (actorSource && /purge|retention|cleanup/i.test(actorSource))
    ) {
      label = {
        zh: '系統（自動清理）',
        id: 'Sistem (pembersihan otomatis)',
        en: 'System (auto purge)',
      }
    } else if (actorSource === 'revoke_share_readonly_for_caregiver_role') {
      label = {
        zh: '系統（權限規則）',
        id: 'Sistem (aturan izin)',
        en: 'System (permission rule)',
      }
    } else if (actorSource && actorSource.trim()) {
      const s = actorSource.trim()
      label = {
        zh: `系統（${s}）`,
        id: `Sistem (${s})`,
        en: `System (${s})`,
      }
    } else {
      label = {
        zh: '系統',
        id: 'Sistem',
        en: 'System',
      }
    }
    return {
      kind: 'system',
      userId: null,
      source: actorSource,
      displayName: null,
      label,
      // system 列的 label 已經把 source 寫進去了，不需要再有一行註記
      sourceNote: null,
    }
  }

  if (actorKind === 'service_role') {
    return {
      kind: 'service_role',
      userId: null,
      source: actorSource,
      displayName: null,
      label: {
        zh: '服務角色',
        id: 'Peran layanan',
        en: 'Service role',
      },
      sourceNote: null,
    }
  }

  // 非預期之未知 actor_kind 防禦性處理
  return {
    kind: 'system',
    userId: null,
    source: actorSource,
    displayName: null,
    label: {
      zh: '系統',
      id: 'Sistem',
      en: 'System',
    },
    sourceNote: null,
  }
}

/**
 * 格式化 ResolvedActor 為特定語系的字串（三語支援）。
 */
export function formatActorLabel(
  actor: ResolvedActor,
  locale: Locale = 'zh'
): string {
  return actor.label[locale] ?? actor.label.zh
}

/**
 * 格式化「規則代刪／帳號刪除連帶」註記；沒有註記時回傳 null，由呼叫端決定不顯示那一行。
 */
export function formatActorSourceNote(
  actor: ResolvedActor,
  locale: Locale = 'zh'
): string | null {
  if (!actor.sourceNote) return null
  return actor.sourceNote[locale] ?? actor.sourceNote.zh
}

function parseRowSnapshot(val: unknown): Record<string, unknown> | null {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return val as Record<string, unknown>
  }
  return null
}

export interface MapRowOptions {
  profileMap?: Map<string, string> | Record<string, string>
  derivedColumns?: ReadonlySet<string>
}

/**
 * 將資料庫原始 record_change_logs 列轉換為型別化讀取模型 RecordChangeEntry。
 */
export function mapRecordChangeRowToEntry(
  row: RecordChangeLogRow,
  options?: MapRowOptions
): RecordChangeEntry {
  const rawChangedColumns = Array.isArray(row.changed_columns) ? [...row.changed_columns] : []
  const { userChangedColumns, derivedColumns } = filterDerivedColumns(
    rawChangedColumns,
    options?.derivedColumns ?? DEFAULT_DERIVED_COLUMNS
  )

  const beforeRow = parseRowSnapshot(row.before_row)
  const afterDiff = parseRowSnapshot(row.after_diff)
  const afterRow = synthesizeAfterRow(row.action, beforeRow, afterDiff)

  const actor = resolveActor({
    actorKind: row.actor_kind,
    actorUserId: row.actor_user_id,
    actorSource: row.actor_source,
    profileMap: options?.profileMap,
  })

  return {
    id: row.id,
    tableName: row.table_name,
    rowId: row.row_id,
    patientId: row.patient_id,
    householdId: row.household_id,
    action: row.action as AuditAction,
    actorKind: row.actor_kind as AuditActorKind,
    actorUserId: row.actor_user_id,
    actorSource: row.actor_source,
    actor,
    changedAt: row.changed_at,
    expiresAt: row.expires_at,
    changedColumns: userChangedColumns,
    derivedChangedColumns: derivedColumns,
    rawChangedColumns,
    beforeRow,
    afterDiff,
    afterRow,
  }
}

/**
 * 批次解析 userIds 對應的顯示名稱。
 * 執行策略：
 * 1. 先注入外部提供的 actorMap。
 * 2. 查 app_profiles（RLS 允許登入者查自己的資料，故操作者為本人時可直接解出）。
 * 3. 若仍有未解析者且呼叫者具備 household owner 權限，呼叫 fetch_household_members RPC。
 * 4. 其餘查無資料者留空，由 resolveActor 統一降級為「未知成員」。
 */
async function resolveActorProfiles(
  userIds: string[],
  client: SupabaseClient,
  providedMap?: Map<string, string> | Record<string, string>
): Promise<Map<string, string>> {
  const result = new Map<string, string>()

  if (providedMap) {
    if (providedMap instanceof Map) {
      for (const [k, v] of providedMap.entries()) {
        result.set(k, v)
      }
    } else {
      for (const [k, v] of Object.entries(providedMap)) {
        result.set(k, v)
      }
    }
  }

  const missing = Array.from(new Set(userIds.filter(id => Boolean(id) && !result.has(id))))
  if (missing.length === 0) return result

  // 1. 先查 app_profiles（登入者自己操作的紀錄可直接解出）
  try {
    if (typeof client.from === 'function') {
      const { data: profiles, error } = await client
        .from('app_profiles')
        .select('user_id, display_name')
        .in('user_id', missing)
      if (!error && Array.isArray(profiles)) {
        for (const p of profiles) {
          if (p?.user_id && p?.display_name?.trim()) {
            result.set(p.user_id, p.display_name.trim())
          }
        }
      }
    }
  } catch {
    // 忽略 RLS 或網路查詢錯誤，不影響 audit 歷史主體回傳
  }

  // 2. 若仍有缺漏，嘗試透過 fetch_household_members 比對家庭成員名稱（家庭擁有者情境）
  const stillMissing = missing.filter(id => !result.has(id))
  if (stillMissing.length > 0 && typeof client.rpc === 'function') {
    try {
      const { data: members, error } = await client.rpc('fetch_household_members')
      if (!error && Array.isArray(members)) {
        for (const m of members as Array<{ user_id?: string; display_name?: string | null }>) {
          if (m?.user_id && m?.display_name?.trim() && stillMissing.includes(m.user_id)) {
            result.set(m.user_id, m.display_name.trim())
          }
        }
      }
    } catch {
      // 非 household owner 呼叫此 RPC 會拋例外，安靜吞掉並在 resolveActor 中顯示為「未知成員」
    }
  }

  return result
}

export interface FetchRecordChangeHistoryOptions {
  tableName: string
  rowId: string
  // 必填：care_access 等複合鍵來源的 row_id 只是 user id，跨病人可能重複，必須以病人限縮
  patientId: string
  limit?: number
  ascending?: boolean
  actorMap?: Map<string, string> | Record<string, string>
  derivedColumns?: ReadonlySet<string>
  client?: SupabaseClient
}

/**
 * 查詢特定資料表特定一筆紀錄的異動歷史（例如血壓紀錄、回診問題等）。
 * 直接查詢 record_change_logs 表，由資料庫 RLS 把關。
 */
export async function fetchRecordChangeHistory(
  options: FetchRecordChangeHistoryOptions
): Promise<RecordChangeEntry[]> {
  const { tableName, rowId, patientId, limit, ascending = false, actorMap, derivedColumns } = options
  const client = options.client ?? defaultClient

  if (!tableName || !tableName.trim()) {
    throw new Error('tableName is required / 必須提供資料表名稱')
  }
  if (!rowId || !rowId.trim()) {
    throw new Error('rowId is required / 必須提供紀錄編號')
  }
  // RLS 只保證「有權限的病人」，不保證「目前選定的病人」，所以這裡強制帶 patient_id
  if (!patientId || !patientId.trim()) {
    throw new Error('patientId is required / 必須提供病人編號')
  }

  let query = client
    .from('record_change_logs')
    .select('*')
    .eq('table_name', tableName.trim())
    .eq('row_id', rowId.trim())
    .eq('patient_id', patientId.trim())

  query = query.order('changed_at', { ascending })

  if (typeof limit === 'number' && limit > 0) {
    query = query.limit(limit)
  }

  const { data, error } = await query
  if (error) throw error

  const rows = (data ?? []) as RecordChangeLogRow[]
  const userIds = rows
    .filter(r => r.actor_kind === 'user' && Boolean(r.actor_user_id))
    .map(r => r.actor_user_id as string)

  const profileMap = await resolveActorProfiles(userIds, client, actorMap)

  return rows.map(row => mapRecordChangeRowToEntry(row, { profileMap, derivedColumns }))
}

export interface FetchRecentPatientChangesOptions {
  patientId: string
  days?: number
  limit?: number
  actorMap?: Map<string, string> | Record<string, string>
  derivedColumns?: ReadonlySet<string>
  client?: SupabaseClient
}

/**
 * 查詢特定病人最近 N 天（預設 30 天）的所有異動紀錄（供病人層異動清單使用）。
 * 直接查詢 record_change_logs 表，由資料庫 RLS 把關。
 */
export async function fetchRecentPatientChanges(
  options: FetchRecentPatientChangesOptions
): Promise<RecordChangeEntry[]> {
  const { patientId, actorMap, derivedColumns } = options
  const days = typeof options.days === 'number' && options.days > 0 ? options.days : 30
  const client = options.client ?? defaultClient

  if (!patientId || !patientId.trim()) {
    throw new Error('patientId is required / 必須提供病人編號')
  }

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()

  let query = client
    .from('record_change_logs')
    .select('*')
    .eq('patient_id', patientId.trim())
    .gte('changed_at', cutoff)
    .order('changed_at', { ascending: false })

  if (typeof options.limit === 'number' && options.limit > 0) {
    query = query.limit(options.limit)
  }

  const { data, error } = await query
  if (error) throw error

  const rows = (data ?? []) as RecordChangeLogRow[]
  const userIds = rows
    .filter(r => r.actor_kind === 'user' && Boolean(r.actor_user_id))
    .map(r => r.actor_user_id as string)

  const profileMap = await resolveActorProfiles(userIds, client, actorMap)

  return rows.map(row => mapRecordChangeRowToEntry(row, { profileMap, derivedColumns }))
}
