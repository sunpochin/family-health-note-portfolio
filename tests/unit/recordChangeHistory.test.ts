/*
檔案用途：測試 recordChangeHistory.ts 的型別化讀取與轉換邏輯（ADR-008 AUDIT-3，issue #969）。
包含 before ⊕ diff 合成、推導欄位過濾、actor 解析（含已刪除帳號與系統列三語）、
fetchRecordChangeHistory 與 fetchRecentPatientChanges 查詢參數與 mock 測試，以及安全不變量驗證。
所在層：tests/unit 單元測試層。
主要關聯：src/lib/recordChangeHistory.ts、docs/adr/008-audit-coverage-boundary.md、
docs/architecture/audit-coverage-design.md §8.1／§10。
*/
import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_DERIVED_COLUMNS,
  filterDerivedColumns,
  formatActorLabel,
  formatActorSourceNote,
  mapRecordChangeRowToEntry,
  resolveActor,
  synthesizeAfterRow,
  fetchRecordChangeHistory,
  fetchRecentPatientChanges,
  type RecordChangeLogRow,
  type ResolvedActor,
} from '../../src/lib/recordChangeHistory'

describe('recordChangeHistory - synthesizeAfterRow (before ⊕ diff 合成)', () => {
  it('insert 時 beforeRow 為 null，afterDiff 即為完整新列', () => {
    const afterDiff = {
      id: 'row-1',
      systolic: 120,
      diastolic: 80,
      patient_id: 'patient-1',
    }
    const afterRow = synthesizeAfterRow('insert', null, afterDiff)
    expect(afterRow).toEqual(afterDiff)
  })

  it('update 時以 beforeRow 舊列為基底，合併 afterDiff 覆蓋更新欄位', () => {
    const beforeRow = {
      id: 'row-1',
      systolic: 120,
      diastolic: 80,
      pulse: 72,
      patient_id: 'patient-1',
    }
    const afterDiff = {
      systolic: 135,
      pulse: 78,
    }
    const afterRow = synthesizeAfterRow('update', beforeRow, afterDiff)
    expect(afterRow).toEqual({
      id: 'row-1',
      systolic: 135,
      diastolic: 80,
      pulse: 78,
      patient_id: 'patient-1',
    })
  })

  it('delete 時資料已被刪除，afterRow 一律回傳 null', () => {
    const beforeRow = {
      id: 'row-1',
      systolic: 120,
      diastolic: 80,
    }
    const afterRow = synthesizeAfterRow('delete', beforeRow, null)
    expect(afterRow).toBeNull()
  })

  it('防禦性處理：update 若兩者皆為空則回傳 null', () => {
    expect(synthesizeAfterRow('update', null, null)).toBeNull()
  })
})

describe('recordChangeHistory - filterDerivedColumns (推導欄位過濾)', () => {
  it('自 changed_columns 正確過濾預設推導欄位（answered_at, updated_at, care_date）', () => {
    const raw = ['systolic', 'diastolic', 'answered_at', 'updated_at', 'care_date', 'notes']
    const { userChangedColumns, derivedColumns } = filterDerivedColumns(raw)

    expect(userChangedColumns).toEqual(['systolic', 'diastolic', 'notes'])
    expect(derivedColumns).toEqual(['answered_at', 'updated_at', 'care_date'])
  })

  it('傳入空陣列或 null/undefined 時回傳空陣列', () => {
    expect(filterDerivedColumns([])).toEqual({ userChangedColumns: [], derivedColumns: [] })
    expect(filterDerivedColumns(null)).toEqual({ userChangedColumns: [], derivedColumns: [] })
    expect(filterDerivedColumns(undefined)).toEqual({ userChangedColumns: [], derivedColumns: [] })
  })

  it('支援傳入自訂的推導欄位集合', () => {
    const custom = new Set(['created_at', 'auto_flag'])
    const raw = ['systolic', 'created_at', 'auto_flag', 'updated_at']
    const { userChangedColumns, derivedColumns } = filterDerivedColumns(raw, custom)

    expect(userChangedColumns).toEqual(['systolic', 'updated_at'])
    expect(derivedColumns).toEqual(['created_at', 'auto_flag'])
  })

  it('DEFAULT_DERIVED_COLUMNS 包含 ADR-008 §4.4 第 2 點明列的三個欄位', () => {
    expect(DEFAULT_DERIVED_COLUMNS.has('answered_at')).toBe(true)
    expect(DEFAULT_DERIVED_COLUMNS.has('updated_at')).toBe(true)
    expect(DEFAULT_DERIVED_COLUMNS.has('care_date')).toBe(true)
  })
})

describe('recordChangeHistory - resolveActor (操作者身分與三語標籤解析)', () => {
  it('user 在 profileMap 存在時解析為該使用者的 display_name', () => {
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'user-123',
      actorSource: null,
      profileMap: new Map([['user-123', 'Meiling']]),
    })

    expect(actor.kind).toBe('user')
    expect(actor.userId).toBe('user-123')
    expect(actor.displayName).toBe('Meiling')
    expect(actor.label).toEqual({
      zh: 'Meiling',
      id: 'Meiling',
      en: 'Meiling',
    })
    expect(formatActorLabel(actor, 'zh')).toBe('Meiling')
    expect(formatActorLabel(actor, 'id')).toBe('Meiling')
    expect(formatActorLabel(actor, 'en')).toBe('Meiling')
  })

  it('user 在 profileMap 查無資料（已刪除帳號之 dangling uid）時三語顯示中性「未知成員」（無法分辨已刪除或看不到他人 profile）', () => {
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'user-deleted-456',
      actorSource: null,
      profileMap: new Map(),
    })

    expect(actor.kind).toBe('user')
    expect(actor.userId).toBe('user-deleted-456')
    expect(actor.displayName).toBeNull()
    expect(actor.label).toEqual({
      zh: '未知成員',
      id: 'Anggota tidak diketahui',
      en: 'Unknown member',
    })
    expect(formatActorLabel(actor, 'zh')).toBe('未知成員')
    expect(formatActorLabel(actor, 'id')).toBe('Anggota tidak diketahui')
    expect(formatActorLabel(actor, 'en')).toBe('Unknown member')
  })

  it('user + 體重保留規則來源：仍是寫入者本人，另帶「由保留規則代刪」註記，不會被誤標成系統動作（#1054）', () => {
    // AUDIT-2：寫入過去日期的體重會擠掉當天原本的量測，那筆 DELETE 刻意不 bypass，
    // 記成 actor_kind = 'user' ＋ actor_source = 'enforce_patient_weight_daily_retention'
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'user-123',
      actorSource: 'enforce_patient_weight_daily_retention',
      profileMap: new Map([['user-123', 'Meiling']]),
    })

    expect(actor.kind).toBe('user')
    expect(actor.userId).toBe('user-123')
    expect(actor.source).toBe('enforce_patient_weight_daily_retention')
    expect(actor.displayName).toBe('Meiling')
    expect(actor.label).toEqual({ zh: 'Meiling', id: 'Meiling', en: 'Meiling' })
    expect(actor.sourceNote).toEqual({
      zh: '由保留規則代刪',
      id: 'Dihapus oleh aturan penyimpanan data',
      en: 'Deleted by retention rule',
    })
    expect(formatActorSourceNote(actor, 'zh')).toBe('由保留規則代刪')
    expect(formatActorSourceNote(actor, 'id')).toBe('Dihapus oleh aturan penyimpanan data')
    expect(formatActorSourceNote(actor, 'en')).toBe('Deleted by retention rule')
    // 名字那一行不得出現「系統」字樣；規則代刪是註記，不是換掉操作者
    for (const locale of ['zh', 'id', 'en'] as const) {
      expect(formatActorLabel(actor, locale)).not.toMatch(/系統|Sistem|System/)
    }
  })

  it('user + 體重保留規則來源但解析不到名字時，仍顯示「未知成員」並帶註記', () => {
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'user-gone',
      actorSource: 'enforce_patient_weight_daily_retention',
      profileMap: new Map(),
    })

    expect(actor.kind).toBe('user')
    expect(actor.displayName).toBeNull()
    expect(formatActorLabel(actor, 'zh')).toBe('未知成員')
    expect(formatActorSourceNote(actor, 'zh')).toBe('由保留規則代刪')
  })

  it('user + delete_user_account 來源：記成 user 並帶「因帳號刪除而連帶異動」註記（設計文件 §5.3／§6.4）', () => {
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'user-deleted-456',
      actorSource: 'delete_user_account',
      profileMap: new Map(),
    })

    expect(actor.kind).toBe('user')
    expect(actor.userId).toBe('user-deleted-456')
    expect(formatActorLabel(actor, 'zh')).toBe('未知成員')
    expect(actor.sourceNote).toEqual({
      zh: '因帳號刪除而連帶異動',
      id: 'Berubah akibat penghapusan akun',
      en: 'Changed by account deletion',
    })
  })

  it('user 沒有 source、或 source 不是已知的規則／流程來源時不產生註記，也不把函式名當文字顯示', () => {
    const sources: Array<string | null> = [
      null,
      '',
      '   ',
      'set_notification_subscription',
      // actor_source 是資料庫的任意字串；原型鏈上的名字不能命中註記表
      'constructor',
      '__proto__',
      'toString',
    ]

    for (const source of sources) {
      const actor = resolveActor({
        actorKind: 'user',
        actorUserId: 'user-123',
        actorSource: source,
        profileMap: new Map([['user-123', 'Meiling']]),
      })
      expect(actor.sourceNote).toBeNull()
      expect(formatActorSourceNote(actor, 'zh')).toBeNull()
      expect(formatActorLabel(actor, 'zh')).toBe('Meiling')
    }
  })

  it('system／service_role 列不帶 sourceNote（system 的 label 已經包含來源）', () => {
    const system = resolveActor({
      actorKind: 'system',
      actorUserId: null,
      actorSource: 'revoke_share_readonly_for_caregiver_role',
    })
    const serviceRole = resolveActor({
      actorKind: 'service_role',
      actorUserId: null,
      actorSource: null,
    })
    const unknownKind = resolveActor({
      actorKind: 'something_new',
      actorUserId: null,
      actorSource: null,
    })

    expect(system.sourceNote).toBeNull()
    expect(serviceRole.sourceNote).toBeNull()
    expect(unknownKind.sourceNote).toBeNull()
    expect(formatActorSourceNote(system, 'zh')).toBeNull()
  })

  it('system + purge 自動清理來源解析為「系統（自動清理）」', () => {
    // purge_expired_body_temperature_records 不在清單內：體溫清理整段在 app.audit_bypass 下、不寫 audit 列，
    // 這個 source 不可能出現（#1054）。enforce_patient_weight_daily_retention 在 system 之下只剩
    // 沒有 JWT 的情境（維運直接執行）；登入者觸發的那種是 user，見上方的 sourceNote 案例。
    const sources = [
      'purge_expired_record_change_logs',
      'enforce_patient_weight_daily_retention',
      'daily_cleanup_routine',
    ]

    for (const source of sources) {
      const actor = resolveActor({
        actorKind: 'system',
        actorUserId: null,
        actorSource: source,
      })
      expect(actor.label).toEqual({
        zh: '系統（自動清理）',
        id: 'Sistem (pembersihan otomatis)',
        en: 'System (auto purge)',
      })
    }
  })

  it('system + revoke_share_readonly_for_caregiver_role 來源解析為「系統（權限規則）」', () => {
    const actor = resolveActor({
      actorKind: 'system',
      actorUserId: null,
      actorSource: 'revoke_share_readonly_for_caregiver_role',
    })

    expect(actor.label).toEqual({
      zh: '系統（權限規則）',
      id: 'Sistem (aturan izin)',
      en: 'System (permission rule)',
    })
  })

  it('system 未帶 actorSource 或自訂來源時不顯示空白', () => {
    const noSourceActor = resolveActor({
      actorKind: 'system',
      actorUserId: null,
      actorSource: null,
    })
    expect(noSourceActor.label).toEqual({
      zh: '系統',
      id: 'Sistem',
      en: 'System',
    })

    const customSourceActor = resolveActor({
      actorKind: 'system',
      actorUserId: null,
      actorSource: 'custom_sync_job',
    })
    expect(customSourceActor.label).toEqual({
      zh: '系統（custom_sync_job）',
      id: 'Sistem (custom_sync_job)',
      en: 'System (custom_sync_job)',
    })
  })

  it('service_role 解析為「服務角色」', () => {
    const actor = resolveActor({
      actorKind: 'service_role',
      actorUserId: null,
      actorSource: null,
    })

    expect(actor.kind).toBe('service_role')
    expect(actor.userId).toBeNull()
    expect(actor.label).toEqual({
      zh: '服務角色',
      id: 'Peran layanan',
      en: 'Service role',
    })
  })
})

describe('recordChangeHistory - mapRecordChangeRowToEntry', () => {
  it('將資料庫列完整轉換為型別化 RecordChangeEntry', () => {
    const row: RecordChangeLogRow = {
      id: 'audit-log-1',
      table_name: 'blood_pressure_records',
      row_id: 'bp-100',
      patient_id: 'patient-999',
      household_id: 'household-1',
      action: 'update',
      actor_kind: 'user',
      actor_user_id: 'user-owner',
      actor_source: null,
      changed_columns: ['systolic', 'updated_at'],
      before_row: {
        id: 'bp-100',
        systolic: 120,
        diastolic: 80,
        updated_at: '2026-09-01T08:00:00Z',
      },
      after_diff: {
        systolic: 135,
        updated_at: '2026-09-01T08:15:00Z',
      },
      changed_at: '2026-09-01T08:15:00Z',
      expires_at: '2027-02-28T08:15:00Z',
    }

    const entry = mapRecordChangeRowToEntry(row, {
      profileMap: new Map([['user-owner', 'Caregiver Alice']]),
    })

    expect(entry.id).toBe('audit-log-1')
    expect(entry.tableName).toBe('blood_pressure_records')
    expect(entry.rowId).toBe('bp-100')
    expect(entry.patientId).toBe('patient-999')
    expect(entry.householdId).toBe('household-1')
    expect(entry.action).toBe('update')
    expect(entry.actorKind).toBe('user')
    expect(entry.actorUserId).toBe('user-owner')
    expect(entry.actor.displayName).toBe('Caregiver Alice')
    expect(entry.changedColumns).toEqual(['systolic'])
    expect(entry.derivedChangedColumns).toEqual(['updated_at'])
    expect(entry.rawChangedColumns).toEqual(['systolic', 'updated_at'])
    expect(entry.afterRow).toEqual({
      id: 'bp-100',
      systolic: 135,
      diastolic: 80,
      updated_at: '2026-09-01T08:15:00Z',
    })
  })

  it('體重保留規則代刪的列（user + enforce_patient_weight_daily_retention）端到端：delete、操作者是本人、帶代刪註記（#1054）', () => {
    // 形狀對照 AUDIT-2 migration：資料庫列的 actor_source 由 SET LOCAL app.audit_source 寫入，
    // before_row 是被擠掉的那筆體重（recorded_by 類 email 欄位已在寫入時剝除）
    const row: RecordChangeLogRow = {
      id: 'audit-log-weight-1',
      table_name: 'patient_weight_measurement_records',
      row_id: 'weight-7',
      patient_id: 'patient-999',
      household_id: null,
      action: 'delete',
      actor_kind: 'user',
      actor_user_id: 'user-owner',
      actor_source: 'enforce_patient_weight_daily_retention',
      changed_columns: null,
      before_row: { id: 'weight-7', weight_kg: 52.4, measured_on: '2026-09-30' },
      after_diff: null,
      changed_at: '2026-10-05T09:00:00Z',
      expires_at: '2027-04-03T09:00:00Z',
    }

    const entry = mapRecordChangeRowToEntry(row, {
      profileMap: new Map([['user-owner', 'Caregiver Alice']]),
    })

    expect(entry.action).toBe('delete')
    expect(entry.actorKind).toBe('user')
    expect(entry.actorSource).toBe('enforce_patient_weight_daily_retention')
    expect(entry.actor.kind).toBe('user')
    expect(formatActorLabel(entry.actor, 'en')).toBe('Caregiver Alice')
    expect(formatActorSourceNote(entry.actor, 'en')).toBe('Deleted by retention rule')
    expect(entry.afterRow).toBeNull()
    expect(JSON.stringify(entry)).not.toContain('@')
  })

  it('一般使用者自己刪的列（source 為 null）沒有代刪註記', () => {
    const row: RecordChangeLogRow = {
      id: 'audit-log-weight-2',
      table_name: 'patient_weight_measurement_records',
      row_id: 'weight-8',
      patient_id: 'patient-999',
      household_id: null,
      action: 'delete',
      actor_kind: 'user',
      actor_user_id: 'user-owner',
      actor_source: null,
      changed_columns: null,
      before_row: { id: 'weight-8', weight_kg: 52.1 },
      after_diff: null,
      changed_at: '2026-10-05T09:00:00Z',
      expires_at: '2027-04-03T09:00:00Z',
    }

    const entry = mapRecordChangeRowToEntry(row, {
      profileMap: new Map([['user-owner', 'Caregiver Alice']]),
    })

    expect(entry.actor.sourceNote).toBeNull()
    expect(formatActorSourceNote(entry.actor, 'zh')).toBeNull()
  })
})

describe('recordChangeHistory - fetchRecordChangeHistory & fetchRecentPatientChanges', () => {
  it('fetchRecordChangeHistory 在缺少 tableName 或 rowId 時拋出防禦性錯誤', async () => {
    await expect(
      fetchRecordChangeHistory({ tableName: '', rowId: 'row-1', patientId: 'p1' })
    ).rejects.toThrow('tableName is required')

    await expect(
      fetchRecordChangeHistory({ tableName: 'blood_pressure_records', rowId: '', patientId: 'p1' })
    ).rejects.toThrow('rowId is required')
  })

  it('fetchRecordChangeHistory 在缺少 patientId 時拋出，避免複合鍵 row_id 跨病人混入', async () => {
    await expect(
      fetchRecordChangeHistory({ tableName: 'care_access', rowId: 'user-1', patientId: ' ' })
    ).rejects.toThrow('patientId is required')
  })

  it('fetchRecentPatientChanges 在缺少 patientId 時拋出防禦性錯誤', async () => {
    await expect(
      fetchRecentPatientChanges({ patientId: '' })
    ).rejects.toThrow('patientId is required')
  })

  it('fetchRecordChangeHistory 正確帶入條件與 mock 查詢', async () => {
    const mockRows: RecordChangeLogRow[] = [
      {
        id: 'log-1',
        table_name: 'blood_pressure_records',
        row_id: 'row-123',
        patient_id: 'patient-456',
        household_id: null,
        action: 'insert',
        actor_kind: 'user',
        actor_user_id: 'user-1',
        actor_source: null,
        changed_columns: null,
        before_row: null,
        after_diff: { systolic: 120, diastolic: 80 },
        changed_at: '2026-09-20T10:00:00Z',
        expires_at: null,
      },
    ]

    const capturedFilters: Record<string, unknown> = {}
    let capturedOrder: unknown = null
    let capturedLimit: number | null = null

    const mockQueryBuilder = {
      eq: (col: string, val: unknown) => {
        capturedFilters[col] = val
        return mockQueryBuilder
      },
      order: (col: string, opts: unknown) => {
        capturedOrder = { col, opts }
        return mockQueryBuilder
      },
      limit: (n: number) => {
        capturedLimit = n
        return mockQueryBuilder
      },
      then: (resolve: (val: unknown) => unknown) => {
        resolve({ data: mockRows, error: null })
      },
    }

    const mockClient = {
      from: (table: string) => {
        if (table === 'record_change_logs') {
          return {
            select: () => mockQueryBuilder,
          }
        }
        if (table === 'app_profiles') {
          return {
            select: () => ({
              in: () => Promise.resolve({ data: [{ user_id: 'user-1', display_name: 'Doctor Bob' }], error: null }),
            }),
          }
        }
        throw new Error(`Unexpected table ${table}`)
      },
      rpc: () => Promise.resolve({ data: [], error: null }),
    }

    const entries = await fetchRecordChangeHistory({
      tableName: 'blood_pressure_records',
      rowId: 'row-123',
      patientId: 'patient-456',
      limit: 10,
      client: mockClient as any,
    })

    expect(capturedFilters['table_name']).toBe('blood_pressure_records')
    expect(capturedFilters['row_id']).toBe('row-123')
    expect(capturedFilters['patient_id']).toBe('patient-456')
    expect(capturedLimit).toBe(10)
    expect(entries.length).toBe(1)
    expect(entries[0].actor.displayName).toBe('Doctor Bob')
    expect(entries[0].action).toBe('insert')
    expect(entries[0].afterRow).toEqual({ systolic: 120, diastolic: 80 })
  })

  it('fetchRecentPatientChanges 依據天數計算 cutoff 並正確傳入 gte 條件', async () => {
    let capturedPatientId: string | null = null
    let capturedCutoff: string | null = null

    const mockQueryBuilder = {
      eq: (col: string, val: string) => {
        if (col === 'patient_id') capturedPatientId = val
        return mockQueryBuilder
      },
      gte: (col: string, val: string) => {
        if (col === 'changed_at') capturedCutoff = val
        return mockQueryBuilder
      },
      order: () => mockQueryBuilder,
      limit: () => mockQueryBuilder,
      then: (resolve: (val: unknown) => unknown) => {
        resolve({ data: [], error: null })
      },
    }

    const mockClient = {
      from: (table: string) => ({
        select: () => mockQueryBuilder,
      }),
      rpc: () => Promise.resolve({ data: [], error: null }),
    }

    await fetchRecentPatientChanges({
      patientId: 'patient-789',
      days: 14,
      client: mockClient as any,
    })

    expect(capturedPatientId).toBe('patient-789')
    expect(capturedCutoff).not.toBeNull()
    const cutoffDate = new Date(capturedCutoff!)
    const now = Date.now()
    // cutoff 約在 14 天前（允許 10 秒鐘誤差）
    expect(now - cutoffDate.getTime()).toBeGreaterThan(13 * 86_400_000)
    expect(now - cutoffDate.getTime()).toBeLessThan(15 * 86_400_000)
  })

  it('當 app_profiles 無法查得其他照護者時，嘗試以 fetch_household_members 比對', async () => {
    const mockRows: RecordChangeLogRow[] = [
      {
        id: 'log-2',
        table_name: 'patient_anomaly_alert_settings',
        row_id: 'patient-100',
        patient_id: 'patient-100',
        household_id: 'hh-1',
        action: 'update',
        actor_kind: 'user',
        actor_user_id: 'carer-dewi',
        actor_source: null,
        changed_columns: ['systolic_high'],
        before_row: { systolic_high: 140 },
        after_diff: { systolic_high: 145 },
        changed_at: '2026-09-22T10:00:00Z',
        expires_at: null,
      },
    ]

    const mockClient = {
      from: (table: string) => {
        if (table === 'record_change_logs') {
          const qb: any = {
            eq: () => qb,
            order: () => qb,
            then: (res: any) => res({ data: mockRows, error: null }),
          }
          return {
            select: () => qb,
          }
        }
        if (table === 'app_profiles') {
          // 因 RLS 只回傳空陣列（不是本人）
          return {
            select: () => ({
              in: () => Promise.resolve({ data: [], error: null }),
            }),
          }
        }
        throw new Error(`Unexpected table ${table}`)
      },
      rpc: (fn: string) => {
        if (fn === 'fetch_household_members') {
          return Promise.resolve({
            data: [
              { user_id: 'carer-dewi', display_name: 'Dewi', email: 'dewi@example.com' },
            ],
            error: null,
          })
        }
        throw new Error(`Unexpected rpc ${fn}`)
      },
    }

    const entries = await fetchRecordChangeHistory({
      tableName: 'patient_anomaly_alert_settings',
      rowId: 'patient-100',
      patientId: 'patient-100',
      client: mockClient as any,
    })

    expect(entries.length).toBe(1)
    expect(entries[0].actor.displayName).toBe('Dewi')
    expect(entries[0].actor.label.zh).toBe('Dewi')
  })
})

describe('recordChangeHistory - 安全與不變量 (Security Boundaries & Invariants)', () => {
  it('ResolvedActor 與 RecordChangeEntry 絕不包含 email 欄位（ADR-008 決策三）', () => {
    const actor = resolveActor({
      actorKind: 'user',
      actorUserId: 'uid-abc',
      actorSource: null,
      profileMap: new Map([['uid-abc', 'Alice']]),
    })

    expect('email' in actor).toBe(false)
    expect('userEmail' in actor).toBe(false)

    const row: RecordChangeLogRow = {
      id: 'log-inv',
      table_name: 'blood_pressure_records',
      row_id: 'bp-1',
      patient_id: 'p-1',
      household_id: null,
      action: 'insert',
      actor_kind: 'user',
      actor_user_id: 'uid-abc',
      actor_source: null,
      changed_columns: null,
      before_row: null,
      after_diff: { systolic: 120 },
      changed_at: '2026-09-20T10:00:00Z',
      expires_at: null,
    }

    const entry = mapRecordChangeRowToEntry(row)
    expect('email' in entry).toBe(false)
    expect('actorEmail' in entry).toBe(false)
    expect(JSON.stringify(entry)).not.toContain('@')
  })

  it('不得將 record_change_logs 送進 /share（#655 與 ADR-008 §8.3）', async () => {
    // 斷言 shareSummaryV2Dto 中絕對未引用或暴露 record_change_logs
    const shareDtoModule = await import('../../src/lib/shareSummaryV2Dto')
    const jsonStr = JSON.stringify(shareDtoModule)
    expect(jsonStr).not.toContain('record_change_logs')
    expect(jsonStr).not.toContain('recordChangeHistory')
  })
})
