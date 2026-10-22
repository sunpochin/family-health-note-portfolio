/*
檔案用途：在 hook harness 裡把血壓輸入表單 hook 接上 App 殼層的離線佇列補送器（issue #1138）：
  補送器與表單各自是一棵 hook 樹，表單經 context 讀補送器的回傳值；補送器的 state 一變，表單要重新拿到新的 context 值才看得到，
  所以 rerender／act 都先讓補送器重繪、再把它最新的回傳值塞回表單的 context。正式程式碼由 React 自己做這件事。
所在層：tests/unit/helpers 測試支援層；只組合 reactHookHarness，不替換任何正式模組。
主要關聯：reactHookHarness、tests/unit/bpQueueAllPatients.test.ts、bloodPressureInputLimitBlocked.test.ts、bpOfflineSaveQueue.test.ts、
  src/features/vitals/hooks/useBloodPressureQueueCoordinator.ts、BloodPressureQueueProvider.tsx。
*/
import { renderHook, type HookHandle } from './reactHookHarness'

export interface BloodPressureQueueModules<Q> {
  /** 受測模組要在 mock.module 之後才 `await import`，所以由呼叫端傳進來，不能在這裡 import。 */
  useBloodPressureQueueCoordinator: (params: { patientId: string; userEmail?: string }) => Q
  BloodPressureQueueContext: unknown
}

export interface BloodPressureQueueView<Q, T> extends HookHandle<T> {
  /** 補送器自己的 hook 樹；測試可直接讀它的狀態（notifyProblems、records…）。 */
  coordinator: HookHandle<Q>
  /** 只卸載畫面（看護切到別的分頁），補送器留著——殼層的補送器本來就不隨分頁卸載。unmount 則兩者都卸。 */
  unmountScreen: () => void
}

/**
 * 同時掛起補送器與表單（或任何讀 useBloodPressureQueue 的 hook／元件）。
 * getPatientId 用函式：測試切換病人時改外面的變數再 rerender，兩棵樹都會拿到新病人。
 */
export function renderWithBloodPressureQueue<Q, T>(
  modules: BloodPressureQueueModules<Q>,
  getPatientId: () => string,
  userEmail: string | undefined,
  body: () => T,
): BloodPressureQueueView<Q, T> {
  const coordinator = renderHook(() => modules.useBloodPressureQueueCoordinator({ patientId: getPatientId(), userEmail }))
  const view = renderHook(body, { contexts: [[modules.BloodPressureQueueContext, coordinator.current]] })
  // 先讓補送器用最新的病人重繪，再把它的回傳值交給表單：順序反過來表單會多讀到一次舊病人的補送器。
  const bind = () => {
    coordinator.rerender()
    view.provideContext(modules.BloodPressureQueueContext, coordinator.current)
  }
  return {
    get current() { return view.current },
    coordinator,
    rerender: () => {
      bind()
      return view.rerender()
    },
    act: action => {
      // 互動（例如 submit）可能呼叫補送器的方法而改它的 state；結束後同步一次，表單才看得到。
      view.act(action)
      bind()
      return view.rerender()
    },
    unmountScreen: () => view.unmount(),
    unmount: () => {
      view.unmount()
      coordinator.unmount()
    },
    provideContext: (context, value) => view.provideContext(context, value),
  }
}
