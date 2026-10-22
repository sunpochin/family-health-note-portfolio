<!--
檔案用途：記錄「就診前摘要」規則引擎（issue #686，#659 的 S2）的規則設計、措辭契約與已知取捨。
所在層：docs/features；就診前摘要是醫療軌跡（S1）之上疊加的規則層，資料模型仍以 medical-trajectory.md
描述的 TrajectoryEvent[] 與擴寬血壓視窗為基礎。
主要關聯：src/lib/preVisitBrief.ts、src/features/vitals/components/PreVisitBriefSection.tsx、
src/features/vitals/hooks/usePreVisitSources.ts、src/features/vitals/components/BloodPressureReportPanel.tsx、
src/lib/recordReport.ts 的 buildGptReportText、src/lib/preVisitSources.ts；R5 的資料來源見 docs/features/lab-results.md；
決策脈絡與紅線見 docs/product/clinical-care-ops.md（§4、§6）。
-->

# 就診前摘要規則引擎（S2）

## 為什麼要做

醫師版報告的 GPT 複製文字過去把「擬問題」整段外包給外部 LLM（`recordReport.ts` 的 Task for GPT），App
本身不產生任何具體問題。產品負責人決定第一版用**確定性規則模板**而不是 LLM：可被單元測試審計、資料
不外送、也不踩醫材（SaMD）紅線——系統只陳述既有 helper 算出的數字（「觀察」），再附上固定開頭的
「請與醫師確認」問題，不下因果推論、不建議調藥。這是 #659 五個施工單位的第二張，依賴 S1（#684）的
`TrajectoryEvent[]` 與擴寬血壓基線視窗。

## 規劃文件與分工

issue #686 的規劃文件是 [`docs/product/clinical-care-ops.md`](../product/clinical-care-ops.md)（#659），S1–S5 全部合併後它只保留決策脈絡：
產品與安全紅線（§4，SaMD 邊界與措辭契約的來源）、被否決的方案（§6，例如第一版不用 LLM 產生提問、不推論「未落實的醫師指示」、
不算服藥依從率）與開放決策（§10）。**規則本身的現行行為以本檔與 `src/lib/preVisitBrief.ts` 為準**，規劃文件不再重複規則表。
資料來源（軌跡、擴寬血壓視窗、三態讀取狀態）見 [`medical-trajectory.md`](./medical-trajectory.md)；R5 的資料表與接法見 [`lab-results.md`](./lab-results.md)。

## 規則優先序與資料來源

| 規則 | Priority | 觸發條件 | 資料來源 |
| --- | --- | --- | --- |
| R5 | 1 | 檢驗值的 `labRangeStatus` 為 `below`／`above`（只用該筆報告自己的參考範圍；缺值為 `unknown`，不分類、不產生項目） | `opts.labResults`（S4，見 [`lab-results.md`](./lab-results.md)）；證據並列另讀 `events` 的調藥 |
| R1 | 2 | `blood_pressure`／`diuretic` 群的調藥事件，比對前 7 天 vs 調藥後至視窗末的血壓平均 | `events`（S1 的 `TrajectoryEvent[]`）＋ `opts.baselineRecords`（S1 擴寬視窗血壓） |
| R2 | 3 | `medication_refill` 提醒，`status === 'active'` 且已逾期 | `opts.dueReminders`（未過濾的原始清單） |
| R3 | 3 | `follow_up_visit`／`blood_draw` 提醒，`status === 'active'` 且已逾期 | 同上 |
| R4 | 4 | `doctor_instruction` 時間線事件，純回顧、上限取最近 2 筆 | `events` |
| R6 | 5 | 視窗內量測涵蓋率（有紀錄天數 / 總天數）< 50% | `records`（報告本身的血壓紀錄） |

R5（檢驗值規則）由 S4（#687）加入，優先序最高；證據並列只做同義配對（`A12B ↔ K`、`A10 ↔ GLU／HbA1c`），採檢日前後 14 天內有該群調藥時，
用不含方向動詞、不用連接詞的中性句並列，不寫因果。實際可選到的調藥是「兩層篩選的交集」：R5 只在 `events`（軌跡）裡找，而軌跡只納入 ±7 天回顧窗與**報告視窗**相交的調藥，
所以落在報告視窗起點前 8～14 天、但仍在採檢日 14 天內的調藥不會被並列（`usePreVisitSources` 讀檢驗值也只讀報告視窗內）。這是已知的取捨，不是規則的保證範圍（細節見 [`lab-results.md`](./lab-results.md)）。

R2 是**唯一**的「可能未續開」信號：不從「藥單還在但沒打卡」或「醫師指示沒有對應調藥」推論任何事（「多喝水」本來就不會有調藥，那是假判斷；
被否決的理由見規劃文件 §6）。

## 為什麼 R2／R3 不能直接沿用 `events` 裡的 `due_reminder`

`buildMedicalTrajectory`（S1）產出的 `DueReminderTrajectoryEvent` 已經先篩過
`status === 'active'`，且只保留到期日落在報告視窗內的提醒——這是為了讓「近期醫療軌跡」時間序只顯示
「這段期間發生的事」。但 R2／R3 要回答的問題是「現在還有沒有沒處理的逾期提醒」，跟到期日是否剛好落在
這次報告視窗內無關：一張三個月前就該續開、到現在還沒續開的藥單，一樣值得在下次看診時問醫師，即使報告
只選了「近 7 天」。因此 `buildPreVisitBrief` 的 `opts.dueReminders` 刻意要求呼叫端傳入
`listCareDueReminders()` 的**未過濾**結果（`usePreVisitSources.ts` 已經另外把它暴露出來），由 R2／R3
自己判斷 `status === 'active'` 且 `computeRemainingDays(due_date) < 0`——不從其他資料（例如藥單異動、
時間線）推論「可能未續開」，也不能只看 `CareDueRemindersPage.tsx` 前端已經篩過的畫面資料
（Codex review PR #689 的既有坑：`listCareDueReminders()` 回傳所有狀態，篩選是呼叫端各自的責任）。

## 去重鍵：只有非 null 的 `relatedMedicationId` 才共用鍵

排名管線（`rankPreVisitQuestions`）是 priority 升冪 → occurredAt 降冪 → 去重 → 取 3。去重鍵的規則：

- `relatedMedicationId` 非 null 時（目前只有 R1 用藥品 catalog id、R2 用藥單 plan id），用
  `med:${relatedMedicationId}` 當鍵——同一個藥品／藥單的多筆項目只保留排序較前的一筆。
- 其餘一律是 null（R3、R4、R5、R6），改用 `${ruleId}:${dedupeId}`（`dedupeId` 是
  來源實體自己的 id，例如提醒 id、時間線事件 id、檢驗值 id；R5 即用此鍵，所以多筆超出參考範圍的檢驗值不會被併成一項）。如果錯把這些項目也用同一個 `null` 當鍵，會讓完全
  不相關的規則（例如一筆逾期回診＋一筆逾期抽血＋一筆醫師指示回顧）被誤判成「同一項」而只剩一筆
  （同樣是 Codex review PR #689 抓到的既有坑，這次在 R2/R3/R4 的去重邏輯裡重演一次）。

`tests/unit/preVisitBrief.test.ts` 的「keeps distinct null-relatedMedicationId items from different
rules」測試專門鎖住這個行為。

## 措辭契約：觀察 → 問題，禁用詞清單

每個項目固定是「觀察」（`PreVisitBriefItem.observation`，只用既有 helper 算出的數字，例如
`summarizeBpRecords` 的平均值、`computeRemainingDays` 的逾期天數）→「問題」
（`PreVisitBriefItem.question`，可能是 `null`）。問題一律以「請與醫師確認／Tanyakan kepada
dokter／Please confirm with the doctor」開頭，觀察與問題都不得包含
`PRE_VISIT_FORBIDDEN_PHRASES`（因果推論詞、停藥／加藥指示詞、「副作用」等）。三語完整清單見
`src/lib/preVisitBrief.ts` 的常數定義與 `tests/unit/preVisitBriefPhrasing.test.ts`。

「只有觀察」（`question: null`）只有兩種情況：R1 調藥後零血壓量測（沒有資料可對照，問「有沒有變化」沒
意義）、R6 量測涵蓋率過低（涵蓋率太低時任何「對照」都不足以形成具體問題）。零候選項目時
（`buildPreVisitBrief` 回傳空陣列）畫面與 GPT 文字都印固定的「區間內沒有可對照的藥單異動或逾期提醒」，
不補一個通用問題湊數。

## 來源標籤：「照護筆記」vs「排程提醒」（照護閉環 T3，issue #947）

`docs/product/care-loop-domain-model.md` §3 Q4 定案：`care_timeline_entries.reassess_on`（R4 讀）與
`care_due_reminders.due_date`（R2／R3 讀）**不統一**——前者是任何有 `can_record` 的人都能標的「這件事之後要
再看一下」，後者是要 `can_manage_medication` 才能建立、有明確排程規則的到期日。但兩者過去混在同一個清單裡，
使用者看不出權限與「正式程度」不同。最小修改是在 `PreVisitBriefSection.tsx` 依規則來源分組（`groupPreVisitBriefItems`）：
R1／R5／R6 留在主清單；R4 進「照護筆記／Catatan perawatan／Care notes」小節；R2／R3 進「排程提醒／Pengingat
terjadwal／Scheduled reminders」小節，各附一句來源說明。「照護筆記」的說明寫「來自照護紀錄的醫師指示，部分附有
重新評估日期」，不能寫成「重新評估標記」：`buildR4Items` 收的是所有 `doctor_instruction` 事件，`reassess_on`
只是其中可選的欄位（Codex review PR #953 P2）。分組只影響顯示，不改 `rankPreVisitQuestions` 的優先序
與取 3 邏輯，也不改 `buildGptReportText` 的 GPT 文字（那段仍照排名平鋪）。沒有項目的小節不渲染。

## 「加入問題清單」：觀察落地成 Concern（照護閉環 T4，issue #948）

`docs/product/care-loop-domain-model.md` §3 Q1 定案：Concern 不新開表，R1／R5 等有提問的項目可以一鍵轉成一筆
`patient_visit_questions(source = 'pre_visit_rule', source_rule_id = ruleId, source_entity_id = dedupeId)`（T1 加的
三欄）。實作分工：

- `src/features/vitals/hooks/useAddBriefToVisitQuestions.ts`（Rule A／C，另有 `stale` 狀態：資料庫以 23503 拒絕代表來源已被刪除或不屬於這位病人，按鈕停用並提示重新整理摘要，不讓使用者對一筆永遠不會成功的項目一直重試）：掛載時讀一次既有清單、以
  `visitQuestionSourceKey` 判定哪些 `(規則, 來源列)` 已在清單；`add()` 寫入「提問＋（觀察）」（按下當時的語系，
  跟範本問題同一慣例；超過 500 字截斷）並記 `source` 成對 id；資料庫回 23505（partial unique index）視為
  「已在清單」而不是錯誤；切換病人時整組狀態清空，不殘留上一位病人的「已在清單」。
- `PreVisitBriefSection.tsx` 只在收到 `adoption` 時畫按鈕（`print-hidden`），四種狀態文案三語：加入問題清單／
  加入中…／已在清單（disabled）／加入失敗，再試一次。R6 沒有提問，沒有按鈕。
- 唯一掛載點是 `BloodPressureReportPanel`，且只在 `allowQuestionAdoption`（血壓模組近期趨勢，`InputPage` 傳入）、
  人類病人、已登入、非展示病人時啟用；封存對象的唯讀歷史頁與列印預覽維持純呈現。

## ⚠️ 健康安全語意變更，需要主刀 Agent 或使用者最終審查

這張票的措辭本身就是產品風險（規劃文件 §4 的措辭契約，依 AGENTS.md 屬於「健康安全語意」變更）。
`PreVisitBriefSection.tsx` 與 `preVisitBrief.ts` 的文案改動，實作 Agent 不能自行判定「措辭沒問題」就
跳過複查；PR 說明必須明確標註待審查，且僅在主刀 Agent 或使用者確認後才能合併。

## 利尿劑（C03）↔ 血鉀：第一版只做同義配對（已定案）

規劃文件 §10 的開放決策，實作採「先只做同義配對」：R1 把 `diuretic`（C03）跟 `blood_pressure` 群用同一套
「7 天基線 vs 調藥後血壓平均」邏輯處理；R5 的證據並列也只配 `A12B ↔ K`、`A10 ↔ GLU／HbA1c`，**不**把利尿劑與血鉀配對，
也不做兩者的因果推論。若之後要做真正的血鉀對照，需要另開票（涉及潛在的因果語意風險，不是這條規則的延伸）。

## 非人類病人隱藏

就診前摘要只服務人類病人（寵物用藥與提醒規則不同，且規劃文件的措辭契約是針對人類醫療情境設計）。
`BloodPressureReportPanel.tsx` 在 `careRecipientType !== 'human'` 時，直接把 `preVisitBriefItems`
設為 `null` 而不是空陣列傳給 `RecordReport`；`RecordReport.tsx` 收到 `null` 時完全不渲染
`PreVisitBriefSection`，跟「規則引擎算出零項目」（渲染固定空狀態文案）在語意上是兩件不同的事，不能
共用同一個「空陣列」表示。

## 放置、匯出與邊界

- 版面順序：「目前藥單」→「近期醫療軌跡」→「就診前摘要」→「資料限制」，兩段都在 `.record-report` 內、列印可見
  （`RecordReport.tsx` 的註解寫明這個順序的理由：先看現在吃什麼，再看這段期間改了什麼，最後才是報告本身的限制）。
- 免責聲明在螢幕與列印都保留，並多一句「就診前摘要只並列已記錄的事實與提問，不代表因果關係。」（`PreVisitBriefSection.tsx` 的 zh 原文）。
- GPT 複製文字納入兩段：`buildGptReportText(records, context, trajectory?, preVisitBrief?)` 的後兩個參數是選填，省略時輸出位元組不變；
  CSV 不納入（理由見 [`vitals.md`](./vitals.md)「目前藥單只在畫面」段）。
- 邊界情境：無血壓紀錄仍顯示軌跡、R1 只有觀察、R6 觸發；`/demo` 走既有 demo 路徑（`getFallbackDemoCareTimeline`），提醒與檢驗值來源回報
  `not_applicable`；封存病人頁是同一個唯讀面板；日期分桶一律走台北照護日（`eventReviewWindow`／`summarizeEventReviewDays`）。
- **⚠️ 已知問題（[#1027](https://github.com/demo-xq7/jia-jian-log/issues/1027)）：切換病人時不保證無殘留。** `usePreVisitSources` 用 `useLatestRequest` 丟棄遲到的舊回應，
  但在新資料回來前**不會清空**上一位病人的 `events`／`dueReminders`／`labResults`，`BloodPressureReportPanel` 也沒用它的 `loading`、掛載處沒有 `key={patientId}`；
  因此新病人的血壓先回來時，軌跡與摘要可能短暫顯示上一位的內容（違反 AGENTS.md § 3.5）。修復前，staging 驗證的「切換病人無殘留」這項預期會失敗。

## 離線與來源不可用時的行為

`opts.sourceStatus`（沿用 S1 `preVisitSources.ts` 的三態）逐規則把關：`medicationChanges` 不可用時跳過
R1，`dueReminders` 不可用時跳過 R2／R3，`timelineEntries` 不可用時跳過 R4，`labResults` 不可用時跳過 R5。離線時這幾個來源通常都會是
`unavailable`（見 medical-trajectory.md 的三態說明），因此「離線時不跑 R1–R5」是這個逐規則把關的自然
結果，不需要另外用 `isOfflineData` 判斷一次。R6 只依賴 `records`（報告本身的血壓紀錄，離線時可能仍有
快取），刻意不受這些來源狀態影響。`PreVisitBriefSection.tsx` 沿用 `TrajectorySection.tsx` 既有的
「來源不可用」三語文案慣例，分開列出哪個來源讀不到，不合併成一句籠統的「無法讀取」。

## 驗證方式

- `bun test tests/unit/preVisitBrief.test.ts tests/unit/preVisitBriefPhrasing.test.ts tests/unit/preVisitBriefSectionRender.test.ts tests/unit/i18n.test.ts`
- `bun run lint`、`bun run build`、`npx tsc --noEmit`
- staging 人工驗證：用測試病人（不用真名）重現「調藥後量測對照、逾期提醒、醫師指示回顧」情境，確認
  列印預覽、GPT 複製文字都出現「就診前摘要」段落、切換病人無殘留（目前有已知問題 [#1027](https://github.com/demo-xq7/jia-jian-log/issues/1027)，修復前此項預期失敗）、devtools 離線時顯示「無法讀取」、
  寵物病人完全不顯示這個區塊。
