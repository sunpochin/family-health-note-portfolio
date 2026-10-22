/*
檔案用途：看護離開血壓頁或換了病人之後才被拒絕的線上血壓儲存，在 App 殼層的提醒橫幅（issue #1117）。
  輸入頁沒開著時，這是唯一能告訴看護「剛才那筆沒存進去」的地方；回到那位病人的輸入頁後由輸入頁接手顯示、橫幅自動消失。
所在層：src/features/vitals/components；讀殼層補送器（useBloodPressureQueue）的 rejectedSaves（每筆一列、各自清），自己不保存狀態。
主要關聯：App.tsx（掛在狀態列下方、BloodPressureQueueProvider 之內）、useBloodPressureQueueCoordinator（rejectedSaves／clearRejectedSave）、
  useBloodPressureInputForm（輸入頁接手）、BpLimitBlockedNotice（被每日上限擋下時顯示等級與「請打電話」）、InputPage.utils 的 saveErrorMessage。
*/
import { useI18n } from '../../../lib/i18n'
import type { PatientIdentity } from '../../../lib/auth'
import { Icon } from '../../../components/ui/Icon'
import { useBloodPressureQueue } from '../hooks/BloodPressureQueueProvider'
import { BpLimitBlockedNotice } from './BpLimitBlockedNotice'
import { L, saveErrorMessage } from '../pages/InputPage.utils'

export const SAVE_REJECTED_BANNER_TEXT = {
  // 眼前這位的那筆沒存進去；原因接在後面（登入過期、每日上限、資料不合理……），與輸入頁當場被拒絕時同一句原因。
  rejected: (name: string, reason: string) => ({
    id: `${name}: tekanan darah tadi tidak tersimpan (${reason}). Masukkan lagi di bagian tekanan darah.`,
    zh: `${name}：剛才的血壓沒有儲存成功（${reason}），請到血壓區段重新輸入。`,
    en: `${name}: the blood pressure entered just now was not saved (${reason}). Enter it again in the blood pressure section.`,
  }),
  // 被每日上限擋下：原因與等級由下方 BpLimitBlockedNotice 講，這句只說「沒存進去」，不把同一句上限說明講兩次。
  rejectedByLimit: (name: string) => ({
    id: `${name}: tekanan darah tadi tidak tersimpan.`,
    zh: `${name}：剛才的血壓沒有儲存成功。`,
    en: `${name}: the blood pressure entered just now was not saved.`,
  }),
  // 結果不明（暫時性失敗或逾時後本機佇列又存不了）：伺服器可能已經寫入，不能叫看護重新輸入（新 UUID 會多一筆），先看今日紀錄。
  rejectedUncertain: (name: string) => ({
    id: `${name}: tekanan darah tadi belum pasti tersimpan. Lihat catatan hari ini di bagian tekanan darah; kalau belum ada, masukkan lagi.`,
    zh: `${name}：剛才的血壓不確定有沒有存進去，請到血壓區段看今日紀錄，沒有的話再重新輸入。`,
    en: `${name}: it is not certain the blood pressure just entered was saved. Check today's records in the blood pressure section; enter it again only if it is missing.`,
  }),
  // 另一位照護對象、而且結果不明：同樣不能叫看護直接重輸（第二輪 Codex P2），只點名、不講數值。
  rejectedElsewhereUncertain: (name: string) => ({
    id: `${name}: tekanan darah tadi belum pasti tersimpan. Pindah ke orang tersebut dan lihat catatan hari ini; kalau belum ada, masukkan lagi.`,
    zh: `${name}：剛才的血壓不確定有沒有存進去，請切換到該對象看今日紀錄，沒有的話再重新輸入。`,
    en: `${name}: it is not certain the blood pressure just entered was saved. Switch to that person and check today's records; enter it again only if it is missing.`,
  }),
  // 那筆屬於另一位照護對象、被上限擋下、而且是要立刻聯絡家人的等級：不畫數值，但「請打電話」不能少（Codex 第四輪 P1）。
  rejectedElsewhereCallFamily: (name: string) => ({
    id: `${name}: tekanan darah yang ditolak itu termasuk tingkat yang perlu segera menghubungi keluarga. Telepon keluarga sekarang.`,
    zh: `${name}：被擋下的那筆血壓屬於需要立刻聯絡家人的等級，請現在就打電話給家人。`,
    en: `${name}: the rejected reading is at a level that needs the family right away. Call the family now.`,
  }),
  // 那筆屬於另一位照護對象：只點名、不講數值與原因（§ 3.5），原因在那位的畫面上。
  rejectedElsewhere: (name: string) => ({
    id: `${name}: tekanan darah tadi tidak tersimpan. Pindah ke orang tersebut untuk melihat alasannya.`,
    zh: `${name}：剛才的血壓沒有儲存成功，請切換到該對象查看原因。`,
    en: `${name}: the blood pressure entered just now was not saved. Switch to that person to see why.`,
  }),
  openBloodPressure: { id: 'Buka tekanan darah', zh: '前往血壓', en: 'Open blood pressure' },
  switchTo: (name: string) => ({ id: `Pindah ke ${name}`, zh: `切換到 ${name}`, en: `Switch to ${name}` }),
  dismiss: { id: 'Mengerti', zh: '知道了', en: 'Got it' },
}

export function BloodPressureSaveRejectedBanner({ selectedPatientId, patients, switchablePatientIds, onOpenBloodPressure, onSwitchTo }: {
  selectedPatientId: string
  /** 含已封存對象的完整清單：被拒絕的那筆可能屬於已經切不到的人，名字仍要講。 */
  patients: readonly PatientIdentity[]
  onOpenBloodPressure: () => void
  /** 切換器真的切得到的病人 id（App 傳 accessiblePatients，不含已封存）；不在裡面就不給「切換」按鈕，只講去哪裡看（PR #1219 審查兩輪）。 */
  switchablePatientIds: readonly string[]
  onSwitchTo?: (patientId: string) => void
}) {
  const { text, locale } = useI18n()
  const queue = useBloodPressureQueue()
  const rejections = queue.rejectedSaves
  if (rejections.length === 0) return null

  return (
    // 紅色而非琥珀色：這筆真的沒有寫進去，看護要重新輸入（離線暫存才是琥珀色）。assertive：需要看護現在處理。
    // 每筆一列、各自「知道了」：後到的拒絕不能把先到的（可能是危險讀數）擠掉（PR #1219 Codex 第三輪）。
    <div role="alert" aria-live="assertive" className="print-hidden shrink-0 divide-y divide-red-200 border-b border-red-200 bg-red-50 px-4 text-sm text-red-900">
      {rejections.map(rejection => {
        const name = patients.find(patient => patient.patientId === rejection.patientId)?.displayName || text(L.anotherCareRecipient)
        const mine = rejection.patientId === selectedPatientId
        const reason = saveErrorMessage(rejection.error, locale)
        // 數值與等級只在那筆的病人就是眼前這位時才畫（§ 3.5）；別人的只點名。
        const showLimitReading = mine && rejection.limitBlockedReading !== null
        const canSwitch = Boolean(onSwitchTo) && switchablePatientIds.includes(rejection.patientId)
        const headline = !mine
          ? (rejection.uncertain ? SAVE_REJECTED_BANNER_TEXT.rejectedElsewhereUncertain(name) : SAVE_REJECTED_BANNER_TEXT.rejectedElsewhere(name))
          : rejection.uncertain ? SAVE_REJECTED_BANNER_TEXT.rejectedUncertain(name)
            : showLimitReading ? SAVE_REJECTED_BANNER_TEXT.rejectedByLimit(name) : SAVE_REJECTED_BANNER_TEXT.rejected(name, reason)
        return (
          <div key={rejection.recordId} data-rejected-save={rejection.recordId} className="flex items-start gap-2 py-2.5">
            <Icon name="alert-triangle" className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-semibold leading-5">{text(headline)}</p>
              {!mine && rejection.callFamily && (
                <p data-call-family className="rounded-2xl border border-red-300 bg-red-100 px-4 py-3 text-lg font-black leading-snug text-red-800">{text(SAVE_REJECTED_BANNER_TEXT.rejectedElsewhereCallFamily(name))}</p>
              )}
              {showLimitReading && rejection.limitBlockedReading && (
                <BpLimitBlockedNotice reading={rejection.limitBlockedReading} limitMessage={reason} />
              )}
              {/* 觸控目標至少 44px（control-min）：看護單手、半夜操作時容易按錯。 */}
              <div className="flex flex-wrap gap-2">
                {mine ? (
                  <button type="button" onClick={onOpenBloodPressure} className="min-h-11 rounded-lg bg-red-700 px-3 font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2">
                    {text(SAVE_REJECTED_BANNER_TEXT.openBloodPressure)}
                  </button>
                ) : canSwitch && (
                  <button type="button" onClick={() => onSwitchTo?.(rejection.patientId)} className="min-h-11 rounded-lg bg-red-700 px-3 font-bold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700 focus-visible:ring-offset-2">
                    {text(SAVE_REJECTED_BANNER_TEXT.switchTo(name))}
                  </button>
                )}
                <button type="button" onClick={() => queue.clearRejectedSave(rejection.recordId)} className="min-h-11 rounded-lg px-3 font-bold text-red-900 underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-700">
                  {text(SAVE_REJECTED_BANNER_TEXT.dismiss)}
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
