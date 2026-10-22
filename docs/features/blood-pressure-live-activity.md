<!--
檔案用途：iOS 原生殼「血壓複測倒數 Live Activity（鎖屏／動態島）」（issue #865）的現行設計、原生碼審查紀錄、已知限制與驗收清單。
所在層：docs/features；功能落地後的單一真相文件，邊界決策與被拒絕方案在 ADR-010。
主要關聯：src/lib/bloodPressureLiveActivity.ts、src/lib/nativeBloodPressureLiveActivity.ts、src/hooks/useBloodPressureLiveActivity.ts、
  src/hooks/useBloodPressureSession.ts、ios/App/App/BloodPressureLiveActivityPlugin.swift、ios/App/BloodPressureLiveActivity/、docs/adr/010-live-activity-privacy-boundary.md。
-->

# 血壓複測倒數 Live Activity / Blood Pressure Countdown Live Activity（issue #865）

## 做什麼、不做什麼

- **只在 iOS 16.2+ 的原生殼**。量完第一次血壓、App 內出現「第二次量測前請休息」banner 的同時，鎖屏與動態島出現同一個倒數：紅色倒數中 →（deadline）綠色「現在可以再量一次」＋打勾。
- banner 消失時（量完第二次、換照護對象、登出、換時段）Activity 一起消失。
- 鎖屏只有「血壓複測倒數中／現在可以再量一次」、「回到 App 記錄第二次量測」與計時器；**沒有**姓名、病人 ID、血壓或脈搏數值。
- 不做：push 更新、其他用途的 Activity（服藥提醒等）、Android、主畫面／鎖屏 widget（ADR-006 另案）。

## 資料流

```text
useBloodPressureSession.currentMeasurementSession   ← banner 用的同一個值
        │
useBloodPressureLiveActivity（只在 iOS；載入中不動；key = sessionKey|deadline|locale）
        │ buildBloodPressureLiveActivityPayload（白名單：startedAt／deadline／三段文案）
nativeBloodPressureLiveActivity（JS 端排隊，保證 start/end 順序）
        │ Capacitor bridge
BloodPressureLiveActivityPlugin.swift（原生再驗證；main actor 排隊；永遠只留一個 Activity）
        │ ActivityKit request / update / end
BloodPressureLiveActivity.appex（SwiftUI：鎖屏、動態島 compact／minimal／expanded）
```

## 設計重點（為什麼這樣做）

| 決策 | 理由 |
| --- | --- |
| 輸入就是 `currentMeasurementSession` | 已經依「目前病人＋目前時段」過濾過；換病人／登出的清除路徑只有一條，不會出現 banner 消失但鎖屏還在倒數。 |
| 第一次同步即使沒有 session 也送 `end` | 清掉上一個 process（被滑掉、被系統回收）留下的 Activity；原生 `load()` 也做一次，兩層互為備援。 |
| `loading` 時不動 | auth／病人清單載入中 session 可能短暫是 null，避免鎖屏倒數被關掉又立刻重開。 |
| 文案在 TypeScript、語言跟 App 走 | AGENTS.md § 3.6 的三語檢查只看得到 TS；看護常把手機與 App 設成不同語言。換語言時整個重建 Activity（文案放在靜態 attributes）。 |
| 原生端封閉允許清單 `ApprovedCopy` | bridge 是公開介面；三段文案必須整組等於 zh／id／en 其中一組核准版本，姓名、數值、混搭語言都整筆拒絕。改 TS 文案時必須同步改 Swift，`bloodPressureLiveActivity.test.ts` 會讀 Swift 原始碼擋下漂移（ADR-010）。 |
| 開不成的 start 在下次回前景重試 | ActivityKit 只允許前景 request；存完第一筆就立刻鎖屏時會回 `started: false`。hook 此時不把這輪記成已同步，`appStateChange(isActive)` 時再試一次；成功後回前景不會重建（Codex review PR #1010）。 |
| 轉綠靠 App 在 deadline 送本機 `update` | Simulator（iOS 26.1）實測 `staleDate` 過了一分多鐘都沒重畫。進背景時向系統借背景時間（`beginBackgroundTask`）讓 deadline 那刻還醒著；借不到就停在紅色 0:00，回 App 那刻用 continuous clock 補送。 |
| 更新不帶 `alertConfiguration` | 「可以量了」不是需要把人叫醒的警報（設計鐵律：警報分級、寧缺勿濫）。 |
| `end` 用 `.immediate` | 預設策略會讓已結束的 Activity 在鎖屏再留最多 4 小時。 |
| App target weak-link ActivityKit | App 最低支援 iOS 15，ActivityKit 從 16.1 才有；以 `LC_LOAD_WEAK_DYLIB` 連結（建置後用 `otool -l` 確認），舊系統照常啟動、只是沒有鎖屏倒數。 |

## 原生碼審查紀錄

- 新增原生碼：`BloodPressureLiveActivityPlugin.swift`（App target）、`BloodPressureCountdownAttributes.swift`（兩個 target 共用）、`BloodPressureLiveActivityBundle.swift`、`BloodPressureCountdownLiveActivity.swift`、extension `Info.plist`。沒有新的 SPM／CocoaPods／npm 依賴，不改 `package.json`、不影響 `cap sync` 漂移守門（#815）。
- plugin 只 import `ActivityKit`、`Capacitor`、`Foundation`、`UIKit`：沒有網路、檔案、Keychain、UserDefaults 或 log API；`pushType: nil`，不產生 push token。
- 主 App `Info.plist` 新增 `NSSupportsLiveActivities = YES`；extension 版本號與 App 共用 `MARKETING_VERSION`／`CURRENT_PROJECT_VERSION`，`scripts/sync-native-version.ts` 與 Xcode Cloud 的 `agvtool new-version -all` 都會一起改到。
- 商店隱私聲明不需變更：沒有資料離開裝置。

## 已知限制

- **deadline 時 App 在背景且系統不給背景時間**：鎖屏停在紅色 0:00（文案仍是「倒數中」），回到 App 時立刻轉綠。Simulator 上鎖定後有拿到背景時間、準時轉綠；實機行為待驗。
- **App 在背景被使用者滑掉**：iOS 不一定送 `willTerminate`，Activity 會留到下次開 App（冷啟動清理）或系統 8 小時上限。
- **使用者在「設定 → Family Health Note → 即時動態」關閉**：plugin 回 `started: false`，App 內 banner 照常運作，不顯示錯誤；每次回前景會再試一次（便宜的 no-op）。第一次使用時 iOS 會在鎖屏詢問「是否繼續允許」，這是系統行為。
- iOS 16.1 裝置不支援（實作用到 16.2 的 `ActivityContent` API）。

## 驗收清單

- [x] `bun test --isolate tests/unit/bloodPressureLiveActivity.test.ts tests/unit/useBloodPressureLiveActivity.test.ts`
- [x] Simulator（iPhone 17 Pro／iOS 26.1、demo 假資料）：開始量測 → 鎖屏與動態島紅色倒數 → 鎖定狀態下 deadline 轉綠打勾 → 換照護對象後動態島清空 → 殺掉重開後殘留 Activity 被清掉；鎖屏截圖只有倒數與固定文案。
- [ ] owner 自有裝置（免費 Apple ID 即可）：同上流程，另測「App 在背景 60 秒以上才回來」「設定關閉即時動態」「登出」。
- [ ] Astra 獨立複審 payload 白名單與原生驗證（issue #865 模型分工）。
