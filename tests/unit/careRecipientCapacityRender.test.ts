/*
檔案用途：在實際新增表單驗證三語額滿提示、原生殼中性文案與送出攔截。
所在層：tests/unit；以假資料執行元件，不發邀請或讀取健康資料。
主要關聯：CareRecipientManagement、useCareRecipientCapacity、reactHookHarness。
*/
import { expect, mock, test } from 'bun:test'
import { installReactHookHarness, renderHook } from './helpers/reactHookHarness'
import { findAll, textContent } from './helpers/elementTree'

installReactHookHarness()
let native = false
let mutations = 0
mock.module('../../src/lib/platform', () => ({ isNativeApp: () => native }))
mock.module('../../src/lib/supabase', () => ({ supabase: { rpc: async () => ({ data: { activeCount: 2, limit: 2 }, error: null }) } }))
mock.module('../../src/hooks/useConfirm', () => ({ useConfirm: () => ({ confirm: async () => true, dialog: null }) }))
mock.module('../../src/lib/tenant', () => ({
  fetchCurrentHouseholdRole: async () => 'owner',
  fetchHouseholdArchivedPets: async () => [],
  fetchHouseholdPatientInvitations: async () => [],
  addHouseholdPatient: async () => { mutations++; return 'synthetic-patient' },
  createHouseholdPatientInvitationWithEmail: async () => { mutations++; throw new Error('Unexpected invitation') },
  archiveHouseholdPet: async () => {}, revokeHouseholdPatientInvitation: async () => {},
}))
const { CareRecipientManagement } = await import('../../src/features/care-family/components/CareRecipientManagement')
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
const patients: [] = []

test('both live entry points render localized capacity and refuse full-household mutations', async () => {
  const expected = { zh: '本家庭 2/2 位已滿', id: 'Kapasitas keluarga 2/2 sudah penuh', en: 'This household is full (2/2)' }
  for (const locale of ['zh', 'id', 'en'] as const) {
    for (const isNative of [false, true]) {
      native = isNative
      mutations = 0
      const view = renderHook(() => CareRecipientManagement({
        availablePatients: patients, isDemoMode: false, onCreated: async () => {}, onArchived: async () => {}, onViewArchived: () => {},
      }), { defaultContext: { locale, setLocale: () => {} } })
      await tick()
      view.rerender()
      await tick()
      view.rerender()
      const forms = findAll(view.current, node => node.type === 'form')
      expect(forms).toHaveLength(2)
      for (const form of forms) {
        const rendered = textContent(form)
        expect(rendered).toContain(expected[locale])
        if (isNative) expect(rendered).not.toContain('Premium')
        else expect(rendered).toContain('Premium')
        await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({ preventDefault: () => {} })
      }
      expect(mutations).toBe(0)
      view.unmount()
    }
  }
})
