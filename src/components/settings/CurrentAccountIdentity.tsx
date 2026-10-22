/*
檔案用途：在設定頁明確區分目前登入帳號與這個帳號的「我自己」照護對象。
所在層：src/components/settings；只接收目前登入者已載入的身分資料，不查其他帳號。
主要關聯：SettingsPage、PatientIdentity.isOwnPatient、useI18n、#1314。
*/
import type { PatientIdentity } from '../../lib/auth'
import { useI18n } from '../../lib/i18n'

export function CurrentAccountIdentity({ userEmail, patients, isDemoMode }: {
  userEmail?: string
  patients: PatientIdentity[]
  isDemoMode: boolean
}) {
  const { text } = useI18n()
  // 顯示名稱可由使用者自行修改，不能靠它猜是哪個 Google 帳號；只呈現已登入者自己的 email。
  if (isDemoMode || !userEmail) return null
  const ownPatient = patients.find(patient => patient.isOwnPatient)

  return <div className="mt-3 rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-slate-800">
    <p><span className="font-semibold">{text({ id: 'Akun yang sedang masuk', zh: '目前登入帳號', en: 'Signed-in account' })}：</span><span className="break-all">{userEmail}</span></p>
    {ownPatient && <p className="mt-1"><span className="font-semibold">{text({ id: 'Pasien "Saya sendiri" untuk akun ini', zh: '此帳號的「我自己」照護對象', en: '“Myself” care recipient for this account' })}：</span>{ownPatient.displayName}</p>}
  </div>
}
