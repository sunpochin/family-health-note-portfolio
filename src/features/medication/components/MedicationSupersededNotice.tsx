/*
檔案用途：服藥離線打卡補送時，發現同劑已有紀錄或受控事實阻止舊撤回時的三語提示與「關閉」按鈕。
所在層：src/features/medication/components；放在共用 PendingSyncStatus 的 status 區塊裡，讓讀屏器與待同步筆數一起唸。
主要關聯：MedicationPage、features/medication/hooks/useMedicationPendingDoses（supersededCount／dismissSuperseded）、issue #822。
*/
import { common, useI18n } from '../../../lib/i18n'

export function MedicationSupersededNotice({ count, onDismiss, controlledCorrectionCount = 0 }: { count: number; onDismiss: () => void; controlledCorrectionCount?: number }) {
  const { text } = useI18n()
  const ordinaryCount = Math.max(0, count - controlledCorrectionCount)
  // 衝突時不做合併 UI（issue #822 範圍外）：資料庫保留先記錄的那筆，這裡只告訴看護為什麼藥卡上的時間跟她按的不一樣，
  // 避免她以為自己的打卡不見了而再按一次或再給一次藥。
  return (
    <div className="mt-2 rounded-lg bg-white/70 p-2 text-sm font-semibold text-amber-950">
      {/* 兩種結果並存時分別說明，避免把受控更正誤說成家人搶先打卡，或漏掉真正的時間衝突。 */}
      {ordinaryCount > 0 && <p>{text({
        id: `${ordinaryCount} dosis yang dicatat tanpa koneksi sudah lebih dulu dicatat di perangkat lain atau oleh keluarga. Waktu catatan pertama yang dipakai.`,
        zh: `${ordinaryCount} 劑離線打卡已由其他裝置或家人先記錄，畫面以先記錄的時間為準。`,
        en: ordinaryCount === 1
          ? 'A dose checked in without a connection was already recorded on another device or by family. The earlier record is kept.'
          : `${ordinaryCount} doses checked in without a connection were already recorded on another device or by family. The earlier records are kept.`,
      })}</p>}
      {controlledCorrectionCount > 0 && <p>{text({
        zh: `${controlledCorrectionCount} 筆服藥紀錄已經醫囑確認流程儲存，舊的離線撤回沒有取消這些事實。若需要取消，請使用「更正」並填寫原因。`,
        id: `${controlledCorrectionCount} catatan dosis sudah disimpan melalui konfirmasi instruksi. Pembatalan luring lama tidak membatalkan catatan ini. Untuk membatalkan, gunakan koreksi dan isi alasannya.`,
        en: controlledCorrectionCount === 1
          ? '1 intake record was saved through the instruction confirmation flow. The old offline withdrawal did not cancel it. To cancel, use the correction flow and provide a reason.'
          : `${controlledCorrectionCount} intake records were saved through the instruction confirmation flow. The old offline withdrawal did not cancel them. To cancel, use the correction flow and provide a reason.`,
      })}</p>}
      {/* 觸控目標至少 44px（control-min）：看護單手、半夜操作時 36／40px 容易按錯，與 15 秒原則衝突（#1161）。 */}
      <button type="button" onClick={onDismiss} className="mt-2 min-h-11 rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-bold text-amber-900">
        {text(common.close)}
      </button>
    </div>
  )
}
