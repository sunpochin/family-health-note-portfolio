<!--
檔案用途：說明 household、patient、家庭成員、照護對象與寵物的現行邊界。
所在層：docs/features；供 onboarding、subject switcher 與 family management 修改使用。
主要關聯：src/features/care-family、src/lib/tenant.ts、care_access RLS 與 data-model。
-->

# 家庭與照護對象 / Household and Patients

## 公開多租戶模型

首次登入由 transaction RPC 建立 profile、household、owner membership 與第一位 patient。前端不可自己順序寫多張表，因為中途斷線會留下沒有 owner 或 patient 的半套家庭；重複 OAuth callback 應回傳既有 household。

`household_members` 表示家庭中的人與角色；`patients` 表示被照護的人或寵物。所有健康資料仍以 patient UUID 關聯，不能以 household membership 直接代替 patient access。

## 選擇器

一至三位對象使用 44px 分段控制；更多對象改用同高度下拉選單，避免姓名被壓縮與誤選。去重使用 patient UUID；同名對象以封存標記或短 ID 區分。切換只改目前工作對象，不擴大資料庫權限。

所有切換入口都使用同一個 `SubjectSwitcher`，包含設定頁的「目前操作對象」。設定頁原本另做一套只在該頁出現的 radio 卡片，等於同一件事有兩種外觀與兩種互動方式，照護者難以建立「要換人就去哪裡」的穩定習慣；共用元件也是〈介面元件化規範〉的要求。

封存會讓對象離開日常選單與寫入流程，但保留唯讀歷史；不提供會永久抹除照護資料的快捷刪除。

「離開寫入流程」由兩層守住。第一層是結構性的：家屬要讀已封存對象的生命歷史時，走設定頁「查看生命歷史」進入 `ArchivedPatientHistoryPage`（`src/features/system-admin/pages/ArchivedPatientHistoryPage.tsx`），這個頁面直接以明確的 `patientId` 讀取資料，完全不呼叫 `setActiveSubject`／`onSubjectSelect`，因此已封存對象從來不會進入全域的目前操作對象狀態——這比事後攔截更徹底，直接排除了「已封存對象變成可寫入路徑會讀到的對象」這個問題類別。第二層是防禦性的：`src/lib/careSubjectGuard.ts` 的 `resolveWritableSubject` 在每次切換底部分頁時仍會檢查目前對象是否可寫入，萬一未來有人不小心用含封存對象的清單接上某個 `SubjectSwitcher`，這裡仍會攔下並自動換回可寫入對象、在畫面上說明原因；正常操作下這層不會真的觸發。第三層是 `SubjectSwitcher` 找不到目前 patient UUID 時明確擋下並要求重新選擇，不會靜默顯示清單第一位。回歸測試在 `tests/unit/careSubjectGuard.test.ts`。

病人本人帳號是 patient-scoped 的例外：只能看到 `profiles.patient_id` 指向自己的資料，不能因同屬 household 而看到家中的狗或其他寵物。移除錯誤 access 只撤銷授權，不刪除寵物 patient 或其歷史；資料庫 migration 與前端選擇器都會守住這個邊界。

## 家庭成員授權

### 家庭照護對象名額（#1178，H3）

> 此段描述 #1178 分支的實作；合併與 staging 驗收前不視為已部署契約。先前的邀請名額缺口與 2026-10-15 owner 決策見 [`security-review-handoff.md`](../operations/security-review-handoff.md)。

免費家庭最多 2 位、有效 Premium 最多 5 位，人與寵物合計，已封存不計。`patients` 的 `enforce_household_care_recipient_limit` 在 INSERT、解除封存或搬入家庭時，以家庭 advisory transaction lock 先鎖再數；七支既有新增 RPC 不各自加判斷。已滿時回固定 `P0001 / household_care_recipient_limit`。只改姓名、繼續照護與降級都不會觸發名額阻擋；降級不封存、不隱藏、不收回既有 `care_access`，超過免費名額的既有對象仍可寫入健康紀錄。

`household_care_recipient_limit_internal` 在 H3 補上，只有資料庫內部可執行、不查登入身分；公開 `household_care_recipient_limit` 保留 membership 檢查後轉呼叫它。這使沒有登入身分的 seed 也能正確使用合成家庭的 Premium；seed 在插入三位病人之前建立招待 entitlement，`care_recipient_limit` 由 GENERATED 欄位產生，不另設 bypass。

人類邀請在接受前已預建一筆 patient，因此待接受邀請占名額。owner 決定撤銷、拒絕、到期或刪除尚未接受的邀請後自動封存預建對象以釋出名額；邀請狀態 trigger 只處理原本 pending 的列，DELETE trigger 也處理舊版已撤銷／拒絕的列，避免刪帳流程先移除邀請後失去釋出線索。封存前要求該 patient 沒有 pending／accepted 邀請、本人 profile 或 `care_access`。名額查詢和新增 trigger 在同一家庭 advisory transaction lock 下先結案過期邀請，也補封存舊的已失效邀請列，避免時間到了卻因沒打開邀請清單而永遠卡額滿。已接受或已建立照護權限的病人不會被這條整理規則封存。拒絕以「只在畫面扣除到期邀請數」作為替代方案，因為資料庫仍會把未封存 patient 算進上限；也不在每一支新增 RPC 複製清理邏輯，避免漏掉入口。

目前仍使用的新增入口在 `CareRecipientManagement`：寵物新增與本人邀請。兩者送出前重讀 `fetch_household_care_recipient_capacity`，分別沿用最早 membership 與最早 owner membership，不能以目前選取病人推測寫入家庭。該 RPC 只回傳人數與上限，先清理已失效邀請，不回傳尚未授權病人的身分。額滿提示有 zh／id／en；免費 web 提示可升級至 5 位，原生殼與已滿五位的家庭維持中性說明、不放購買連結。邀請 Function 只轉傳固定額滿碼，其他資料庫錯誤仍遮蔽。

舊 `TenantApp` onboarding 新增頁已於 #1169 移除，`beginHouseholdOnboarding` 只剩測試呼叫；H3 不復活它，也不對只設定每日照護模組的 `OnboardingWizard` 加上新增限制。保留的 onboarding RPC 仍受同一個 trigger 保護。

驗證：`supabase/tests/household-care-recipient-limit.sql` 覆蓋兩個新增 RPC、封存釋出名額、解除封存、Premium 硬上限、降級後三位仍可經 RLS 寫血壓、無關帳號隔離，及撤銷／拒絕／到期／刪除邀請後釋出名額而已接受者保持活躍；`bun run db:replay` 也執行原有核心照護權限測試。部署前應核對需新增對象的家庭已透過 H6 runtime flow 開通正確方案；不在 migration 補登真人。回滾應先以新 migration 撤下名額 trigger／提示 RPC 的使用，保留 entitlement 與所有病人資料，不刪除超額對象。

新增、替換或移除 member 必須由 RLS／RPC 檢查管理者與目標 household。UI 的角色預覽或模擬列只能用於測試與顯示，不能用可猜測 role string 取代 `care_access.patient_id`。修改授權後需驗證核心帳號仍能讀寫被照護者資料。

目前沒有任何畫面能直接以 email 新增家庭成員，或對已加入者事後逐人調整「可記錄」「可調整藥單」。舊的「家庭成員與照護授權」畫面（`HouseholdMemberManagement`）自 2026-07-30 起沒有掛載點，已於 #1173 連同前端 helper 移除；`add_household_member`、`remove_household_member`、`set_household_patient_access`、`fetch_household_members`、`fetch_household_patient_access` 這幾支 RPC 仍在資料庫，前端沒有呼叫端。家人加入走下面的 `caregiver_invitations` 流程（owner 確認後才寫入 `care_access`），收回用「撤銷此病人權限」；若日後要提供事後調整能力位，應加在邀請列表上，不要復活直接加人的入口。

新增人類被照顧者不等於立即取得健康資料權限。Owner 只能建立待接受邀請，邀請包含被照顧者的 Google Email 與授權依據；被照顧者以該 Google 帳號登入後，畫面會顯示資料庫由 Auth 帳號解析的邀請者 email，明確接受後才建立被照顧者與邀請照顧者的 `care_access`。多封邀請要逐封處理，載入失敗不能視為空清單或觸發私人 patient 自動建立。邀請前不寫入任何病人 access，直接傳入 patient UUID 或 email 不能繞過 RPC。

本人邀請可由 owner 在建立後用中性分享連結傳遞；連結只保存伺服器產生 token 的 hash，登入後仍必須符合受邀 Google Email，並回到原本的邀請確認流程。Owner 可從邀請清單撤銷尚未接受的邀請；撤銷不刪除 patient，也不會直接寫入或移除健康資料權限。

邀請兄弟姐妹或其他家人一起照護則走另一條 `caregiver_invitations` 流程：Owner 先選一位已授權且未封存的 patient，分開指定「查看／記錄」與藥單管理能力；伺服器產生七日 token，只保存 hash。受邀者用 Google 登入後只能提出加入申請，Owner 在看到 Auth 驗證的 email 後才確認並寫入指定 patient 的 `care_access`。這條確認路徑不更新受邀者的 `profiles.patient_id`；若是剛註冊帳號，只建立自己的 personal patient 來滿足既有外鍵，因此不會把兄弟姐妹自己的 patient 搬進受邀家庭。pending 邀請撤銷與已加入者的 patient access 撤銷是兩個不同 RPC；已有較高 grant 也不會因新邀請被降低。

若既有帳號是在家庭搬遷完成後才首次建立 Auth 身分，修復 migration 會沿著該帳號已有的完整 `care_access` 找回 household membership；它只處理既定核心帳號，且不覆蓋現有角色。這是補齊帳號生命週期的資料缺口，不是把 household membership 當成病人資料授權的替代品。

`create_household_patient_invitation` RPC 的 `RAISE EXCEPTION` 訊息是純英文，PostgREST 會原樣轉傳給前端。`CareRecipientManagement.tsx` 的 `describeInviteError` 用子字串比對這些英文訊息（例如 `already has a patient identity`、`Only a household owner`），對照已知情境顯示雙語說明；不在列表裡的錯誤才顯示通用重試文字。這是 UI 與資料庫錯誤文字之間刻意但脆弱的耦合——修改 RPC 裡對應的 `RAISE EXCEPTION` 文字時，必須同步檢查並更新 `describeInviteError` 的比對字串，否則畫面會悄悄退回不具體的通用訊息。

## 寵物

人與寵物共用健康紀錄、藥品目錄與照護時間線，但 Dashboard 摘要卡對寵物優先顯示體重、服藥與事件，並把血壓引導至診所，不假裝每種指標都適合所有物種。藥品可標註 `applicable_species` 與 `contraindicated_species`；禁忌警示不能只靠顏色。

慢性病寵物（如糖尿病貓犬、腎病貓）另有每日照護專屬模組，供飼主在家記錄診所也會問的日常觀察：液體攝取／排尿（依物種提供）、消化（排便與嘔吐）、食慾、皮下點滴與胰島素／血糖。這些不進 Dashboard 摘要卡，只在照護對象為寵物時出現在每日照護分頁；鳥類的自動範本不顯示含貓砂盆尿塊欄位的液體管理模組。資料表見 [`docs/architecture/data-model.md`](../architecture/data-model.md)。

每個寵物慢性病模組在今天的輸入與清單下方提供可收合的「近期趨勢」，期間沿用共用的 7／14／28／42 天選擇。趨勢查詢固定帶上目前 `patient_id`；一天一筆的液體／消化紀錄直接按日期呈現，多筆的食慾、點滴、胰島素與血糖則分別以每日平均或總量呈現。沒有紀錄的日子留白，不會被當成 0；圖表下方另提供可讀的日期／數值表格，讓趨勢不只依賴顏色或滑鼠提示。

設定頁的新增寵物選單固定提供四個選項：貓、狗、鳥、其他；貓小乖使用 `MengniCatMark`、狗猛膩使用 `MengniDogMark`、鳥 Pickle 使用 `PickleBirdMark`。這刻意不使用 emoji，避免不同裝置字型造成圖案與尺寸不一致；既有兔子 patient 仍保留讀取與歷史呈現相容性，但不再出現在新增選單。鳥以獨立的 `bird` patient 類型保存，不把它塞進 `other`，讓授權 RPC 與物種照護規則能保持可追蹤。

## 不採用的替代

- 不以一個 `subject` 字串取代 UUID，因為跨家庭與同名會混淆。
- 不把每個家庭成員的 email 塞進資料表作病人身分，因為照顧者可能代填多人。
- 不在建立人類 patient 的同一個 RPC 立即授權建立者，因為建立資料與取得健康資料權限必須分成「邀請」和「接受」兩個事件。
- 不分拆人類／寵物 app，避免授權與交接重複。
