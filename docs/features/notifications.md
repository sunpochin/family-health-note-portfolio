<!--
檔案用途：定義 Google Calendar 到 Telegram 的照護提醒資料邊界、可靠性策略與啟用程序。
所在層：docs/features；描述 server-side 通知功能，不取代 Supabase 平台或發布規則。
主要關聯：calendar-notifier Edge Function、telegram-health-check（issue #1247）、通知 migration、Google Cloud service account 與 Telegram。
-->

# 日曆通知 / Calendar Notifications

## 目的與範圍

日曆通知讓家人在外地也能透過 Telegram 收到「即將有專用照護日曆行程」的雙語提醒。它不是前端 Google 登入功能的延伸：現有 Google Identity Services（GIS）只負責使用者登入，保持原本 scope 不變；通知改用獨立的 Google Cloud service account，以 reader 身分被分享給一個專用的次要 Calendar。

未來行程頁與 Telegram 使用同一個 Google service account，但兩個開關刻意分離：`enabled` 只代表 notifier，`agenda_enabled` 才允許家健錄顯示未來 7／14 天。行程頁直接讀 Google 作為 SSOT，不建立 event cache，也不把預約自動寫成 care timeline；完整的所有權與多租戶 OAuth 決策見 [ADR-001](../adr/001-calendar-ownership-and-agenda-access.md)。

前端在底部主導覽提供獨立的「行程／Jadwal」頁，永遠以 App 目前選定的 `patient_id` 查詢，可切換未來 7／14 天。切換照護對象或範圍時，render 階段就先隱藏上一個 scope 的內容並取消舊請求，避免上一人的就醫行程短暫出現在另一人姓名下；Demo 只顯示未連結提示，不呼叫私人 Calendar。

這個切分讓手機、外地電腦和排程都不需要保存家人的 Google OAuth refresh token，也避免把所有主日曆交給系統。service account 只能讀取被明確分享的次要日曆，權限為「查看所有活動詳細資料」即可；不要授予編輯者、不要分享個人主日曆。

## 帳號與 staging 測試對照（避免誤認）

這次已完成的通知不是病人本人日曆的正式通知，而是一個隔離的 staging 演練：

| 項目 | 實際使用者／資源 | 代表什麼 |
| --- | --- | --- |
| 建立假事件的 Google 帳號 | 主要家屬（owner）的 Google 帳號（實際帳號對照見 `docs/operations/staging-acceptance-accounts.md`，不進公開版） | 只用來在 Google Calendar 網頁建立 staging 假事件；它不是通知收件人的病人身分。 |
| 被讀取的 Calendar | （staging 專用測試副日曆，名稱略） | 專用測試副日曆；不是該帳號的主日曆，也不是病人本人的日曆。 |
| Calendar 唯讀身分 | `<calendar-notifier-sa>@<gcp-project>.iam.gserviceaccount.com` | Edge Function 使用的 service account，只能讀上面那本被明確分享的 staging 日曆。 |
| 病人本人在家健錄的帳號 | 病人本人帳號（同上文件） | 這次沒有讀取、寫入或修改該病人的資料；正式來源仍要另外綁定明確的 `patient_id`。 |
| Telegram | staging Supabase secrets 裡既有的 bot token／chat ID | 測試確實送出一則通用雙語提醒，但訊息沒有包含事件標題、地點或描述。 |

本次送出的通知來自 Supabase Edge Function `calendar-notifier`，不是 Vercel 前端，也不是既有血壓通知 Worker。第一次測試留下 1 筆 `sent`；第二次同一事件被去重跳過，沒有再送一次。測試來源已停用，病人本人的 production 資料與 production Calendar 都沒有碰到。

小朋友版：主要家屬帳號只是拿來在「測試日曆」放一張假紙條；service account 像只拿到那個抽屜鑰匙的郵差；病人本人帳號的抽屜完全沒有打開。

## 資料與隱私邊界

`calendar_notification_sources` 每列都帶明確 `patient_id`、Google Calendar ID、提前分鐘數與啟用狀態。`notification_deliveries` 只保存 source、patient、SHA-256 occurrence key、實例開始時間、提前分鐘數與送達狀態；key 只在 Function 記憶體中由 raw event ID、開始時間與 lead time 算出，永不保存原始 event ID。外鍵以 `(source_id, patient_id)` 再次驗證同一個病人，避免 source ID 被跨病人引用，而 delivery 自己保留當時的 lead time 作為去重稽核。**issue #1061 階段 D（migration `20261009093000`）之後 `notification_deliveries` 凍結**：`calendar-notifier` 不再寫它，去重改由 outbox 唯一鍵負責；殘留的 `pending` 已由退場 migration 終結，表與既有列保留供稽核與 sweeper 對帳。

日曆標題、description、location、attendee 與原始 Google 回應都不得寫入 Postgres 或 log。Telegram MVP 也刻意只送「請開啟 Google Calendar 看詳情」的繁中／印尼文通用提醒；這避免把日曆敏感內容複製到另一個聊天系統。未來若要顯示標題，需先經過明確的隱私設計與使用者同意。

授權照護者只能 SELECT 自己有 `care_access` 的病人來源與送達狀態；瀏覽器角色沒有 INSERT／UPDATE／DELETE 權限。設定來源和實際排程處理由 service role Edge Function 進行，RLS 仍保護一般 client，service role 僅可存在於 Supabase server secret。

行程頁的 `calendar-agenda` Function 是不同邊界：它需要已登入者 JWT，使用 caller RLS context 查詢 `patient_id + agenda_enabled=true`，不使用 service role。回應只在 React 記憶體使用並帶 `Cache-Control: private, no-store`；不得放入 localStorage、IndexedDB 或 PWA cache。

部署 acceptance gate：本次不碰 staging 資料或權限；套用 migration／Function 後，必須分別以主要家屬（owner）帳號與看護帳號實測讀取病人本人帳號對應病人的 7／14 天 agenda，並以未授權帳號確認 RLS 回傳未設定／拒絕而非日曆內容。這是既有核心照護授權不變量在 agenda 路徑的必要驗收，不可由前端隱藏按鈕取代。

## 去重與送達狀態

排程對每個 enabled source 以「現在往前 grace window」判斷是否到提醒時間，並向 Google 以加上 lead time 的事件開始窗口查詢。只取 timed event；取消和全天事件一律忽略，因為全天事件沒有可靠的分鐘級開始時間。

`(source_id, calendar_occurrence_key)` 是資料庫唯一鍵。key 已含 recurring event 的每個 occurrence 開始時間與 lead time，因此重疊的 Cron、短暫延遲或 API 重試都不會重送同一個提醒。

送達單先以 `pending` 保留，再在發送前切成 `sending`。Telegram 成功是 `sent`；已知 4xx 是 `failed_terminal`；網路中斷或 Telegram 5xx 是 `delivery_unknown`。後兩種尤其 `delivery_unknown` 不得由下一輪排程盲目重送，因為 Telegram 可能已收到但 HTTP 回應遺失。`sending` 也保留供人檢查，而不是自動猜測它沒有送出。

[ADR-007](../adr/007-notification-delivery-semantics.md) 票 1（issue #958，migration `20260926155217`）已把四張 delivery 帳本的 schema 對齊：每張表都有 `attempt_count`、`next_attempt_at`、`claim_token`、`claim_generation` 與 `resolution_source`（`runtime`／`migration`），`failure_code` 的正規值域統一為 `provider_*`（含新增的 `provider_rate_limited`、`delivery_expired`、`unattempted_abandoned`），`notification_deliveries` 與 `care_due_reminder_deliveries` 在票 9 contract 之前**同時**接受舊的 `telegram_*`（expand 窗口，讓仍在線上的舊分類器寫得進去）。既有的 `pending` 列依上線約束 1 逐表處理：這兩張 cron 帳本的 `pending` 一律改判 `failed_terminal` ＋ `unattempted_abandoned` 並標 `resolution_source = 'migration'`——它們沒有重試者，留著只是一個沒人取的抽屜。票 3（#960）已讓分類器直接產出 `provider_*`；票 4（#961）落地 D4：這兩條路徑**沒有重試者**，所以合法的 Telegram 429（可解析的錯誤封包）直接 `failed_terminal` ＋ `provider_rate_limited`、不寫 `pending`（D4 條件 0，由 D7 的零門檻告警立刻發出訊號），裸 429 一律 `delivery_unknown`；轉 `sent` 一律清空 `failure_code`（D2）。退場（#1061 階段 D，`20261009093000`）之前，兩支 Function 每一輪先把自己帳本裡「上一輪遺留」的 `pending` 終結為 `failed_terminal` ＋ `unattempted_abandoned` ＋ `resolution_source = 'runtime'`（`_shared/ownerlessPending.ts`，已刪除）；退場後兩張帳本沒有寫入者，殘留的 `pending` 由退場 migration 一次終結（`resolution_source = 'migration'`）。

## delivery sweeper：只告警、不重送（ADR-007 D7，票 6，issue #963）

四張 delivery 帳本（`personal_notification_outbox`、`care_due_reminder_deliveries`、`notification_deliveries`、`blood_pressure_notification_deliveries`）由 `notification-delivery-sweeper`（Cron 每 5 分鐘）呼叫資料庫函式 `run_notification_delivery_sweep()` 掃一輪，把需要有人看的列寫進 `notification_delivery_incidents`。**它只讀 delivery 表、只寫告警表、絕不呼叫 provider、絕不改任何 delivery 列**——這不是叮嚀而是資料庫權限：掃描函式由專屬角色 `notification_delivery_sweeper` 擁有（`SECURITY DEFINER` 以它的權限執行），該角色對四張表只有 SELECT（`SELECT … FOR UPDATE` 在權限層就是 42501，不會讓 `FOR UPDATE SKIP LOCKED` 的取件安靜跳過任何列），也沒有任何 claim／reserve／resolve RPC 的 EXECUTE。

四種掃描對象與起算欄位：`sending` 超過 M（10 分鐘，與 D9-b 的 fresh／expired 分界及 `_shared/deliveryPolicy.ts` 同一個值）以 `attempt_started_at` 起算；`delivery_unknown` 以 `resolved_at` 起算、門檻 0；`pending` 逾期以 `COALESCE(next_attempt_at, created_at)` 起算（10 分鐘）並另以 `created_at + 30 分鐘` 絕對期限；`failed_terminal` 門檻 0、落下即告警，**只有 `recipient_unauthorized` 不告警**（`recipient_unlinked`、`provider_rate_limited`、`delivery_expired`、`unattempted_abandoned`、`provider_http_4xx`、`provider_api_rejected`、`configuration_error` 都告警）。

每個 delivery 列最多一筆有效 incident，鍵是 `(delivery_table, delivery_id, source_created_at)`（`id` 的 `gen_random_uuid()` 不是不重用的保證），`alert_kind` 是屬性、隨狀態就地更新；來源走到 `sent` 就 `closed`；人為結案 `acknowledged` 之後 sweeper 只更新 `last_seen_at`，**重新開啟綁世代**（來源列的 `claim_generation` 前進才重開，與狀態變不變無關，也不看 `attempt_count`）。incident 帶非正規化 `patient_id`，INSERT 時以**不加鎖**的 SELECT 回查來源列 `(delivery_id, created_at)` 驗證相符，四個身分欄寫入後不可變；四張 delivery 表的 `patient_id` 與 `created_at` 由 `BEFORE UPDATE` trigger 凍結、`BEFORE DELETE` 連帶刪掉指向它的 incident；每輪掃描先對帳刪掉回查不到來源的孤兒。列上只有指標與授權鍵，不含訊息內容、數值、email 或 external id。

讀取：對該 `patient_id` 有 `care_access` 的登入者（RLS）。結案：`acknowledge_notification_delivery_incident(id, claim_generation)`（migration `20260928000000`），呼叫者須有 `care_access` **且** `can_record`，並交出畫面上看到的 `claim_generation_seen`：世代已前進（sweeper 就地重開同一筆 id）就回 `stale` 不結案、前端重讀，避免結掉一個照護者沒看過的新失敗；已非 open 回 `closed`；管理者身分只放寬 `can_record`、不放寬 `care_access`（沒有該病人 `care_access` 的管理者讀不到也結不掉）；`authenticated` 對 incident 表沒有直接 UPDATE。誠實上限：sweeper 帶來的是「100% 可稽核」，不是字面上的 100% 送達。

**告警的指名消費者（票 10，issue #974）**：「今天」頁頂端的 `NotificationIncidentBanner`（`src/features/today/components/`）讀該病人的 open incident（`src/lib/notificationDeliveryIncidents.ts`，以 `patient_id` 分區、RLS 再擋一次），三語、印尼文優先、大字高對比、左對齊；文字只說「有一則家人通知可能沒有送到，請直接聯絡家人確認」，**不含數值、收件人或訊息內容**。有 `can_record`（或管理者）的人看到一顆「已處理」，一次結掉該病人全部 open incident（15 秒原則，不逐筆點）；viewer 看得到橫幅但沒有按鈕。**Fail loudly**：incident 查詢失敗顯示「無法確認家人通知狀態」，不得顯示成沒有告警。切換病人時 hook 立刻清空並讓舊請求失效（§ 3.5），進行中的結案與失敗記號都以「病人＋incident」分區：不會讓新病人的按鈕卡在「儲存中」，結案失敗只在那筆 incident 仍 open 時顯示（被別人結掉或 sweeper 關掉就丟棄，之後重開也不再頂著舊失敗）；結案成功會讓還在路上的補查作廢，免得結案前拍下的快照把剛結掉的告警放回畫面。頁面停留期間每 60 秒背景補查一次（分頁隱藏時跳過）、回到前景（分頁重新可見／視窗取得焦點）立刻補查，sweeper 之後新開或重開的 incident 不會因為畫面沒動而看不到；補查等待期間舊清單留著、不閃「載入中」，補查失敗同樣顯示「無法確認」。展示模式沒有 Supabase，回空清單（沒有告警是正確答案）。**不用 Telegram 再發一則告警**：失敗的正是那條管道。票 2 的「移除 5xx 請求內重試」開關要等本橫幅上線、且 production 的 A6 sweeper Cron 確認存在後，才把 `IN_REQUEST_RETRY_DEFAULT` 改成 `false`（另開 follow-up）。

## 提醒排入失敗的可見性（issue #1251）

2026-10-14 owner 選定「Function 已觀察到的排入失敗」範圍。兩支提醒 Function 共用的 `reminderPersonalEnqueue.ts` 在重試耗盡或回應契約錯誤後，獨立呼叫 `record_reminder_notification_enqueue_failure`。這個 RPC 只給 service role，從仍有效的來源推導病人，確認存在付費且已綁管道的 `care_access` 成員，且該 occurrence 尚有合格收件人／管道未排入 outbox（每一位合格收件人皆已排入才壓抑失敗），且日曆行程初次嘗試時仍符合開始前兩分鐘以上的前置時間門檻，才寫入最小失敗紀錄 `reminder_notification_enqueue_failures`。免費／未綁定家庭、小於前置時間的行程不產生假告警；RPC 回應遺失但交易其實成功時，也不誤報漏排。

紀錄依日曆來源或到期提醒＋occurrence＋`failure_generation` 去重，只存來源、病人、雜湊／到期日、行程開始時間、建立時間與失敗代數；沒有行程標題、原始 Google event ID、數值或收件人。複合外鍵綁住來源的 `patient_id`，來源刪除時連帶清掉各代失敗紀錄與 incident；失敗紀錄本身不可修改。不能直接把 incident 綁到整本日曆：同一本日曆有多個行程，補排其中一個不應關掉另一個的失敗。

Migration `20261015103443` 為既有紀錄加上預設 0 的代數。只有 recorder **再次觀察到**合格收件人漏排，且最新收據已因補排完成而 `closed`、這次最後一次 enqueue 嘗試開始晚於其 `closed_at`，才追加下一代不可變收據，交由原 sweeper 建立新的 incident；舊 incident 保持 closed。這處理到期提醒補送窗口內新加入收件人的失敗。最新一代尚未 sweep、仍 open 或已人工 acknowledged 時都去重；舊請求延遲回來不追加。同一代的並行追加由唯一鍵收斂，不鎖 delivery。單純清理 outbox 加 sweep 不會新告警；清理後若又實際觀察到一次新的合格排入失敗，則是新的失敗事實。未採用直接重開舊 incident 或覆寫 receipt，避免舊的「已處理」動作誤消新告警，亦保留不可變歷史。

Migration `20261015110237` 讓 recorder 與既有 reminder sweep helper 在讀寫前，以獨立 statement 取得同一個 transaction advisory lock，避免 sweep 正在關閉或首次建立 incident、recorder 卻讀到舊 open／不存在而去重。兩端維持 `VOLATILE`，只接受 READ COMMITTED／READ UNCOMMITTED；固定快照交易回 `40001`，呼叫者須重開交易。鎖只序列化低頻失敗紀錄與 reminder sweep，持有到交易結束；正常 enqueue 與原四張 delivery 的 claim 不拿鎖，不增加來源寫入權。未採 incident 列鎖，因首次 INSERT 前沒有列可鎖；未包裝整個主掃描，因 reminder 寫入集中在既有 invoker helper。

recorder 新增可選的第六參數 `p_last_attempt_at`；Function 在每次 enqueue 發出前取時間，日曆資格仍用 `p_initial_attempt_at`，新世代使用最後一次嘗試開始時間，避免重試跨結案被首次時間壓掉。移除舊精確五參數簽章以免 PostgREST default overload 衝突；舊四／五參數呼叫仍能用，未送最後時間時保守沿用首次時間，故須先 migration、再部署兩支 Function。此時間是 Function 的嘗試開始界線，不能證明任意網路延遲／時鐘偏差下的 DB 執行先後；不用延遲回應完成時間推測新失敗，以免舊請求加 outbox 清理誤開告警。全域鎖適用目前低頻路徑，若量級上升才評估每 occurrence 鎖。

暫時失敗後重試若回傳 `0`，helper 仍呼叫失敗紀錄 RPC 釐清：日曆可能在等待期間跨過開始前兩分鐘截止線，`0` 只代表未新增列，不能證明補排成功。RPC 使用**初次**嘗試時間，回 `true` 時留下告警且 helper 回失敗；明確回 `false` 才視為本來無須排入或全體已排入；RPC 無法確認也回失敗並保留固定事件 log。首次呼叫直接回 `0`、或重試確實新增列則維持原成功行為。不改 enqueue 的截止線，也不在截止後強制送出提醒。

sweeper 對這張新來源只有 SELECT，沿用既有 incident 的鍵、patient RLS、結案 RPC 與三語橫幅，新增 `enqueue_failed` 種類；之後當所有合格收件人／管道皆出現同病人、同來源與 occurrence 的 outbox 列才關閉（部分收件人排入但仍有人未排入時保持 open，讓照護者看見漏排告警）。已關閉（closed）或已確認（acknowledged）的終態失敗在後續 sweep 中跳過 conflict update，避免歷史失敗累積造成 row version 膨脹與寫入放大；已人工處理的同一次失敗也不反覆打擾。若同時有其他送達告警，橫幅仍保留其他告警的提示。

**界線**：未執行的 cron、Google 讀取失敗，以及連失敗紀錄 RPC 都無法寫入的資料庫中斷，不能由這條路證明。失敗紀錄寫入失敗只留下固定事件名稱，原 cron 仍回 500，不假裝告警已保存。原本的 outbox `pending_overdue`（10 分鐘／30 分鐘絕對期限）保留，不改血壓 notifier，不增加重送。純 SQL 對帳未採用，因為資料庫沒有尚未排入的 Google 行程；owner 未把額外行程登記或排程健康偵測納入這一輪。

### 驗證配方（警報鏈變更，§8）

- 本機 helper 測試：重試新增列成功不記失敗；失敗後重試回 `0` 仍核對初次資格，區分漏排、全體已排入／不合資格與無法確認；重試耗盡／畸形回應各記一次；最後一次嘗試時間與首次資格分開；紀錄 RPC 拋錯、回錯、回應不合契約時不遮蔽原失敗、不洩漏輸入；兩支 cron 共用同一入口。
- 隔離 migration replay：日曆與到期提醒的付費／已綁定正例、免費／未綁定／停用／已封存反例、來源病人不匹配、client 權限拒絕、sweeper 無來源寫入權、不同 occurrence 分開告警、重跑去重、人工結案不重開、補排只關掉對應告警、來源刪除連帶清理；補排關閉後新增收件人失敗需新一代、延遲舊請求不追加、新一代去重／不可變、錯病人不能誤關、再補排關閉與 outbox 清理不重開。固定快照交易明確拒絕。另以兩條隔離連線驗證既有 open／尚無 incident、sweep／recorder 各自先拿鎖的四種順序；等待後新失敗仍 open，並覆蓋重試跨結案與真正延遲舊請求。既有核心照護授權與其他四種告警的完整 replay 一起跑。
- 前端測試：新 alert kind 可讀取；zh／id／en 都顯示提醒未排入；與其他告警混合時兩種提示都保留；既有切換病人／讀取失敗／結案流程保持。
- staging 驗收仍由 owner 在合併後用假家庭執行：暫時撤回 enqueue RPC 的 service-role EXECUTE → 呼叫任一提醒 cron → 還原權限 → 下一輪 sweeper 與「今天」頁確認告警 → 對**同一 occurrence** 補排 → 再掃描確認關閉。日曆測試須留足開始前時間，且由 owner 還原權限；Agent 不執行遠端資料庫寫入。

Migration 只新增空的失敗來源表、受限 RPC、來源綁定與 incident 種類／掃描規則，不回填歷史漏排、不改既有 delivery 狀態或照護授權。先套 migration 再部署 Function；舊前端不認得新種類，需與本次三語前端一起驗收。回滾 Function 會停止新增紀錄，既有告警仍可處理；不可為了回滾清掉未處理告警或重新開啟群組送達。

## Telegram 健康檢查：在看護遇到之前發現 bot 壞了（issue #1247）

sweeper 只在**已經有一筆通知送失敗之後**才告警。2026-10-08 production 的 `TELEGRAM_BOT_TOKEN` 失效時，是看護在畫面上先看到「家人通知沒有送出」。`telegram-health-check`（Cron，見 `docs/operations/cron-inventory.md` A8）定期主動檢查同一個 bot 的 token 與 webhook。那次事件「修好一層才露出下一層」共三層，第二層「bot 不在共用群組」已隨共用群組退場（issue #1061 階段 D）不再適用：現在 Telegram 只剩個人化私訊（drain 用 `TELEGRAM_BOT_TOKEN` 送）與綁定（`telegram-webhook`）兩條路，所以只檢查這兩層，也不讀 `TELEGRAM_CHAT_ID`：

| 順序 | Telegram 方法（唯讀） | 抓什麼 | 分類 |
| --- | --- | --- | --- |
| 1 | `getMe` | token 無效或被撤銷（401／404） | `token_invalid` |
| 2 | `getWebhookInfo` | 沒登記 webhook、登記到別的網址或訂閱的更新類型排除了 `message`、24 小時內有投遞錯誤 | `webhook_missing`／`webhook_mismatch`／`webhook_erroring` |

依序短路（token 壞了就不打 `getWebhookInfo`）；兩步都過才是 `ok`。5xx、429、逾時、連線失敗或回應讀不懂一律 `network_unknown`，**絕不當成 `ok`**。

- **只讀**：程式只認 `getMe`／`getWebhookInfo` 兩個方法（`TELEGRAM_HEALTH_ALLOWED_METHODS`，測試釘住）。`getChat` 雖然也是唯讀，但共用群組已退場，不再呼叫（靜態測試擋）。絕不呼叫 `sendMessage`（會打擾家屬）、`setWebhook`／`deleteWebhook`（維護者的一次性操作），也不呼叫 `getUpdates`（webhook 存在時回 409 並干擾投遞）。
- **webhook 比對**：期望網址由 `SUPABASE_URL` 推得（`<SUPABASE_URL>/functions/v1/telegram-webhook`），兩邊去掉結尾斜線後逐字比對。`allowed_updates` 有內容卻不含 `message` 也算 `webhook_mismatch`（`/start` 永遠送不到 Function；Telegram 在 `setWebhook` 省略它時沿用舊設定）。`last_error_date` 是 Unix 秒，Telegram 恢復後**不會清掉**，所以只有 24 小時內的錯誤才算 `webhook_erroring`。`pending_update_count` 刻意不看：短暫累積是正常的，單一門檻分不出真的在堆積。
- **升級**：除了 `ok` 與 `network_unknown` 以外的四類都是 provider 明確的答案，第一輪就升級；`network_unknown` 單次只記錄（回 200 加 `telegram_health_check_degraded` 警告 log），**連續兩輪**才升級。升級時 Function 回 **500** 並記 `telegram_health_check_failing`（error 等級）。**Supabase Cron 的執行紀錄不會因此顯示失敗**：Dashboard 的 HTTP Request Cron 透過 pg_net 非同步送出，`cron.job_run_details` 只記錄「請求已排入佇列」，Function 之後回什麼狀態碼都不影響它。所以目前看得到失敗的地方只有 Edge Function 的 Invocations／Logs（500、error log）與 `notification_provider_health` 表，**沒有任何人會被主動通知**。主動送達維運的出口由 #1246 決定，**不能**用同一個 Telegram bot 告警（失敗的正是那條管道）。
- **紀錄**：每輪寫入 `notification_provider_health`（migration `20261009030000`，每個 provider 一列），欄位是分類、判定步驟、HTTP 狀態碼、連續失敗次數、`failing_since`、`last_ok_at`、`last_checked_at`。不存也不記 token、chat id、webhook 網址或 Telegram 回應內容。只有 `service_role` 能讀寫，`authenticated`／`anon` 沒有任何權限；這張表不屬於任何病人，所以不走 `care_access`。為什麼不寫進 `notification_delivery_incidents`：那張表的每一列都綁一筆 delivery 與 `patient_id`（ADR-007 D7），系統層狀態放不進去。
- **查最近狀態**（維護者，SQL editor）：`select classification, failed_check, http_status, consecutive_failures, failing_since, last_ok_at, last_checked_at from public.notification_provider_health;`
- **`ok` 不代表 webhook secret 一致**：Telegram 登記的 `secret_token` 與 `TELEGRAM_WEBHOOK_SECRET` 不一致時，`telegram-webhook` 刻意回 200（避免 Telegram 重試），Telegram 不會記錯誤，`getWebhookInfo` 也不回傳 secret，所以健康檢查照樣判 `ok`，綁定卻全部被拒。被拒的請求本來就沒通過驗證，計入健康狀態等於讓任何人製造假警報，所以刻意不計（#1256 追蹤）。要確認 secret，仍用 staging runbook §5.3 的方法：手動私訊 bot `/start`，應收到「綁定連結已失效或不正確」；Function Logs 出現 `telegram_webhook_rejected` 就是不一致。
- **看不到的**：前端建置時的 `VITE_TELEGRAM_BOT_USERNAME` 與 bot 是否一致，Function 檢查不到（那是 Vercel 建置環境的值），仍是 issue #1247 的待討論項。

**staging 驗收**（獨立 bot、假資料；**不得在 production 製造失敗**），每一步手動觸發一次 Function、對照分類，做完還原：

1. 正常狀態下觸發，得到 `ok`。
2. 把 `TELEGRAM_BOT_TOKEN` 暫時改成無效值，得到 `token_invalid`／`getMe`／401，HTTP 回 500。
3. 還原 token，在本機以 staging bot 執行 `deleteWebhook`，得到 `webhook_missing`；之後依 `docs/operations/staging-edge-function-secrets-setup.md` 用同一個 `TELEGRAM_WEBHOOK_SECRET` 重新 `setWebhook`。
4. 全部還原後再觸發一次，回到 `ok`，`consecutive_failures` 歸零。

## 一次性平台設定（由維護者執行）

這些步驟只文件化；migration 不硬編碼 project URL、Cron token 或任何 secret，Agent 也不得自行執行：

1. 在 Google Cloud 建立專用 service account，建立 JSON key，並將該 service account email 以 reader 分享到新的次要 Google Calendar。不要改現有 GIS OAuth consent screen 或瀏覽器 scope。
2. 在 Supabase 專案設定 Edge Function secrets：`GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON`、`CALENDAR_NOTIFIER_CRON_SECRET`；可選 `CALENDAR_NOTIFIER_GRACE_MINUTES`（預設 7，範圍 1–60）。Telegram 送出在 `personal-notification-drain`（`TELEGRAM_BOT_TOKEN`），這支 Function 不讀任何 Telegram secret（#1061 階段 D）。Supabase 會為 Function 提供 `SUPABASE_URL` 與 `SUPABASE_SERVICE_ROLE_KEY`，不用也不能把它們提交到 repo。
3. 套用 migration、部署 `calendar-notifier` Function 後，建立 Supabase Cron job，例如每 5 分鐘以 `POST` 呼叫 Function，帶 `Authorization: Bearer <CALENDAR_NOTIFIER_CRON_SECRET>`。Cron 的 project URL 和 token 必須留在受控平台設定，不可寫入 SQL migration。ADR-007 票 6 之後另設 `NOTIFICATION_DELIVERY_SWEEPER_CRON_SECRET` 並替 `notification-delivery-sweeper` 建一條每 5 分鐘的 Cron（見 `docs/operations/cron-inventory.md` A6）。
4. 以 staging 的專用測試日曆建立一筆分鐘級行程，確認付費且已綁定的測試照護者收到私訊（舊共用群組沒有任何訊息）；接著確認同一行程在下一輪 Cron 不會在 `personal_notification_outbox` 多出一列（唯一鍵去重）。最後用未授權帳號確認 REST SELECT 被 RLS 拒絕，並用主要家屬（owner）帳號、看護帳號驗證可讀病人本人的通知狀態。

若 Calendar API、Telegram 或 secret 有問題，排程不會改動健康紀錄；只會留下不含日曆內容的聚合 Function log 與 delivery 狀態，方便維護者安全排查。

## 藥量與照護到期提醒（`care-due-reminders`）

issue #414 的提醒資料位於 `care_due_reminders`，每列都以明確 `patient_id` 分區；人類可建立回診、抽血、打針，寵物可建立疫苗、心絲蟲預防、驅蟲，兩者都可建立藥量倒數。RLS 的讀取沿用 `care_access`，寫入與管理要求同一位病人的 `can_manage_medication`，不使用 email、角色字串或前端隱藏作授權。每日照護入口偏好也以同一個 `patient_id` 保存，切換病人時不重用上一位的資料。

藥量到期日固定是領藥日期加上天數；其他類型只保存照護者明確輸入的日期（回診／抽血等非藥量型別另可記科別並連回一筆時間線事件或檢驗值，只是備忘來源、不影響到期判斷，見 `docs/architecture/data-model.md` 的 `care_due_reminders`）。門檻是每筆提醒可調的 1–180 天數，預設依類型提供；提醒畫面與 Telegram 只陳述類型、日期、剩餘或逾期天數，絕不推論病因、醫療結果或調藥方式。已送出的提醒保留送達紀錄（退場前是 `care_due_reminder_deliveries` 的 `ON DELETE RESTRICT` 外鍵；#1061 階段 D 之後是 `personal_notification_outbox` 列，由 migration `20261009110000` 的 `BEFORE DELETE` trigger 以同一個 SQLSTATE 23503 擋下），因此只能改成「略過」，不能刪除歷史。

**訂閱的寫入路徑（ADR-007 票 5，issue #962，migration `20260926164959`）**：`notification_subscriptions` 決定「哪個 patient 可以用專案擁有的共用 Telegram 目的地」（SEC-20260908-01），它**不是照護權限的一部分**。唯一的開通／停用入口是 `SECURITY DEFINER` RPC `set_notification_subscription(patient_id, channel, enabled)`：呼叫者必須**同時**是管理者（`is_admin_email`）**且**對該 patient 有 `care_access`——只有 `care_access`（含 owner、可記錄者）不夠，管理者身分也不是繞過 `care_access` 的旁路；停用寫 `enabled = false`、不刪列；`channel` 只收正規詞彙表 `telegram | line | push`（與 `personal_notification_outbox.channel` 同一份，只擴充不移除）；每一次變更由 ADR-008 的 `record_change_logs` 留痕（只記 `auth.uid()`、原值、新值、時間）。`authenticated`／`anon` 對表本身仍沒有任何 INSERT／UPDATE／DELETE，repo 內也不得有其他寫入路徑（`tests/unit/notificationSubscriptionWritePathMigration.test.ts` 掃原始碼）。**合法 caller（issue #994）**：後台開關 UI（`AdminPage` 的「通知訂閱」分頁／`NotificationSubscriptionsPanel`）透過 `src/lib/notificationSubscriptions.ts` 以管理者登入 session 呼叫 `supabase.rpc('set_notification_subscription', { p_patient_id, p_channel, p_enabled })`，大字、三語，不顯示任何 chat id 或 external id，並精確轉譯非管理者或無 care_access 的 RPC 錯誤訊息。**不能用 Supabase Dashboard 的 SQL editor**：它不帶應用 JWT，`auth.uid()` 為空，RPC 一定回 `Authenticated user with email required`；而且那是需要事前明確核准的直接資料庫操作（AGENTS.md § 3.2）。

**共用群組已退場（issue #1061 階段 D，migration `20261009093000`，2026-10-09）**：全域 `TELEGRAM_CHAT_ID` 指向的共用 Telegram 群組是單一家庭時期的設計——第二個家庭的病人一旦被接上，他們的姓名與讀數就會出現在別人家的群組。#1100（migration `20261005155025`）先把它釘在恰好一個家庭當閘門，#1101（#1059，免費危險級個人 Telegram）與 #1110（#1104，提醒的個人送達路徑）讓每個家庭都有自己的路之後，退場 PR 一次拆掉：

- **資料面**：所有 `notification_subscriptions` 的 `telegram` 列停用（`record_change_logs` 以 `app.audit_source = 'issue_1061_retire_shared_telegram_group'` 留痕；列保留，ADR-007 D6 不刪列），並以 BEFORE trigger `refuse_retired_shared_telegram_subscription` 讓 telegram 列**不可能再被啟用**（停用與 line／push 不受影響；後台把拒絕訊息轉成三語「共用群組已退場，家人改走個人通知」）——上一版 `blood-pressure-notifier` 走 SECURITY DEFINER 的 reserve／resolve RPC，帳本的 REVOKE 碰不到它，它唯一的開關就是這個旗標；四個 guard trigger、七支判定函式與釘選表 `shared_telegram_group_household` 移除（釘選列先帶稽核 DELETE 再 DROP TABLE，稽核表留有 delete 列）；`notification_deliveries`／`care_due_reminder_deliveries` 凍結（還在 `sending` 的列先改判 `delivery_unknown` ＋ `provider_network_unknown`——REVOKE 之後沒有送出端能寫回終局，停在 `sending` 會變成一筆永遠結不掉的 `sending_stale`；殘留 `pending` 終結為 `failed_terminal` ＋ `unattempted_abandoned`；兩者 `resolution_source = 'migration'`；再 REVOKE 所有 API role 的 INSERT／UPDATE／DELETE；表與既有列保留供稽核、restore drill 與 sweeper 對帳）。收寫入權同時解決部署順序問題：workflow 先 `db push` 再 `functions deploy`，窗口內（或 Function 部署失敗時）上一版 cron Function 仍在跑，但它們送群組前先對帳本 INSERT 取單，取單被拒就不送、個人化排入照做。`calendar_notification_sources.enabled` **不動**：它只剩「這本日曆要不要排個人化私訊」一個意思，任何家庭都能啟用。
- **程式面**：`blood-pressure-notifier`、`calendar-notifier`、`care-due-reminders` 不再讀 `TELEGRAM_BOT_TOKEN`／`TELEGRAM_CHAT_ID`、不再送 Telegram、不再寫群組帳本、不再查 `notification_subscriptions`；`TELEGRAM_CHAT_ID` 從 `required-secrets.json` 移除（staging／production 的 secret 留著不礙事，沒有任何 Function 讀它）。部署計畫（`scripts/functionSecrets.ts` 的 `FUNCTION_DEPLOY_DEPENDENCIES`）把這三支列為 `personal-notification-drain` 的下游：drain 因缺 secret 被擋時，三支生產者跟著維持上一版，不會出現「排入成功、沒人排空」的新版。每一則通知只走 `personal_notification_outbox` → `personal-notification-drain`，誰綁定誰收到，別的家庭永遠看不到。
- **隱私權政策升版 2026-10-09**（migration `20261009110000`）：接收者從「owner 家的共用群組」縮成「各自綁定的家人」，`notificationProviderDisclosures.ts` 不再提家庭群組與維護者開通；條款與健康同意不升。同一支 migration 加上到期提醒的刪除守門（見「藥量與照護到期提醒」）。
- **延遲**：危險血壓的送達從即時變成最多約 60 秒（A1 每分鐘排空），owner 的二選一定案為接受並記錄（理由見 [`personal-notifications.md`](personal-notifications.md)「決策一」的取捨）。
- **後台「通知訂閱」分頁**：`set_notification_subscription` RPC 與表仍在（D6 契約），但 telegram 開關切回啟用會被上述 trigger 拒絕（三語說明改走個人通知）；分頁與表的退役在 #1252，拆它們時連 trigger 一起拆。
- **restore drill**：`supabase/tests/rls-authorization.sql` 的 #1061 區塊改成退場斷言（表、函式、trigger 不存在；沒有 enabled 的 telegram 訂閱；兩張帳本沒有 pending；別家的日曆來源能直接啟用），SEC-20260908-01 的核心病人訂閱斷言改成「列仍在、已停用」。
- **production 切換前置**（owner 動作）：A1 drain 與 A6 sweeper 的 Cron 在 production 必須先存在，否則合併進 `main` 等於拆掉唯一的血壓通知路徑而沒有替代；核心照護帳號（AGENTS.md § 3.4）已完成個人綁定；要收提醒與非危險級血壓的人已設為付費 tier。清單見 [`production-secrets-cron-webhook-checklist.md`](../operations/production-secrets-cron-webhook-checklist.md)。
- 退場前的閘門規則、釘選 runbook 與換群組主人的程序，見 git 歷史裡本節 2026-10-05～10-08 的版本；migration `20261005155025` 的檔頭註解也完整保留。

排程 Function `care-due-reminders` 使用 `CARE_DUE_REMINDERS_CRON_SECRET`，以台北日曆日判斷門檻。issue #1104 之後它讀**所有病人**的 active 提醒並以 keyset 分頁讀到空頁；#1061 階段 D 之後它只做一件事：對到期且在 7 天補送窗口內的提醒呼叫 `enqueue_reminder_personal_notifications`（去重由 outbox 唯一鍵負責，`occurrence_key` 是到期日），不再讀 `notification_subscriptions`、不再寫 `care_due_reminder_deliveries`、不再送 Telegram；回應與 log 只有計數（`due`、`outsideCatchUpWindow`、`personalQueued`、`personalEnqueueFailures`）。Staging 手動 gate 是設定 secret、部署 Function、建立每日 Cron，再用兩個已授權照護者與一個未授權身份驗證同病人 read/write 的正反向結果；本 repo 不會自動接 production 或執行遠端 migration。

## 個人化私訊（issue #1104）

日曆提醒與照護到期提醒排進個人化通知 outbox（`notification_kind` 為 `calendar_reminder`／`care_due_reminder`），由 `personal-notification-drain` 送到每位收件人自己綁定的 Telegram／LINE。這原本是 #1061 階段 D 的前置（先讓提醒有第二條路，再拆第一條）；2026-10-09 群組退場後它是提醒**唯一**的送達路徑。

- **誰收得到**：該病人的 `care_access` 成員、已綁定管道、`personal_notification_tier = 'personal'`。提醒沒有免費路徑（ADR-011 D3 只讓危險級血壓的 Telegram 免費）。排入與送出前各驗一次。
- **怎麼排入**：兩支 cron Function 對每個到期 occurrence 呼叫 `_shared/reminderPersonalEnqueue.ts` → `enqueue_reminder_personal_notifications`（只有 `service_role` 能執行，`patient_id` 由來源列推導）。#1061 階段 D 之後沒有群組路徑：helper 對暫時性失敗（RPC error、連線被重置）在同一輪內退避重試（最多 3 次，間隔 0.5 秒、2 秒；RPC 冪等所以安全），回應形狀壞掉不重試；最終失敗只累計、不 throw，不影響同一輪其他 occurrence。誠實的邊界：500 只讓這次失敗在 Supabase 的 Function 呼叫紀錄裡是紅的，目前沒有任何告警在看 cron 的回應，排入失敗也沒有 outbox 列給 sweeper 掃；對沒有共用群組的家庭，私訊是唯一的路，照護者看得到的訊號是 #1061 第二步的工作。補排的機會因 cron 而異：到期提醒每天跑、逾期 7 天內每天都會再排一次；日曆的 grace window（7 分鐘）與 cron 間隔（5 分鐘）只重疊約 2 分鐘，大多數行程下一輪已經看不到，排入失敗就是漏掉。
- **讀取範圍**：`care-due-reminders` 讀所有家庭的 active 提醒，以 `due_date <= 今天＋180 天`（threshold 上限）、依 `id` 做 keyset 分頁（`id > 上一頁最後一個 id`，每頁 500 列）一路讀到空頁；PostgREST 的 `max_rows`（1000）會不報錯地截斷單一查詢，而「不滿一頁就停」在 max_rows 被調小時同樣會漏讀。到期提醒的私訊只補到逾期第 7 天，群組路徑不受影響。
- **訊息**：純文字三語，標題帶照護對象顯示名稱。日曆寫台北時間的開始時刻（drain 每分鐘取一次，「N 分鐘後」會不準），仍然不放行程標題、地點、描述；到期提醒與群組版共用同一段內文。
- **何時不送**：
  - 照護對象已封存（例如走掉的寵物）→ 不排、送出前也再擋一次：`archive_household_pet` 不會動它的提醒，卻把所有人降成唯讀，沒有人能再把提醒標成完成。
  - 排入時行程已經開始或兩分鐘內就開始 → 不排，沒有列、也沒有告警。cron 每 5 分鐘才跑一次，所以 lead time 少於 7 分鐘（cron 間隔＋2 分鐘）的日曆，有一部分行程第一次被看到時已經不到兩分鐘，私訊會被略過；lead time 1–2 分鐘的日曆永遠不會排私訊。日曆來源的 lead time 請設至少 7 分鐘。
  - 日曆來源已停用、提醒已完成／略過、到期日改了、照護對象在途中被封存 → `failed_terminal` ＋ `source_withdrawn`（#1112）。只有成功讀到並確認這些狀態才使用此碼；查詢失敗、來源缺失或病人不符仍是 `configuration_error`，血壓缺紀錄也仍告警。若收件人在排隊期間解綁但提醒已確認撤回，亦優先判定為 `source_withdrawn` 避免誤報，未撤回的有效提醒仍保留 `recipient_unlinked`。sweeper 不為撤回新開 incident，已因 pending／sending 逾時開出的 incident 會關閉；不重送、不抹掉帳本。
  - 排入後、送出前行程才開始 → `delivery_expired`。
- **過渡期**：被釘住家庭裡付費又綁定的人會收到兩則（群組＋私訊），與 personal-notifications 階段 C 相同。日曆來源仍受上面 #1061 閘門限制（啟用中的來源＝群組路由），所以日曆私訊目前只有被釘住的家庭用得到；到期提醒的私訊涵蓋每個家庭。

### 已撤回提醒的部署與驗證（issue #1112）

Migration `20261013205549_reminder_source_withdrawn.sql` 只擴充 outbox 的 failure CHECK，另限制 `source_withdrawn` 必須是提醒 kind 的終局；不改 RLS、care_access、五值狀態機或其他三張帳本。sweeper 保持原有 owner、ACL 與不重送，只調整新告警與關閉既有告警的述詞；#1251 helper 的生命週期交易鎖維持原樣。

先套 migration，再部署 drain。舊 drain 在部署窗口仍可能寫 `configuration_error`；**不回填**這些舊列，因為歷史上可能是真正的查詢／資料錯誤，不能用現在的來源狀態猜當時原因。回退 drain 可保留新 schema；既有 `source_withdrawn` 列仍不重送。

為保留 PR #1291（#1251）同時擴充的 enqueue-failure 掃描，migration 以固定 `regprocedure` 讀取現行函式，只替換兩個逐字錨點；每個錨點出現次數不是一就中止整筆 migration，不以整份舊函式覆寫其他功能。未來若先改了這兩個述詞，合併時必須重新核對並重播，不可移除錨點檢查。

**合併／套用順序：PR #1291 先、#1112 後。** #1291 仍以整支函式取代 sweeper；即使它的 migration 時間戳較早，若它在 #1112 已部署後才透過 `--include-all` 補套，仍會覆寫撤回規則。合併本 PR 前須確認 #1291 已成功套用 staging，更新本 PR 基線與快照再重播；若刻意反過來，#1291 必須先補相容修正。單靠空資料庫按時間戳重播不能證明反向部署安全。

2026-10-15 整合檢查：#1291 已以 `0fb5474f` 合併 staging，其 [migration workflow](https://github.com/demo-xq7/jia-jian-log/actions/runs/38726201299) 的套用步驟成功。本 PR 已同步 staging `2c582f2f`，從全部 migration 重建 schema 快照並通過五份 SQL 測試（含 #1251 漏排與 #1112 撤回回歸）。整合保留漏排 helper、世代／交易鎖與既有權限；沒有新增 migration。這只完成前置與本機整合驗證，hosted staging 的 Cron → drain → sweeper → 今天頁驗收仍待完成。

驗證配方（僅 staging 假病人、已付費且綁定的測試照護者）：

1. 排入一筆 active 到期提醒，在 drain 前標成完成／略過或改期，確認不呼叫 provider，outbox 是 `failed_terminal/source_withdrawn`，sweeper 後沒有新 incident；改期後的新 occurrence 仍可送出。
2. 同樣驗證日曆停用、照護對象封存。另用本機 SQL fixture 建立已逾期的 pending／sending incident，轉為 `source_withdrawn` 後確認 open 與 acknowledged 都關閉，多輪掃描不重開。
3. 反例：缺血壓紀錄、提醒來源缺失、病人不符或查詢錯誤仍為 `configuration_error` 並告警；日曆自然開始仍走 `delivery_expired`，不視為主動撤回。

PR #1299 的期限補修（`20261015080000_reminder_withdrawal_deadline.sql`）：

- 有效截止是 `created_at + 30 分鐘`；日曆另取行程開始時間的較早者。**撤回必須嚴格早於截止**，等於或晚於截止仍保留 `delivery_expired` 告警；不能事後完成就抹掉先前漏送。
- 來源的既有 `updated_at` 沒有 DB 維護，不能作時間證據。兩張來源表新增 nullable `notification_source_changed_at`，由 trigger 的 `clock_timestamp()` 產生；到期提醒只在 status／due_date 改變時更新，日曆只在 enabled 改變時更新。INSERT 忽略呼叫者提供的時間，無關編輯保留 OLD，避免偽造或筆記編輯改寫撤回證據。原 `patients.archived_at` 仍是封存證據。
- v1／v2 claim 在原本直接逾期的 pending 列上，先確認同病人來源和撤回時間，再寫 `source_withdrawn`；改期比較使用 `to_char(due_date, 'YYYY-MM-DD')`，與排入時的 occurrence key 相同，不受呼叫者 `DateStyle` 影響，避免仍有效但已逾期的提醒被誤當撤回而漏報。其餘仍走原逾期規則。未逾期的取件順序、血壓優先、token、世代與鎖不變。這避免 drain 中斷後恢復時繞過撤回分類。
- 不回填舊的來源時間；缺乏可信時間的已撤回來源保留告警，有效 active 來源仍正常送出。不回填 sent、provider 終局失敗、delivery_unknown 或任何既有終局。最近一次來源狀態變更不能還原完整歷史，若撤回後又改狀態／日期，仍以可證明的最近變更時間判斷。
- 先套兩支 migration，再部署新版 drain。這是新增 metadata 與 trigger，不改 RLS 或 care_access；trigger 不增加讀取權限。回退 drain 時保留新增欄位與 trigger，避免丟失之後的時間證據。staging 另補測 29:59 取件、30:01 完成及逾 30 分鐘才恢復 drain 的情境。

本機自動證據是 `reminderSource.test.ts` 的真實讀取函式＋假 client、`personalNotificationDrainFunction.test.ts` 的寫回契約，以及 `rls-authorization.sql` 的 sweeper／CHECK／不重取／核心照護授權斷言。它們不取代 staging 的 Cron → drain → sweeper → 今天頁端到端驗收。

## 回滾與限制

暫停通知優先把 source 的 `enabled` 設為 false，而不是刪除 delivery audit。#1061 閘門若要回滾，DROP 那四個 `guard_*` trigger 即恢復舊行為，不需動資料；不要用「刪掉釘選」來替別的家庭開通。若需回滾程式，先停用 Cron，再停用來源；既有 `delivery_unknown` 不可為了補送而改回 pending。移除資料表或大量刪除通知紀錄屬於破壞性資料操作，需另行明確授權。
