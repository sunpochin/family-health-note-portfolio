<!--
檔案用途：整理健康、服藥、家庭與目錄資料的 canonical 身分與關聯。
所在層：docs/architecture；供 migration、RPC、資料查詢與匯出修改使用。
主要關聯：supabase/migrations、src/lib/database.types.ts、medications 與 patient access 文件。
-->

# 資料模型 / Data Model

## Canonical 身分

公開多租戶模型以 UUID 為核心：`app_profiles`／`profiles` 表示登入帳號，`households` 表示家庭，`patients` 表示照護對象，`household_members` 表示家庭成員關係。健康資料的 `patient_id` 是唯一可靠的照護對象邊界；舊的 subject 字串（`nenek`、`saya` 等）僅作相容或顯示用途，不能再用來推測跨家庭權限。

血壓紀錄至少要能分辨：

- `patient_id`：被量測者；`NOT NULL`（issue #1052，migration `20261005135311`）。沒有對象的血壓不只違反 § 3.5，被改或被刪時 `record_change_logs` 的兩個分區鍵也都是 NULL——沒人讀得到、隔天還會被 purge 當孤兒清掉，等於沒稽核。前端型別 `BpRecord.patient_id` 仍保留可空，是給缺欄位的舊離線快取用，不代表資料庫允許。
- `recorded_by_user_id`／`recorded_by`：實際操作人。
- `measured_at`：實際量測時間，依台北時區顯示。
- `created_at`：伺服器寫入時間，不代表量測時間。

服藥、照護事件、匯出與 Dashboard 查詢都沿用 `patient_id`，避免一個頁面使用 subject、另一個頁面使用 email 而混資料。

**前端寫入契約（操作人欄位）**：多張病人級紀錄表的操作人欄位（`recorded_by`／`created_by`）是 `NOT NULL`、沒有預設值，INSERT policy 又要求它等於
`auth.jwt()->>'email'`（兩邊 `LOWER`）。所以前端**新增時必須自己送登入者 email**（存小寫），資料庫不會補；**編輯時不得送**——這些欄位建立後由審計觸發器鎖住不可改，
非原登錄者的編輯本來就會被 UPDATE policy 的 `WITH CHECK` 以 `42501` 擋下，送出只會把錯誤換成觸發器的 `P0001`。新增寫入路徑時要有一個測試直接斷言 insert payload
含這個欄位：SQL 層的 RLS 測試與自帶欄位的 fixture 都攔不到漏送（`patient_lab_results` 曾因漏送，從上線起畫面無法新增，issue #1034，由 PR #1041 修復；見 `tests/unit/labResultsWrite.test.ts`）。

所有代表身體狀態的數值，以及會改變健康判讀的病人專屬目標、基準與警示門檻，都屬於 patient-scoped 資料。畫面查詢、表單草稿、離線快取、圖表、報告與通知必須攜帶或分區保存 `patient_id`；「自己」也要先解析成 patient，不能直接把登入帳號 UUID 當成被量測者。這個區分讓同一位照護者切換多人時不會看到、送出或覆寫上一位病人的數值。

## 帳號設定與照護資料分離

`user_settings` 是登入帳號層的輕量設定表，目前保存 `medication_slots_expanded`、`created_at` 與 `updated_at`。主鍵直接參照 `auth.users.id`，所以同一帳號在不同裝置登入時可以讀到相同的閱讀偏好；這筆資料不含 `patient_id`，也不會改變藥單、服藥紀錄或照護授權。

`patient_daily_care_preferences` 是畫面顯示的病人分區設定，主鍵為 `patient_id`，保存血壓、體溫、服藥、飲食、體重、5 個寵物慢性病模組與失智照護模組共十一個 boolean，再加一個 `use_custom_template` 開關，讓同一位被照顧者的授權照護者看到一致入口。它不是健康事實，也不取代 `care_access`；RLS 仍要求登入者對目標病人的明確照護授權。沒有 row 時前端以其餘十項全部開啟相容既有使用者，唯獨 `show_dementia_care` 預設 `FALSE`（見下方 `dementia_care_records`），並以 CHECK 保證至少留下一個照護入口。`use_custom_template` 預設 `FALSE`：關閉時 `visibleDailyCareModules()` 依病人物種（`patients.care_recipient_type`）自動篩掉不適用的模組（例如貓狗不會看到血壓）；開啟後跳過物種篩選，改由這十一個 boolean 各自決定。舊 `user_patient_care_preferences` 保留作歷史相容資料。

`account_usage_limits.photo_retention_tier`（`standard`／`vip`）在 H5 #1181 後只作首次貼圖 trigger 與一次性回填的 legacy 相容來源，清理 Function 不再讀它；H7 才移除。照片的天數與起點固定在 `care_timeline_entries.photo_retention_days`／`photo_retention_started_at`，瀏覽器送來的值會被 trigger 覆寫。它不取代 `patient_id` 授權，也不重用 `plan_code`；每日寫入配額仍由 `*_daily_limit` 與 trigger fallback 決定（血壓與照護大事記預設 9／9，issue #1058、[ADR-011](../adr/011-paywall-safety-boundary.md)）。

**Household 級付費狀態（issue #1176，H1；[ADR-012](../adr/012-household-entitlement-and-subscription-lifecycle.md) D1／D2）**：付費單位是 `households.id`，一律由 `patient_id → patients.household_id` 解析，不由呼叫者 email 解析。遷移進度（expand → dual-read → contract）：AI 藥單草稿（H2 #1177）與照片保存（H5 #1181）已接上家庭 Premium 與 kill switch，H7 前仍 dual-read 各自 legacy tier（掛起時兩者都不算）。照片開關只影響新蓋章，不縮短已保存期限。個人化通知（H4）尚未接上。H7 才 contract；共用 `supabase/functions/_shared/paidFeatureEntitlementPolicy.ts` 的 `HOUSEHOLD_PREMIUM_READER_LIVE` 是管理頁與伺服器的實作狀態來源。

- `household_entitlements`：每家庭最多一列，沒有列＝免費。`premium_tier`（`none`／`premium`）是唯一產品開關；`premium_source`（`subscription`／`complimentary`／`trial`）、`premium_until`（NULL 只給招待）、`premium_source_ref`（訂閱 id，撤銷時 compare-and-set）的組合由表層 CHECK 綁死；`care_recipient_limit` 是依 tier 產生的 generated column（Premium 5、否則 2，另有 CHECK 硬上限 5），任何寫入路徑（含 H3 seed 的直接 INSERT）都不能指定或寫錯它。四個 API role 都 REVOKE，`service_role` 只有 SELECT；寫入只走 `set_household_entitlement`（`service_role` only），同一交易寫 `household_entitlement_change_logs`。
- `household_entitlement_change_logs`：每次呼叫一筆 `premium_tier` 列（含寫入後的來源／有效期／來源 id，所以續約延長也追得到）＋上限變動時一筆 `care_recipient_limit` 列；`source`、`reason` 封閉值域、沒有自由文字欄、沒有外鍵、不存 email；`admin` 必有 `actor_user_id`、`payment_webhook` 必有 `provider_event_id`；UPDATE／DELETE 由 trigger 拒絕。
- `paid_feature_suspensions`：全域 kill switch，有列＝該付費功能（`medication_ai_draft`／`personal_notification_extras`／`photo_retention_180`）對所有家庭暫停並退回免費額度。ADR-012 原寫成 `app_admin_config` 的欄位，但那是 key／value 表，owner 2026-10-06 改定為獨立小表。唯一寫入路徑是 `set_paid_feature_suspension(feature, suspended, actor)`（`service_role` only，issue #1180／H6）：狀態真的改變時在既有的 `app_admin_config_audit_log` 留一列（`key = 'paid_feature_suspensions'`、變更前後的排序 JSON 陣列、操作者 uid），**不寫任何家庭稽核**——這是全域營運動作。
- 後台讀取（H6）：`admin_list_household_entitlements(after_created_at, after_id, limit)` 每家庭一列（名稱、owner email、成員數、使用中／已封存被照顧者數、tier／來源／有效期／此刻是否生效），以 `(created_at, id)` keyset 分頁（offset 分頁在兩頁之間有新增或刪除時會重複或漏列），`admin_list_household_entitlement_changes(household_id, limit)` 回單一家庭的稽核列並帶出操作者 email（上限夾在 1～200）。兩支都只給 `service_role`，只經 `admin-list-households` Function 在比對 `ADMIN_EMAIL` 之後呼叫。家庭 Premium 的寫入沿用 `set_household_entitlement`（`source = 'admin'`），由 `admin-set-household-entitlement` Function 呼叫；家庭有進行中的訂閱時它回 `subscription_in_progress`，Function 轉成 409，管理者明確選「招待並終止訂閱」（請求帶 `cancelSubscription: true`，只接受招待／試用）才改呼叫 `admin_grant_household_entitlement(..., p_cancel_subscription => true)`（#1202）；這條路徑給試用時，到期日不得早於進行中訂閱列的 `current_period_end`（`trial_ends_before_paid_period`，Function 回 422，migration `20261007073000`），否則付款人已付費的天數會隨試用到期消失。
- Helper：`patient_household_premium(patient_id)`（authenticated；沒有 `care_access` 回 false 不 raise）、`patient_household_premium_trusted(patient_id)`（只給 `service_role`，給已自行驗過收件人的 drain 類讀取點）、`household_care_recipient_limit(household_id)`（authenticated；非成員回 2）、`current_household_daily_limit(metric, fallback, patient_id, actor_email DEFAULT NULL)`（只處理 `medication_ai_draft`：Premium 20、免費或暫停時 3；JWT role 是 authenticated／anon 時先過 `care_access`，`service_role` 與沒有 JWT 的資料庫內部 session（pg_cron、migration）走 trusted 判定。#1177 起由 `enforce_daily_medication_ocr_limit` 的 `llm_draft` 分支呼叫，計數與 advisory lock 都以家庭為單位；H7 之前 dual-read：回傳家庭值與 legacy 帳號值（`medication_ai_draft_tier = 'ai'` 時的 `medication_ai_draft_daily_limit`）較大者，legacy 帳號在瀏覽器角色只認 JWT 自己的 email、其他角色採 `actor_email`；kill switch 在兩者之前判定）。「Premium 生效」只在一處定義（內部 `household_premium_effective()`）：`premium_tier = 'premium'` 且 `premium_until` 為 NULL 或還沒到——cron 晚跑時過期的權限也不會繼續生效。authenticated 版 helper 刻意不給 `service_role`（那裡沒有 `auth.uid()`，會默默判成免費），呼叫錯版本會直接 permission denied。兩支 authenticated helper 的授權依據刻意不同：付費與配額問的是「這位病人」，看 `care_access`；被照顧者上限問的是「這個家庭」，看 `household_members`（含 viewer）。所以只有 `care_access`、不是家庭成員的看護會拿到 Premium＝true 但上限 2，這不是漏洞——上限只給家庭成員在新增對象時看。

**訂閱與付款帳本（issue #1182，P1；ADR-012 D6／D8；migration `20261006183520`）**：純狀態機，沒有供應商；`provider` 只有 `newebpay`／`manual`（後者給測試與招待），藍新回呼的解密與比對是 P2。

- `payment_orders`：一次結帳一列，`id` 就是供應商的 `MerchantOrderNo`（英數底線、28 字）。`status`：`pending` → `paid`（首期成功）／`paid_late`（訂單已 `expired`／`superseded` 後才收到首期成功，仍開通並以旗標告警）／`expired`（30 分鐘未付）／`superseded`（同家庭又建了一張）／`rejected`（首期失敗）。只存方案、金額、幣別、條款版本、七日解除權例外的勾選時間、語言、供應商單號；**不存卡號、末四碼、持卡人**。`household_id` 沒有外鍵（帳本依稅法保存、家庭刪了列也要在），`payer_user_id` 是 `ON DELETE SET NULL`。寫入只走 `create_household_premium_order(household, plan_code, terms_version, refund_waiver, locale, replaces_subscription_id)`（authenticated；**沒有金額參數**，金額來自 `premium_plan_offer()` 的常數；呼叫者必須是該家庭目前的 owner，不是就 `not_household_owner`、不回傳家庭是否存在；`terms_version` 必須等於 `current_paid_terms_version()`；`refund_waiver` 必須為 true；同一交易先把該家庭逾時的 `pending` 標 `expired`、仍 `pending` 的舊單標 `superseded`；家庭已有 `active|grace|cancel_requested` 的訂閱時沒有替代 id 就拒絕）。
- `household_subscriptions`：帳務生命週期，一張委託一列、歷史保留，**只在首期扣款成功時由 `apply_payment_event` 建立**（`pending` 不是訂閱狀態、也沒有 `expired`）。`status`：`active`／`grace`／`cancel_requested`／`terminating`／`cancelled`／終局 `downgraded`／`superseded`。兩個 partial UNIQUE：每家庭最多一張 `active|grace|cancel_requested|cancelled`（仍持有權限的四個狀態；`terminating` 與終局不在內，替代列才能與終止中的舊列並存）；每個 `(provider, provider_period_no)` 最多一張非終局列（回呼的正典查找先抓它、沒有才落到最新的終局列）。`cancel_reason`（`payer`／`owner`／`payer_deleted`／`admin_grant`／`refund`）、`cancel_attempts`（終止委託重試，`mark_subscription_terminating` 在 3 次後拒絕再送）、`replaces_subscription_id`（替代關係）、`payer_locale`（提醒信語言）、`status_before_cancel`（取消前是 `active` 還是 `grace`，反悔回到它）、`next_billing_at`（供應商授權日＋一期，與服務期末分開；提醒信只看它，NULL 不寄）、`renewal_reminder_sent_for_billing_at`（提醒冪等欄）。`terminating` 且 `terminate_dispatched_at IS NULL` 的列是回呼產生的孤兒委託（替代訂單已付、或開通 CAS 輸了），等 P2 以委託查詢 API 對帳後補送終止。
- `payment_events`：只增（UPDATE／DELETE 由 trigger 拒絕）的帳本。冪等鍵 `UNIQUE (provider, provider_period_no, already_times, event_kind)`，首期另以 `order_id` UNIQUE；`event_kind`：`first_charge_succeeded`／`period_charge_succeeded`／`period_charge_failed`／`period_charge_after_cancel`／`refund`／`rejected`／`stale`；`flags` 是封閉值域的告警旗標（`late_arrival`、`late_first_charge`、`duplicate_first_charge`、`entitlement_held_by_other_source`、拒收理由）；存 payload 的 SHA-256 而不是 payload。
- 權限：三張表 RLS、四個 API role 都 REVOKE；`payment_events` 只有 `service_role` SELECT（對帳）；`payment_orders`／`household_subscriptions` 對 `authenticated` 只有 SELECT，policy＝`payer_user_id = auth.uid() OR is_household_owner(household_id)`（owner 判斷走既有的 SECURITY DEFINER helper，不在 policy 裡子查詢 `household_members`），`service_role` 也只有 SELECT；寫入一律走 RPC，一個轉移一個交易。
- `apply_payment_event(provider, order_no, period_no, trade_no, already_times, succeeded, amount, auth_at, payload_sha256)`（`service_role`）：先 INSERT 帳本列（`ON CONFLICT DO NOTHING`），沒插到就 `duplicate` no-op；「對到」與「怎麼處理」分兩步——首期以訂單（任何狀態）、後續期以委託編號（含終局）對，只有對不到、金額不符、`AlreadyTimes` 跳號才 `rejected`，倒退是 `stale`；**到達時間不是拒收條件**（超過 24 小時只加 `late_arrival`）。回呼處理分支與每個轉移的觸發者見 `monetization-plan.md` §3.2／§5.2（含「P1 實作差異」）。
- 其他 RPC：`cancel_household_subscription`（付款人或 owner；只記 `cancel_requested`）、`resume_household_subscription`（只有付款人、只在 `cancel_requested`、只對 `payer`／`owner` 理由）、`set_subscription_payer_locale`（只有付款人）；`service_role`：`mark_subscription_terminating`／`claim_subscription_termination_dispatch`（回呼產生的 `terminating` 列的送出前認領）／`confirm_subscription_terminated(id, provider|admin)`（家庭已有別張持權列時直接 `superseded`）／`reopen_subscription_termination`（終止委託狀態機，供應商端由 P2 呼叫）、`refund_household_subscription`（先終止委託才准退，撤銷走 compare-and-set）、`admin_grant_household_entitlement(household, source, until, actor, cancel_subscription)`（家庭有進行中訂閱時 `set_household_entitlement` 的 admin 招待／試用預設 `subscription_in_progress`，這支以同一交易把 `active|grace` 標 `cancel_requested(admin_grant)` 後寫招待）、`expire_household_subscriptions`／`expire_pending_payment_orders`／`list_renewal_reminder_candidates`／`claim_renewal_reminder`／`release_renewal_reminder_claim`（每日 `subscription-lifecycle` cron；提醒信至多一封——送信前在資料庫認領，供應商明確拒絕才釋放）。admin 對付費家庭的直接撤銷（`revoked`／`correction` → `none`）同樣被守門擋下，只能走退款路徑。鎖的順序所有寫入者一致：家庭的訂閱交易鎖 → entitlement 交易鎖 → 列鎖；`apply_payment_event` 兩把都持有，所以回呼的分支與 `payment_events.flags` 在寫帳本列之前就定案。`set_household_entitlement` 由本票重建：多 `p_expected_premium_tier`（比對家庭**此刻生效**的 tier；給「仍是 none 才授予」用）、`reason` 多 `payer_deleted`；compare-and-set 輸掉時由內部 helper 寫一筆 `superseded_by_other_source` 稽核列。`delete_user_account` 加一段：付款人的 `active|grace` 訂閱轉 `cancel_requested(payer_deleted)`、已是 `cancel_requested` 的只改理由，`terminating`／`cancelled` 原狀保留，外鍵把 `payer_user_id` 設 NULL。

共用表的寫入能力與照護紀錄一致要求 `care_access.can_record`；舊表在過渡期仍可被舊版客戶端讀寫，但其寫入也受同一能力限制，並由 trigger 同步到共用表。這避免 view-only 帳號繞過新表 policy，也避免尚未更新的 PWA 形成分裂設定。

語言、顯示單位、圖表期間與版面展開狀態等不帶健康判讀意義的設定可以維持 user-scoped。若設定會因人而異地改變目標範圍、危險判定、警示或照護行為，就不再是單純介面偏好，必須存成 patient-scoped 資料並套用相同授權邊界。

設定表的 RLS 只允許 `auth.uid() = user_id` 的 SELECT／INSERT／UPDATE／DELETE。偏好尚未建立時由前端與資料庫預設為展開；展示模式沒有登入身分，才退回 localStorage，避免匿名展示資料建立正式帳號設定。

## 服藥三層模型

1. `drug_products`／相關官方表：TFDA、健保或 MOA 的公共候選主檔。
2. `medications`：家庭可選取的穩定藥品項目，保存商品名、學名、數值劑量、劑型、驗證狀態與可選外觀。
3. `medication_plans`：某一 patient 的服用安排，保存時段、顆數、順序與 PRN。
4. `medication_intake_logs`：某一 plan 在某日某顆的實際勾選。

需要時服用不共用這個 routine log：`prn_medication_events` 是每次實際使用的 append-only 事件，保存 `patient_id`、`plan_id`、實際 `taken_at`、資料庫推導的 `care_date`、實際量、原因／症狀、效果狀態、備註與記錄人。事件 UUID 由 client 在第一次送出前建立，重試遇到唯一鍵衝突時回讀同一事件；更正不能覆寫醫療事實，而是將原事件標為 `voided` 並留下原因，再視需要建立新事件。`prn_medication_daily_assessments` 只保存明確的 `not_needed` 或可恢復的 `not_assessed`，`used`、次數與最後時間永遠由 active events 導出。

服藥紀錄的日期欄位分工如下：`taken_at` 是不可取代的實際服用時間；`taken_on` 是既有日曆日相容欄位；`care_date` 是以 `Asia/Taipei` 04:00 切分的照護日。結構化藥單唯一索引使用 `patient_id + plan_id + care_date + dose_number`；舊版沒有 `plan_id` 的單顆藥則使用 `LOWER(account_email) + medication_id + care_date`，兩種路徑都能把跨午夜但未跨 04:00 的紀錄視為同一筆。資料庫 trigger 以 `taken_at` 強制計算 `care_date`，前端只提供 UX 預覽。

官方主檔不直接等同於病人的醫囑；使用者選到官方候選後才建立或連結 `medications`。未驗證自訂藥品可以支援照護記錄，但不能被說成官方資料，也不能餵給成分交互作用或總量判斷。

### 服用方式（A／B 兩層，issue #622）

服藥三層模型只回答「什麼時候吃、吃了沒」，不回答「這顆藥能不能整顆吞」；這一格由獨立的兩層資料補上：

- **A 層**：`medications.official_dosage_form_text`／`official_score_text` 兩個唯讀欄位，由
  `refresh_official_medication_dosage_details()` 從 `drug_products.dosage_form`／`tfda_drug_appearances.score`
  回填，寫法完全比照 `atc_code` 回填——只由 service-role 的 refresh 函式寫入，`apply_medication_plan_change`
  不碰，也不要求 `verification_status = 'official'`。前端純函式 `resolveSwallowGuidance()`
  （`src/lib/medication/medicationSwallowGuidance.ts`）讀這兩個欄位轉成三語提示，不進資料庫。
- **B 層**：`patient_medication_instructions`，主鍵 `(patient_id, medication_id)`——一個病人的一顆藥只有一種吃法，
  不像 `medication_plans` 是 (patient, medication, slot) 三元組。刻意不塞進 `medications`（跨病人共用目錄）
  也不塞進 `medication_plans`（要動 20 參數 RPC）；`instruction_codes`（代碼陣列）、`instruction_note`
  （200 字內）、`source`（`pharmacist`／`doctor`／`package_insert`／`family`）、`confirmed_on`、`updated_by`／
  `updated_at`（trigger 從 JWT 強制寫入）。只用一般 `supabase.from()` 讀寫，RLS 把關，不進
  `medication_plan_change_logs`（不動處方，`updated_by`／`updated_at` 就是這張表自己的稽核）。

A、B 兩層互不覆蓋、互不裁決：畫面上兩邊都照顯示，矛盾時額外附一條警告，不靜默讓任一邊勝出（見
`docs/features/medication.md` 的「服用方式」小節與 `detectInstructionConflict()`）。

## 其他核心表

- `care_timeline_entries`：看診、症狀、藥物調整、疫苗、飲食與家屬觀察等交接事件；`photo_paths` 保存最多四組 private Storage 的原圖／縮圖相對 path，照片二進位不進 Postgres，immutable CHECK validator 會把每組 path 綁定到同列的 `patient_id + id`。H5 #1181 以伺服器擁有的 `photo_retention_days`（30／180）與 `photo_retention_started_at` 記錄第一張貼上的期限；未貼過照片為 NULL，清空後保留原蓋章，降級不縮短。既有有圖列以 `created_at` 回填起點；清理後保留文字事件但清空附件 metadata，詳見 [照片保留與清理](../features/care-timeline.md#照片保留與清理)。
- `care-event-photos`：private Supabase Storage bucket；path 以 `patients/{patient_id}/events/{event_id}/` 分區，Storage RLS 沿用 `care_access`，讀取檢查可見病人，寫入／刪除要求 `can_record`。逾期刪除必須由 `care-event-photo-retention` Edge Function 使用 Storage API 執行，不能只刪 `storage.objects` 的 SQL 列。
- `body_temperature_records`：病人級體溫、測量部位、量測情境與備註；沿用血壓相同的 `care_access` 讀寫邊界，並由資料庫 trigger 限制每日 24 筆、保留 24 天。
- `weight_records`／設定：病人級體重與是否啟用追蹤的設定；`recorded_by` 只保留代填稽核，唯一鍵以 `patient_id + measured_on` 防止跨裝置重複。
- `patient_weight_measurement_records`：病人級當日最多十二筆體重；`measurement_number`（1–12）與 `patient_id + measured_on` 形成跨裝置去重邊界。過去日期由資料庫 trigger 僅保留 `measured_at` 最新的一筆；舊 `weight_records` 保留每日單筆唯一鍵供快取 PWA 使用，舊寫入由 trigger 同步到新版第 1 槽位。更早的 `weight_measurement_records` 相容表也由 `20260812110000_scope_legacy_weight_measurements.sql` 回填並強制使用 `patient_id`，不再以 email 作為健康資料邊界；若 email／日期對應多位病人，migration 會中止而不猜測歸屬。
- `meal_food_catalog_items`：每位病人已確認過的食物／產品快取，可作模糊搜尋；不是跨家庭公開營養資料。
- `meal_records`／`meal_record_items`：病人級餐次與食物快照；子項目的複合外鍵要求和餐次同一個 patient，避免跨人串接。
- `care_access`：舊家庭版的明確病人授權表，仍是安全檢查的重要來源。`(profile_email, patient_id)` 仍是唯一鍵，另外加了 `user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE`（F-5，issue #590 單位 1）：授權身分正從 email 改綁 `auth.uid()`，`user_id` 為 `NULL` 代表尚未綁定、仍走 email 過渡軌，已綁定的列只認 `user_id`。詳見 [`auth-and-rls.md`](auth-and-rls.md) 與 [`care-access-identity-binding.md`](care-access-identity-binding.md)。
- `calendar_notification_sources`：病人級的專用 Google Calendar 來源，保存 Calendar ID、提前分鐘、Telegram `enabled` 與行程頁 `agenda_enabled`；兩個旗標互不推導。partial unique index 限制同一 `patient_id + google_calendar_id` 至多一個 agenda source，避免相同行程在頁面重複；它不保存行程內容，也不使用登入者帳號作為病人歸屬。
- `shared_telegram_group_household`（issue #1061）：**已移除**（migration `20261009093000`，2026-10-09）。閘門時期（`20261005155025`～）它記錄全域 `TELEGRAM_CHAT_ID` 共用群組屬於哪個家庭，並以 BEFORE trigger 鎖住每一條已啟用的共用路由都在那個家庭；共用群組退場後整張連同七支判定函式一起拿掉，`record_change_logs` 留有釘選與退場的稽核列。
- `notification_deliveries`：通知副作用的最小稽核資料，只保存 SHA-256 occurrence key、occurrence 開始時間、提前分鐘與狀態。key 在 Function 記憶體中以 raw Google event ID、開始時間與 lead time 算出，原始 ID 不落 DB／log；複合外鍵 `(source_id, patient_id)` 必須對回同一個 source，唯一鍵 `(source_id, calendar_occurrence_key)` 是 Cron 重疊時的真正去重邊界；不得新增 title、description 或 location 欄位。ADR-007 票 1（`20260926155217`）起，它與 `care_due_reminder_deliveries`、`personal_notification_outbox`、`blood_pressure_notification_deliveries` 四張 delivery 帳本共用同一組五值 `status`、同一份 `provider_*` `failure_code` 值域（兩張 cron 帳本在票 9 之前另收 `telegram_*` 過渡值）與同一組欄位：`attempt_count`／`next_attempt_at`（D4）、`claim_token`／`claim_generation`（D9）、`resolution_source`（`runtime`／`migration`，遷移判定的終局列才是 `migration`）。直送帳本同時補上 `failure_code`、`attempt_started_at`、`provider_http_status`。任何一張表的值域或欄位單獨漂移都會被 `tests/unit/notificationDeliveryLedgerAlignmentMigration.test.ts` 與 `rls-authorization.sql` 擋下。票 6（`20260926165847`）另加 `notification_delivery_incidents`：sweeper 的告警表，每個 delivery 列最多一筆，鍵 `(delivery_table, delivery_id, source_created_at)`，非正規化 `patient_id` 由 INSERT 回查驗證且不可變；四張 delivery 表因此多了凍結 `patient_id`／`created_at` 的 `BEFORE UPDATE` 與連帶刪 incident 的 `BEFORE DELETE` trigger，並有一條只對 `notification_delivery_sweeper` 角色生效的 SELECT policy。詳見 `docs/features/notifications.md`「delivery sweeper」。**#1061 階段 D（`20261009093000`）起 `notification_deliveries` 與 `care_due_reminder_deliveries` 凍結**：沒有寫入者，殘留 `pending` 已終結為 `failed_terminal` ＋ `unattempted_abandoned` ＋ `resolution_source = 'migration'`；表與既有列保留供稽核、restore drill 與 sweeper 對帳。
- `reminder_notification_enqueue_failures`（#1251）：Function 觀察到漏排後經 service-only RPC 保存的不可變失敗收據。只存來源指標、DB 推導的 `patient_id`、occurrence、建立時間與 `failure_generation`（預設 0）；兩種來源各以複合 FK 鎖住病人，以來源＋occurrence＋代數去重。瀏覽器與 service role 均不得直接讀寫，sweeper 只有 SELECT；以此作第五種 incident 來源、產生 `enqueue_failed`，全部合格收件人都有 matching outbox 才結案。舊 closed／ack 收據不重開；只有最新一代已補排 closed、且最後一次嘗試開始晚於該關閉、又缺合格收件人時，recorder 才追加下一代，保留舊 incident 的終態。清理 outbox 本身不產生新代數，來源刪除連帶清除各代收據與 incident。recorder 與 reminder sweep 共用交易 advisory lock，等待後在 READ COMMITTED 重新讀取；固定快照交易回 40001。它不是第五張 delivery 帳本，不改送達狀態機。
- `personal_notification_outbox`（個人化通知，issue #599／#602）：每位收件人×管道一列，不存訊息內容，drain 送出前以 service role 重讀來源。`notification_kind` 為 `blood_pressure`、`calendar_reminder`、`care_due_reminder`（後兩者 issue #1104，`20261005155810`）；`source_record_id` 依 kind 指向 `blood_pressure_records`／`calendar_notification_sources`／`care_due_reminders`（沒有 FK，由 kind 分派）。提醒用 `occurrence_key`（日曆＝既有 SHA-256 occurrence key、到期提醒＝到期日）與 `occurrence_at`（日曆開始時間）區分同一來源的每一次觸發，形狀由 CHECK 綁死；唯一鍵 `UNIQUE NULLS NOT DISTINCT (notification_kind, source_record_id, occurrence_key, recipient_user_id, channel)`，血壓列 occurrence 為 NULL、去重與舊鍵相同。提醒只能經只給 `service_role` 的 `enqueue_reminder_personal_notifications` 排入，`patient_id` 由來源列推導。詳見 `docs/features/personal-notifications.md`。
- `household_members`：公開多租戶家庭內的 member role 與 patient 關聯。
- `record_change_logs`（ADR-008 AUDIT-1，issue #967）：通用異動稽核表，由 `log_record_change()` AFTER trigger 寫入，目前掛在 `care_access`、`household_members`、`patients`（Tier A，全事件、永久）與 `patient_anomaly_alert_settings`、`pet_blood_glucose_target_ranges`（Tier A′）；AUDIT-2（issue #968，migration `20261005040913_attach_tier_b_record_change_audit.sql`）起再掛 Tier B 18 張病人級健康表（血壓、體溫、canonical 體重、體液、餐次與餐次子項、失智照護、六張寵物紀錄、檢驗值、照護事件、回診提醒、回診問題、服藥紀錄）：只掛 `AFTER UPDATE`（`WHEN (OLD.* IS DISTINCT FROM NEW.*)`）與 `AFTER DELETE`，不記 INSERT，`expires_at = changed_at + 180 天`（trigger 參數 `'180 days'`）；`care_timeline_entries` 以 `TG_ARGV[2]` 剝除 `medication_change_snapshot`；legacy `weight_records`／`weight_measurement_records` 不掛。體溫 24 天清理與體重每日保留的換日壓縮以 `app.audit_bypass` 略過（只包住刪除那一句、結束後還原原值）；但寫入「過去日期」把當天原本的量測擠掉時照常記一筆 `delete`（actor 是寫入者、`actor_source = 'enforce_patient_weight_daily_retention'`），否則繞過 UI 就能無痕抹掉一筆歷史體重；`purge_expired_record_change_logs()` 由 pg_cron `purge-record-change-logs` 每日台北 02:00 清掉過期列與「`patient_id`、`household_id` 都已沒有活父列」的孤兒列（只給 service_role 與排程）。每列存 `table_name`／`row_id`（複合主鍵表存 `user_id`，每病人一列的設定表存 `patient_id`）、`patient_id`／`household_id` 分區鍵、`action`、`actor_kind`（`user`／`service_role`／`system`）＋ `actor_user_id`（只記 `auth.uid()`，永遠不記 email）、`actor_source`、`changed_columns`、`before_row`（剝除 email 型記錄者欄位後的整列 OLD）、`after_diff`（只含改到的欄位）、`expires_at`（Tier A／A′ 為 NULL）。**整張表沒有任何外鍵**（cascade 會撞不可變 trigger、反過來讓刪帳號／刪病人失敗），沒有 email 欄位，只有 SELECT policy（`can_record` 照護者讀病人層列、家庭 owner 經 `is_household_owner()` 讀家庭層列），API role 沒有任何 DML，UPDATE 一律拒絕、DELETE 只放行 `app.audit_bypass = 'on'` 的 purge。trigger 參數：`TG_ARGV[0]` 保留類別（`'permanent'` 或 interval 字面值）、`TG_ARGV[1]` row_id 欄位、`TG_ARGV[2]` 額外剝除欄位；transaction-local GUC：`app.audit_bypass`（系統清理與 `delete_user_account` 的健康列段落）、`app.audit_actor_kind = 'system'`（規則 trigger 在使用者 session 內的系統寫入，目前是 `revoke_share_readonly_for_caregiver_role`，設完必須還原）、`app.audit_source`。剝除後沒有差異的 UPDATE（同值回寫、只換 `profile_email` 快照）不留列；分區鍵（`row_id`／`patient_id`／`household_id`）改變的 UPDATE 寫成舊分區一筆 `delete` ＋ 新分區一筆 `insert`，舊快照永遠不落到新分區（PR #975 review）。讀取層與 UI 見 AUDIT-3／AUDIT-4；理由與被拒絕方案見 [`../adr/008-audit-coverage-boundary.md`](../adr/008-audit-coverage-boundary.md)。
- `legal_consents`：條款、隱私與健康資料同意版本、伺服器時間與代理關係。
- `patient_share_consents`：病人級的分享同意／授權稽核，保存 `patient_id`、操作者、本人／代理人類型、代理依據、固定 `scope_version`、同意文字版本與 server timestamp；不能用帳號層 `legal_consents` 單獨取代這筆分享授權。
- `patient_share_links`：病人級唯讀 bearer link metadata，只保存 token hash，不保存 raw token；`expires_at` 最多七天、`revoked_at` 可即時失效，並以 `(share_consent_id, patient_id, scope_version)` 複合外鍵把 link 綁回同一位病人與 scope。Stage 2 新增 `redeem_patient_share_link`（token hash → link）與 `get_patient_share_summary`（link → 固定 DTO）兩支 service-role-only RPC 讀取這張表，仍沒有任何 anon／authenticated 可直接查詢的 token lookup 入口。
- `patient_share_link_access_events`（issue #923）：唯讀分享連結的逐次存取稽核，append-only。`redeem_patient_share_link` 兌換成功寫一筆 `exchange`、`get_patient_share_summary`／`_v2` 讀取成功寫一筆 `summary_read`，都在 RPC 授權閘門通過之後、同一交易內由內部函式 `record_patient_share_link_access()` 寫入（寫入失敗時整次兌換／讀取一起失敗，且進入寫入函式後的失敗一律以專屬 SQLSTATE `SA923` 拋出，不與「連結無效」的 `P0001` 混用（函式不見的 `42883`、鎖逾時的 `57014` 不在其內，仍 fail closed 但記成原本的 stage）；兩支 Edge Function 據此另記 `stage:"audit"`，client 文案不變，issue #1003）；失敗路徑一律不寫。欄位只有 `link_id`、`patient_id`（由連結帶出）、`event_type`、`occurred_at`，沒有健康數值、token、token hash、IP 或 email。啟用 RLS、沒有 policy，`anon`／`authenticated`／`service_role` 都沒有任何權限；UPDATE 由 trigger 一律拒絕，DELETE 只剩保存期清理（`purge_expired_patient_share_link_access_events()`，180 天，pg_cron `purge-patient-share-link-access-events` 每日台北 01:45，兌換時也順手清）與刪連結／刪病人的 cascade。外洩時的查法見 [`../operations/share-link-breach-response.md`](../operations/share-link-breach-response.md) §2。
- `share_link_rate_limits`：唯讀分享公開入口的速率限制 bucket，只保存雜湊過的 key（IP、token 或 link 的 SHA-256）與時間窗內請求次數，不保存 raw IP 或 raw token；`check_share_link_rate_limit` 機會性清除超過一天的舊 bucket，避免長期累積可回推來源的紀錄。
- 寵物慢性病照護（`pet_liquid_intake_records`、`pet_digestion_records`、`pet_appetite_records`、`pet_subcutaneous_fluid_records`、`pet_insulin_records`、`pet_blood_glucose_records`）：只服務每日照護分頁的寵物模組，不進 Dashboard 摘要卡。液體管理與消化健康是「一天一筆」，以 `patient_id + recorded_date` 唯一鍵防止同一天覆蓋成兩筆；食慾（含 `meal_type`）、皮下點滴、胰島素與血糖是一天可多筆的時間戳紀錄。胰島素與血糖刻意拆成兩張表，因為兩者量測頻率不同、且不是每次都同時記錄。RLS 沿用既有 `care_access`（需要 `can_record` 才能寫入），`recorded_by`／`administered_by` 只表示操作人。

`pet_blood_glucose_target_ranges` 是病人級血糖判讀門檻，`patient_id` 是主鍵且沒有 authenticated 直接 DML；`upsert_pet_blood_glucose_target_range` 只接受對該 patient 具 `can_record` 的照護者。`record_pet_endocrine` 則在同一交易內寫入胰島素與血糖兩張表，避免前端依序 request 造成半套紀錄。沒有 target row 時不套用全域門檻，前端只顯示原始血糖值。

寵物歷史趨勢仍直接讀這六張表，不建立第二份彙總表或快取真相；查詢必須以 `patient_id` 和明確的台北日期／時間範圍分區。前端只在圖表展開後載入，並在 `src/lib/petTrendSeries.ts` 將每日一筆紀錄保留原值、食慾／血糖取每日平均、點滴／胰島素取每日總量；沒有紀錄的日期維持空值，避免把缺少照護輸入誤解成零值。

- `dementia_care_records`：失智照護模組（issue #421）的三種觀察紀錄——躁動時段、日夜顛倒模式、走失風險，用 `record_type` 區分，共用同一張表（時間、時段、備註欄位一致，不需要拆表）。`time_period` 可不填。RLS 沿用既有 `care_access`（`can_record` 才能寫入），`recorded_by` 只表示操作人；只在病人啟用 `dailyCareModules.dementiaCare` 時才會出現在每日照護頁（見下方預設關閉說明）。

- `care_due_reminders`：藥量倒數與人／寵物到期提醒（issue #414），讀取看 `care_access`、寫入要 `can_manage_medication`。照護閉環 T2（issue #946）起，非 `medication_refill` 型別可帶 `related_entry_id`（→ `care_timeline_entries`）或 `related_lab_result_id`（→ `patient_lab_results`，兩者互斥）與 `visit_department`（≤ 40 字自由文字，沿用時間線科別慣例），兩個關聯都是 `(欄位, patient_id)` 複合外鍵、`ON DELETE SET NULL (欄位)`，跨病人引用在資料庫層被拒；這不是排定實體（沒有時分、診間或「已確認」狀態機），仍只是「提醒你去約」的到期日（[ADR-005](../adr/005-care-loop-closure.md) 決策一）。照護閉環 T6（issue #956）起提醒表單才有入口填這三欄：非藥量倒數型別顯示「科別」與「連回來源」單一下拉（時間線事件／檢驗值二選一或不連結，互斥由單一 `<select>` 的結構保證；預設列最近 10 筆、展開 30 筆，排除調藥系統事件），編輯會預填既有連結、送出時三欄都明確帶值，所以只改到期日不會清掉連結；提醒清單以 `ReminderSourceChip` 顯示已連結來源，讀不到時顯示「暫時無法顯示」而不是讓連結憑空消失。`care_timeline_entries` 與 `patient_lab_results` 為此各補一個結構性 `UNIQUE (id, patient_id)`，不改既有欄位。
- `patient_lab_results`：白名單檢驗值（issue #687，K／NA／CR／EGFR／HBA1C／GLU／HB，單位與項目綁定），預設關閉的病人級模組。讀取看 `care_access`，寫入要 `can_record`；
  瀏覽器端只能寫 `source = 'manual'` 且不帶 `source_fingerprint`。`recorded_by` 由前端在新增時送登入者 email（見上方「前端寫入契約」）；編輯只限原登錄者，畫面對別人登錄的那筆不顯示「編輯」。
  現行行為詳見 [`docs/features/lab-results.md`](../features/lab-results.md)。
- `patient_visit_questions`：病人層級長期累積的回診問題清單（issue #723），只要求一般 `care_access`。照護閉環 T1（issue #945）起也是 Concern／Outcome 的最小載體：`source`／`source_rule_id`／`source_entity_id` 記錄「就診前摘要哪條規則、哪一列」採納成這筆問題（CHECK 保證成對、partial unique index 保證同病人同來源只採納一次，刻意不對來源表建外鍵，但 `validate_patient_visit_question_source` trigger 在寫入當下驗證來源列屬於同一位病人），`answered_at` 由 trigger 在 `answer` 變動時維護、前端只讀（`20260925191000` 以 `asked_at` 回填舊答案）。⚠️ `source_entity_id` 沒有外鍵，只在寫入時驗證；改動四張來源表 `patient_id` 的未來操作必須自行處理引用它的問題列。詳見 [`../features/visit-questions.md`](../features/visit-questions.md) 與 [ADR-005](../adr/005-care-loop-closure.md)。

`medication_plan_change_logs` 是不可變的藥單異動真相，保存明確 action、plan snapshot、actor 與 recorded/effective time。`care_timeline_entries.medication_plan_change_log_id` 是唯一投影 linkage，`medication_change_snapshot` 是供時間線讀取的展示投影，不取代 change log。歷史舊 log 可沒有完整 before snapshot，但 migration 會保留原資料並標示部分相容快照；新 mutation 必須完整保存前後狀態。

## 不變量

- 所有外鍵與 RPC 回傳都要保留 UUID，不用顯示名稱 join。
- 停用 medication plan 不刪除 intake history；歷史可追溯比畫面乾淨重要。
- 唯一索引是跨裝置去重的真正邊界；按鈕停用只提供 UX。
- 照護日只改每日工作區的分組，不改寫 `measured_at`、`taken_at` 或照護大事記的實際時間；任何報告若用照護日，必須在標題標明。
- 建立 plan 必須 idempotent，網路重試不能產生重複醫囑。
- PRN plan 的 `as_needed` 是分區與 RLS 關聯條件，不代表已使用；既有 PRN plan 搬遷時不猜測歷史使用、不回填 event，也不把它改成 routine slot。

- plan 時段或劑量調整若已有 plan id，必須以該 id 原地更新；不可用新增另一個 schedule row 代替，否則會留下兩個 active 醫囑。
- 名冊／profile 必須先於 care access 與 plan seed，否則外鍵與 RLS 重播會失敗。
- 匯出按 patient 分檔，不把登入者自己的帳號體重無條件混進其他成員資料。
- 新增生理數值或健康門檻前，先定義 patient 關聯與 RLS；前端 active patient、姓名或 localStorage key 不能成為唯一歸屬依據。
- 通知 delivery 的 `delivery_unknown` 與 `sending` 不能自動改回 pending；遠端 Telegram 結果不確定時，資料庫唯一鍵與可觀測狀態優先於補送。
- 有 `patient_id` 的新表預設掛 `log_record_change()` 通用 audit trigger（ADR-008 決策五），不得再開只記 email 的 bespoke log 表；`record_change_logs` 與任何 audit 表都不加外鍵，也不存 email。
- 指向 `auth.users` 的外鍵動作只能是 `CASCADE` 或 `SET NULL`，否則帳號會刪不掉；若 `SET NULL` 會被該表的不可變 trigger 擋下（`patient_bp_standards.created_by`，issue #967），改為刻意不建外鍵、保留 dangling uid，並在 migration 註解寫明理由。兩張邀請表的 `invited_by_user_id` 自 #967 範圍補充（migration `20260926051643`）起改為可 NULL 並 `ON DELETE SET NULL`：已接受的邀請保留作授權來源紀錄，未接受的由 `delete_user_account` 在刪帳號前清掉；`caregiver_invitations_request_pair_check` 不再要求 `requested_by_user_id` 非 NULL（否則經邀請加入過的帳號 SET NULL 時撞 23514）。`supabase/tests/rls-authorization.sql` 的 `account_deletion_every_auth_fk` 讓帳號在每張參照 `auth.users` 的表都有一列再刪，並把覆蓋清單綁在 catalog 上：新增這類外鍵卻沒補 fixture，測試就失敗。

## database.types.ts 產生流程

`src/lib/database.types.ts` 是 Supabase 公開 schema 的 TypeScript 型別快照，理論上應該由
`supabase gen types typescript` 產生，而不是手寫維護。issue #833 調查（2026-09）確認：

- repo 的 `package.json` scripts 與 `.github/workflows/*.yml` 都沒有任何步驟會自動重新產生這個檔案；
  一直是開發者本機手動執行指令後貼上結果送 PR。
- 這個手動流程沒有強制檢查點，調查當下就已經漏更新：本檔目前缺少
  `20260915110000_add_medication_catalog_curator_entitlement.sql` 到
  `20260915130000_create_patient_medication_appearance_overrides.sql`
  這幾支 migration 新增的表與欄位（例如 `patient_medication_appearance_overrides` 整張表都不在快照裡）。
  這代表使用到這些新表的程式碼目前拿不到型別檢查保護，是需要另外排查的風險，但不在本 issue 範圍內修正。

### 重新產生步驟

1. `supabase login`（或在 CI／本機安全環境設定 `SUPABASE_ACCESS_TOKEN`）取得存取權杖；本機互動式登入
   的憑證不要落地寫進任何 git-tracked 檔案。
2. 依分支狀態選其中一種：
   - **分支沒有新增 migration，或新增的 migration 已經合併進 staging**：先依
     `docs/staging-environment-guide.md`「真值從哪裡取得」設定 `STAGING_SUPABASE_PROJECT_ID`
     環境變數，再執行 `bun run types:generate`（實際指令是
     `bunx supabase@2.109.1 gen types typescript --project-id "$STAGING_SUPABASE_PROJECT_ID" --schema public`，
     CLI 版本釘住 `2.109.1` 與 `staging-supabase-migrations.yml` 等 migration workflow 一致，避免
     不同機器裝到不同版本的 CLI 產生不一致的快照；issue #888 之後這個 project ref 不再寫死於
     `package.json`，只保留在 `supabase/config.toml`、`scripts/seed-staging.ts`、
     `scripts/verify-staging-data.ts` 三個已記錄例外的 tracked 檔案裡，不需要另外查詢）。
   - **分支自己新增了 migration，staging 還沒部署**（`staging-supabase-migrations.yml` 只在合併
     進 `staging` 之後才 `supabase db push`，所以 `--project-id` 這條遠端指令讀到的是舊 schema，
     看不到分支自己新增的表／欄位——這正是本次調查一開始想避免的「型別落後」問題）：改執行
     `bun run types:generate:local`，先跑 `supabase start` 在本機 Docker 用該分支的完整
     migration 清單重播 schema，再對本機資料庫產生型別（`bunx supabase@2.109.1 gen types
     typescript --local --schema public`），這樣才會包含分支自己的 migration。
   兩個 script 都先寫進暫存檔，CLI 成功才覆寫 `src/lib/database.types.ts`，避免失敗時把本檔清空——
   這是本次調查時實測第一版 script 在沒有存取權杖的情況下曾直接把本檔清空後才修正的教訓。
3. 執行 `npx tsc --noEmit`，確認新型別沒有讓既有程式碼出現型別錯誤，再檢視 diff 並送 PR。

本次調查所在的沙盒環境沒有 `SUPABASE_ACCESS_TOKEN`，也沒有可用的 Docker daemon 跑
`supabase gen types typescript --local`，因此無法在這次 PR 內實際重新產生並回填最新內容；
新增的 `types:generate`／`types:generate:local` script 已可在具備登入權杖與（`--local` 時）
Docker 的環境下直接使用。

## 資料搬遷原則

先以受控 migration 將舊 subject／email 對應到已確認 UUID，再改查詢與 RLS；不以模糊藥名、同名或猜測照片補資料。照護日 migration 只由 `taken_at` 推導 `care_date`，建立唯一索引前若發現歷史跨邊界衝突就中止，不能自動刪除資料。新增 RPC 後要 reload PostgREST schema。若資料邊界改變，必須先驗證核心照護帳號仍能讀寫被照護者資料，再進 staging 驗收。
