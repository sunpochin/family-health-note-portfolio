<!--
檔案用途：整理血壓／心跳／體重輸入、警示、Dashboard 與報告規格。
所在層：docs/features；供 vitals UI、統計、匯出與照護流程修改使用。
主要關聯：src/features/vitals、src/lib/dashboardStats.ts、vitalPresentation.ts 與 data-model。
-->

# 生命徵象 / Vitals

## 量測流程

輸入頁以手機優先，先確認第一筆資料已寫入遠端或已明確暫存本機，再開始 60 秒休息倒數；畫面會把「已寫入資料庫」與「等待同步」分開標示，不能把離線暫存冒充成遠端成功。第二筆完成後顯示當下時段摘要；若仍有 pending，不顯示不完整的遠端摘要。時段依台北時間分成 pagi、siang、malam1、malam2、malam3，夜間 bucket 是觀察點，不是強迫使用者每天必須量三次的排程。

血壓 INSERT 遇到連線中斷、408／429 或暫時性 5xx 時，會把同一筆含 `patient_id`、normalized `recorded_by` 與 client UUID 的資料放進 `localStorage` pending queue；storage key 本身也依病人與帳號分區。RLS、每日上限與格式錯誤不進 queue，因為重試不能修好授權或資料問題；Telegram 通知仍是獨立副作用，不會因資料 queue 盲目重送而製造重複提醒。

「連線中斷」由 `src/lib/dataErrors.ts` 的 `isRetryableWriteError()` 判斷，要認得 supabase-js 實際回傳的形狀：postgrest-js 2.x 不會把 fetch 的 `TypeError` 往外丟，而是回傳 `{ message: 'TypeError: Failed to fetch', code: '' }`、`status 0`（Safari 是 `TypeError: Load failed`）。2026-10-06 以前只認原生 `TypeError`，真正離線時這筆會顯示一般儲存錯誤、不進 queue，自動同步也就沒東西可送（issue #1116）。`tests/unit/dataErrors.test.ts` 用真的 supabase-js client 搭配會失敗的假 `fetch` 產生錯誤，升級 supabase-js 若又改了形狀會先在測試失敗。畫面文案刻意沒跟著改：`isConnectionError()` 仍只決定「連線或伺服器設定有問題，請通知家屬」那一句，單純沒訊號時不叫看護去找家人。

佇列補送時 `insertBloodPressureRecord()` 只送 `blood_pressure_records` 真的有的欄位（issue #1126）。佇列紀錄多出的 `queued_at`／`notified` 若一起送出，PostgREST（v11 起）會把 JSON 的 key 當成 INSERT 欄位而回 400 `PGRST204`，被當成永久失敗，那筆就永遠卡在佇列、家屬也收不到通知；#1116 讓離線儲存真的進佇列之後，每一筆離線紀錄都會撞到這裡。`tests/unit/bpOfflineSaveQueue.test.ts` 用真的 supabase-js client（只注入 fetch）加上一個跟真的一樣會擋未知欄位的假 PostgREST 鎖住這件事，欄位清單直接讀 `supabase/schema.sql`。

離線儲存從紅字「儲存失敗」變成琥珀色「已暫存」後，看護沒有理由打電話，但家人要等補送成功才會收到通知。所以只要目前病人的佇列裡還有「需要通知家人」等級（`isFamilyAlertLevelReading`，用量測當下生效的標準判讀）、而且還沒通知過的讀數，儲存按鈕下方的 assertive 區塊就會用三語請看護直接打電話給家人，並說明連線恢復後會自動補送、不用重新輸入（`L.queuedFamilyAlertPending`）。這個提醒直接從佇列推導（`queuedFamilyAlert`：`'none' | 'alert' | 'unknown' | 'rejected' | 'rejected_unknown'`）：切換病人再切回來、重新開 App 都還在，補送成功移出佇列就消失；也依 `patient_id` 過濾，不會掛到下一位病人的畫面上。

離線重開 App 時 `BpStandardProvider` 讀不到個別標準，只能退回一般成人門檻（`unavailable: true`）；長輩標準下 100/55 是偏低警示、一般成人卻算正常，直接用退回門檻判讀就會漏掉提醒（Codex review on PR #1127）。所以讀數進佇列時，若個別標準讀得到，就把「需不需要通知家人」的結論存在本機紀錄的 `family_alert`（只存在本機，`insertBloodPressureRecord` 不會送出）。畫面判斷的順序是：個別標準讀得到就用現在的判讀；讀不到就用 `family_alert`；兩者都沒有（App 一開就離線、從沒讀到標準）時顯示另一句三語提醒（`L.queuedFamilyAlertUnknown`），說明目前無法判斷、數值偏高偏低就直接打電話，不拿一般成人門檻假裝判讀過。標準還在載入中不算「讀不到」，避免連線正常時每次開頁先閃一下這句。補送時被伺服器永久拒絕的讀數不會自動補送，「連線恢復後會自動補送」對它是錯的：需要通知家人的被拒絕讀數改顯示 `'rejected'`（`L.queuedFamilyAlertRejected`：沒有被系統接受、家人不會收到，請直接打電話），優先於其他所有狀態；等級不明的改顯示 `'rejected_unknown'`（issue #1125）。只有再試也不會成功的拒絕算數，權限類拒絕照常重試、維持原本兩句。原本列在這裡的兩個缺口（只補送畫面上那位、被擋的請求看起來像離線）已在 issue #1125 處理，見下方「離線佇列自動同步」；剩下的缺口追蹤在 issue #1138。

被每日上限擋下的那一筆不進資料庫、不排入 queue、也不會通知家屬（上限是防濫用，被擋就是被擋）。所以輸入頁會在**儲存按鈕正下方**（不是頁尾的錯誤區：嵌在每日照護頁時頁尾距離按鈕好幾個螢幕高）、同一個朗讀區塊裡先講等級、再講上限說明，用同一套判讀（`useBpEvaluator`＋`VitalAlertBadge`）顯示這筆沒存進去的讀數與等級；若落在紅色三階（danger／danger-low／critical），再加一段大字提示「這筆危險、沒存進去、家人不會收到通知，請直接打電話給家屬」。實作在 `BpLimitBlockedNotice`，快照由 `useBloodPressureInputForm` 的 `limitBlockedReading` 保存，與錯誤訊息同生同滅（issue #1060）。

按下儲存後的其他回饋也一樣緊貼儲存按鈕（issue #1093）：一般儲存錯誤、家屬通知失敗／無法確認／沒有送出（`notifyFailed`、`familyDelivery` 各狀態）、「這筆不會自動通知家人」與「通知送出中」說明、離線待同步區塊、兩次量測完成摘要與本筆等級卡，都排在當日明細與近期趨勢**之前**；原本頁尾的狀態區已移除。錯誤與家屬通知失敗可能同時存在（例如離線補送那一筆的通知結果，在這次送出出錯之後才非同步回來），因此共用**一個** assertive live region（錯誤在前），`BpLimitBlockedNotice` 也放進同一個 region、本身不再掛 `role="alert"`，避免讀屏器只唸最後掛上的那一個；「不會自動通知家人」與「送出中」維持 polite。家屬通知結果是儲存後數秒才非同步回來，看護可能已往下捲，所以需要看護行動的內容（錯誤、家屬通知失敗／不明、「不會自動通知家人」；不含「送出中」）一變就以 `scrollIntoView({ block: 'nearest' })` 瞬間捲到剛好看得到（已可見時不動；不用 smooth，因為動畫遇到收鍵盤或分頁在背景時會被中斷而完全沒捲到）。實作在 `BpSaveNotices`；各狀態對應哪一句由純函式 `familyNotices` 決定並有單元測試，`FamilyDeliveryState` 用 `Record` 窮舉文案，hook 新增送達狀態卻漏配文案時 typecheck 會失敗。

**儲存進行中不能切換病人（issue #1103）。** 寫入途中若切到另一位病人，這筆被拒絕（非暫時性錯誤、每日上限）的結果因病人已變，依 § 3.5 不能顯示在新病人的畫面上；回到原病人時輸入已被清空、也沒有錯誤，一筆可能是危險讀數的紀錄就無聲消失（北極星鐵律 4）。既有的逐請求病人比對（PR #1092）負責「不把 A 的結果畫在 B 身上」，但不負責「讓看護知道 A 沒存成」，所以改在源頭解決：`status === 'saving'` 期間鎖住病人切換器，結果出來（成功、暫存、失敗）才解鎖，失敗訊息此時仍在原病人的畫面上。`SubjectSwitcher` 新增 `lockedReason`（`LocalizedText`，同時是「鎖住」的開關與畫面上的三語原因說明，不會出現按鈕變灰卻沒人解釋）：分段按鈕、下拉選單與「目前對象無法使用」的退路按鈕都會 `disabled`，處理函式也再擋一次。獨立 `InputPage` 自己鎖；嵌入每日照護頁時切換器在 `DailyCarePage`，由 `InputPage` 透過 `onSavingChange` 回報、`DailyCarePage` 據此鎖，InputPage 卸載時一定回報 `false`，外層不會永遠鎖著。取捨與已知缺口（追蹤在 issue #1117）：儲存請求沒有逾時，網路卡住時切換器會鎖到請求失敗為止（儲存按鈕本來就同樣停用）；這個鎖只涵蓋這兩個切換器，底部導覽與其他分頁（今天、大事記、門診、設定）的切換器都沒鎖——看護若在儲存中離開每日照護分頁，該頁卸載、儲存狀態隨之消失，這時才被拒絕的紀錄仍然看不到（即使沒換病人），所以「被拒絕的儲存一定顯示在它所屬的病人上」目前只對這兩個切換器成立。

### 離線佇列自動同步

殼層提示的本機保存由 `src/features/vitals/lib/shellNoticeStore.ts` 的 `createPerKeyStore` 與 `hooks/usePerKeyStoreState.ts` 共用處理（issue #1227）；`bloodPressureShellNoticeStores.ts` 保留點名與拒絕提示各自的舊 namespace、解析／錯誤摘要格式及排序。模組先留在 vitals 內，避免只有血壓使用時就把它擴成全站抽象；離線佇列本身仍由 `bloodPressurePendingQueue` 負責。`useBloodPressureQueueCoordinator` 只接回提示狀態與操作，補送、通知分流及畫面接手時機不變；逐鍵事件、寫入失敗留記憶體與 clear 語意由 `tests/unit/shellNoticeStore.test.ts` 驗證，協調器測試保留補送與重新掛載的整合案例。

除了按「現在同步」手動重送，`src/hooks/usePendingWriteFlush.ts`（2026-10-06 起與服藥打卡共用，issue #822；2026-10-07 起由 App 殼層的 `useBloodPressureQueueCoordinator` 呼叫、不再是血壓輸入區段，見下方 issue #1138）會在連線恢復（`online`）、分頁回前景（`visibilitychange` → visible）、iOS bfcache 還原（`pageshow`）與原生殼回前景（Capacitor `App` `appStateChange`，`isActive: true`）時自動觸發補送（2026-10-06 起是涵蓋整個帳號的 `flushAllPendingBloodPressureRecords()`，見下方），固定 client UUID 讓回應遺失後的重試不會多出第二筆。看護在收訊不穩的地下室、電梯旁量完血壓後即使直接關掉 App，回到有訊號處或原生殼切回前景的 30 秒內也會自動送出，不需要記得手動同步。

自動觸發以單一旗標防重入，同一時間只會有一輪同步在跑；同步失敗會以遞增退避（30 秒／2 分鐘／10 分鐘，之後固定停在 10 分鐘）安排下一次自動重試，避免弱網路反覆嘗試時打爆 Supabase。血壓輸入頁下方在有待送紀錄時顯示三語「N 筆尚未同步」與最後一次嘗試時間，成功清空後這個狀態列會自動消失。

**補送涵蓋這個帳號所有照護對象（issue #1125）。** 佇列依病人分桶，以前只補送畫面上那位：A 的危險血壓離線暫存後切到 B，連線恢復也不會送、家人收不到，要等有人再打開 A。現在每一輪都用 `flushAllPendingBloodPressureRecords()`（共用佇列的 `flushAll`）依序送這個帳號在這台裝置上所有病人的桶：畫面上這位優先，其餘依最早待送時間；遇到暫時性失敗就整輪停下，永久性失敗只卡那一筆。每筆照自己的 `patient_id` 寫入與通知。B 的畫面上只看到「其他照護對象還有 N 筆紀錄等待同步」（只有筆數、沒有數值與名字，§ 3.5），「現在同步」與自動退避也涵蓋它們。別人的紀錄補送後不用畫面上這位的判讀標準評等級（那是 B 的標準），只看入佇列時用那位自己的標準記下的 `family_alert`（`queuedRecordAlertLevel()`；兩邊都不知道時當成可能危險，因為相關提示的文案本來就是「若危險／可能沒收到，請聯絡家人」），也不寫進「這筆」的通知提示；但家屬通知可能沒到時不能吞掉，改在儲存按鈕下方同一個 assertive 區塊點名「{名字}：離線時存的血壓已補送，但家人可能沒有收到通知，請直接聯絡家人」，不帶數值（`otherPatientNotifyProblems`）。「個人通知已送達」的兩種結果不點名：家人已經收到，不能多叫看護打一通電話。畫面上這位自己的補送若提示已被較新的一筆接手（離線兩次量測一起補送時，第二筆的結果常先回來），送達問題、呼叫失敗，以及警示級讀數「沒有任何家屬通知」也都改走這個點名提示，不再靜默丟掉。點名提示在下一次儲存時清掉（與「這筆」的提示一起）；換病人時刻意不清，看護在 B 看到「A：…」後切到 A 去處理時，提示不能正好消失。補送結束時以「現在」畫面上的病人重讀佇列，補送途中切換病人不會把上一位的待同步清單蓋到新病人身上。前兩個缺口（只在血壓區塊掛載時補送、線上儲存的通知結果被丟掉）已在 issue #1138 處理，見下一段；仍留著的是：別人被拒絕的警示級讀數在目前畫面上只有一句「請切到該對象查看」（要不要點名、怎麼講是產品決定，追蹤在 #1138 的審查留言）。

**補送器住在 App 殼層，不在血壓區段（issue #1138，2026-10-07）。** 以前 `usePendingWriteFlush` 由 `useBloodPressureInputForm` 呼叫，只在每日照護頁的血壓區段掛載時才有監聽器：看護離線存了 185/105、切到今天頁，連線恢復時沒有人補送，家人要等有人再打開血壓區段。現在補送、退避、通知與「家人可能沒收到」的狀態都在 `useBloodPressureQueueCoordinator`（`src/features/vitals/hooks/`），由 `BloodPressureQueueProvider` 掛在 `App.tsx` 的 `BpStandardProvider` 之內（補送到畫面上這位的紀錄時要用她的判讀標準決定要不要提示），登入後不論分頁都在。表單 hook 經 `useBloodPressureQueue()` 讀清單（依病人過濾後才顯示數值，別人的只算筆數）、按「現在同步」，並在掛載期間向補送器登記成「畫面」（`BloodPressureQueueScreen`）：補送到紀錄、要通知家人之前，補送器先問畫面 `claimNotice`，這筆的病人就在眼前才領「這筆」提示的序號；沒有畫面、不是它的、畫面已卸載、或序號已被較新的一筆接手，送達問題一律改成點名提示（`notifyProblems`），存在補送器裡，之後打開任何病人的輸入頁都看得到，下一次儲存時清掉。線上儲存的通知結果也走同一條分流：換病人、離開分頁、或被同一位病人的補送接手序號後才回來的結果，以前直接丟掉，現在改點名。同一時間只有一輪補送：同分頁靠觸發器的防重入，跨分頁靠 Web Locks（`navigator.locks`，`ifAvailable`；拿不到鎖的那一輪直接讓給另一個分頁、回「還沒清空」照常排退避，不改「連線失敗」的提示），另一個分頁送完後 `storage` 事件讓這邊立刻重讀清單；沒有 Web Locks 的舊 WebView 退回不鎖，行為與以前相同。畫面上這位的清單直接讀她自己的桶、其他人才靠列舉（`localStorage.key` 不可用時列舉會落空，眼前這位的待送清單不能因此消失）。點名提示的文案改成「{名字}：血壓已存檔，但家人可能沒有收到通知，請直接聯絡家人」，不再寫「離線時存的」，因為線上儲存也會走這句。PR #1218 的 Codex 審查再補了四件事：點名提示寫進 localStorage（`jia-jian.pending-blood-pressure.notify-problems.v1-<帳號>`，只有病人 id）並靠 `storage` 事件跨分頁同步，否則拿到鎖、送了通知的背景分頁一關，提示就沒了；待送清單與點名提示在第一次 render 就從本機讀（不等 effect），不然觸發器掛載時的那次探測之後 hasPending 才從 false 變 true、多觸發一次立即探測，把剛排好的 30 秒退避推進到 2 分鐘；帳號的第一筆紀錄若在沒有輸入頁時補送成功也要埋 `first_record_saved`，所以輸入頁入佇列時記下 `first_record`（只存本機），補送器成功後埋點（analytics 的一次性 marker 去重）；`OnboardingWizard` 與邀請畫面（病人邀請、照護者邀請）那幾條提早 return 也掛上補送器（`withBloodPressureQueue()`），那些畫面開著的幾分鐘另一位病人的離線血壓照樣補送；舊版 build 排進佇列、沒有 `first_record` 欄位的紀錄，補送成功後問一次資料庫「排除這位病人整批佇列之外還有沒有別的紀錄」（`hasOtherBloodPressureRecord()`，不 await），問不到只放棄埋點、不擋寫入與通知。第三輪再補：已登入的 `/join`、`/patient-invite` 頁也掛補送器；點名提示改成每位病人一把 key（`…notify-problems.v2-<帳號>-patient-<id>`），兩個分頁同時點名不同人不會互相覆蓋；別的分頁送走紀錄時（`storage` 事件後佇列少了的那幾筆）通知掛著的輸入頁重抓今日清單與最新讀值。Codex App 獨立審查再補：只有在前景的分頁（`document.visibilityState !== 'hidden'`）能獨占「這筆」的提示，背景分頁的表單即使掛著、拿到鎖，結果也走持久化的點名提示；本機儲存寫不進或不能列舉 key 時，點名提示仍留在記憶體（讀不到回 null、不當成「沒有提示」）；別的分頁的 `storage` 事件只依事件指到的那位加減、不整份覆蓋，寫不進本機的點名不會被別人的事件抹掉，`localStorage.clear()` 只清持久化過的。

**離開頁面或換病人後才被拒絕的線上儲存不再消失；一次寫入最多等 15 秒（issue #1117，2026-10-07）。** #1103 只鎖了每日照護頁的兩個病人切換器；底部導覽與其他分頁的切換器沒鎖，儲存中點別的分頁會把輸入頁卸載，之後伺服器拒絕（每日上限、資料不合理、權限）時 `setErrMsg`／`setStatus` 落在已卸載的元件上，沒有任何畫面講這件事。現在：(1) `insertBloodPressureRecord()` 用 `AbortController` 把 INSERT 與 23505 後的回讀合計限制在 `BLOOD_PRESSURE_SAVE_TIMEOUT_MS`＝15 秒（15 秒原則；iOS Safari 自己的 fetch 逾時約一分鐘），而且整個呼叫再跟明確的期限競速（supabase-js 送請求前的 token refresh 不收 signal，登入到期又卡在弱網路時 abort 了也沒人回來；Codex App 獨立審查），到期就 abort 並立刻回 code 空字串、status 0 的「AbortError: …」（與 postgrest-js 中止時同形），`isRetryableWriteError()` 認得它，所以這筆進離線佇列、由殼層補送器重送（id 是 client UUID，伺服器其實已收到時重送只會回「已存在」）；補送路徑同樣受這個逾時保護，一輪補送不會卡死觸發器的防重入旗標。(2) 不可重試的拒絕回來時若輸入頁已卸載、或畫面上已是別人（`mountedRef`／`patientIdRef`），表單 hook 不再丟掉，改交殼層補送器保管（`rejectedSave`：病人 id、原始錯誤、被上限擋下時的讀數快照）；`App.tsx` 狀態列下方的 `BloodPressureSaveRejectedBanner` 在任何分頁點名「{名字}：剛才的血壓沒有儲存成功（原因），請到血壓區段重新輸入」，被上限擋下時用 `BpLimitBlockedNotice` 顯示等級與「請打電話」；那筆屬於別人時只點名、不講數值（§ 3.5），附「切換到她」按鈕。回到那位病人、**看得到的**輸入頁時表單 hook 接手（同一個位置、同一句話），橫幅自動消失；看護也可按「知道了」清掉；每一筆各自保留、各自清（以 client UUID 為鍵），連續兩筆都在離開後被拒絕時後到的不會蓋掉先到的（Codex 第三輪）；也寫進 localStorage（`…rejected-saves.v1-<帳號>-record-<UUID>`，值含病人 id、錯誤摘要、被上限擋下時的讀數與「要不要立刻聯絡家人」的判定）並靠 `storage` 事件跨分頁同步，瀏覽器分頁在背景（`document.visibilityState`）也算「已離開」，背景分頁不接手；那筆屬於切不到的對象（已封存）又是要聯絡家人的等級時，橫幅不畫數值但仍講「請現在打電話」（Codex 第四輪）。每日照護頁切到別的區段時 InputPage 仍掛載、只是 hidden（`DailyCarePage` 傳 `visible`），隱藏的面板與卸載同一個待遇：拒絕交殼層、不接手（PR #1219 審查）。同一輪審查也修了警報鏈上的一個洞：每日上限 trigger 是 BEFORE INSERT、只數同一天筆數、不排除 NEW.id，第 9 筆在逾時後其實已寫入、補送再來一次會先撞上限而輪不到主鍵去重，以前會被判成「再試也不會成功」永遠卡在佇列、家屬通知永遠不送；現在 `insertBloodPressureRecord()` 遇到 `daily_blood_pressure_limit` 也回讀 id，有那一列就當「已存在」正常走通知。橫幅的「切換到她」只在切換器真的切得到那位時出現（`switchablePatientIds`）。Codex 第一輪再補兩件：暫時性失敗（含逾時）後本機佇列又存不了時結果其實不明（伺服器可能已寫入），`rejectedSave.uncertain` 讓橫幅與輸入頁改講「先看今日紀錄，沒有的話再重新輸入」（`L.saveOutcomeUnknown`），不叫看護直接重輸（新 UUID 會多一筆）；同一位病人新的一筆有自己的結果在畫面上時不接手舊的拒絕（只在 status 為 idle 時接：送出中接手會讓按鈕看起來能按、切換器提早解鎖；新的一筆也被拒絕時接手會把較新那筆的訊息與等級蓋掉。成功／暫存 2 秒後回 idle 才接，被拒絕則舊的留在殼層橫幅），接手時取消成功後 2 秒歸零的計時器。第二輪又修：那筆屬於別人且結果不明時也用「不確定」文案；「切換到她」只認 `accessiblePatients`（不含已封存；從橫幅切到封存對象會讓她變成可寫入的現役對象）。重新整理頁面後不保留（記憶體狀態；票文範圍是分頁與病人切換）。票文第 3 點（通知結果在切換間隔被丟掉）不另做：#1138 已把丟掉的通知結果改成點名提示，伺服器端 sweeper（ADR-007 票 6／票 10）也會對 `delivery_unknown`／`failed_terminal`／逾時 `sending` 開 incident 顯示在今天頁橫幅。底部導覽刻意不鎖：有了上述兩條，鎖住只會違反 15 秒原則。測試：`tests/unit/bpSaveAfterLeaving.test.ts`。

**補送失敗時講真正的原因（issue #1125）。** 2026-10-06 以前不論原因一律顯示「請確認網路後再重新同步」（本段舊版寫的「顯示既有的錯誤訊息」並不成立）。現在：

- 被伺服器永久拒絕的那筆（權限、每日上限、資料格式）留在佇列、繼續送後面的紀錄，狀態列以「有紀錄沒有同步成功：」開頭講出原因（`queuedRejectionText()`，判斷順序與 `saveErrorMessage()` 相同；歸不了類的拒絕說重試沒用、請通知家屬，而不是「再試一次」）。原因以紀錄 id 記住（`nextPendingRejections()`）：下一輪若前面先斷線、沒嘗試到這筆，原因保留，不會一下有一下沒有；這筆自己再試時遇到暫時性失敗，就丟掉舊原因，回到一般的連線失敗處理。只顯示畫面上這位的原因；別人有被拒絕的紀錄時，只說「其他照護對象有紀錄沒有同步成功，請切換到該對象查看原因；切換清單裡找不到該對象時，請通知家屬」（那位的權限被收回或已封存時，清單裡就沒有她）。
- 只有「再試也不會成功」的拒絕（每日上限、資料格式，程式裡叫 settled）不算「還在等自動重試」：剩下的若都是這種，這一輪就算清空、不排 10 分鐘退避，它們在下一次連線恢復、回前景、換病人或按「現在同步」時再試；否則一筆卡住的紀錄會讓整個帳號永遠停在 10 分鐘退避，另一位病人新的離線危險讀數也等不到「第一次進佇列就立刻試一次」。權限類（401／403／42501）不算定局：登入過期、或 token 換新剛好失敗時 supabase-js 退回 anon key 送出都長這樣，重新登入或下一輪就可能成功，所以照常退避重試。
- 需要通知家人、又被 settled 拒絕的讀數，「請打電話給家人」那句改成不承諾自動補送的版本（`queuedFamilyAlert` 的 `'rejected'`；等級不明時 `'rejected_unknown'`，同樣請看護偏高偏低就打電話）。
- 暫時性失敗時，手機自認離線（`navigator.onLine === false`），或手機自認有網路但失敗還不到 2 分鐘（`PENDING_UNREACHABLE_AFTER_MS`），講「請確認網路」。手機自認有網路、從第一次失敗起 2 分鐘以上都沒有任何一筆送到，改講「手機顯示有網路，但一直連不到伺服器；請換個網路再按『現在同步』，還是不行請通知家屬」（`L.pendingUnreachable`）。DNS、公共 Wi-Fi 登入頁、內容攔截器或過嚴的 CSP `connect-src` 擋掉請求時，postgrest-js 回的錯誤與真正離線一模一樣，只能靠這個條件分開；2 分鐘大約是退避排程的第三次嘗試，避免把收訊差的電梯口誤判成被擋。兩次失敗之間隔超過 15 分鐘（例如 App 在背景好幾小時）就重新計時，醒來後的第一次偶發失敗不會直接被說成連不到伺服器。
- 沒有另外發 ops 告警：請求被擋時，告警也會走同一條被擋的路，前端目前也沒有錯誤回報通道。看護看到的文案就是升級路徑（通知家屬）。

測試：`tests/unit/bpQueueAllPatients.test.ts` 用真的 supabase-js client（只注入 fetch）跑完整的表單 hook（連同殼層補送器，靠 `tests/unit/helpers/bloodPressureQueueHarness.ts` 把兩棵 hook 樹接起來）；跨病人補送、點名提示、拒絕原因與「連不到伺服器」都在這裡。`tests/unit/bpQueueCoordinator.test.ts` 驗證沒有輸入頁也補送並通知、卸載後／換病人後／被接手後的通知結果點名、跨分頁鎖與 `storage` 事件（issue #1138）。共用佇列的列舉與停止規則在 `tests/unit/pendingWriteQueue.test.ts`。

第一筆成功後，App 外殼會以目前 `patient_id`、照護日與量測時段保存這一輪量測的截止時間，並在主要頁面上方顯示大字倒數。倒數不放在血壓輸入卡內，讓照護者等待時可以切到照護大事記、健康資料或其他每日照護分頁；第二筆成功或切換病人後才清除這個暫時狀態。狀態只存在 `sessionStorage`，因為它是本次裝置操作的流程提示，不是新的健康紀錄，也不應跨裝置同步；重新載入若已跨過照護日／時段，就會捨棄舊流程，避免第一筆新量測被誤當第二筆。

722 原則是建議參考：連續 7 天、早晚各 2 次、每次 2 遍且間隔 1 分鐘；實際夜間量測依被照護者狀況與醫囑，不把建議寫成硬性警報。

## 照護日與真實時間

每日照護摘要、最近量測摘要、輸入頁的同一輪量測 key 與血壓每日新增配額，使用台北時間 04:00–隔日 04:00 的照護日。血壓每日配額預設每位病人每個照護日 9 筆（核心照護帳號 20、CHECK 上限 20）：它是防濫用上限、不是付費牆，必須高於 722 量測法的一天 8 筆，否則被擋下的危險讀數不會進資料庫也不會通知家屬（issue #1058、[ADR-011](../adr/011-paywall-safety-boundary.md) D1）。沒有 `account_usage_limits` 列的帳號走 trigger fallback，fallback 與欄位 DEFAULT 必須同一個數字。這能讓凌晨 02:00–03:59 的睡前後續量測和前一晚留在同一份交接資料，也讓 05:00 起床量測自然開始新的一天。

每筆資料仍以 `measured_at` 保存實際發生時間；醫師／GPT 報告明示照護日區間並保留逐筆原始時間。照護大事記與體重目前維持各自的日曆日語意，不可把照護日當成全系統任意改寫的日期。

## 警示

目前顯示規則以家庭量測的高壓／低壓與心跳界線為基礎：

| 狀態 | 規則 |
| --- | --- |
| danger | 收縮壓 ≥ 160 或舒張壓 ≥ 100 |
| warning | 收縮壓 ≥ 130、舒張壓 ≥ 80 或心跳 > 120 |
| danger-low | 收縮壓 < 90 或舒張壓 < 50 |
| warning-low | 收縮壓 90–99 或舒張壓 50–54 |
| normal | 其他情況，含刻意降噪的舒張壓 55–59 |

高壓端先判定，再判低壓端；banner 以成功送出的 snapshot 為準，不讀 reset 後的輸入框。警示不得只靠顏色，必須同時有文字或 badge。

`VitalAlertBadge`（`src/features/vitals/components/VitalAlertBadge.tsx`）包裝 `evaluateReading`，統一輸出這個 badge；`DashboardStatsCards`「最新」列與 `DailyBloodPressureRecords`（本照護日新增的量測紀錄）逐筆量測共用同一份判定與樣式，避免兩處各自維護一份規則，導致總覽顯示偏高、當日清單卻看不出風險等級。

徽章預設可換行（`whitespace-normal`＋`max-w-full`，多行用 `rounded-2xl` 而非 `rounded-full`），呼叫端不需要自己覆寫：最高階的印尼文標籤在 375px 手機上單行約 460px，舊版 `whitespace-nowrap` 會讓整頁出現橫向捲動（issue #1096）。最高階（`danger_high`）的行動文字只來自 `bp-levels.json` 的標籤本身，徽章不再另外接一句「立即複測」，否則同一句指示會顯示兩遍。

### 判讀標準模板（BP standard templates）

上表是 `general_adult` 這一份標準的內容，不是全 app 唯一的標準。自 issue #896 起，判讀函式改成「**讀數 ＋ 一份標準**」：

```ts
evaluateBp(sys, dia, standard)                    // 最嚴重的那一條規則
evaluateReading(sys, dia, pulse, standard)        // level／labels／recommendations／standardKey
getAlertLevel(sys, dia, pulse, standard)
```

**`standard` 參數必填、沒有預設值。** 全 repo 有 14 個呼叫點散在 10 個檔案；寫成選填會讓漏接的呼叫點照常編譯、靜默用一般成人標準，於是同一位病人的圖表、異常示警、輸入即時回饋與列印報告可以各說各話（`AGENTS.md` § 3.5）。必填把每一個漏接變成編譯錯誤。自 issue #898 起這 14 個呼叫點全部改由病人綁定的 evaluator 供應，過渡期用的 `DEFAULT_BP_STANDARD` 別名已移除——留著只會變成下一個靜默預設的入口。

三份資料檔的分工（「抽詞彙，不抽階梯」）：

| 檔案 | 內容 |
| --- | --- |
| `src/config/blood-pressure-spec.json` | 九級表本尊，D1 凍結，**一個字不改**。`general_adult` 的階梯直接指向它，不複製 |
| `src/config/bp-levels.json` | 等級詞彙：每個等級 key 的 `zh`／`id`／`en` 標籤、臨床建議與 `webAlertLevel`，全專案一份 |
| `src/config/bp-standards/*.json` | 每個模板一份**完整門檻階梯**，只描述「哪個數值區間對應哪個等級 key」 |

模板刻意**不是**對九級表的 diff：diff 表達不出 `elderly_relaxed` 的「低於 120 就該注意」，也會讓自訂模板的下界欄位變成可證明永遠不影響判讀的死欄位。理由全文見 [`docs/product/blood-pressure-standard-templates.md`](../product/blood-pressure-standard-templates.md) § 6.3。

**hard floor 先行，且 floor 不是模板資料。** `≥180/120` 與 `<90/50` 是 `bpStandard.ts` 裡的程式守衛，不在任何模板 JSON 裡，模板因此在結構上無法表達降級。唯一例外是 `general_adult`：九級表自己的第 1 條與第 5 條就是 floor，但它們之間還夾著 `cukup_tinggi` 與 `tinggi`，把 `danger_low` 守衛提到最前面會讓 140/45 從「⚠️ 偏高」變成「🔴 明顯偏低」——那是真正的行為變更，撞 R3，所以九級表走原本的 first-match 流程。


#### 病人級標準的儲存：生效日期化（issue #897）

`patient_bp_standards` 存的**不是「這位病人現在用哪個標準」，而是「這位病人在哪段期間用哪個標準」**——append-only、每列一段 `[effective_from, effective_to)`，依讀數的 `measured_at` 解析。

為什麼不是每位病人一列可覆寫的設定：判讀是在**畫面渲染時**即時算的（`evaluateReading` 跑在每一筆歷史紀錄上）。若只存一列，術後嚴格控制的階段結束、換回一般成人之後，**過去那段期間的所有讀數會被重新漆成綠色**，而且列印報告會在歷史讀數旁印出當下的標準名稱——那比不印更糟，醫師會以為那段期間就是用這個標準判讀的。

也**不是**「INSERT 當下把標準快照到血壓紀錄上」：本 app 支援補登舊量測，補登 8 月的讀數該套用 8 月生效的標準，快照會答錯這一題。

| 保護 | 機制 |
| --- | --- |
| 同一病人的區間不得重疊 | `EXCLUDE USING gist` ＋ `btree_gist`；沒有它，換標準的兩步寫入中途失敗會留下兩列同時生效，解析結果變成看資料列順序的運氣 |
| 歷史不可竄改 | trigger `protect_patient_bp_standard_immutable_fields`：UPDATE **只允許改 `effective_to`**，且已結束的區間不得再動。RLS 管「誰能改這一列」，trigger 管「可以改成什麼」——policy 表達不了欄位級的不可變性 |
| 歷史不可消失 | **不授予 `DELETE`**。打錯字的修正方式是結束該列再開一列；刪掉會讓那段期間的讀數退回 `general_adult`，等於靜默改寫歷史判讀 |
| 自訂目標不得把危險值設成正常 | CHECK 限制在 R1 floor 之內（收縮 90–179、舒張 50–119），與引擎的 `assertCustomBounds()` 是同一組規則的兩道防線 |
| 換標準是原子操作 | RPC `set_patient_bp_standard()`（**SECURITY INVOKER**，RLS 照常生效）。順序被 EXCLUDE 綁死（必須先關再開），兩步之間失敗會留下沒有標準涵蓋的空窗 |

**一個容易漏掉的 RLS 行為**：唯讀照護者（`can_manage_medication = false`）執行 UPDATE 時，Postgres 在 `USING` 濾掉所有列的情況下**只回報 0 rows、不拋錯**。因此 RPC 內部必須自己判斷「有開放區間卻關不掉 ⇒ 沒有權限」並 `RAISE EXCEPTION`，否則照護者按下「換標準」會看起來成功但什麼都沒發生。

`src/lib/bpStandards.ts` 只提供「一次取回全部區間」的 `readBpStandardIntervals()` ＋ 純函式 `resolveStandardAt()`，刻意沒有單筆查詢 API：清單一次渲染幾十筆讀數，逐筆查詢會變成 N 次網路往返。沒有任何區間涵蓋某個 `measured_at` 時（功能上線前的歷史資料）退回 `general_adult` 並回報 `configured: false`，報告必須據此標示「當時未設定個別標準」。

**雙軸模板會同時回傳兩條規則。** `post_op_strict` 把收縮壓與舒張壓當成兩條獨立的階梯，`ReadingEvaluation.bpRules` 依「收縮壓在前、舒張壓在後」列出全部命中的規則，`labels` 把它們串起來（沿用心跳警示既有的串接做法），`bpRule` 與 `level` 則取其中最嚴重的那一條決定顏色。例如 109/56 ＝「🔻 低於目標；🔻 舒張壓低於參考值」。

`AlertLevel` 因此新增**兩個**等級：`'off-target'`（超出目標）與 `'below-target'`（低於目標／低於參考值）。收縮壓「低於目標」與舒張壓「低於參考值」**共用** `below-target`，由規則 key（`below_target`／`diastolic_below_ref`）產生不同標籤——`bpRule.key` 決定文案、`webAlertLevel` 決定顏色，不為舒張壓再開第三個等級。

`ReadingEvaluation` 另外新增 `standardKey`，讓列印報告、就診前摘要、分享連結與通知能印出「依據：術後嚴格控制 110–120」（規劃文件 R5）；目標帶用 `targetSystolicBand(standard)` 從階梯推導，不另外寫一個會漂移的摘要欄位。

第一版模板：`general_adult`（預設）、`post_op_strict`、`elderly_relaxed`、`ckd_diabetes`、`custom`。`custom` 由 `createCustomStandard(bounds)` 用照護者輸入的目標帶展開成完整階梯——**展開發生在建立標準時，不是判讀時**。妊娠與兒童明確不做，理由見規劃文件 § 3。

⚠️ 只有 `post_op_strict` 的階梯由規劃文件 § 3.1 逐格指定；`elderly_relaxed`／`ckd_diabetes`／`custom` 的完整階梯是依 § 3 摘要欄推導的第一版，對正式使用者開啟模板選單（issue #898）之前需要臨床確認。回歸測試在 `tests/unit/bpStandardTemplates.test.ts`。

#### UI 怎麼取得標準：`useBpEvaluator()`（issue #898）

畫面**不直接呼叫裸函式**。`<BpStandardProvider patientId>` 一次載入該病人的全部生效區間，底下所有元件用 `useBpEvaluator()` 取得同一份 evaluator：

```ts
evaluator.evaluateAt(sys, dia, pulse, measuredAt)  // 清單／圖表／報告：用該筆量測當時生效的標準
evaluator.evaluateNow(sys, dia, pulse)             // 輸入即時回饋與平均值：還沒有 measured_at
evaluator.resolver                                 // 傳給 src/lib 的純函式（它們不得自己查資料庫）
```

掛載點只有兩個：`App.tsx` 的 `selectedPatientId`，以及 `BloodPressureReportPanel` 自己的 `patientId`（封存對象的唯讀歷史頁傳進來的 id 刻意不進入 `activeSubject`，巢狀 Provider 讓內層覆蓋外層）。

**沒有 Provider 時 `useBpEvaluator()` 直接丟例外**，不退回 general_adult：退回會讓漏掛的畫面看起來完全正常、只是用錯人的標準判讀，那種錯誤不會有人回報。防呆檢查的是 `typeof value?.resolver === 'function'` 而不是只檢查 truthy——測試的 hook harness 對沒有對應 Provider 的 context 會回傳一個共用預設值，只檢查 null 會放行。

**載入狀態與 `patientId` 綁在同一個 state。** Provider 存的是 `{ patientId, intervals }` 而不是裸的 `intervals`，判讀前先比對 owner。用 `useEffect` 在切換病人時清空是**不夠的**：passive effect 在 commit 之後才跑，`patientId` 換掉的那一次 render 整棵子樹會先拿著上一位病人的區間跑完一遍（Codex review，PR #905 P2）。綁 owner 讓比對在 render 當下同步完成，不依賴 effect 時機。

**「讀不到」與「查過了、沒設定」是兩件事。** `ResolvedBpStandard` 除了 `configured` 還有 `unavailable`：載入中、查詢失敗，或手上的區間還屬於上一位病人時，resolver 是 `UNAVAILABLE_BP_STANDARD_RESOLVER`（仍給一份門檻讓畫面畫得出來——空白的血壓清單比暫時用預設門檻更糟——但 `unavailable: true`）。這個區別是必要的：報告若把讀取失敗印成「當時未設定個別標準」，就是對醫師陳述一個我們並不知道的事實。

消費端因此必須真的用到 `loading`／`error`，不能只放著：`BloodPressureReportPanel` 連同標準一起等載入完成，讀取失敗時顯示可重試的警告並**停用匯出**（CSV 與 GPT 摘要會離開 app 進到醫師手上，不能帶著一份我們自己都不確定的判讀出去）。回歸測試在 `tests/unit/bpEvaluatorProvider.test.ts`。

`src/lib` 的純函式（`dashboardStats`／`recordReport`／`preVisitBrief`／`careAnomalySignals`）改成收一個 `BpStandardResolver`，同樣**必填**；沒有病人情境的呼叫端（主要是測試）必須顯式傳 `GENERAL_ADULT_RESOLVER`，讓 review 看得到那是刻意的。

#### 分級紅與配色落點收斂

`src/lib/alertPresentation.ts` 是全 app **唯一一份**等級對照表。原本 badge、列印報告、圖表 tooltip、輸入頁與統計卡各自維護一份 class map，新增等級時漏改一處就會出現「總覽紅、清單綠」。

它的 key 是 `AlertTone`，刻意比 `AlertLevel` 多三階：

| 額外的階 | 為什麼要分出來 |
| --- | --- |
| `critical` vs `danger` | 兩者的 `webAlertLevel` 都是 `danger`，但 185/120 是「現在就打電話」、165/95 是「今天內回報醫師」。同一個紅講兩件事＝警報疲乏 |
| `on-target` vs `normal` | 兩者都是 `normal`，但「在目標內」是對著醫囑目標說的正向回饋 |
| `pulse-warning` | 血壓沒到警示級、只是心跳 >120 時用心跳自己的琥珀。「紅＝血壓」是全 app 一致的語彙 |

視覺階梯：**外框 → 實心 → 實心＋色條 → 深實心＋色條＋行動文字**。`warning` 與 `danger` 的底色相同，左側 4px 色條是它們在灰階下唯一的差別；`critical` 再靠更深的底色與「立即複測」分出來。高側用紅、低側用琥珀，加上上／下三角圖示，讓「往哪邊調」在紅綠色盲與灰階列印下都還在。列印報告走 `ALERT_SOFT_CHIP_CLASS`（淺底）但**保留同一組色條**：實心深紅會吃墨、家用印表機容易糊成一塊黑。色條一律連同 `rounded-l-none` 一起給（`ALERT_BAR_CLASS`）：chip 是圓角，只加左邊框會被瀏覽器沿圓角彎成彎月形，看起來像顏色溢出的 bug；左側兩角改直角後才是一條直線。

跨畫面一致性由 `tests/unit/alertPresentation.test.ts` 鎖住：掃過整個值域 × 兩份標準，確認每一組數值在五個落點都查得到樣式，而且四階紅的非色相差異還在。

#### R5：報告必須說出依據哪一份標準

`RecordReport` 表頭、CSV 的每一列與 GPT 摘要都印出判讀標準（例如「術後嚴格控制 110–120 mmHg」）。這是本功能最容易漏、後果最嚴重的一點：醫師看到「偏高」卻不知道基準是 110–120 還是一般成人的 135/85，會做出不同的處置決定。

- 印的是**該筆讀數當時**生效的標準，不是現在的。跨越標準變更日的報告會列出兩份而不是一份（`bpStandardsUsed()` 逐筆解析後去重）。
- `configured: false` 一律印「當時未設定個別標準（一般成人）」，**不得**改印現在的標準名稱。
- CSV 把標準放在**每一列**而不只是表頭：匯出的檔案會被排序、篩選與部分複製，表頭一離開那一列就失去對應關係。

#### 設定面板

`src/components/settings/BpStandardSettings.tsx`，比照 `CareAnomalyAlertSettings` 的自給自足慣例（只接 `patientId`／`isDemoMode`／`canManageMedication`）。只有 `can_manage_medication` 的照護者能改，唯讀家屬看到鎖住的欄位與說明，不會等到儲存才被 RLS 拒絕。

面板同時顯示「現在生效」與「已排程、從某日起生效」兩列——既然支援未來生效，排了程卻看不到會讓使用者以為沒存到。畫面上另有一行明說「變更從現在起生效，過去的紀錄不會被重新上色」：生效日期化最容易被誤解的就是這一點。

**面板不自己讀一份 intervals，也不自己重讀。** 它直接消費 Provider 的狀態，存檔後呼叫 `evaluator.reload()`。自己維護一份的後果是：換完標準走回「今天」或血壓輸入頁，那些畫面仍用舊的 resolver 判讀，要整頁重載才會更新——一個會改變健康判讀的設定不能有那種延遲（Codex review，PR #905 P1）。

**換病人時表單一律先重置再填。** 只在「新病人有生效區間」時才覆寫，會讓從一位設了自訂目標的病人切到尚未設定的病人時，畫面上顯示、而且可以直接按下儲存**前一位病人的目標帶與門診備註**——寫進另一個人健康判讀的值（同上，P1）。回歸測試在 `tests/unit/bpStandardSettingsPanel.test.ts`，兩條都經過「還原舊寫法會失敗」的驗證。

## 視覺識別

收縮壓使用 `#C23B3B`，舒張壓使用 `#2563EB`，心跳使用 `#7C3AED`；OS 深色模式也維持這組亮色值，因為卡片永遠是白底（暗色值 `#F87171`／`#60A5FA`／`#C084FC` 只保留給未來的暗色表面，#1152）。圖表以高壓實線圓點、低壓實線菱形、心跳虛線方點區分；不要再加佔手機寬度的小圓點。

## Telegram 通知可靠性

血壓寫入 Supabase 成功後，`src/lib/telegramNotification.ts` 只把 `recordId` 與 `patientId` 交給帶目前登入 session 的 `blood-pressure-notifier` Edge Function。Function 以 caller-scoped Supabase client 對 `blood_pressure_records` 做精確的 `id + patient_id` 查詢，再由 RLS 與 JWT email 驗證目前使用者；血壓數值、病人名稱與提交者不接受瀏覽器自訂。通知失敗不回滾已保存的血壓；網路錯誤一律不重送，避免回應遺失時產生重複提醒。直送 Telegram 與請求內重試開關 `BLOOD_PRESSURE_NOTIFIER_IN_REQUEST_RETRY` 已於 2026-10-09 隨共用群組退場移除（issue #1061 階段 D）：Function 只用與畫面同源的判讀引擎算等級，把通知排進 `personal_notification_outbox`，送出與重試在 `personal-notification-drain`（ADR-007 D4）；排入失敗一律回 502。

**直送帳本的五值狀態機（ADR-007 票 2，issue #959，migration `20260926161421`；歷史——2026-10-09 起 Function 不再直送，見下一段）**：送出前 Function 呼叫 `reserve_blood_pressure_notification_delivery_v2`，`pending → sending` 由一次條件式 UPDATE 原子取得，回傳 `claimed` 與 `claim_token`；**只有 `claimed = true` 才送出**，其餘一律不送、也不得回報成功。送出器回傳 `provider_*` 分類而不 throw，之後呼叫 `resolve_blood_pressure_notification_delivery` 寫終局狀態（`sent`／`delivery_unknown`／`failed_terminal`；單向、驗證 `claim_token`，舊 token 的重試在 `WHERE` 就落空，這是 D9 的 ABA 防護）。`resolve` 失敗不回 502（訊息可能已在家屬手機上），改回報 `unknown`。Function 回應帶明確的 `sharedTelegram` 結果欄位：`delivered`／`in_progress`（另一個呼叫正在送，回應附伺服器算好的 `sharedRemainingMs`＝門檻 M＝10 分鐘扣掉那次送出已耗時間；前端只拿它當相對期限回看帳本直到終局，不把伺服器時間戳和手機時鐘相減）／`unknown`（`sending` 逾時、`delivery_unknown`、resolve 失敗）／`failed`（確定沒送，且**不會自動重試**——直送路徑沒有重試者，不得對看護說「稍後重試」）／`deferred`／`not_subscribed`；輸入頁對 `in_progress`／`unknown`／`failed` 各有三語提示，都先說「血壓已存檔」，看護不必重新輸入；`personalQueued = true`（個人化通知已排入 outbox、有自己的重試者）時 `unknown`／`failed` 改用只說「家人群組那一則」的版本，並說明個人通知會自動送出，不對整條家人通知路徑說「沒送出、不會重試」。Telegram 回 2xx 但回覆內容讀不到（header 之後斷線、不是 JSON、沒有 `ok`）判 `delivery_unknown`／`provider_network_unknown`，`provider_api_rejected` 只留給真的解析到 `ok:false` 的回覆。舊簽章 `reserve_blood_pressure_notification_delivery` 在部署窗口內仍供舊版 Function 呼叫，它建立的列帶 `created_by_legacy_reserve` 標記、對 v2 的 claim 不可見（上線約束 2）；舊簽章 `confirm_blood_pressure_notification_delivery` 同樣只收 legacy-marked 的 `pending` 列，記錄者無法用它把 v2 的 `sending`／`delivery_unknown`／`failed_terminal` 蓋成 `sent`。這個欄位的過渡預設是 `true`：卡在 migration 的 `ALTER TABLE` 鎖上、之後才恢復執行的舊函式本體不會寫這個欄位，必須一樣被當成 legacy，只有 v2 自己的 INSERT 明寫 `false`；`DROP`、第二次隔離與收掉過渡預設都屬票 9。

**#1061 階段 D（2026-10-09）之後**：Function 不再呼叫 reserve／resolve，`blood_pressure_notification_deliveries` 沒有新列；回應的 `sharedTelegram` 固定是 `not_subscribed`（線上契約值，意思是「沒有共用群組那一則」；沿用舊值而不是新增 `retired`，是因為 Function 與 Vercel 前端分兩條 pipeline 部署，前端認不得的值會被當成 `unrecognized`，警示級讀數沒有任何家人會收到時看護就不再被告知），前端只看 `personalQueued`／`personalUnknown`／`personalDelivered`。直送 RPC、帳本與前端的 `in_progress` 回看留待 follow-up 清理。

**#1102 第一階段（2026-10-14）**：保留的 `in_progress` 回看改呼叫唯讀 `personal_notification_counts(record_id, patient_id)`，仍只准該病人的記錄者讀取；queued／unknown／delivered 都包含免費危險級列，不重新 enqueue。RPC 失敗時沿用 `personalUnknown: true` 的警告，不重送血壓、不影響已排入的通知。兩參數 enqueue 暫留作部署相容；待確認部署中的 caller 都已遷移後，才在另一個 migration 移除，完整部署／回滾條件見 [personal-notifications.md「狀態回看與舊入口退役」](personal-notifications.md#狀態回看與舊入口退役1102)。

Telegram 標題使用 Function 從授權紀錄重新讀到的病人顯示名稱，例如「王美玲血壓量測通知」或「陳伯伯血壓量測通知」；提交者由 JWT email 產生並移到第二行，讓收件者先辨認是哪一位被照顧者，再看到誰代為提交。前端已完全不依賴 `VITE_WORKER_URL`／`VITE_WORKER_API_KEY`；舊版 Cloudflare Worker `/notify` 已於 2026-09-07 停用並自 repo 移除，不再是任何 build 的相容路徑。

### 刪除血壓紀錄與 delivery 收據的生命週期（issue #932）

`blood_pressure_notification_deliveries` 的 `record_id, patient_id` 外鍵原本是 `ON DELETE RESTRICT`：只要 `blood-pressure-notifier` 替某筆血壓保留過一次 delivery（幾乎每一筆會推播的量測都會），照護者刪除那筆量測就會撞外鍵失敗，畫面卻只顯示「請確認網路後再試」，跟網路無關。`20260925140000` 把它改成 `ON DELETE CASCADE`：量測被刪除時，已經沒有用途的收據列（`status='sent'`，或根本沒建立過）一併刪除；一律不允許刪除（原 RESTRICT）曾經是唯一安全但過度保守的作法，現在改成「已解決的收據可以一起清掉，還在處理中的收據擋下刪除」。

但 CASCADE 不分青紅皂白：如果照護者剛好在 `reserve_blood_pressure_notification_delivery`（寫入 `status='pending'`）與 `confirm_blood_pressure_notification_delivery`（改成 `sent`）之間的極短時間窗刪除同一筆量測，CASCADE 會連帶刪掉那筆還在處理中的收據，讓 confirm 找不到列而丟例外，整支 Function 在呼叫 `enqueue_blood_pressure_personal_notifications` 之前就中止且不重試——即使 Telegram 那則警示已經送達，個人化通知仍會漏發。`20260925160000` 補上一個 `BEFORE DELETE` trigger：只要該筆量測還有 `status='pending'` 的收據就擋下刪除、丟出「稍後再試」的例外；沒有 pending 收據（未推播過，或已經 `sent`）時放行，交給既有的 CASCADE 清掉收據。這個時間窗通常只有一次 RPC 往返加一次 Telegram API 呼叫（不到幾秒），不需要重新設計 delivery 的狀態機或授權邏輯。

ADR-007 票 1／票 2 之後 `blood_pressure_notification_deliveries` 已是五值狀態機；`20260926161421` 把這個 `BEFORE DELETE` 守門改成「有**新鮮的** `pending` 或 `sending` 收據」——兩者都代表收據可能還在被 Function 使用中，但只擋門檻 M＝10 分鐘內的（以 `COALESCE(attempt_started_at, created_at)` 判斷；舊簽章 `reserve_*` 每次交出 legacy 的 `pending` 列都會蓋上 `attempt_started_at`，所以舊 Function 正在（重）送的列仍被擋）。Function 取單後中止或 `resolve` 失敗會讓列停在 `sending`，舊 confirm 失敗會留下 legacy `pending`，兩者都沒有人會再把它轉成終局，一律擋住就永遠刪不掉那筆量測；超過 M 的 stale 列與已終局（`sent`／`delivery_unknown`／`failed_terminal`）的收據照舊放行 CASCADE。`resolve_*` 另接受 `p_attempts`（這次實際拿到的 provider 回應數；請求內重試可能是 2、缺 secret 未送是 0），`attempt_count` 依它累加而不是固定 +1。

這個順序是刻意的：照護紀錄是單一真相，Telegram 是提醒副本；不能為了通知重試而重複寫入血壓，也不能把通知錯誤靜默成成功。部署修正後仍需在 staging 部署 `blood-pressure-notifier` 與 `personal-notification-drain`（後者才讀 `TELEGRAM_BOT_TOKEN`），並用兩個核心照護帳號驗證各自可寫入的病人紀錄通知；不執行 production 直接部署。

### 沒有家人會收到時要看得見（Fail loudly）

共用 Telegram 群組與它的 SEC-20260908-01 訂閱閘門已於 2026-10-09 退場（issue #1061 階段 D；退場前的六列情況表見 git 歷史）。現在 Function 唯一的送達路徑是 `enqueue_blood_pressure_personal_notifications_v2` → outbox → drain，收件人授權（`care_access`、付費 tier 或免費危險級、綁定）在 RPC 與 drain 各驗一次：

| 情況 | Function log（只有事件名，不含病人 id、數值、email） | HTTP 回應 | 輸入頁 |
| --- | --- | --- | --- |
| 有排入個人化通知（付費家屬，以及危險等級時所有綁 Telegram 的 `care_access` 成員） | — | 200 `{ ok: true, sharedTelegram: 'not_subscribed', personalQueued: true, personalUnknown, personalDelivered }` | 無提示 |
| 沒有任何個人化通知（沒有人綁定，或非危險級且沒有付費家屬） | — | 200 `{ ok: true, sharedTelegram: 'not_subscribed', personalQueued: false, personalUnknown: false, personalDelivered: false }` | **只有警示級讀數**才顯示三語說明：這筆不會自動通知家人，危險值請直接聯絡家人（`role="status"`）；正常讀數不提示 |
| 個人那一則可能已送達、不會重送（`personalUnknown`） | — | 200，`personalUnknown: true` | 「無法確認個人通知是否送達，請直接聯絡家人」 |
| 個人化 enqueue 失敗 | `blood_pressure_notifier_enqueue_failed` | 502 | 既有的「通知失敗，請截圖回報」警示（不能講成「沒設定」，因為不知道原本該不該有） |
| 請求沒帶 header `X-Delivery-Contract: 2`（部署窗口內仍在跑舊版快取 PWA 的看護）且 `personalUnknown` | `blood_pressure_notifier_legacy_contract_rejected` | 502 `{ error, sharedTelegram, personalQueued }` | 舊 adapter 只認「非 2xx＝通知失敗」，對它回 200 等於不警告；outbox 已照常處理，只有回應退回舊契約（寧可多提醒；不能要求看護先更新 PWA，AGENTS.md § 3.7） |

`personalQueued`／`personalUnknown`／`personalDelivered` 來自 `enqueue_blood_pressure_personal_notifications_v2` 回傳的 `(queued_count, unknown_count, delivered_count)`（migration `20261005145950`，回傳語意沿用 `20260927004500`）：分別是這筆紀錄目前 `pending`／`sending`、`delivery_unknown`、`sent` 的 outbox 列數（已存在＋這次新插入）；同一筆紀錄重播或並行的第二個呼叫不會再拿到 0。畫面優先序：不明 > 在路上 > 已送達；`failed_terminal` 的列兩邊都不算。「警示級」由 `InputPage.utils.ts` 的 `isFamilyAlertLevelReading()` 判定（北極星鐵律 3：警報分級、寧缺勿濫）：danger／danger-low／warning-low 與 warning 會提示，但 warning 裡的「偏高觀察」（九級表寫明「記錄即可，無須警報」）不提示，除非同時心跳 >120；normal、off-target、below-target（建議是記錄、回診時回報）也不提示。多數病人沒有任何家屬通知，若每筆都提示，看護很快就會忽略，真正危險的那筆反而沒人看。線上送出用 `evaluateNow`，離線補送用該筆 `measured_at` 當下生效的標準（`evaluateAt`）。前端 `parseTelegramNotificationResult` 對認不得的回應（例如部署窗口內舊版 Function 的 `{ ok: true }`）一律視為未略過，避免對每一筆跳出錯誤提示。回歸測試：`tests/unit/bloodPressureNotifier.test.ts`、`tests/unit/telegramNotification.test.ts`。

### 通知與畫面同源判讀（issue #899）

通知的「狀態」與畫面**逐字相同**，而且用的是該病人**量測當下**生效的判讀標準。在這之前 Function 有自己一套門檻（130/80 起算 warning、≥180 沒有獨立的「立即複測」等級、心跳 >120 會把危險低血壓降成 warning），已經和九級表漂移；病人級標準上線後差距只會更大——家屬在 Telegram 讀到「✅ 正常」、打開 app 卻是「超出目標」。

- **同一份資料、對齊的兩份引擎**：Function 不能直接 import 前端引擎（JSON module 與前端相依過不了 Deno bundler），所以 `scripts/sync-bp-rules-to-edge.ts` 把 `src/config` 的九級表、等級詞彙與各模板階梯逐字寫成 `supabase/functions/_shared/bpRuleData.ts`，`_shared/bpEvaluation.ts` 是與 `evaluateReading()`／`resolveStandardAt()` 對齊的 Deno 版引擎。**改完 `src/config` 的血壓規則必須跑一次產生器**；改任一邊的判讀程式必須兩邊一起改。
- **漂移守門**：`tests/unit/bpRuleParity.test.ts` 同時讀兩邊——資料逐欄相等，且對每個模板與多組自訂目標帶掃過所有整數讀數（收縮 60–200 × 舒張 30–130 × 有無心跳警示）比對等級與三語標籤，外加生效區間解析與 R5 來源標示。任何一邊單獨改動都會紅燈。
- **讀標準的授權邊界**：`blood-pressure-notifier` 以 caller-scoped client 讀 `patient_bp_standards`，**不得**為此改用 service role；`personal-notification-drain` 本來就持有 service role，用同一個欄位清單讀取。兩者的 select 清單（`BP_STANDARD_INTERVAL_COLUMNS`）刻意不含醫囑備註 `prescribed_note`，由測試鎖住。
- **R5**：訊息多一行「📐 判讀標準」，印出標準名稱與收縮壓目標帶（例如「術後嚴格控制 110–120 mmHg」）；未設定個別標準時印「一般成人（未設定個別標準）」。
- **讀不到標準時照樣送出**：查詢失敗或資料形狀不對時，暫以一般成人標準判讀，但「判讀標準」那一行明說「無法讀取個別判讀標準」。一般成人九級表刻意不套 hard floor（R3），例如 140/45 會先命中「偏高」，而雙軸模板會判成 danger-low；因此讀不到標準時 `evaluateNotificationReading` 會另外套上 hard floor（≥180/120、<90/50）並取較嚴重的等級，危險讀數不會因查詢故障而漏報。為了一張設定表讀不到就吞掉整則健康通知，才是 Fail loudly 要擋的事。
- **全域群組訊息的版面**：只有改寫／新增的「狀態」與「判讀標準」兩行補上英文（`zh / id / en`），其餘行維持既有中文＋印尼文格式。
- **讀得到紀錄就讀得到標準**：`patient_bp_standards` 的 SELECT policy 與 `blood_pressure_records` 的讀取 policy 用同一個述詞（`care_access.user_id = auth.uid()`，見 migration `20260915100000`），所以不會出現「讀得到這筆血壓、卻因權限讀不到標準而被靜默當成未設定」的情況——未綁定 `user_id` 的記錄者在 `record_lookup` 就已經 404。日後若放寬其中一邊的 policy，這個等價就不再成立，必須一起檢查。

## 記錄與回顧的分工

每個照護模組都自己內含「今天輸入」與「近期趨勢」，趨勢不再集中在另一個底部分頁。這是刻意的：量完血壓最自然的下一個動作就是跟前幾天比一下，若必須切換底部分頁才看得到，日常動線每天都要被打斷一次。更關鍵的是，原本的切法只做了一半——血壓與體溫有趨勢，體重、飲食與服藥完全沒有，使用者學到的「想看趨勢就去那一頁」有三次會落空。

五個模組共用 `ModuleTrendSection` 外框（期間選項、展開記憶、延遲載入邊界），避免各自長出五種版本。趨勢區塊預設收合並記住狀態：照護分頁的首要工作是記錄，預設展開會把輸入表單推到摺線以下，也會讓較重的圖表套件進入每次開 App 的載入路徑。因此每個趨勢面板都是自己的 lazy chunk，recharts 只在照護者第一次展開時下載。

期間選擇與展開狀態由 `src/lib/preferences/trendPreference.ts` 統一保存，各模組與封存對象的唯讀歷史頁共用同一份；依〈生理數值對象綁定不變量〉，圖表期間與版面展開狀態屬純帳號層偏好，不需要 patient-scoped 分區。

## 血壓報告（原獨立的報告底部分頁）

已無獨立的「報告」底部分頁。血壓與體溫的趨勢圖原本同時存在於各自模組的「近期趨勢」與這個報告頁，是純粹的重複顯示；統計卡片、逐筆報告與 CSV／GPT 匯出則是報告頁裡真正沒有重複的部分。因此改為：血壓與體溫的趨勢圖只留在各自模組；統計卡片、逐筆報告與匯出併入血壓模組的「近期趨勢」，因為這些內容本來就是血壓資料的延伸，不需要另外佔一個底部分頁才看得到。

`BloodPressureReportPanel`（`src/features/vitals/components/BloodPressureReportPanel.tsx`）是這些內容現在的共同落點，接受明確的 `patientId`，不再依賴全域的目前操作對象狀態；它以 patient 篩選趨勢、平均、偏高／偏低與時段分布，並用結構化 record report 供醫師／家屬閱讀，顯示測量時間與規則狀態，不把資料庫寫入時間冒充量測時間。目前報告與 CSV 的資料範圍仍是血壓；體重、飲食與服藥次數已可在各自模組查閱，尚未併入匯出檔。

結構化報告卡片同時以 `readMedicationDay(patientId, 今天照護日)` 讀出「目前藥單」（依時段分組、`as_needed` 藥品另列「需要時服用」），與統計卡片、極值和列印／存 PDF 共用同一份 `.record-report`，讓照護者就診前不必切到服藥分頁再截圖。這裡刻意讀當日有效藥單，不是 `readMedicationHistory` 的變更紀錄——變更紀錄回答「藥單什麼時候改過」，看診當下要看的是「現在正在吃什麼」，兩者語意不同不能互換。藥單清單只在畫面上顯示，不寫進 CSV／GPT 匯出，避免既有的匯出格式（每列固定血壓欄位）被迫塞進和血壓無關的欄位。

輸出按鈕（複製摘要、下載 CSV、列印／存 PDF）由 `ReportExportActions`（`src/features/vitals/components/ReportExportActions.tsx`）放在面板最上方、趨勢圖之前，不再藏在結構化報告卡片裡：紀錄一多，原本要捲過趨勢圖、統計卡與整段「每日紀錄」才按得到「複製摘要」。按鈕圖示改為與文字同列的線條 SVG（舊的 ✦ ↓ ▧ 字元在部分平台會變豆腐字），「複製摘要」是唯一實心主按鈕。

面板展開時用的是自己那一份 `useBpRecords`，不會跟輸入表單或「本照護日新增的量測紀錄」自動同步；`InputPage` 因此把表單的 `dailyRecordsVersion` 加上清單修改／刪除次數，當成 `refreshVersion` 傳進 `BloodPressureReportPanel`，任何一邊寫入後「每日紀錄」都會重抓，剛量的那一筆不必重新整理頁面就會出現。

「每日紀錄」逐筆列在 375px 手機上只有約 245px 可用：時間 2.75rem、血壓 4.5rem（容納 180/110）、心跳 `minmax(2rem, max-content)`、其餘給狀態標籤。手機版隱藏心跳的「bpm」單位（♥ 與紫色已標明，讀屏器仍念「心跳」），sm 以上與列印照常顯示；心跳欄不用固定寬，是因為三位數心跳（≥100）正是要看清楚的異常值，固定寬會壓到狀態標籤。

列印報告底部共用 `src/components/system/PrintSourceFooter.tsx`，顯示家健錄名稱、正式公開首頁與繁中／印尼文／英文的「家庭自記錄，非醫療診斷文件」免責文字。QR 由 `src/lib/qrCode.ts` 以 inline SVG 矩陣產生，payload 固定為 `APP_CANONICAL_URL`，不把 `patientId`、姓名、token 或目前頁面 query 帶進紙本；這個固定邊界也讓 staging 預覽不會把 staging host 印成對外來源。

原本的四顆快速跳轉錨點已在拆掉報告頁前就先移除：手機頁面需要目錄本身就是頁面過長的症狀，而且載入中與錯誤狀態下目標區塊尚未 render，按下去沒有反應。

已封存對象的完整血壓與體溫歷史改由設定頁的「查看生命歷史」進入 `ArchivedPatientHistoryPage`（`src/features/system-admin/pages/ArchivedPatientHistoryPage.tsx`），不掛在底部主導覽，也完全不呼叫 `setActiveSubject`／`onSubjectSelect`——這個頁面直接以已封存對象的 `patientId` 讀取資料，結構上就不會讓已封存對象進入 `activeSubject`，見〈生理數值對象綁定不變量〉與 `src/lib/careSubjectGuard.ts` 的說明。

CSV 匯出按 patient 產生獨立檔，分頁讀取避免 1,000 筆上限；藥品目錄分批讀取，使用 UTF-8 BOM 並防 Excel 公式注入。體重與飲食同樣以 patient UUID 讀寫，不能靠 email 拼檔。

## 體重

體重是病人級照護資料；當天最多保存十二筆，每筆保存 `measured_at`，使用 `patient_weight_measurement_records` 的 `measurement_number` 1–12 表示量測槽位，並以 `patient_id + measured_on + measurement_number` 做唯一鍵。跨日後，資料庫保留每個過去日期 `measured_at` 最新的一筆；當天才允許十二筆，避免歷史高頻量測無限堆積。新槽位使用 INSERT，避免兩台裝置同時填入空槽位時互相覆蓋；舊版 PWA 繼續使用 `weight_records`，由 trigger 同步到新版第 1 槽位。體重輸入與「最近紀錄」在每日照護的同一個體重區段呈現，避免照護者在不同入口間找歷史資料；詳細的每餐熱量與病人專屬食物快取見 [`nutrition.md`](./nutrition.md)。

體重模組另含「近期趨勢」，以每日平均呈現體重變化。取當日平均而非某一次讀值，是因為體重在一天內會因進食與排泄浮動，單看某一次容易把日常波動誤讀成趨勢；沒有量測的日子在圖上留白而不連線，讓「沒量」與「量了沒變」可以分辨。彙整規則在 `src/lib/trendSeries.ts`，回歸測試在 `tests/unit/trendSeries.test.ts`。

體重一律顯示小數點後兩位。資料庫欄位本來就是 `NUMERIC(5, 2)`、寫入前也已收斂到兩位，但畫面（今天的紀錄、最近紀錄、趨勢圖數值）之前只印一位：照護者輸入 58.25、回頭看到 58.3，會以為系統擅自改了他量到的數字。位數、輸入框 step 與格式化都集中在 `src/lib/weight.ts` 的 `WEIGHT_DECIMALS`、`WEIGHT_INPUT_STEP`、`formatWeightKg` 與 `roundWeightKg`，避免哪天只改了顯示或只改了寫入而再度不一致；`formatWeightKg` 也負責把 Supabase 可能回傳的字串型 NUMERIC 轉成數字，並讓壞資料顯示破折號而不是 NaN。回歸測試在 `tests/unit/weight.test.ts`。

`measurement_number` 是資料庫唯一鍵需要的內部欄位，不再出現在畫面上。照護者只會遇到兩種狀態：記錄新的一筆（欄位留白，寫入當日第一個空槽），或點今天清單裡的某一筆進行修改（沿用該筆槽位）。修改中的那一筆以量測時間標示——照護者記得的是「早上量的那次」，不是「第 3 次」。

原本要求先從十二顆按鈕選「第幾次」才能輸入。體重不像血壓的早中晚有臨床意義，「第 7 次」對照護者沒有語意，等於要求使用者幫系統管理一個對他無意義的編號；要修正今天量過的某一筆，還得先展開「更改量測次數」再從十二顆按鈕裡找出正確的那一顆。今天的紀錄現在直接列出並可點選修改，與血壓、體溫的當日清單是同一種操作方式。底層的 INSERT／UPDATE、台北日期與病人級唯一鍵都沒有改變。

體重入口只由 `patient_daily_care_preferences.show_weight` 控制，以目前被照護者的 `patient_id` 為唯一鍵；設定頁開啟後，體重只在每日照護的頁內區段顯示，不再新增底部主導覽 tab，避免同一筆健康資料在兩個入口分流。這個偏好按病人共用，不會因不同照護者登入而分歧。原本另有一層獨立的「體重功能」病人級開關（`weight_settings` 表），只是在這個顯示偏好之上多包一層永遠同步的鎖、沒有額外效果，因此已移除該開關的 UI 與 App 層狀態；`weight_settings` 資料表仍保留給舊版快取 PWA 用戶端的相容路徑，不再由目前 UI 讀寫。替代方案「只在前端對主要家屬（owner）帳號硬編碼」無法隨照護對象與授權同步，因此不採用。

## 體溫

體溫與血壓同屬每日照護的生命徵象，入口和服藥並列在每日照護頁，不新增底部導覽。每筆體溫以 `patient_id`、`recorded_by`、`measured_at` 與 `created_at` 保存，另記錄測量部位（耳、額、口、腋）、量測情境與 240 字內備註；測量部位不能省略，因為不同部位的讀值不能直接混為一談。

資料庫 trigger 以伺服器 `created_at` 為每日計數基準，依病人每天最多 24 筆，並以病人 UUID advisory lock 防止同時寫入超額。這是 bot 防爆上限，不是醫療建議；刪除錯誤紀錄會釋出額度，RLS 仍只允許 `care_access.can_record` 的照護者讀寫。

因為是防爆上限而不是照護目標，額度計數平常不顯示，只有剩下 `TEMPERATURE_QUOTA_WARNING_MARGIN` 筆以內才出現。一般照護一天量兩三次永遠碰不到 24 筆，把分母做成常駐的顯眼徽章等於每天提醒使用者一件不需要在意的事，還會製造「是不是快用完了」的焦慮。

體溫紀錄保留 24 天。正式 Supabase 若已啟用 `pg_cron`，每日台北凌晨會執行清理函式；沒有排程模組的本機／預覽環境，下一次新增體溫時會順手清掉逾期資料。選 24 天是保留一個發燒週期與就醫前後上下文，不把短期紀錄永久堆積；長期趨勢應由醫師或匯出資料保存，而不是把過期健康資料留在產品資料庫。

體溫趨勢使用獨立圖表與數字狀態文字，不和血壓共用刻度，也不只用顏色判斷。`38°C` 以上只顯示「發燒範圍」提醒，若有呼吸困難、胸痛、發紺、意識改變或高燒持續超過 72 小時，畫面提示儘速就醫；App 不取代醫師診斷。

體溫輸入欄在輸入時只接受小數點後一位；若貼上或鍵入第二位小數，欄位會拒絕該變更並在欄位旁顯示繁中／印尼文提示，避免照護者只看到儲存按鈕停用卻不知道原因。

## 輸入 UX 與圖表

直接數字輸入可用自動跳欄、聚焦全選與未完整數值的溫和雙語提示，讓照護者抄寫血壓計時少按、少滑、少出錯；行動裝置的 `inputMode="numeric"` 已能穩定叫出螢幕數字鍵盤，因此輸入方式統一為鍵盤，不再提供滾輪切換。圖表可在服藥 plan 變更時間加註記，但註記是時間線索，不是自動推論藥物造成了血壓變化。

自動跳欄三格共用 `bpAutoAdvance` 的同一條規則：三位數立刻跳（血壓三格上限都是三位數，第三位輸入完必定完整），兩位數且已達該欄位下限則延遲 `BP_AUTO_ADVANCE_DELAY_MS` 再跳。延遲是必要的——兩位數可能只是三位數打到一半（105 會先經過 10），立刻跳會在打字中途搶走焦點。修正前收縮壓要滿三位數才跳、舒張壓與心跳滿兩位數就跳，導致 98 不跳而 85 跳，外觀相同的三個框行為不同。回歸測試在 `tests/unit/bpAutoAdvance.test.ts`。

延遲跳轉等待期間，輸入框會顯示淡藍色 pulse 提示（`PickerCard` 的 `pendingAdvance`），讓照護者知道系統即將自動跳走，不必搶著手動點下一格；一旦任何欄位被手動聚焦（點擊或 Tab），就會立刻取消尚未觸發的延遲跳轉，避免自動 `focus()` 與手動 focus 互搶焦點造成卡頓。

當 `visualViewport` 因軟鍵盤縮小超過 150px，App 進入暫時性的 compact input mode：隱藏每日照護頁首、最新量測、輸入方式切換、下方紀錄與底部導覽，只保留三個輸入欄與儲存按鈕。欄位聚焦後延遲 250ms 執行 `scrollIntoView`，等待 iOS 鍵盤 resize 完成，避免立即捲動造成跳動；儲存成功後 blur 目前焦點，讓鍵盤與導覽恢復自然狀態。沒有 `visualViewport` 的瀏覽器維持原本版面，不改動桌面配置。

Dashboard 的今日照護摘要與最新讀值要把 `measured_at`、狀態規則和目前 patient 一起呈現；不要顯示 Supabase、migration 或資料庫名稱作為照護者主要訊息。合規頁、CSV 匯出、帳號刪除與條款／隱私入口屬系統管理，但都要保留在可追溯的公開或設定流程中。

## 語音輸入文字草稿（issue #800）

血壓輸入的選用「語音輸入（文字草稿）」使用瀏覽器 `SpeechRecognition`／`webkitSpeechRecognition`，依目前 UI 語系預選 `id-ID`／`zh-TW`／`en-US`，並可獨立選口述語言。按下「同意並開始口述」才要求收音；開始前明示瀏覽器可能將音訊傳至其辨識服務，提醒不要口述姓名等個資。不宣稱本機／離線辨識，也不由本產品保存音訊、辨識原文或記錄錯誤內容。

只把 final 原文追加至可編輯文字欄位，保留先前手動內容。使用者核對後手動填入收縮壓、舒張壓及心跳，最後沿用原本儲存按鈕、驗證、RLS 與通知。**草稿不是量測紀錄，也不會隨血壓儲存。** 不採用「把 130 80 自動拆成數值」或直接寫入：口音、數字與單位辨識仍可能錯誤，結構化解析屬後續迭代，不在 MVP。

草稿僅存於以 `patient_id`／UI 語系為 key 的元件記憶體；切換病人或 UI 語言、離開血壓面板或開始送出時卸載清空。取消、收起區塊、背景化、手動編輯或改口述語言會取消未完成的收音，保留同一病人的已完成文字；已排程的舊 callback 必須失效。結束口述使用 `stop()` 允許服務回 final；取消與卸載使用 `abort()` 捨棄未完成結果。最長 30 秒 watchdog 避免服務／權限提示沒有回應而無限等待。

不支援、非安全來源、拒絕權限、無聲音、網路或裝置錯誤都顯示三語退路，不鎖定量測欄位或儲存按鈕；不顯示 provider 原始錯誤。語音 API 支援及辨識準確度因瀏覽器與裝置而異，原生 WebView 不保證支援；不新增原生麥克風權限或 SDK。回滾只需移除語音元件入口，沒有 migration、RLS、離線佇列或判讀規則變動。

驗證：`tests/unit/voiceInput.test.ts` 用假辨識器涵蓋 final／interim、追加、取消、手動修正、權限／網路失敗、超時、背景化與卸載；Playwright CLI 在匿名 Demo 驗證三語、手機尺寸、手動儲存、切換病人與面板的延遲結果隔離。不用真人資料或真的啟動麥克風；真機印尼文／中文辨識準確度仍須在 preview／staging 驗收。API 行為依 [MDN SpeechRecognition](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition)、[stop](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/stop)、[abort](https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/abort)。
