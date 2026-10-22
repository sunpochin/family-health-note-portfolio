/*
檔案用途：集中處理管理者後台「通知訂閱」資料存取邊界——查詢病人清單與訂閱現況、呼叫 set_notification_subscription RPC、轉譯錯誤文案。
所在層：src/lib；唯一的 set_notification_subscription RPC 呼叫端，供 AdminPage 的 NotificationSubscriptionsPanel 使用。
主要關聯：src/features/system-admin/components/NotificationSubscriptionsPanel.tsx、
         supabase/migrations/20260926164959_add_notification_subscription_channels_and_admin_rpc_adr007.sql、
         supabase/migrations/20261005155025_pin_shared_telegram_group_to_one_household.sql（共用群組閘門的拒絕訊息，issue #1061；閘門已拆）、
         supabase/migrations/20261009093000_retire_shared_telegram_group.sql（共用群組退場後「不得再啟用」的拒絕訊息，issue #1061 階段 D）、
         docs/adr/007-notification-delivery-semantics.md（D6、issue #962、issue #994）。
*/
import { supabase } from './supabase'
import type { LocalizedText } from './i18n'
import { describeSaveError, readErrorFields } from './dataErrors'

export const NOTIFICATION_CHANNELS = ['telegram', 'line', 'push'] as const
export type NotificationChannel = typeof NOTIFICATION_CHANNELS[number]

/**
 * 後台實際開放切換的管道：目前只有 Telegram 有共用的送出端
 *（care-due-reminders、blood-pressure-notifier 都只撈 channel='telegram'）。
 * LINE 走另一條個人通知 outbox、push 尚無 sender，開了也不會送達，
 * 給管理者「已開通」的假安心比不提供更危險；等共用消費端存在再加回來。
 */
export const ADMIN_TOGGLEABLE_CHANNELS: readonly NotificationChannel[] = ['telegram']

export const CHANNEL_LABELS: Record<NotificationChannel, LocalizedText> = {
  telegram: { id: 'Telegram', zh: 'Telegram', en: 'Telegram' },
  line: { id: 'LINE', zh: 'LINE', en: 'LINE' },
  push: { id: 'Notifikasi push', zh: '推播通知', en: 'Push notification' },
}

export interface AdminAccessiblePatient {
  id: string
  displayName: string
  archived: boolean
}

export interface AdminNotificationSubscriptionData {
  patients: AdminAccessiblePatient[]
  subscriptions: Record<string, boolean>
}

export interface SetNotificationSubscriptionRpcArgs {
  p_patient_id: string
  p_channel: string
  p_enabled: boolean
}

export type RpcLike = (functionName: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>

const defaultRpc: RpcLike = async (functionName, args) => supabase.rpc(functionName, args)

export function subscriptionKey(patientId: string, channel: NotificationChannel): string {
  return `${patientId}:${channel}`
}

/**
 * 組合 set_notification_subscription RPC 引數形狀。
 * 參數名稱必須與 SQL 定義完全一致：p_patient_id, p_channel, p_enabled。
 */
export function buildSetNotificationSubscriptionRpcArgs(
  patientId: string,
  channel: NotificationChannel,
  enabled: boolean,
): SetNotificationSubscriptionRpcArgs {
  return {
    p_patient_id: patientId,
    p_channel: channel,
    p_enabled: enabled,
  }
}

/**
 * 將 RPC 拋出的五種具體錯誤（不是管理者／沒有 care_access／不支援的管道／共用群組只屬於一個家庭的隱私閘門／群組尚未指定家庭）轉譯為三語文案；
 * 其餘錯誤委派給共用的 describeSaveError，確保多語覆蓋與型別安全。
 */
export function describeNotificationSubscriptionError(error: unknown): LocalizedText {
  const fields = readErrorFields(error)
  const message = fields.message

  // RPC 錯誤 1：呼叫者不是系統管理員（is_admin_email 為 false）
  if (message.includes('Only an administrator can change notification subscriptions')) {
    return {
      id: 'Hanya administrator sistem yang dapat mengubah langganan notifikasi.',
      zh: '只有系統管理員可以變更通知訂閱。',
      en: 'Only a system administrator can change notification subscriptions.',
    }
  }

  // RPC 錯誤 2：呼叫者對該 patient 沒有 care_access
  if (message.includes('Caller does not have care access to this patient')) {
    return {
      id: 'Anda tidak memiliki izin perawatan untuk pasien ini.',
      zh: '您對此照護對象沒有照護權限。',
      en: 'Caller does not have care access to this patient.',
    }
  }

  // RPC 錯誤 3：不支援的 channel
  if (message.includes('Unsupported notification channel')) {
    return {
      id: 'Saluran notifikasi tidak didukung.',
      zh: '不支援的通知管道。',
      en: 'Unsupported notification channel.',
    }
  }

  // RPC 錯誤 4（issue #1061）：共用 Telegram 群組只屬於一個家庭，資料庫 trigger 拒絕把別的家庭接進來。
  // 管理者即使同時有兩家的 care_access 也會碰到——要說清楚這是刻意的隱私邊界，不是權限或網路問題，
  // 否則管理者會以為重試或補權限就能開通，而那正是會把別家病人的讀數送進自己家群組的操作。
  if (message.includes('Patient is not in the household that owns the shared Telegram group')) {
    return {
      id: 'Grup Telegram bersama hanya untuk satu keluarga. Pasien keluarga lain tidak bisa ditambahkan; gunakan notifikasi pribadi.',
      zh: '共用 Telegram 群組只屬於一個家庭，不能接上其他家庭的照護對象；請改用個人通知。',
      en: 'The shared Telegram group belongs to one household only. Care recipients from other households cannot be added; use personal notifications instead.',
    }
  }

  // RPC 錯誤 5（issue #1061）：還沒有任何家庭被釘為群組主人。被拒的可能正是群組主人那一家，
  // 不能沿用上一句「請改用個人通知」——要讓管理者知道是待維護者處理的設定，不是這條警報路徑被取消。
  if (message.includes('No household owns the shared Telegram group yet')) {
    return {
      id: 'Grup Telegram bersama belum ditetapkan untuk keluarga mana pun, jadi belum bisa diaktifkan. Hubungi pengelola sistem.',
      zh: '共用 Telegram 群組還沒有指定屬於哪個家庭，暫時無法開通；請聯絡系統維護者。',
      en: 'The shared Telegram group has not been assigned to a household yet, so it cannot be enabled. Contact the system maintainer.',
    }
  }

  // RPC 錯誤 6（issue #1061 階段 D，migration 20261009093000）：共用群組已退場，資料庫 trigger 拒絕把 telegram 列切回啟用。
  // 要說清楚這條路已經不存在、家人改走各自綁定的個人通知；不能說「稍後再試」，再試一百次也一樣。
  if (message.includes('The shared Telegram group has been retired')) {
    return {
      id: 'Grup Telegram bersama sudah dihentikan dan tidak bisa diaktifkan lagi. Anggota keluarga menerima notifikasi melalui Telegram atau LINE pribadi yang mereka tautkan sendiri.',
      zh: '共用 Telegram 群組已退場，無法再開通；家人改由各自綁定的個人 Telegram 或 LINE 收取通知。',
      en: 'The shared Telegram group has been retired and can no longer be enabled. Family members receive notifications through the personal Telegram or LINE they linked themselves.',
    }
  }

  return describeSaveError(error, {
    id: 'Gagal mengubah langganan notifikasi. Periksa koneksi lalu coba lagi.',
    zh: '變更通知訂閱失敗，請確認網路後重試。',
    en: 'Failed to update notification subscription. Check your network and try again.',
  })
}

/**
 * 查詢管理者有 care_access 的病人清單，以及各病人在各 channel 的通知訂閱現況。
 * 只使用 SELECT policy（authenticated 可讀有 care_access 的病人訂閱），無任何表層寫入操作。
 */
export async function fetchAdminNotificationSubscriptions(
  client = supabase,
): Promise<AdminNotificationSubscriptionData> {
  const [accessRes, subsRes] = await Promise.all([
    client.from('care_access').select('patient_id, patients(id, display_name, archived_at)'),
    client.from('notification_subscriptions').select('patient_id, channel, enabled'),
  ])

  if (accessRes.error) {
    console.error('[admin notification subscriptions] fetch care_access error:', accessRes.error)
    throw accessRes.error
  }
  if (subsRes.error) {
    console.error('[admin notification subscriptions] fetch notification_subscriptions error:', subsRes.error)
    throw subsRes.error
  }

  // 以 patient_id 去重。已封存對象仍要保留在清單：封存不會停用其訂閱與 care_due_reminders，
  // 提醒可能繼續送進共用群組，管理者必須還有開關可以關掉。
  const patientMap = new Map<string, AdminAccessiblePatient>()
  for (const row of accessRes.data ?? []) {
    if (!row.patient_id) continue
    const patientRaw = (row as unknown as { patients: { id: string; display_name: string; archived_at: string | null } | { id: string; display_name: string; archived_at: string | null }[] | null }).patients
    const patientRecord = Array.isArray(patientRaw) ? patientRaw[0] : patientRaw

    if (!patientMap.has(row.patient_id)) {
      patientMap.set(row.patient_id, {
        id: row.patient_id,
        displayName: patientRecord?.display_name?.trim() || '未命名對象',
        archived: Boolean(patientRecord?.archived_at),
      })
    }
  }

  const patients = Array.from(patientMap.values()).sort(
    (a, b) => Number(a.archived) - Number(b.archived) || a.displayName.localeCompare(b.displayName),
  )

  // 讀取到的 subscription 列建立查表索引；未設定者預設為 false（未開通）
  const subscriptions: Record<string, boolean> = {}
  for (const sub of (subsRes.data ?? []) as Array<{ patient_id: string; channel: string; enabled: boolean }>) {
    if (NOTIFICATION_CHANNELS.includes(sub.channel as NotificationChannel)) {
      subscriptions[subscriptionKey(sub.patient_id, sub.channel as NotificationChannel)] = Boolean(sub.enabled)
    }
  }

  return { patients, subscriptions }
}

/**
 * 唯一的伺服器控制訂閱寫入路徑呼叫者：
 * 呼叫 SECURITY DEFINER RPC `set_notification_subscription(p_patient_id, p_channel, p_enabled)`。
 * 停用走 enabled=false，不刪除歷史資料列；由 record_change_logs trigger 自動留痕。
 */
export async function setNotificationSubscription(
  params: {
    patientId: string
    channel: NotificationChannel
    enabled: boolean
  },
  rpc: RpcLike = defaultRpc,
): Promise<{ ok: true } | { ok: false; error: LocalizedText; rawError: unknown }> {
  const args = buildSetNotificationSubscriptionRpcArgs(params.patientId, params.channel, params.enabled)
  const { error } = await rpc('set_notification_subscription', args as unknown as Record<string, unknown>)

  if (error) {
    console.error('[set_notification_subscription error]', error)
    return {
      ok: false,
      error: describeNotificationSubscriptionError(error),
      rawError: error,
    }
  }

  return { ok: true }
}
