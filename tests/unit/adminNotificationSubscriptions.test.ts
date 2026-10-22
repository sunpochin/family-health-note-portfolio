/*
檔案用途：驗證管理者後台「通知訂閱」資料層邏輯，包含 RPC 引數組裝、錯誤轉譯、開關 RPC 呼叫與訂閱資料聚合。
所在層：tests/unit；不連接遠端 Supabase。
主要關聯：src/lib/notificationSubscriptions.ts、
         supabase/migrations/20260926164959_add_notification_subscription_channels_and_admin_rpc_adr007.sql、
         supabase/migrations/20261005155025_pin_shared_telegram_group_to_one_household.sql（issue #1061 閘門的拒絕訊息）。
*/
import { describe, expect, test } from 'bun:test'
import {
  NOTIFICATION_CHANNELS,
  buildSetNotificationSubscriptionRpcArgs,
  describeNotificationSubscriptionError,
  fetchAdminNotificationSubscriptions,
  setNotificationSubscription,
  subscriptionKey,
} from '../../src/lib/notificationSubscriptions'

describe('notificationSubscriptions data layer', () => {
  describe('buildSetNotificationSubscriptionRpcArgs', () => {
    test('組合正確的 RPC 參數形狀 (p_patient_id, p_channel, p_enabled)', () => {
      const args = buildSetNotificationSubscriptionRpcArgs('patient-123', 'line', true)
      expect(args).toEqual({
        p_patient_id: 'patient-123',
        p_channel: 'line',
        p_enabled: true,
      })
    })

    test('涵蓋 telegram、line、push 三種合法管道', () => {
      expect(NOTIFICATION_CHANNELS).toEqual(['telegram', 'line', 'push'])
      for (const channel of NOTIFICATION_CHANNELS) {
        const enabledArgs = buildSetNotificationSubscriptionRpcArgs('patient-uuid', channel, true)
        expect(enabledArgs.p_channel).toBe(channel)
        expect(enabledArgs.p_enabled).toBe(true)

        const disabledArgs = buildSetNotificationSubscriptionRpcArgs('patient-uuid', channel, false)
        expect(disabledArgs.p_channel).toBe(channel)
        expect(disabledArgs.p_enabled).toBe(false)
      }
    })
  })

  describe('describeNotificationSubscriptionError', () => {
    test('精確轉譯 RPC 錯誤：不是系統管理員', () => {
      const err = { message: 'Only an administrator can change notification subscriptions' }
      const localized = describeNotificationSubscriptionError(err)
      expect(localized.zh).toBe('只有系統管理員可以變更通知訂閱。')
      expect(localized.id).toBe('Hanya administrator sistem yang dapat mengubah langganan notifikasi.')
      expect(localized.en).toBe('Only a system administrator can change notification subscriptions.')
    })

    test('精確轉譯 RPC 錯誤：呼叫者對該病人沒有 care_access', () => {
      const err = { message: 'Caller does not have care access to this patient' }
      const localized = describeNotificationSubscriptionError(err)
      expect(localized.zh).toBe('您對此照護對象沒有照護權限。')
      expect(localized.id).toBe('Anda tidak memiliki izin perawatan untuk pasien ini.')
      expect(localized.en).toBe('Caller does not have care access to this patient.')
    })

    test('精確轉譯 RPC 錯誤：不支援的 channel', () => {
      const err = { message: 'Unsupported notification channel' }
      const localized = describeNotificationSubscriptionError(err)
      expect(localized.zh).toBe('不支援的通知管道。')
      expect(localized.id).toBe('Saluran notifikasi tidak didukung.')
      expect(localized.en).toBe('Unsupported notification channel.')
    })

    test('精確轉譯資料庫閘門錯誤：別的家庭不能接上共用 Telegram 群組（issue #1061）', () => {
      // PostgREST 會把 RAISE 的 HINT 一起帶回來；轉譯只看 message，hint 是英文維運說明，不能直接顯示給管理者。
      const err = {
        code: 'P0001',
        message: 'Patient is not in the household that owns the shared Telegram group',
        hint: 'The shared Telegram group (TELEGRAM_CHAT_ID) belongs to one household only; other households must use personal notifications (issue #1061).',
      }
      const localized = describeNotificationSubscriptionError(err)
      expect(localized.zh).toBe('共用 Telegram 群組只屬於一個家庭，不能接上其他家庭的照護對象；請改用個人通知。')
      expect(localized.id).toBe('Grup Telegram bersama hanya untuk satu keluarga. Pasien keluarga lain tidak bisa ditambahkan; gunakan notifikasi pribadi.')
      expect(localized.en).toBe('The shared Telegram group belongs to one household only. Care recipients from other households cannot be added; use personal notifications instead.')
    })

    test('沒有任何家庭被釘為群組主人時給不同的三語文案，不叫管理者改用個人通知（issue #1061）', () => {
      const localized = describeNotificationSubscriptionError({ code: 'P0001', message: 'No household owns the shared Telegram group yet' })
      expect(localized.zh).toBe('共用 Telegram 群組還沒有指定屬於哪個家庭，暫時無法開通；請聯絡系統維護者。')
      expect(localized.id).toBe('Grup Telegram bersama belum ditetapkan untuk keluarga mana pun, jadi belum bisa diaktifkan. Hubungi pengelola sistem.')
      expect(localized.en).toBe('The shared Telegram group has not been assigned to a household yet, so it cannot be enabled. Contact the system maintainer.')
      expect(localized.zh).not.toContain('個人通知')
    })

    test('共用群組退場後，資料庫拒絕再啟用 telegram 時給三語文案，說明改走個人通知、不叫人重試（issue #1061 階段 D）', () => {
      const localized = describeNotificationSubscriptionError({
        code: 'P0001',
        message: 'The shared Telegram group has been retired; telegram subscriptions cannot be enabled',
        hint: 'issue #1061 stage D (migration 20261009093000): no sender reads this flag any more; family members receive notifications through their own linked Telegram or LINE.',
      })
      expect(localized.zh).toBe('共用 Telegram 群組已退場，無法再開通；家人改由各自綁定的個人 Telegram 或 LINE 收取通知。')
      expect(localized.id).toBe('Grup Telegram bersama sudah dihentikan dan tidak bisa diaktifkan lagi. Anggota keluarga menerima notifikasi melalui Telegram atau LINE pribadi yang mereka tautkan sendiri.')
      expect(localized.en).toBe('The shared Telegram group has been retired and can no longer be enabled. Family members receive notifications through the personal Telegram or LINE they linked themselves.')
      expect(localized.zh).not.toContain('重試')
    })

    test('通用連線/權限與未知錯誤回退至安全的三語文案', () => {
      const connectionErr = { code: 'PGRST301', message: 'timeout' }
      const localizedConn = describeNotificationSubscriptionError(connectionErr)
      expect(localizedConn.zh).toContain('連線或伺服器設定有問題')

      const unknownErr = { message: 'unexpected database failure' }
      const localizedUnknown = describeNotificationSubscriptionError(unknownErr)
      expect(localizedUnknown.zh).toBe('變更通知訂閱失敗，請確認網路後重試。')
      expect(localizedUnknown.id).toBe('Gagal mengubah langganan notifikasi. Periksa koneksi lalu coba lagi.')
      expect(localizedUnknown.en).toBe('Failed to update notification subscription. Check your network and try again.')
    })
  })

  describe('setNotificationSubscription', () => {
    test('以正確函式名稱與引數呼叫 RPC 並回傳成功', async () => {
      let calledFn = ''
      let passedArgs: unknown = null

      const mockRpc = async (fn: string, args?: Record<string, unknown>) => {
        calledFn = fn
        passedArgs = args
        return { data: [{ subscription_patient_id: 'p-1', subscription_channel: 'line', subscription_enabled: true }], error: null }
      }

      const res = await setNotificationSubscription(
        { patientId: 'p-1', channel: 'line', enabled: true },
        mockRpc,
      )

      expect(res.ok).toBe(true)
      expect(calledFn).toBe('set_notification_subscription')
      expect(passedArgs).toEqual({
        p_patient_id: 'p-1',
        p_channel: 'line',
        p_enabled: true,
      })
    })

    test('當 RPC 拒絕時捕捉錯誤並回傳三語轉譯結果', async () => {
      const mockRpc = async () => ({
        data: null,
        error: { message: 'Only an administrator can change notification subscriptions' },
      })

      const res = await setNotificationSubscription(
        { patientId: 'p-2', channel: 'telegram', enabled: false },
        mockRpc,
      )

      expect(res.ok).toBe(false)
      if (!res.ok) {
        expect(res.error.zh).toBe('只有系統管理員可以變更通知訂閱。')
        expect(res.error.id).toBe('Hanya administrator sistem yang dapat mengubah langganan notifikasi.')
        expect(res.error.en).toBe('Only a system administrator can change notification subscriptions.')
      }
    })
  })

  describe('fetchAdminNotificationSubscriptions', () => {
    test('正確聚合病人與訂閱現況，並去重、保留封存病人（供關閉其訂閱）且排在最後', async () => {
      const mockClient = {
        from: (table: string) => ({
          select: async () => {
            if (table === 'care_access') {
              return {
                data: [
                  { patient_id: 'patient-a', patients: { id: 'patient-a', display_name: '媽媽', archived_at: null } },
                  // 重複 access 列，應去重
                  { patient_id: 'patient-a', patients: { id: 'patient-a', display_name: '媽媽', archived_at: null } },
                  { patient_id: 'patient-b', patients: { id: 'patient-b', display_name: '爸爸', archived_at: null } },
                  // 已封存病人，仍須保留以便管理者關閉其訂閱
                  { patient_id: 'patient-c', patients: { id: 'patient-c', display_name: '阿公', archived_at: '2026-01-01' } },
                ],
                error: null,
              }
            }
            if (table === 'notification_subscriptions') {
              return {
                data: [
                  { patient_id: 'patient-a', channel: 'line', enabled: true },
                  { patient_id: 'patient-a', channel: 'telegram', enabled: false },
                  // 未在合法 channel 內的歷史列應被過濾
                  { patient_id: 'patient-a', channel: 'carrier_pigeon', enabled: true },
                ],
                error: null,
              }
            }
            throw new Error(`Unexpected table ${table}`)
          },
        }),
      }

      const result = await fetchAdminNotificationSubscriptions(mockClient as any)
      expect(result.patients.map(p => p.id)).toEqual(['patient-a', 'patient-b', 'patient-c'])
      expect(result.patients.map(p => p.archived)).toEqual([false, false, true])
      expect(result.subscriptions[subscriptionKey('patient-a', 'line')]).toBe(true)
      expect(result.subscriptions[subscriptionKey('patient-a', 'telegram')]).toBe(false)
      // 未設定的 channel 查無鍵值（預設 undefined / falsy）
      expect(result.subscriptions[subscriptionKey('patient-a', 'push')]).toBeUndefined()
      expect(result.subscriptions[subscriptionKey('patient-b', 'line')]).toBeUndefined()
    })
  })
})
