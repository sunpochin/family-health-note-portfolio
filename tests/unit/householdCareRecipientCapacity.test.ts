/*
檔案用途：驗證家庭名額的 API 邊界、每次送出重讀，以及三語與原生殼提示。
所在層：tests/unit；使用合成回應與 React hook harness，不連外部服務。
主要關聯：householdCareRecipientCapacity、useCareRecipientCapacity、tenant 邀請轉接。
*/
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'

installReactHookHarness()
let native = false
let response: { data: unknown; error: unknown } = { data: { activeCount: 1, limit: 2 }, error: null }
const calls: unknown[] = []
mock.module('../../src/lib/platform', () => ({ isNativeApp: () => native }))
mock.module('../../src/lib/supabase', () => ({ supabase: {
  rpc: async (name: string, args: unknown) => { calls.push([name, args]); return response },
} }))
const { fetchHouseholdCareRecipientCapacity, householdCareRecipientLimitText, isHouseholdCareRecipientLimitError } = await import('../../src/lib/householdCareRecipientCapacity')
const { useCareRecipientCapacity } = await import('../../src/features/care-family/hooks/useCareRecipientCapacity')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => { native = false; calls.length = 0; response = { data: { activeCount: 1, limit: 2 }, error: null } })

describe('household care recipient capacity', () => {
  test('selects the same membership rule as each mutation and accepts no caller-supplied household ID', async () => {
    await fetchHouseholdCareRecipientCapacity(false)
    await fetchHouseholdCareRecipientCapacity(true)
    expect(calls).toEqual([
      ['fetch_household_care_recipient_capacity', { p_owner_only: false }],
      ['fetch_household_care_recipient_capacity', { p_owner_only: true }],
    ])
  })
  test('malformed or failed reads cannot authorize a submit', async () => {
    for (const data of [{ activeCount: -1, limit: 2 }, { activeCount: 1, limit: 6 }, { activeCount: '1', limit: 2 }]) {
      response = { data, error: null }
      await expect(fetchHouseholdCareRecipientCapacity(false)).rejects.toThrow('Invalid household capacity response')
    }
    response = { data: null, error: new Error('offline') }
    await expect(fetchHouseholdCareRecipientCapacity(false)).rejects.toThrow('offline')
  })
  test('each submission rereads capacity and blocks after another device fills the last slot', async () => {
    const view = renderHook(() => useCareRecipientCapacity(false, true, 1))
    await tick()
    view.rerender()
    expect(view.current.notice).toBeNull()
    response = { data: { activeCount: 2, limit: 2 }, error: null }
    await expect(view.current.check()).rejects.toThrow('household_care_recipient_limit')
    view.rerender()
    expect(view.current.notice?.zh).toContain('2/2')
    response = { data: { activeCount: 1, limit: 2 }, error: null }
    await view.current.check()
    view.rerender()
    expect(view.current.notice).toBeNull()
    view.unmount()
  })
  test('demo never reads capacity', async () => {
    const view = renderHook(() => useCareRecipientCapacity(false, false, 1))
    await tick()
    expect(calls).toHaveLength(0)
    expect(view.current.notice).toBeNull()
    view.unmount()
  })
  test('all locales include the count; only free web households are offered an upgrade', () => {
    for (const locale of ['zh', 'id', 'en'] as const) {
      const freeWeb = householdCareRecipientLimitText(false, { activeCount: 2, limit: 2 })[locale]
      expect(freeWeb).toContain('2/2')
      expect(freeWeb).toContain('Premium')
      for (const capacity of [{ activeCount: 2, limit: 2 }, { activeCount: 5, limit: 5 }]) {
        expect(householdCareRecipientLimitText(true, capacity)[locale]).not.toContain('Premium')
      }
      expect(householdCareRecipientLimitText(false, { activeCount: 5, limit: 5 })[locale]).not.toContain('Premium')
    }
  })
  test('only the exact database code gets the special message, with neutral wording when reread fails', async () => {
    expect(isHouseholdCareRecipientLimitError({ message: 'household_care_recipient_limit' })).toBe(true)
    expect(isHouseholdCareRecipientLimitError({ message: 'other household_care_recipient_limit error' })).toBe(false)
    const view = renderHook(() => useCareRecipientCapacity(false, true, 1))
    await tick()
    response = { data: null, error: new Error('offline') }
    const message = await view.current.describeError({ message: 'household_care_recipient_limit' })
    expect(message?.en).toContain('full')
    expect(message?.en).not.toContain('Premium')
    expect(await view.current.describeError(new Error('other'))).toBeNull()
    view.unmount()
  })
})
