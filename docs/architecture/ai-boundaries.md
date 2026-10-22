<!--
檔案用途：集中記錄「產品內哪些事可以用 AI、哪些不行」的既有決策總覽（issue #850）——把原本散在四份文件與程式碼註解裡的 AI 使用邊界收成四類表格，讓之後有人想加新 AI 用途時有地方查既有原則。
所在層：docs/architecture；純索引性質的導覽文件，不是規格，也不是新的決策記錄。每一列只指向既有決策文件的具體章節，不重新論證；與被引用文件衝突時一律以被引用文件為準。
主要關聯：docs/product/premium-entitlements-and-ai-medication-draft.md（AI 藥單草稿的紅線與成本）、docs/features/pre-visit-brief.md（規則引擎與否決 LLM）、
         docs/product/clinical-care-ops.md（§4 紅線、§6 被否決方案）、docs/features/medication.md（OCR／AI 草稿現況）、
         docs/features/vitals.md（血壓判讀與通知）、docs/features/notifications.md（到期提醒）、
         src/lib/careAnomalySignals.ts、src/lib/recordReport.ts、supabase/functions/medication-ai-draft/、supabase/functions/medication-ocr/。
-->

# 產品內 AI 使用邊界 / AI Boundaries

對應 issue：[#850](https://github.com/demo-xq7/jia-jian-log/issues/850)

## 1. 這份文件是什麼、不是什麼

這個 repo 的產品功能裡，伺服器直接呼叫外部 AI 服務的地方有兩處，另有瀏覽器語音辨識入口（見 §2），而且就診前摘要已明確否決 LLM。這些決策都已經做了，
但分散在不同文件裡；這份文件只做一件事：**把它們依「該用什麼技術解決」分成四類，每一列指向原始決策的章節**。

- **不新增任何 AI 用途，也不評估要不要加新功能。** 這裡的每一列都來自既有文件或程式碼註解。
- **不重新論證。** 看到某列的理由不夠詳細，去讀它的「出處」欄；出處與本文件不一致時，以出處為準，並回頭修正本文件。
- **章節引用用標題名稱，不用行號**（行號會在下一次重整時漂移，同 [`AGENTS.md`](../../AGENTS.md) 的跨檔引用慣例）。

## 2. 現況盤點：repo 內實際存在的 AI 呼叫點

| 呼叫點 | 外部服務 | 性質 | 現況（以出處為準） | 出處 |
| --- | --- | --- | --- | --- |
| `supabase/functions/medication-ai-draft` | Google Gemini（模型 ID 由 secret `GEMINI_MODEL` 提供，不寫死在程式碼） | 多模態 LLM：藥袋照片 → 結構化藥單草稿 | 免費限次試用＋付費額度；Edge Function 由 `staging-supabase-migrations.yml`／`production-supabase-migrations.yml` 自動 `supabase functions deploy`，但 secret 的「值」不會自動同步（缺必填 secret 的 Function 會被逐支擋下、維持上一版），所以 `GEMINI_API_KEY`／`GEMINI_MODEL` 要先在該環境設好才會上線；premium 文件 §7「部署現況」是較早期的狀態，以 `environment-variables.md` 為準 | [`premium-entitlements-and-ai-medication-draft.md`](../product/premium-entitlements-and-ai-medication-draft.md) §3.2、§5 單位 D／G／H；[`medication.md`](../features/medication.md)「AI 藥單草稿」；[`environment-variables.md`](../operations/environment-variables.md)（自動部署與 secret 閘門） |
| `supabase/functions/medication-ocr` | Google Cloud Vision `TEXT_DETECTION` | 文字辨識（**不是 LLM**）：藥袋照片 → 候選品名 | 前端入口 2026-09-11 起暫時隱藏，程式碼與 Edge Function 都還在 | [`medication.md`](../features/medication.md)「藥袋照片 OCR」 |
| `VoiceInputDraft`／`useVoiceInput`（#800） | 瀏覽器 `SpeechRecognition`／`webkitSpeechRecognition`；可能使用瀏覽器的外部辨識服務 | 語音轉文字（非 LLM）；不解析數值、不自動寫入 | 僅在明示音訊外送可能性並按下同意後啟動；final 原文落入暫存文字欄，照護者核對後手動填量測值 | [`vitals.md`](../features/vitals.md)「語音輸入文字草稿」 |

不在上表、但容易被誤認為「產品內 AI」的兩件事：

- **`.github/workflows/gemini-vision-smoke-test.yml`＋`scripts/smoke-test-medication-ai.ts`**：只在 `workflow_dispatch` 手動觸發的 CI 哨兵測試，用合成假藥袋圖片確認模型沒被棄用，不是產品執行路徑。
  `GEMINI_API_KEY`／`GEMINI_MODEL` 這類 Edge Function secret 的存在性檢查屬於營運面，歸 [`maintainability-review-2026-09.md`](./maintainability-review-2026-09.md) A4，不在本文件範圍。
- **醫師版報告的「GPT 複製文字」**：產品本身不呼叫 GPT，見 §4。

## 3. 四類邊界

### 3.1 deterministic code 就夠了

問題只有一個正確答案（日期運算、查表、門檻比較），不需要也不應該引入機率性的模型。

| 問題 | 為什麼 deterministic 就夠 | 實作位置 | 出處 |
| --- | --- | --- | --- |
| 哪些到期提醒逾期、還剩幾天（藥量倒數、回診、抽血、打針、疫苗） | 藥量到期日固定是領藥日加天數，其他類型只存照護者明確輸入的日期；門檻是每筆可調的 1–180 天，以台北日曆日判斷；畫面與 Telegram 只陳述類型、日期、天數，不推論 | `src/lib/careDueReminders.ts`（`computeRemainingDays`）、`supabase/functions/care-due-reminders` | [`notifications.md`](../features/notifications.md)「藥量與照護到期提醒」；[`pre-visit-brief.md`](../features/pre-visit-brief.md)「為什麼 R2／R3 不能直接沿用 `events` 裡的 `due_reminder`」 |
| 一筆血壓落在哪個等級 | 九級表 D1 凍結。可設定的雙軸模板在比對前先過程式守衛 `hardFloorRule`（`≥180/120`、`<90/50` 不是模板資料，模板在結構上無法表達降級）；`general_adult`（`nine-level-spec`）則**刻意不套用**該守衛，閾值來自凍結的 `src/config/blood-pressure-spec.json`，改判讀要改對地方、測對地方 | `evaluateReading`（`src/types/database.ts`）、`src/types/database/bpStandard.ts` | [`vitals.md`](../features/vitals.md)「警示」、「判讀標準模板（BP standard templates）」 |
| 通知家屬沒送出時，要不要對看護大聲提示 | 前端對**每一筆**成功儲存的紀錄（含離線補送）都呼叫通知 Function，不依等級過濾；是否真的送出由訂閱與 delivery 狀態決定。`isFamilyAlertLevelReading()` 只決定「共用群組被略過時要不要顯示 fail-loudly 警告」（警示級才提示，寧缺勿濫）。通知狀態與畫面逐字同源，用該筆量測當下生效的標準 | `InputPage.utils.ts`、`useBloodPressureInputForm.ts`、`blood-pressure-notifier` | [`vitals.md`](../features/vitals.md)「共用群組被略過時要看得見（Fail loudly）」、「通知與畫面同源判讀（issue #899）」 |
| 看護「今天要做」清單 | 只是 `care_due_reminders`（`remainingDays <= 0`）與 `reassess_on`（今天或已過）的讀取投影；被否決的是另存每日快照表 | `src/features/today/hooks/useTodayOverview.ts` | [`care-loop-domain-model.md`](../product/care-loop-domain-model.md) §3 Q6 |
| 調藥事件的方向（start／stop／dose_up…）與藥物分群（ATC 前綴） | 純函式：把 append-only 的 `medication_plan_change_logs`（調藥的唯一正典來源）附上方向與 ATC 分組，不需要模型判讀 | `src/lib/medicalTrajectory.ts`、`src/lib/medication/medicationAtcCategories.ts` | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §5.1 |

### 3.2 rules 比 AI 好

答案不是唯一的（要挑哪三個問題、哪些觀察值得記），看起來像 LLM 的工作，但**規則可以逐字審計、資料不外送、不踩醫療判斷紅線**，所以選規則。

| 問題 | 為什麼規則比 AI 好 | 實作位置 | 出處 |
| --- | --- | --- | --- |
| 就診前摘要的「觀察 → 3 個回診提問」（R1–R6） | 產品負責人決定第一版用確定性規則模板：可被單元測試審計、資料不外送、不踩 SaMD 紅線；措辭契約（固定開頭「請與醫師確認」＋三語禁用詞）由測試逐字強制，LLM 做不到這種審計 | `src/lib/preVisitBrief.ts`、`tests/unit/preVisitBrief.test.ts`、`tests/unit/preVisitBriefPhrasing.test.ts` | [`pre-visit-brief.md`](../features/pre-visit-brief.md)「為什麼要做」、「措辭契約：觀察 → 問題，禁用詞清單」；[`clinical-care-ops.md`](../product/clinical-care-ops.md) §6 被否決方案「第一版用 LLM 產生回診提問」、§4 第 2 條「措辭契約」、§5.2 |
| 若日後想用 LLM 改寫回診提問，既有的前提條件 | 只能是對**已算好的事實**的改寫；必須走 AI 藥單草稿的 entitlement 與姓名遮蔽模式，並升健康資料同意版本（這是既有決策，不是本文件新增的條件） | — | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §6 同一列 |
| 異常示警（體重驟降、連續未回報服藥、血壓連續偏高、近 N 天內夜間低血壓次數達設定門檻；後者是單一窗口內計數、不是與先前窗口比較的「上升」） | 純函式規則層，只讀既有紀錄、不寫入、不判斷病因；四種示警的三語文案集中在同一檔、用同一組測試保護，code review 一次核對用詞邊界。屬觀察級：不計入「今天要做」、不接 LINE／Telegram 推播 | `src/lib/careAnomalySignals.ts` | 該檔檔頭「為什麼文案集中寫在這個檔案」、「為什麼都不算『今天要做』」；[`growth-roadmap.md`](../product/growth-roadmap.md)「P1-1『異常主動示警』目前狀態」 |
| 「可能未續開」的信號 | R2（逾期的 `medication_refill` 提醒）是**唯一**信號；不從「藥單還在但沒打卡」或「醫師指示沒有對應調藥」推論 | `src/lib/preVisitBrief.ts` | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §5.2 R2 說明、§6「推論『未落實的醫師指示』」 |
| 檢驗值是否超出參考範圍（R5） | 只用**該筆報告自己的**參考值，缺值就只顯示不分類；不用全域參考值，否則等於把醫療門檻寫進程式 | `src/lib/labResults.ts`（`labRangeStatus`）、`src/lib/preVisitBrief.ts`；migration `20260914042410_add_patient_lab_results.sql` | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §5.2 R5、§6「用 HealthWorkbench `labs.json` 全域參考值做分類」（兩份規劃／功能文件對 R5 的「規劃中／本票不做」敘述落後於程式碼，以程式碼為準） |

### 3.3 AI 有明顯價值

目前只有一類：**把藥袋照片變成可編輯的新增用藥草稿**。價值在於藥袋上最重要的醫囑資訊（劑型、劑量、一天幾次、飯前飯後）原本要照護者全部重打，而前身的規則式 OCR 解析只能用正則粗略切出品名、劑量、頻率的字串猜測（`doseGuess`／`frequencyGuess` 只顯示在候選卡片上，實際套用的只有品名，照護者仍要自己判斷劑型與服藥時機）；多模態 LLM 能一次讀出整張藥袋的結構化欄位。價值論述見 [`premium-entitlements-and-ai-medication-draft.md`](../product/premium-entitlements-and-ai-medication-draft.md)（下稱 premium 文件）§1。

這個用途附帶的紅線（每一條都是既有決策，違反就不該合併）：

| 紅線 | 內容 | 程式落點 | 出處 |
| --- | --- | --- | --- |
| 草稿必讀人工確認，永遠不自動寫入 | AI 結果只能預填表單，照護者逐項確認後才走 `createMedicationPlan`／`apply_medication_plan_change`；UI 必須明講「這是 AI 猜的，請核對藥袋」；`applyDraft` 先把表單重置成預設值（劑型 `tablet`、劑量 `1`、服藥時段早餐後）再疊上草稿有值的欄位：品名、成分、規格讀不出（null）就留白，卡片標示「藥袋上沒讀到，請自行填寫」；**劑型、劑量讀不出時不是空白，而是這些預設值**；一天次數＋服藥時機由 `matchFrequencyPreset` 比對，命中時預選對應時段，比對不到就維持預設的早餐後、不用次數硬猜。低信心項目**不會**被清空，只加上警示卡要求格外核對。預設值仍需照護者核對修正（`tests/unit/useMedicationAdminFormApplyDraft.test.ts` 鎖住這些預設） | `MedicationAiDraftSection.tsx`、`useMedicationAdminForm.ts`（`applyDraft`）、`src/lib/medication/medicationAiDraft.ts` | premium 文件 §2 第一條；[`medication.md`](../features/medication.md)「AI 藥單草稿」（其「一天次數與服藥時機不會自動填入」的敘述落後於程式碼，以 `applyDraft` 為準） |
| 姓名不得回流，且誠實揭露照片會完整送出 | 去識別化是**後置過濾**：防姓名回流到前端與 log，防不了照片本身被傳出去。能承諾的只有：(a) 回傳前跑姓名去識別化、(b) Function log 只記筆數、stage 與白名單失敗代碼（`classifyDraftFailureReason`，例如 `gemini_http_404`；不記例外訊息，因為壞掉的模型回應會讓 SyntaxError 夾帶片段）、(c) 照片不落地 Storage；隱私政策不得寫成「去識別化後才送出」。查姓名失敗要 fail closed，不可略過過濾 | `medication-ai-draft/index.ts`（`redactPatientNameFromDraftItems`、`medication_ai_draft_failed` 只記 stage 與白名單代碼） | premium 文件 §2「照片會完整送出，這件事必須誠實揭露；姓名不得回流」；[`medication.md`](../features/medication.md)「藥袋照片 OCR」末段「去識別化措辭經過一次修正」 |
| 綁定發動當下的病人 | 請求帶 `patient_id`、回應原樣帶回並在套用前比對，不符就丟棄；切換病人時已開的草稿一律清空。這是本批最嚴重的健康安全風險（遲到結果填進另一位病人的表單） | `x-patient-id` header；三道防線中，「回應抵達時比對」與「按下套用時再比對」共用純函式 `draftMatchesPatient`，「切換病人即清空」是獨立的 `useEffect([patientId])` 狀態重置，不經過該函式（測試要分開覆蓋） | premium 文件 §2「AI 草稿必須綁定發動當下的病人」；[`medication.md`](../features/medication.md)「病人切換防呆（三道防線）」 |
| 成本上限先於功能 | 先寫一筆 `pending` 才呼叫外部 API，失敗也算一次；不得為了 UX 放寬；`llm_draft` 與 Vision 各自獨立計數 | `insertPendingAiDraftCallLog`、`enforce_daily_medication_ocr_limit`（`call_kind='llm_draft'`） | premium 文件 §2「成本上限先於功能」、§4、§7「成本」；migration `20260910150000_add_medication_ai_draft_entitlement.sql` |
| 免費配額必須遠低於付費配額 | 免費額度的目的是讓人嚐到價值而非替代付費；預設與 CHECK 上限都鎖在個位數，調高前要先回頭檢查這條紅線 | `medication_ai_draft_free_daily_limit` | premium 文件 §2「免費配額必須遠低於付費配額」；migration `20260911100000_add_medication_ai_draft_free_tier.sql`、`20260912070000_raise_medication_ai_draft_paid_limit.sql` |
| 付費旗標永遠不能被瀏覽器改；每個功能各自一格 | `account_usage_limits` 對 `anon`／`authenticated` 是 `REVOKE ALL`，後台寫入只走 service role 的 Edge Function；不用單一 `is_premium`，才能在成本暴衝時單獨關掉 AI | `admin-set-account-entitlement`、`medication_ai_draft_tier` | premium 文件 §2「付費旗標永遠不能被瀏覽器改」、§3.1 |
| 委外處理者或用途變更是同意事項 | 新增 LLM 用途必須在隱私政策與健康資料告知頁寫清楚「送什麼、送給誰、留多久」，並評估是否升同意版本；Gemini 與 Vision 同為 Google，屬同一處理者的用途擴張 | `src/lib/legalConsent.ts`（`CURRENT_HEALTH_CONSENT_VERSION`）、`/privacy`、`/health-data-notice` | premium 文件 §2「委外處理者變更是同意事項」、§3.2、§5 單位 F；migration `20260910180000_bump_health_consent_version_for_medication_ai_draft.sql` |

藥袋照片 OCR（`medication-ocr`，Google Vision，非 LLM）是同一條路徑的前身：它只做規則式解析，產出品名、劑量、頻率三種字串猜測（皆顯示在候選卡片上），但實際套用的只有品名：點選後只是把品名塞進既有搜尋欄位，之後仍走完整人工流程，沒有新增繞過人工確認的儲存路徑；姓名同樣是辨識後由伺服器過濾，配額同樣「失敗也算一次」。現況與細節見 [`medication.md`](../features/medication.md)「藥袋照片 OCR」。

### 3.4 AI 風險太高

這一類是「不做」，不是「做了要加防護」。

| 不做的事 | 為什麼風險太高 | 現行防線 | 出處 |
| --- | --- | --- | --- |
| 自動判斷該停、加、調哪顆藥，或建議劑量 | 不得做醫療判斷（SaMD 邊界）：只陳述資料裡有什麼，不建議增減藥、不預測 | `RecordReport.tsx` 琥珀色「系統提示不是診斷，請勿自行調藥」（螢幕與列印都保留）；`recordReport.ts` 給 GPT 的 `Do not diagnose or recommend medication changes`；`PRE_VISIT_FORBIDDEN_PHRASES` 的停藥／加藥禁用詞 | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §4 第 1 條、§5.2 禁用詞；[`growth-roadmap.md`](../product/growth-roadmap.md) 風險「不得出現醫療宣稱」 |
| 診斷、預測，或「A 藥停了所以 B 異常」這類因果推論 | 同上；系統只能把相關事實**並列**，不用連接詞 | `src/lib/careTimeline.ts`（「不計算因果」）、R5 並列規則 | [`care-timeline.md`](../features/care-timeline.md)「不是醫療診斷引擎」；[`clinical-care-ops.md`](../product/clinical-care-ops.md) §4 第 1 條、§5.2 R5 |
| 把 AI 輸出直接寫進藥單或任何醫囑 | AI 猜的劑量不得當預設值送出；寫錯病人的醫囑是最嚴重的健康安全風險 | §3.3 前三條紅線 | premium 文件 §2 前兩條與「綁定發動當下的病人」 |
| 推論「醫師指示有沒有被落實」 | 「多喝水」本來就不會有對應調藥，這是假判斷；只做純回顧＋中性提問（R4） | R4 的措辭契約 | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §6「推論『未落實的醫師指示』」 |
| 用全域參考值或模型判斷檢驗值異常 | 等於把醫療門檻寫進程式，各檢驗所參考範圍也不同；改用該筆報告自己的參考值 | R5 缺值不分類 | [`clinical-care-ops.md`](../product/clinical-care-ops.md) §6；[`nhi-health-passbook-integration.md`](../product/nhi-health-passbook-integration.md) §4.2 |

## 4. 使用者自行外送的路徑（不是產品內 AI 呼叫）

醫師版報告的「複製給 GPT」按鈕（`ReportExportActions.tsx`，`navigator.clipboard.writeText(buildGptReportText(...))`）是純前端的字串組裝，**產品不呼叫任何外部 AI**；使用者自己決定要不要貼到哪個外部服務。這條路徑的既有設計：

- 文字包預設不放顯示姓名（`Subject: Name-removed patient`），但**仍包含所有逐筆健康數值**，文字包內也如實寫出這一點。出處：`src/lib/recordReport.ts` 的 `buildGptReportText`。
- 除了逐筆血壓，呼叫端有傳入時還會附上「近期醫療軌跡」（藥名、劑量、時段、調藥原因、使用者輸入的時間線標題與內文、逾期提醒）與「就診前摘要」（醫師指示、逾期提醒、檢驗值觀察等）。這些自由文字欄位可能含有識別資訊，**移除顯示姓名不等於已去識別化**，貼到外部服務前要由使用者自行檢視。出處：同函式的 `buildTrajectorySectionLines`／`buildPreVisitBriefSectionLines`；`ReportExportActions.tsx` 的複製按鈕。
- 內建指示「描述趨勢、分開事實與推論、指出缺少的背景、整理可詢問醫師的問題；不要診斷、不要建議自行調藥」；有就診前摘要時另加「請當成待確認的問題，不是結論」。同一函式。
- 就診前摘要規則引擎上線前，App 本身不產生任何具體問題，「擬問題」整段外包給外部 LLM；現在問題先由規則產生（§3.2），GPT 文字只附帶。出處：[`pre-visit-brief.md`](../features/pre-visit-brief.md)「為什麼要做」。

## 5. #800 語音輸入：文字草稿 MVP

本次依 #800 的保守 MVP 重啟：使用瀏覽器原生語音辨識（印尼文／中文／英文），不新增 LLM、付費 API 或後端代理。先呈現可能外送音訊的揭露，再由使用者主動啟動；文字只進可編輯草稿，不解析、不填數值、不寫入。草稿依 `patient_id` 隔離，失敗保留手動量測流程。完整設計與未驗證的真機支援／辨識準確度見 [`vitals.md`](../features/vitals.md)「語音輸入文字草稿」。

[`q4-2026-outcome-compression.md`](../product/q4-2026-outcome-compression.md) 的 defer 是歷史排序，原始構想在 [`growth-roadmap.md`](../product/growth-roadmap.md) P2-3；不以本次 MVP 宣稱已驗證輸入摩擦或印尼文準確度。#868 的 Siri 捷徑只開畫面，仍不辨識內容、不寫入值（見 [`siri-shortcuts.md`](../features/siri-shortcuts.md)）。

## 6. 想加新 AI 用途前，既有原則在哪裡

這不是新的審核流程，只是把上面已存在的原則反向索引，方便提案時逐項對照：

| 要回答的問題 | 去哪看 |
| --- | --- |
| 這件事 deterministic code 或規則能不能解？規則先前為什麼贏過 LLM？ | §3.1、§3.2；[`pre-visit-brief.md`](../features/pre-visit-brief.md)「為什麼要做」 |
| 會不會碰到醫療判斷（建議調藥、診斷、預測、因果）？ | §3.4；[`clinical-care-ops.md`](../product/clinical-care-ops.md) §4 |
| 輸出會不會寫進健康資料？由誰確認？綁定哪位病人？ | §3.3 前三條紅線；[`AGENTS.md`](../../AGENTS.md) § 3.5 |
| 會送什麼資料給誰？隱私文案與同意版本要不要跟著動？ | §3.3「姓名不得回流」「委外處理者…同意事項」；[`AGENTS.md`](../../AGENTS.md) § 3.3 |
| 每次呼叫要花多少錢？誰擋住失控的重試？免費與付費怎麼拉開？ | §3.3「成本上限先於功能」「免費配額…」；premium 文件 §7「成本」 |
| 失敗時看護會不會以為「沒事」？ | 北極星設計鐵律第 4 條 Fail loudly，見 [`vitals.md`](../features/vitals.md)「共用群組被略過時要看得見（Fail loudly）」；呼叫失敗一律退回手動輸入並明講，見 §3.3 所列 Edge Function 的 502／503 回應 |
| 實作與複審要用什麼等級的模型？ | [`AGENTS.md`](../../AGENTS.md) § 5（第三方整合、secrets 屬高風險類別） |
| 什麼時候可以上 production？ | [`AGENTS.md`](../../AGENTS.md) § 3.7；premium 文件 §7「發布」 |

## 7. 維護這份文件

- 新增、移除或改變任何產品內 AI 呼叫點時，**同一個 PR** 更新 §2 與對應的 §3 表格；每一列都要有「出處」欄指向既有決策的章節，沒有出處就先補決策文件。
- 本文件只引用、不複寫決策內容；紅線的措辭若在出處文件被修改，回來同步，不要在這裡另寫一份。
- 驗證：純文件，`git diff --check`；相對連結可解析。
