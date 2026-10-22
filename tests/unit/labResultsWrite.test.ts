/*
檔案用途：鎖住檢驗值寫入的 payload 形狀——新增一定帶 recorded_by、編輯一定不碰 recorded_by，以及「只有原登錄者能編輯」的畫面判斷。
所在層：tests/unit；以假的 Supabase query builder 取代遠端服務，只檢查送出的欄位。
主要關聯：src/lib/labResults.ts、patient_lab_results 的 INSERT／UPDATE RLS policy（issue #1034）。
既有 labResults.test.ts 的 fixture 自帶 recorded_by、RLS 測試又用 SQL 直接 insert，所以兩邊都沒抓到前端漏送；這裡補上那個缺口。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'

type Call = { table: string; op: 'insert' | 'update'; payload: Record<string, unknown> }
const calls: Call[] = []
let nextError: { code: string; message: string } | null = null

function builder(table: string) {
  const chain = {
    insert(payload: Record<string, unknown>) { calls.push({ table, op: 'insert', payload }); return chain },
    update(payload: Record<string, unknown>) { calls.push({ table, op: 'update', payload }); return chain },
    eq() { return chain },
    select() { return chain },
    single: async () => nextError
      ? { data: null, error: nextError }
      : { data: { id: 'lab-1', ...calls.at(-1)?.payload }, error: null },
  }
  return chain
}

mock.module('../../src/lib/supabase', () => ({ supabase: { from: (table: string) => builder(table) } }))

const { canEditLabResult, createLabResult, isLabResultNotEditableError, updateLabResult } = await import('../../src/lib/labResults')

const input = {
  patientId: 'patient-1',
  itemCode: 'K' as const,
  value: 4.2,
  sampledAt: '2026-07-09T16:00:00.000Z',
  referenceLow: 3.5,
  referenceHigh: 5.1,
}

beforeEach(() => { calls.length = 0; nextError = null })

describe('createLabResult', () => {
  test('sends the signed-in email as recorded_by, lower-cased to match the INSERT policy', async () => {
    await createLabResult(input, '  Caregiver@Example.com ')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ table: 'patient_lab_results', op: 'insert' })
    expect(calls[0].payload).toMatchObject({
      patient_id: 'patient-1',
      recorded_by: 'caregiver@example.com',
      source: 'manual',
      unit: 'mmol/L',
    })
    // 手動路徑不得自帶指紋，否則 INSERT policy 會擋。
    expect(calls[0].payload).not.toHaveProperty('source_fingerprint')
  })

  test('refuses to send a row without a recorder instead of letting RLS reject it opaquely', async () => {
    await expect(createLabResult(input, '   ')).rejects.toThrow('lab_result_missing_recorder')
    expect(calls).toHaveLength(0)
  })
})

describe('updateLabResult', () => {
  test('never touches recorded_by, which the audit trigger keeps immutable', async () => {
    await updateLabResult('lab-1', input)
    expect(calls).toHaveLength(1)
    expect(calls[0].op).toBe('update')
    expect(calls[0].payload).not.toHaveProperty('recorded_by')
  })

  test('rethrows the PostgREST error unchanged so the page can read its code', async () => {
    nextError = { code: '42501', message: 'new row violates row-level security policy for table "patient_lab_results"' }
    await expect(updateLabResult('lab-1', input)).rejects.toMatchObject({ code: '42501' })
  })
})

describe('canEditLabResult', () => {
  test('matches the UPDATE policy: only the original recorder, case-insensitive', () => {
    expect(canEditLabResult({ recorded_by: 'caregiver@example.com' }, 'Caregiver@Example.com')).toBe(true)
    expect(canEditLabResult({ recorded_by: 'caregiver@example.com' }, 'family@example.com')).toBe(false)
    expect(canEditLabResult({ recorded_by: 'caregiver@example.com' }, undefined)).toBe(false)
    expect(canEditLabResult({ recorded_by: 'caregiver@example.com' }, '')).toBe(false)
  })
})

describe('isLabResultNotEditableError', () => {
  test('42501 is a non-recorder edit: USING selects the row, WITH CHECK rejects the new row', () => {
    expect(isLabResultNotEditableError({ code: '42501', message: 'new row violates row-level security policy' })).toBe(true)
  })

  test('PGRST116 is a deleted row or a failed USING, and shares the same message', () => {
    expect(isLabResultNotEditableError({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' })).toBe(true)
  })

  test('other failures stay on the generic save-failed message', () => {
    expect(isLabResultNotEditableError({ code: 'P0001', message: 'daily_lab_results_limit' })).toBe(false)
    expect(isLabResultNotEditableError({ code: '23514' })).toBe(false)
    expect(isLabResultNotEditableError(new Error('network'))).toBe(false)
    expect(isLabResultNotEditableError(null)).toBe(false)
    expect(isLabResultNotEditableError(undefined)).toBe(false)
  })
})
