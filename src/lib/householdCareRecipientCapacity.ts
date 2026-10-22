/*
檔案用途：讀取新增入口所屬家庭的名額，並把資料庫額滿錯誤轉成三語提示。
所在層：src/lib；只讀家庭計數，不取得病人身分或健康資料。
主要關聯：fetch_household_care_recipient_capacity、CareRecipientManagement、send-invitation-email。
*/
import { supabase } from './supabase'
import type { LocalizedText } from './i18n'

export const HOUSEHOLD_CARE_RECIPIENT_LIMIT = 'household_care_recipient_limit'
export interface HouseholdCareRecipientCapacity { activeCount: number; limit: number }

export function isHouseholdCareRecipientLimitError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'message' in error && error.message === HOUSEHOLD_CARE_RECIPIENT_LIMIT
}

export async function fetchHouseholdCareRecipientCapacity(ownerOnly: boolean): Promise<HouseholdCareRecipientCapacity | null> {
  const { data, error } = await supabase.rpc('fetch_household_care_recipient_capacity', { p_owner_only: ownerOnly })
  if (error) throw error
  if (data === null) return null
  if (!data || !Number.isInteger(data.activeCount) || data.activeCount < 0 || !Number.isInteger(data.limit) || data.limit < 1 || data.limit > 5) {
    throw new Error('Invalid household capacity response')
  }
  return { activeCount: data.activeCount, limit: data.limit }
}

export function householdCareRecipientLimitText(native: boolean, capacity: HouseholdCareRecipientCapacity | null = null): LocalizedText {
  const count = capacity ? `${capacity.activeCount}/${capacity.limit}` : null
  // 原生殼不引導購買；Premium 已滿五位也不能暗示付費能再加人。
  const upgrade = !native && capacity?.limit === 2
  return {
    zh: `本家庭${count ? ` ${count} 位` : '照護對象名額'}已滿。${upgrade ? '升級 Premium 可增加至 5 位。' : '目前無法再新增照護對象。'}既有照護紀錄仍可正常使用。`,
    id: `Kapasitas keluarga${count ? ` ${count}` : ''} sudah penuh. ${upgrade ? 'Tingkatkan ke Premium untuk hingga 5 penerima perawatan.' : 'Penerima perawatan baru belum dapat ditambahkan.'} Catatan perawatan yang ada tetap dapat digunakan.`,
    en: `This household is full${count ? ` (${count})` : ''}. ${upgrade ? 'Upgrade to Premium for up to 5 care recipients.' : 'No more care recipients can be added right now.'} Existing care records remain available.`,
  }
}
