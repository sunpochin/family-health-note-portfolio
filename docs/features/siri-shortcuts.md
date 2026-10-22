<!--
檔案用途：iOS 原生殼「Siri 捷徑／App Intents：語音快速開啟記錄畫面」（issue #868）的現行設計、隱私邊界、已完成的模擬器驗證、已知限制與待 owner 實機驗收的清單。
所在層：docs/features；功能落地後的單一真相文件。
主要關聯：ios/App/App/SiriShortcuts.swift、SiriShortcutRouter.swift、AppBridgeViewController.swift、src/lib/nativeShortcuts.ts、src/lib/nativeAuth.ts、
  src/components/system/NativeShortcutNavigator.tsx、src/App.tsx（openDailyCareModule）、src/features/care-family/pages/DailyCarePage.tsx、docs/product/mobile-capability-roadmap.md。
-->

# Siri 捷徑／App Intents / Siri Shortcuts（issue #868）

## 做什麼、不做什麼

- **只在 iOS 16+ 的原生殼**。在 iOS 的 Siri、捷徑 App、Spotlight 出現兩個動作：**記錄血壓**、**記錄服藥**（中文沿用 App 內分頁名稱「服藥」，印尼文 Catat tekanan darah／Catat obat）。執行後 App 被帶到前景，並開到「照護」分頁對應的區塊。
- **只開畫面，不存值**：語音辨識不夠準確，不能直接寫進健康資料；意圖沒有任何數值參數，數值一律由使用者在畫面上自己輸入並按儲存。與藥單辨識「AI 產出永遠是草稿、人工逐項確認」是同一個原則。
- **病人不經過語音**：意圖沒有「幫誰記」的參數。只有一位可操作的對象時直接開對應區塊；兩位以上時**不猜**，停在有對象選擇器的「今天」頁並顯示一行說明，使用者選好對象後自己點「量血壓」或服藥。
- 不做：語音直接輸入數值、免確認自動送出、Android（App Actions 機制不同，另案評估）、與 #419／#800 的 App 內語音轉文字輸入框（不同層次，互不依賴）。

## 資料流

```text
Siri／捷徑 App／Spotlight 執行意圖（OpenBloodPressureRecordIntent／OpenMedicationRecordIntent，openAppWhenRun）
        │ perform()：只呼叫 SiriShortcutRouter.shared.request(.bloodPressure | .medication)
SiriShortcutRouter.swift（冷啟動時先暫存；AppBridgeViewController.capacitorDidLoad() 之後才投遞）
        │ ApplicationDelegateProxy.application(open:) → capacitorOpenURL → AppPlugin 的 appUrlOpen（retainUntilConsumed）
        │ 固定網址：jia-jian-log://record/blood-pressure ｜ jia-jian-log://record/medication
nativeAuth.ts exchangeNativeAuthCallback（URL 單一入口：OAuth → Siri 捷徑 → https app link）
        │ nativeShortcuts.handleNativeShortcutUrl（白名單解析；getLaunchUrl 認領但不投遞）
nativeShortcuts 的記憶體訂閱（外殼未就緒時暫存最新一個，2 分鐘過期）
        │
NativeShortcutNavigator（只在登入、同意、對象解析完成後的外殼才掛載；且要等這位病人的每日照護顯示偏好讀完才訂閱）
        ├─ 只有一位對象 → App.openDailyCareModule(moduleId) → 照護分頁對應區塊（模組被病人關閉時帶去顯示設定，不靜默退到別的區塊）
        └─ 兩位以上   → 不開任何輸入畫面：不在照護頁就切到今天分頁、已在照護頁就留在原地，並顯示
                        「照護對象不只一位，請先選擇要記錄的對象」提示（提示只跟著發起的那一頁，離開就收起）
```

## 設計重點（為什麼這樣做）

| 決策 | 理由 |
| --- | --- |
| 沿用既有 `jia-jian-log://` scheme 與 `appUrlOpen`（不新增 Capacitor plugin） | issue touch point 指定；URL 單一入口的「一個網址只被一條路徑處理」結構保證延續（OAuth → 捷徑 → https）。不新增 npm 依賴、不影響 `cap sync` 漂移守門（#815）。 |
| 網址正規化後必須**逐字等於**兩個固定網址 | 自訂 scheme 任何 App／網頁都能呼叫（Simulator 用 `simctl openurl` 從外部送入時，iOS 曾先跳「要用 Family Health Note 開啟嗎？」確認，但不保證每次都跳）。query、fragment、帳密、port、結尾斜線、多餘路徑一次全擋；這個入口因此只能做「開畫面」。 |
| 原生端先暫存、`capacitorDidLoad()` 後才投遞 | 冷啟動時 `perform()` 可能比 Capacitor bridge 先跑，那時 `AppPlugin` 還沒註冊 NotificationCenter 觀察者，通知會掉在地上。`capacitorDidLoad()` 時 `AppPlugin` 已載入，事件以 `retainUntilConsumed` 保留到 JS listener 註冊。用 `weak` 引用 bridge：iOS 回收 scene 重建 bridge 時，請求會等新 bridge。 |
| 用記憶體訂閱，不 `location.assign` 重新載入 | 重新載入會丟掉畫面上未存的草稿、冷啟動多載入一次，也會讓 reload 後重放。照護頁內切區塊不丟草稿（各區塊常駐掛載、只用 `hidden` 切換）。 |
| 偏好讀完才處理請求（`dailyCarePreferenceLoadedPatientId`） | 冷啟動時 `dailyCarePreference` 還是預設值（全部可見），真正的病人設定是非同步載入。拿預設值判斷會先開到病人其實已關掉的模組，讀完後照護頁又靜默把畫面切走，違反 #752「模組被關閉時要明確帶去顯示設定」。請求在 2 分鐘內留在暫存，讀完才交付；讀取失敗也算讀完（畫面此時就是全部顯示）。 |
| 多位對象時，已在照護頁就不離開 | 照護頁的輸入畫面沒有草稿保存，切到今天頁會丟掉打到一半的數字；照護頁自己就有對象選擇器，留在原地加提示即可。 |
| 提示綁在發起的那一頁 | 使用者點了今天頁的「量血壓」進了血壓表單，「請先選擇對象」就不該再釘在表單上方；離開那一頁、換對象或按關閉都會收起。 |
| 「多位對象」用專屬旗標，不重用 `canConfigureActiveSubject` | 後者的語意是設定頁「能不能切換對象」，之後若加權限條件，會悄悄關掉 § 3.5 這道防線。 |
| `getLaunchUrl` 認領但不投遞 | iOS 的 `getLaunchUrl` 回傳「最後一個」開啟過的網址，WebView reload 後每次初始化都會再回傳；語音喚起是一次性手勢，不能因 reload 重放。冷啟動不會因此漏掉（見上列 retainUntilConsumed）。 |
| 外殼未就緒時暫存，2 分鐘後丟棄 | 登入畫面、同意畫面時先留著，登入完成後才導航；超過 2 分鐘就丟，避免使用者在登入畫面停很久後 App 突然自己跳走。App 鎖時外殼保持掛載（只蓋遮罩、`#root` inert），所以鎖住時請求照常處理、解鎖後看到的就是目標畫面。 |
| 多位對象時停在今天頁，不用「上次選的對象」帶進去 | AGENTS.md § 3.5：語音沒有指名對象，而語音喚起跳過了使用者平常會看到對象名稱的那一步，寧可多一步確認。 |
| `openDailyCareModule` 與今天頁的「量血壓」共用 | issue #752 已解決「模組被關閉時靜默退到別的分頁」；Siri 走同一條，不另寫第二份可見性判斷。 |
| `DailyCarePage` 已掛載時也回應 `initialSection` | 原本只在掛載時讀一次；使用者本來就停在照護頁的別的區塊時說「記錄服藥」，請求會被消費掉但區塊不變，等於語音指令靜默失效（fail loudly 的反例）。 |
| 整份 Swift 以 `@available(iOS 16.0, *)` 隔離，App target weak-link `AppIntents` | App 最低支援 iOS 15（與 ActivityKit 同一個處理）。已用 `otool -l` 確認是 `LC_LOAD_WEAK_DYLIB`。 |
| 標題／說明／口語觸發詞放 `Localizable.strings`／`AppShortcuts.strings`（zh-Hant／id／en） | AGENTS.md § 3.6。Siri 介面語言由系統語言決定，不是 App 內 `LocaleProvider` 能控制；`siriShortcuts.test.ts` 鎖住鍵的對應與佔位符。 |

## 隱私邊界

- 兩個意圖**沒有任何參數**（沒有 `@Parameter`、`AppEntity`、`AppEnum`），標題與說明是固定文案：Siri 建議、捷徑 App 與鎖屏上不會出現病人姓名或健康數值。
- 路由層與意圖不 import 網路、檔案、Keychain、UserDefaults 或 WebView 內容 API；只送兩個固定網址常數。`siriShortcuts.test.ts` 讀 Swift 原始碼（去除註解後）擋下這些。
- 觸發後 App 內不顯示病人姓名以外的新資訊；多位對象時的提示是固定文案。

## 驗證紀錄

- `bun test --isolate`：`nativeShortcuts`（解析白名單、暫存／過期、一次性投遞、getLaunchUrl 不重放、決策）、`nativeAuthFlow`（OAuth 不受影響、look-alike 網址被忽略、冷啟動排隊）、`nativeShortcutNavigatorRender`（就緒閘門、已在照護頁不離開、提示綁分頁）、`useDailyCareOnboardingLoaded`、`dailyCarePageSectionRequestRender`（已掛載時收到請求會切區塊、只消費一次、不蓋掉手動選擇）、`dailyCareModules`（含 #752 的「模組被關閉就帶去顯示設定」分支）、`siriShortcuts`（Swift↔TS 網址常數、無參數、weak link、三語鍵對應）。
- **Simulator（iPhone 17／iOS 27.0，demo 假資料）**，建置後確認 `App.app/Metadata.appintents` 有產出、`AppIntents` 為 `LC_LOAD_WEAK_DYLIB`、`root.ssu.yaml` 內 en／id／zh-Hant 三組口語觸發詞皆正確本地化：
  - 捷徑 App 搜尋「Family Health」列出「Record blood pressure」「Record medication」兩個動作，沒有任何參數欄位。
  - 在捷徑 App 執行「Record blood pressure」→ App 由「設定」分頁被帶到「今天」並顯示多位對象提示，沒有進入任何人的血壓輸入。
  - 暫時強制單一對象（驗證後已還原、未提交）：登入畫面時先收到請求 → 進入 demo 後落在「照護 → 血壓」，輸入欄位為空；停在「照護 → 體溫」時收到服藥請求 → 切到「服藥」區塊，今日服藥仍是 0/3。
  - 審查修正後（偏好讀完才處理、已在照護頁不離開、提示綁分頁）重建再驗一次：從「設定」分頁收到請求 → 今天頁＋提示；停在照護頁收到請求 → 留在照護頁（不被踢走）＋提示；點「今天」→ 提示消失。
  - **沒有驗到的**：非 demo 的真實登入下「偏好非同步載入」的時序（demo 是同步讀取，Simulator 不能輸入真實帳密）。這條由 `useDailyCareOnboardingLoaded.test.ts`（讀取中為 null、讀完／失敗才回報、換病人歸零、舊回應不覆蓋）與 `nativeShortcutNavigatorRender.test.ts`（未就緒不處理、就緒才交付）的單元測試把關，owner 實機驗收時請特別試一次「該病人把血壓關掉後，App 被殺掉再用語音開血壓」。
- 型別檢查、ESLint、`i18n.test.ts` 通過。

## 已知限制

- **口語觸發詞必須含 App 名稱**（系統規定每句剛好含一次 `\(.applicationName)`）。issue 驗收文字的「嘿 Siri，幫忙記血壓」不含 App 名稱，字面上做不到；實際說法是「在 Family Health Note 記錄血壓」。使用者仍可在捷徑 App 把這個動作加進捷徑並自訂名稱，之後就能直接說那個名稱。App 名稱目前不分語系（`CFBundleDisplayName` 不隨語系變）；是否加 `INAlternativeAppNames`（讓 Siri 認得「家健錄」等唸法）需要實機語音辨識的證據，另案。
- **多位對象時多一步，而看護帳號幾乎都是多位**：每個帳號都有自己的一筆 patient（`auth.ts` 強制保留本人），所以一位看護照顧一位家人時，對象選擇器裡就是 2 位，語音喚起幾乎一定停在今天頁並顯示提示；「直接開到血壓輸入」主要服務只有本人一筆的帳號。這是 AGENTS.md § 3.5 與 issue「多位病人時停在選擇畫面，不用語音猜病人」的字面結果，但會讓主要使用情境（看護幫長輩記）少省一步。若 owner 想改成「多位時開到上次使用的對象」，改 `resolveNativeShortcutAction` 一處即可，但那就是用「上次選的人」猜，須先決定是否接受。目前也沒有「選好後自動接續剛才的語音請求」。
- Siri 語音辨識本身（說出口 → 辨識成這個意圖）與印尼文／中文口語觸發詞的辨識率，Simulator 無法驗證，見下方 owner 清單。
- iOS 15 裝置沒有這個功能（框架不存在）。設計上 App 其餘功能不受影響（weak link ＋ `@available`），但本機模擬器最低只有 iOS 26，**沒有在 iOS 15 執行環境實測**；有 iOS 15 裝置時請確認 App 能正常啟動。
- Android 沒有對應，也不會誤觸發：`AndroidManifest.xml` 的 intent-filter 只註冊 `jia-jian-log://auth/callback`，這兩個網址進不到 Android App。
- iOS 的 `Info.plist` 註冊的是整個 `jia-jian-log` scheme（不分 host），所以任何 `jia-jian-log://…` 都會送到 JS；是否被處理完全由 `parseNativeShortcutLink`／`parseNativeAuthCallback` 的白名單決定。

## 驗收清單

- [x] 單元測試與型別檢查、ESLint、i18n 掃描
- [x] Simulator：動作被捷徑 App 辨識且無參數、多位對象停在選擇、單一對象直接開區塊、冷啟動排隊、已在照護頁時切區塊
- [ ] owner 的 iPhone 實機（免費 Apple ID 即可）：說「在 Family Health Note 記錄血壓」→ App 開啟並到血壓輸入；用印尼文與繁體中文系統語言各試一次口語觸發詞
- [ ] owner 實機：鎖定 iPhone 時觸發（系統會要求解鎖）、App 鎖開啟時觸發（解鎖後看到目標畫面）、只有一位與兩位以上對象各試一次
- [ ] owner 實機：把某位病人的血壓模組在設定關掉，殺掉 App 後用語音「記錄血壓」→ 應被帶到設定的顯示卡並指名血壓，而不是先開到血壓再被切走
