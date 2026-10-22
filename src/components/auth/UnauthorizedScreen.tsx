/*
檔案用途：未授權帳號提示畫面，告知已登入但尚未獲得家庭照護授權的使用者。
所在層：src/components/auth；為安全性阻斷頁面。
主要關聯：src/App.tsx、signOut。
*/
import { useI18n } from '../../lib/i18n'
import { signOut } from '../../lib/auth'
import { Icon } from '../ui/Icon'

type UnauthorizedScreenProps = {
  email?: string
}

// 為什麼補足 44px：手機上的獨立操作要留出足夠點擊面，降低漏點與誤觸。
export function UnauthorizedScreen({ email }: UnauthorizedScreenProps) {
  const { text } = useI18n()
  return (
    <div className="h-dvh flex flex-col items-center justify-center gap-3 px-8 text-center bg-white">
      <Icon name="lock" className="h-10 w-10 text-slate-500" />
      <p className="text-sm text-slate-700 font-semibold">
        {text({ id: 'Akun ini belum diizinkan', zh: '此帳號尚未被授權', en: 'This account is not authorized yet' })}
      </p>
      {email && <p className="text-xs text-slate-500">{email}</p>}
      <button
        onClick={() => signOut()}
        className="mt-2 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-semibold active:bg-slate-200 transition-colors min-h-11"
      >
        {text({ id: 'Keluar', zh: '登出', en: 'Sign out' })}
      </button>
    </div>
  )
}
