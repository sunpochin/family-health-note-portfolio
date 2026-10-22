<!--
檔案用途：記錄「近期醫療軌跡」讀取模型（issue #684，#659 的 S1）的設計決策、資料來源與已知取捨。
所在層：docs/features；醫療軌跡屬於血壓報告的延伸功能，資料模型獨立於 vitals.md 描述的日常量測流程。
主要關聯：src/lib/medicalTrajectory.ts、src/lib/preVisitSources.ts、
src/features/vitals/hooks/usePreVisitSources.ts、src/features/vitals/components/TrajectorySection.tsx、
src/lib/recordReport.ts 的 buildGptReportText；S2（#686）、S3（#685）依賴本檔描述的 TrajectoryEvent[] 與擴寬血壓視窗。
軌跡頁（D 期，issue #735，src/features/care-family/pages/TrajectoryPage.tsx）另外呼叫同檔案的
buildCareTrajectoryFeed，差異見 docs/features/care-timeline.md。決策脈絡見 docs/product/clinical-care-ops.md；
S3 欄位見 care-timeline.md，S4／S5 見 lab-results.md。
-->

# 醫療軌跡讀取模型（S1）

## 為什麼要做

`RecordReport.tsx` 的醫師版報告過去只列「現在在吃什麼」，不列「這段期間改了什麼」；`DashboardChart.tsx`
在圖上標調藥點，但沒有跟血壓讀值、看診事件、到期提醒放進同一份可列印報告。調藥紀錄
（`medication_plan_change_logs`）、照護時間線（`care_timeline_entries`）與到期提醒
（`care_due_reminders`）都已是既有的不可篡改或獨立資料來源，缺的是把它們合併成一條時間序、
印進報告的**讀取模型**。這是 #659（Clinical Care Ops 產品戰略重定位）五個施工單位（S1–S5）的第一張，
純描述、無 schema 變更；S2（#686，規則引擎與措辭契約見 [`pre-visit-brief.md`](./pre-visit-brief.md)）
已在這份時間序上疊加規則引擎，S3（#685）則以 `health_visit` 結構化欄位補上科別、院所與就醫類型（軌跡頁會顯示；醫師版報告的軌跡段目前讀不到這三欄，見 [#1035](https://github.com/demo-xq7/jia-jian-log/issues/1035)）。軌跡頁（D 期，issue #735）
另外用同一份合併去重邏輯衍生出不限報告視窗、不收斂事件型別的 `buildCareTrajectoryFeed`，
取代原本的事件 tab；差異與取捨說明見 [`care-timeline.md`](./care-timeline.md) 的「軌跡頁」一節。

## 規劃文件與分工

issue #684 的規劃文件是 [`docs/product/clinical-care-ops.md`](../product/clinical-care-ops.md)（#659）。它在 S1–S5 全部合併後
已收斂成**決策脈絡**：為什麼做、產品與安全紅線（§4）、被否決的方案（§6，例如 hash chain、把檢驗值當時間線新事件類型）、
合併順序與開放決策。現行行為的唯一來源是本檔與下列文件，規劃文件不再重複：

| 內容 | 現行文件 |
| --- | --- |
| 軌跡讀取模型（本檔）：調藥正典來源、±7 天回顧窗、擴寬血壓視窗、三態讀取狀態 | 本檔 |
| 就診前摘要規則 R1–R6、措辭契約、禁用詞、排名與去重 | [`pre-visit-brief.md`](./pre-visit-brief.md) |
| `health_visit` 結構化欄位（`visit_kind`／`visit_department`／`visit_institution`，S3） | [`care-timeline.md`](./care-timeline.md) |
| 檢驗值資料表、R5 接法、健康存摺檢驗項目正規化（S4／S5） | [`lab-results.md`](./lab-results.md) |

調藥紀錄的不可篡改性（append-only 的 `medication_plan_change_logs`、只有 SELECT policy、API role 只有 SELECT grant——
INSERT／UPDATE／DELETE 與會繞過逐列觸發器的 `TRUNCATE`、`TRIGGER`／`REFERENCES`／`MAINTAIN` 都已收回（[#1036](https://github.com/demo-xq7/jia-jian-log/issues/1036)）、時間線投影 1:1）在 S1 之前就已完成，
S1 沒有新增任何機制，只在 `rls-authorization.sql` 補了一條「觸發器仍在」的完整性斷言（見下方驗證方式），
證明就算權限層哪天被放寬，觸發器這層仍會擋下 UPDATE／DELETE。

## 資料模型與邊界

### 調藥的唯一正典來源

`medication_plan_change_logs` 是調藥的唯一正典來源；`care_timeline_entries` 裡帶
`medication_plan_change_log_id` 的列只是同一筆調藥的 1:1 顯示投影（見
`supabase/migrations/20260812010000_reliable_medication_timeline_events.sql` 的
`apply_medication_plan_change`）。`buildMedicalTrajectory`（`src/lib/medicalTrajectory.ts`）合併時
會排除所有 `medication_plan_change_log_id IS NOT NULL` 的時間線列，只用 change log 本身產生事件，
否則同一次調藥會顯示兩次（Codex review PR #689）。

### 為什麼調藥要用「±7 天事件回顧窗」判斷是否落在報告區間

S2 的 R1 規則需要每筆調藥前 7 天的血壓基線，且調藥本身可能落在報告視窗起點前 7 天，仍是這段期間血壓
持續受影響的原因。因此 `buildMedicalTrajectory` 不是直接比對調藥 `effective_at` 是否落在
`[windowStart, windowEnd]`，而是用 `careTimeline.ts` 既有的 `eventReviewWindow(effective_at, 7)`
算出「這筆調藥前後 7 天」，只要這個區間與報告視窗相交就納入。看診／醫囑／意外／重新評估等一般時間線
事件，以及到期提醒，維持直接比對是否落在報告視窗內即可，不套用這個 ±7 天緩衝。

### 血壓基線視窗（供 S2 使用，S1 本身不消費）

`useBpRecords(days)` 只抓剛好 `days` 天；S2 的 R1 需要每筆調藥前 7 天的基線，且調藥可能落在視窗起點
前 7 天，兩段 7 天相加＝ 14 天緩衝。`usePreVisitSources.ts` 因此另外呼叫一次
`useBpRecords(selectedDays + 14, patientId)`。因為 `useBpRecords` 內部的 `patientScopedCacheKey`
把 `days` 編進快取鍵，天數不同天生就是不同的 localStorage key，不需要另外設計快取隔離機制，也不會
覆蓋 `BloodPressureReportPanel` 自己那份 `useBpRecords(selectedDays, patientId)` 用來顯示畫面與 CSV
的快取。**S1 的畫面與 CSV 匯出只顯示 `selectedDays`**，這份擴寬後的資料只存在於
`usePreVisitSources` 的回傳值裡，等 S2 的規則引擎真的需要時才會被消費。

### 時間線查詢的欄位清單（issue #1035）

`preVisitSources.ts` 讀 `care_timeline_entries` 的欄位集中在 `TIMELINE_ENTRY_COLUMNS`，必須包含 S3 的
`visit_kind`／`visit_department`／`visit_institution`：醫師版報告的軌跡段與 GPT 複製文字都靠
`sourceEntry.visit_*` 顯示科別／類型／院所（GPT 複製文字只帶科別與類型，不帶院所：院所＋精確日期是強再識別向量，見 ADR-009）。漏選時真實資料永遠是 `undefined`、只有 demo 模式正常，
`tests/unit/preVisitSourcesTimelineColumns.test.ts` 鎖住這份清單。新增時間線欄位要給報告用時，記得同步這裡。

### 三態讀取狀態：ok / unavailable / not_applicable

`src/lib/preVisitSources.ts` 的三個資料來源（調藥歷史、時間線區間、到期提醒）各自獨立回報
`ok`／`unavailable`／`not_applicable`：

- `ok`：成功讀到資料（可能是空陣列，代表這段期間真的沒有異動）。
- `unavailable`：查詢失敗（多半是離線或網路錯誤）。UI 與 GPT 匯出文字都必須印「無法讀取」，
  不能被誤讀成「這段期間沒有異動」——這兩者是不同的事實，混在一起會讓照護者或醫師誤判資料完整性。
- `not_applicable`：這個來源在目前情境下本來就不適用。目前唯一的例子是 `/demo` 訪客模式的到期提醒——
  `care_due_reminders` 沒有展示模式的種子資料或本機 fallback，硬打查詢只會被 anon RLS 擋下並產生一次
  注定失敗的網路請求，違反「/demo 零網路請求」的驗收條件，因此直接短路回報 `not_applicable`。

### ATC 分組只是貼標籤，不是判斷

`resolveTrajectoryMedicationGroup`（`src/lib/medicalTrajectory.ts`）把調藥的 ATC code 分成
`blood_pressure`（C02/C07/C08/C09）、`diuretic`（C03）、`potassium`（A12B）、`diabetes`（A10）、
`anticoagulant`（B01A）五組，是專門給 S2 的 R1 規則引擎用來決定「這筆調藥該比對哪組生理數值」的
分類鍵；S1 本身不對這個分組做任何比對、建議或警示——純分類貼標籤，符合 issue 的「純描述、無規則」
邊界。畫面上顯示給人看的雙語標籤仍然固定經過既有的 `resolveMedicationCategory`
（`src/lib/medication/medicationAtcCategories.ts`），兩者是不同用途、不同對照表，不要合併。

## 驗證方式

- `bun test tests/unit/medicalTrajectory.test.ts tests/unit/recordReport.test.ts tests/unit/trajectorySectionRender.test.ts`
- `bun run lint`、`bun run build`、`npx tsc --noEmit`
- `supabase/tests/rls-authorization.sql` 的觸發器斷言：對 `medication_plan_change_logs` 的 UPDATE／DELETE 必須 raise
  `medication_plan_change_logs_are_immutable`（由 CI 的 `verify-supabase-migrations` 執行）；同檔開頭的 #1036 不變量另外確認 anon／authenticated／service_role 對這張表與 `care_timeline_entries` 沒有 `TRUNCATE`／`TRIGGER`／`REFERENCES`／`MAINTAIN`。這是**人工的觸發器完整性測試**，不是正式環境 API 的行為：測試在最後會 ROLLBACK 的 transaction 裡，暫時給 `authenticated` UPDATE／DELETE grant 並建立全通的 UPDATE／DELETE policy，才碰得到觸發器。正式環境沒有這些 grant 與 policy，一般 API 的修改會先在權限層被擋，看不到 `medication_plan_change_logs_are_immutable`；排查事故時不要拿這個訊息當預期結果。
- staging 人工驗證（用 staging 測試病人，不用真名、不用真實健康資料）：先透過藥單 RPC 停用兩筆 C0x 藥、加一筆
  `doctor_instruction`、一筆逾期 `blood_draw` 提醒與幾筆低讀值，再打開每日照護 → 血壓 → 近期趨勢，確認：
  1. 軌跡段出現且順序正確，三語切換無漏翻。
  2. 列印預覽 A4 保留該段、去掉按鈕。**分頁是否切斷單一項目尚未驗證**：`src/index.css` 的 `break-inside: avoid` 只套在少數區塊（`.record-day`、`.record-row`、`.print-report-chart`、`.print-source-footer`、`.care-handbook-section`），軌跡與摘要的項目沒有，屬已知缺口，不是必過項目。
  3. GPT 複製文字含該段；CSV 位元組不變。
  4. 切換病人無殘留（目前有已知問題，見 [#1027](https://github.com/demo-xq7/jia-jian-log/issues/1027)，修復前此項預期失敗）；`/demo` 從 fixture 渲染、Network 面板零失敗請求。
  5. devtools 離線時顯示「無法讀取」而不是「沒有異動」。
  6. 封存病人頁維持唯讀。
