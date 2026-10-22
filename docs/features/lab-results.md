<!--
檔案用途：記錄白名單檢驗值（issue #687，#659 的 S4）與健康存摺檢驗項目正規化純模組（issue #688，S5）「現在實際長什麼樣」：
資料表、RLS、配額、每日照護模組、R5 規則的接法、S5 純 adapter 的邊界，以及與規劃文件不同的落地決定。
所在層：docs/features；現行規格（已 shipped）。規劃當時的決策脈絡與被否決方案留在 docs/product/clinical-care-ops.md，本檔不重複。
主要關聯：supabase/migrations/20260914042410_add_patient_lab_results.sql、src/lib/labResults.ts、src/lib/labItemMeta.ts、
src/features/labs/pages/LabResultsPage.tsx、src/lib/preVisitBrief.ts（R5）、src/lib/preVisitSources.ts、src/lib/adapters/nhi/labs.ts；
docs/features/pre-visit-brief.md、docs/product/nhi-health-passbook-integration.md（Stage 0 閘門）。
-->

# 檢驗值資料表與健康存摺檢驗項目正規化（S4、S5）

## 為什麼要做

跨科就醫時，抽血報告的數值常是醫師最需要、家屬卻最難拿出來的資料；就診前摘要的 R5 需要「一張抽血報告裡的數值」
這種結構化資料，原本全 repo 沒有任何檢驗表（產品背景見 [`clinical-care-ops.md`](../product/clinical-care-ops.md) §2）。S4 補上資料表與最小手動輸入，且只在被就診前摘要的 R5 消費時才有正當性
（不新增純輸入模組，見 [`clinical-care-ops.md`](../product/clinical-care-ops.md) §4 紅線 3）；S5 把 HealthWorkbench 的
檢驗項目名稱／單位正規化移植成純模組，為日後健康存摺匯入預留，但**不接任何 UI、資料庫或 Storage**。

## 白名單與每日照護模組

- 白名單項目：`K`、`NA`、`CR`、`EGFR`、`HBA1C`、`GLU`、`HB`。每個項目只允許一種單位（K／NA `mmol/L`、CR／GLU `mg/dL`、
  EGFR `mL/min/1.73m2`、HBA1C `%`、HB `g/dL`），由資料庫 CHECK 與 `LAB_ITEM_META`（`src/lib/labItemMeta.ts`）雙重綁定，
  避免同一項目混用單位讓 R5 誤判。`labItemMeta.ts` 是不 import supabase 的純函式檔，`labResults.ts` re-export 全部符號。
- 模組是**預設關閉**的病人級模組，依物種自動模板時**只對人類顯示**（`applicableToSpecies: ['human']`）。**例外**：對象改用自訂模板
  （`useCustomTemplate`）時，`visibleDailyCareModules` 不套物種篩選，寵物也能開啟這個模組並看到人類的檢驗白名單；就診前摘要對非人類對象仍整段隱藏，
  所以 R5 不受影響。每日照護模組 id `labResults`（`src/lib/dailyCareModules.ts`），開關欄位
  `patient_daily_care_preferences.show_lab_results`（預設 `false`），頁面為 `src/features/labs/pages/LabResultsPage.tsx`
  （列出、新增、編輯、刪除；結構比照 `CareDueRemindersPage`）。
  新增時 `createLabResult(input, recordedByEmail)` 送出登入者 email（轉小寫）當 `recorded_by`，沒有 email 就在送出前停下並顯示三語訊息；
  編輯不送（`toRow()` 刻意不含 `recorded_by`）。S4 上線後到 [#1041](https://github.com/demo-xq7/jia-jian-log/pull/1041) 之前，前端漏送這個欄位，畫面新增一律失敗（[#1034](https://github.com/demo-xq7/jia-jian-log/issues/1034)），
  前端寫入契約見 [`data-model.md`](../architecture/data-model.md)「前端寫入契約」。
- 採檢日一律以**台北日曆日**解讀（`sampledAtFromDateKey`／`sampledDateKey`）：畫面上是「日期」不是時刻，若走瀏覽器時區，
  台北使用者每編輯存一次就會往前漂一天（獨立複審抓到的資料漂移）。
- 範圍判讀 `labRangeStatus`：只用**該筆報告自己的** `reference_low`／`reference_high` 分成 `below／within／above`；缺任一端回
  `unknown`，頁面顯示「無參考值可分類」，不分類、不進 R5。刻意不採用全域參考值表（等於把醫療門檻寫進程式，踩 SaMD 線）。

## 資料表 `patient_lab_results`

| 欄位 | 說明 |
| --- | --- |
| `patient_id` | `REFERENCES patients(id) ON DELETE RESTRICT`；唯一分區鍵，建立後不可改 |
| `item_code`／`value`／`unit` | 白名單項目、數值（`NUMERIC(10,3)`，只擋負數，不設醫療門檻）、與項目綁定的單位 |
| `reference_low`／`reference_high` | 該筆報告自己的參考範圍；兩者都有時 `low <= high` |
| `sampled_at` | 採檢時間（預設 `now()`；畫面以台北日曆日寫入） |
| `institution`／`notes` | 院所（≤80 字）、備註（≤240 字），自由文字 |
| `source`／`source_fingerprint` | `manual`（預設）或 `nhi_import`；指紋只允許 `nhi_import` 非 NULL，`(patient_id, source_fingerprint)` 為 partial unique index，預留給日後匯入去重 |
| `recorded_by`／`created_at` | 誰操作與伺服器建立時間（`recorded_by` 不代表數值屬於誰，歸屬看 `patient_id`） |

安全邊界（對應 [`auth-and-rls.md`](../architecture/auth-and-rls.md) 的病人級授權模型）：

- **RLS 明寫 `ENABLE`**，`TO authenticated` 的四條 policy：SELECT 要 `care_access`；INSERT／UPDATE／DELETE 要 `care_access.can_record`。
  沒有 demo policy——檢驗值是特種健康資料，不比照血壓開放公開展示病人瀏覽。
- INSERT 與 UPDATE 的 `WITH CHECK` 都強制 `source = 'manual' AND source_fingerprint IS NULL` 且 `recorded_by` 等於登入 email：
  瀏覽器端只能寫手動結果，不能自稱匯入、也不能預占 fingerprint（否則會擋掉日後真正的匯入）；`nhi_import` 只能由未來受同意閘門控制的
  SECURITY DEFINER RPC 或 service-role 路徑寫入。應用層 `toRow` 固定送 `source: 'manual'`、不送 fingerprint，與 policy 互為雙保險。
- **編輯只限原登錄者**：UPDATE 的 `WITH CHECK` 要求 `recorded_by` 等於目前登入者，而 `recorded_by` 又不可改，所以另一位同樣有
  `can_record` 的照護者編輯時，UPDATE policy 的 `USING` 放行、`WITH CHECK` 以 `42501` 拒絕新列。畫面以 `canEditLabResult`（與 policy 同一條規則、不分大小寫）
  對別人登錄的那筆不顯示「編輯」，改顯示三語說明；DELETE 沒有這個限制。這是 UI 便利，授權仍由 RLS 決定。
- 觸發器 `protect_patient_lab_results_audit_fields`：`patient_id`、`recorded_by`、`created_at`、`source`、`source_fingerprint`
  不可改，違反 raise `patient_lab_results_audit_fields_are_immutable`。
- 每日配額 30 筆（`account_usage_limits.lab_results_daily_limit`，`current_account_daily_limit('lab_results', 30, …)`）：
  一張抽血單就有多個項目，所以比時間線寬。**依伺服器 `created_at` 計算，不用使用者可偽造的 `sampled_at`**，否則反覆補登過去日期就能繞過上限；
  超額 raise `daily_lab_results_limit`，頁面顯示專屬訊息，其餘錯誤顯示通用訊息。
- `delete_user_account()` 連帶 `DELETE FROM patient_lab_results WHERE LOWER(recorded_by) = v_email`。
- `supabase/tests/rls-authorization.sql` 涵蓋：表在 anon／public 檢查清單內；授權帳號能寫手動列；同時自稱 `nhi_import` **且**帶 fingerprint
  的 INSERT 被 RLS 拒（`42501`）；無 `care_access` 的帳號 SELECT／INSERT／UPDATE／DELETE 全被拒。**沒有**單獨測：只帶 fingerprint
  （會被表格 CHECK 以 `23514` 擋，不是 RLS）、只改 `source`、以及 UPDATE 路徑把既有列改成 `nhi_import`。這些測試都以 SQL 直接 insert 並自帶
  `recorded_by`，所以攔不到前端漏送；前端 payload 改由 `tests/unit/labResultsWrite.test.ts` 鎖住（#1041）。
- 照護閉環 T2（issue #946）另讓 `care_due_reminders.related_lab_result_id` 以病人綁定的外鍵指向本表（見 [`data-model.md`](../architecture/data-model.md)）。

## R5：檢驗值超出該筆報告參考範圍（就診前摘要）

規則表與措辭契約在 [`pre-visit-brief.md`](./pre-visit-brief.md)；這裡只記與檢驗值資料流有關的接法：

- **R5 直接吃 `labResults`，不經過 `TrajectoryEvent[]`**：檢驗值沒有進「近期醫療軌跡」時間序（`TrajectorySection` 只在來源不可用時印「檢驗值暫時無法讀取」）。
- 優先序 P1（全規則最高）；只有 `labRangeStatus` 為 `below`／`above` 才產生項目；`relatedMedicationId = null`、去重鍵用該筆檢驗值 id，
  所以多筆超出參考範圍的檢驗值不會被併成一項。
- 證據並列只做**同義配對**：`LAB_ITEM_META[code].relatedMedicationGroups`（`K ↔ potassium`、`GLU／HBA1C ↔ diabetes`），採檢日前後 14 天內
  最近一筆該群調藥，用不含方向動詞的中性句並列，不用連接詞、不寫因果。實際可選到的調藥是「兩層篩選的交集」：R5 只在 `events`（軌跡）裡找，而軌跡只納入 ±7 天回顧窗與**報告視窗**相交的調藥，
  所以落在報告視窗起點前 8～14 天、但仍在採檢日 14 天內的調藥不會被並列（`usePreVisitSources` 讀檢驗值也只讀報告視窗內）。這是已知的取捨，不是規則的保證範圍。利尿劑（C03）↔ 血鉀**沒有**納入。
- 來源狀態：`preVisitSources.ts` 的 `labResults` 沿用 `ok／unavailable／not_applicable` 三態；展示病人（`/demo`）沒有種子資料，
  回報 `not_applicable`，不發注定失敗的查詢；`unavailable` 時略過 R5，不能被誤讀成「沒有超出參考範圍的檢驗值」。

## S5：健康存摺檢驗項目正規化（純 adapter）

`src/lib/adapters/nhi/labs.ts` 只做兩件事：判斷 r7.10（項目名稱）是否落在白名單、輸出白名單命中後的固定單位。**不被任何 UI 或寫入路徑引用。**

- 名稱比對的唯一依據是 `LAB_ITEM_META[code].nhiNameAliases`。HealthWorkbench 上游目錄（`NHI_LAB_KNOWLEDGE_ENTRIES`）有 40 條，涵蓋血液常規、肝腎功能、發炎指標等，
  但與我們七項白名單目前**只有 Hemoglobin、Creatinine、eGFR（三種公式變體）有交集**，所以只有 `HB`、`CR`、`EGFR` 有別名；
  `K／NA／HBA1C／GLU` 在上游目錄沒有對應條目，維持空陣列。擴充白名單時先查上游目錄是否已有條目與別名，沒有的不得由本專案臆測。
- `EGFR` 把上游三個公式變體（CKD-EPI／MDRD／Male）收進同一個白名單，是本專案 schema 只有單一 `EGFR` 代碼的刻意簡化，不是移植上游行為。
- **r7.11（結果值）、r7.12（參考值）、日期、機構欄位刻意不解析、不輸出**：輸出若已長得像 `patient_lab_results` 的欄位，
  後續程式就能不經 Stage 0 簽核直接消費它，等於用「純函式、無 DB 寫入」繞過閘門（PR #610、#795 的 Codex review 教訓）。
- 不移植參考值分類；`fingerprint.js` 另開票。
- 健康存摺匯入的 UI、資料庫寫入與真實檔案進入產品流程仍受 [`nhi-health-passbook-integration.md`](../product/nhi-health-passbook-integration.md) §6 的 Stage 0 閘門限制，**尚未解除**。

## 與規劃文件不同的落地決定

以程式與 migration 為準；下列是規劃文件（[`clinical-care-ops.md`](../product/clinical-care-ops.md) 原 §7.2、§5.1）與實際落地的差異：

| 項目 | 規劃 | 實際 |
| --- | --- | --- |
| 白名單常數檔 | `src/lib/labResults.ts` 內 `LAB_ITEM_META` 含 `relatedAtcGroups: AtcGroup[]`、`decimals: 0｜1｜2` | 中繼資料拆到 `labItemMeta.ts`（純函式，S5 adapter 才能不連帶引入 supabase）；欄位名為 `relatedMedicationGroups`、`decimals: number` |
| 數值上限 | `value < 100000` | 只有 `value >= 0`；不設上限，避免把醫療門檻寫進資料庫 |
| 配額基準 | 未指定 | 依 `created_at`，不用 `sampled_at`（防反覆補登繞過） |
| UPDATE policy | 只描述 INSERT 的 `WITH CHECK` | UPDATE 同樣鎖 `source = 'manual'`，否則可編輯既有列把來源改成 `nhi_import` |
| `delete_user_account()` 基準 | 複製 `20260828010000` 的定義 | 複製 `20260913160242`（補了 `care_access` 以 `user_id` 再清一次）；沿用舊版會悄悄丟掉該段清除 |
| 檢驗值進軌跡 | S1 寫「S4 後加檢驗值」到 `TrajectoryEvent[]` | 沒有；R5 直接讀 `labResults`，軌跡不呈現檢驗值事件 |
| 索引／constraint 命名 | `patient_lab_results_fingerprint_uidx` 等 | `patient_lab_results_patient_fingerprint_unique`、`patient_lab_results_patient_item_sampled_idx`；單位與參考值排序以內嵌 CHECK 表達 |

## 驗證方式

- `bun test tests/unit/labResults.test.ts tests/unit/labResultsWrite.test.ts tests/unit/patientLabResultsMigration.test.ts tests/unit/nhiLabs.test.ts tests/unit/preVisitBrief.test.ts tests/unit/preVisitBriefPhrasing.test.ts`
- `bun run lint`、`bun run build`、`npx tsc --noEmit`、`bun run check:migrations`
- CI `verify-supabase-migrations` 重播 migration 並執行 `supabase/tests/rls-authorization.sql`。
- staging 人工驗證（一律用測試病人與測試帳號，不用真名與真實檢驗值）：從畫面新增一筆超出參考範圍的檢驗值並確認就診前摘要出現 R5、
  RLS 正反、配額、原登錄者編輯與刪除（另一個測試帳號看不到「編輯」）、拋棄式帳號走刪帳號路徑。
