<!--
檔案用途：定義個人化通知（病人家庭 Premium 與免費危險級 Telegram）的架構決策、資料邊界與分階段實作計劃。
所在層：docs/features；記錄 server-side 通知的既有實作與分階段擴充，不取代 notifications.md 的日曆／到期提醒規格。
主要關聯：blood-pressure-notifier、personal-notification-drain、household_entitlements、docs/adr/003-personal-notification-channels.md 與 docs/features/notifications.md。
-->

# 個人化通知 / Personal Notifications

> **狀態：已分階段落地。** 下方保留原始決策與上線歷程；目前個人化通知以 outbox 送達，#1179 把加值判定切到病人家庭。實際部署狀態仍依 staging／production 驗收紀錄判斷。

## #1179：以病人家庭判定加值，免費危險級獨立

- 血壓 v2 enqueue 已用 `current_care_access(patient_id)` 驗記錄者、用 `recorded_by` 確認紀錄，再替該病人的 `care_access` 成員排通知。付費段改為「病人家庭 Premium **或**收件人的舊 `personal_notification_tier`」；`personal_notification_extras` 全域暫停在這個 OR 外。沒有舊旗標列的家庭 Premium 成員照樣能收到。免費危險級 Telegram 的第二段 INSERT 逐字不改，也不讀任何付費表；前面的付費 INSERT 另用子交易攔住查詢錯誤，才不會在免費 INSERT 前把整筆呼叫中止。非危險級的付費查詢錯誤仍回報呼叫端。
- 提醒 enqueue 從來源列推導 `patient_id`，用 service role 專用的受限資格 helper 檢查病人家庭 Premium、舊旗標與全域暫停；不可用 authenticated 版 helper，因為 cron 沒有 `auth.uid()`。提醒漏排收據與 sweeper 也用相同 helper，才不會因照護者自己沒舊旗標而漏記家庭 Premium 的排入失敗或提早關閉告警。sweeper 仍是 `SECURITY INVOKER`，只能讀資格布林值，不直接讀寫付費表。提醒沒有免費分支。
- drain 每列先重驗 `care_access` 與綁定。Telegram 血壓先重讀病人紀錄和量測當下標準，重算免費危險級；符合時直接送出，不查家庭、訂閱、付款或舊帳號 tier。其餘列才讀 `paid_feature_suspensions`、trusted 家庭 helper 與舊旗標。排入時 Premium、送出前降級的警告／LINE 列寫 `recipient_unauthorized`；LINE 綁定本身保留。付費資格資料暫時讀取失敗時尚未呼叫 provider，列延後一分鐘重驗且不耗送出次數；既有 30 分鐘期限仍由 claim RPC 執行，避免資料庫故障被誤判為永久撤權。
- `create_messaging_link_token('line')` 先要求呼叫者對至少一位病人有 `care_access`，再檢查其中任一病人的家庭 Premium 或舊旗標，且全域暫停未啟用。Telegram 仍只要求有 `care_access`。`current_messaging_link_status` 回傳同一個「此刻可否綁 LINE」結果，否則設定頁按鈕會與 RPC 閘門矛盾。

**設計取捨**：付費單位是病人的家庭，不能拿收件人 email 或其自有家庭代替（看護可同時服務兩家）。舊旗標只為 H7 前的過渡並讀，不做 migration 回填真人帳號。暫停不可放在 OR 裡，否則舊旗標會繞過止血開關。也不把家庭查詢塞進免費危險級：付費表故障或降級不能讓安全警報漏送。此變更不改舊兩參數 enqueue，直到部署中的舊 caller 退場證據齊備。

**驗證與上線閘門**：`tests/unit/freeDangerPaidIsolation.test.ts` 比對免費扇出原文、檢查讀取順序與付款 migration；drain 單元測試驗降級三情境；`supabase/tests/rls-authorization.sql`「#1179」以兩個假家庭、假讀數驗入列、提醒、LINE、暫停與舊旗標，並注入付費查詢錯誤，驗免費危險級照排、提醒漏排告警從建立到完整補排才結案。`supabase/tests/reminder-enqueue-failures.sql` 鎖定 sweeper 僅能呼叫受限資格 helper。合併前還需依 `docs/product/monetization-plan.md` §5.5 第 5、6 層在 staging 用假家庭與開發者 Telegram 實測，去識別化證據留 PR。SQL／單元測試不能代替手機收到通知的證據。

## 目的與範圍

退場前，`blood-pressure-notifier`、`calendar-notifier`、`care-due-reminders` 三支 Edge Function 都讀同一組全域 secret `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`，所有病人的所有通知都送進同一個家庭群組，沒有「誰收到什麼」的概念。**2026-10-09 起（issue #1061 階段 D，migration `20261009093000`）這條路徑已移除**：三支 Function 不再讀 `TELEGRAM_CHAT_ID`，每一則通知只走下方的 outbox。

issue #1061 先把這個群組在資料庫層釘在**恰好一個家庭**（閘門，migration `20261005155025`），再於階段 D 整個退場（migration `20261009093000`）；退場紀錄見 [`notifications.md`](notifications.md)「共用群組已退場」。

本計劃讓**被標記為付費的帳號**綁定自己的 Telegram **與／或** LINE，各自收到專屬通知。

本輪範圍**只有血壓通知**；日曆通知與照護到期提醒維持現狀，不在這次改動範圍內。付費狀態**先由維護者手動標記**，不接金流。

**2026-10-06 擴充（issue #1104，#1061 階段 D 的前置）**：日曆提醒與照護到期提醒也走同一個 outbox（`notification_kind` 為 `calendar_reminder`／`care_due_reminder`），只給付費且已綁定的 `care_access` 成員（ADR-011 D3：提醒類的個人送達屬付費）。過渡期群組照送、付費又綁定的人收到兩則（與階段 C 相同）；階段 D（2026-10-09）退場後只剩私訊一則。細節見下方 outbox 一節與 [`notifications.md`](notifications.md)。

## 決策一：external id 永遠不離開資料庫（outbox 模式）

`blood-pressure-notifier` 是 caller-scoped 邊界：`withSupabase({ auth: 'user' })`、套 RLS、**沒有 service role**。`tests/unit/bloodPressureNotifier.test.ts` 有一條 `expect(source).not.toContain('SUPABASE_SERVICE_ROLE_KEY')` 把這個姿態鎖死。它讀不到別的照護者的 chat id。

而一個「回傳 chat id」的 `SECURITY DEFINER` RPC **會被 PostgREST 曝露**——任何登入的照護者都能直接在瀏覽器呼叫它，等於外洩全家人的 Telegram／LINE ID。這是本設計要擋掉的核心風險，也是為什麼不採用「查出收件人後直接送出」這個較直覺的做法。

因此改為 outbox（收件匣）模式：

```
存血壓
  → blood-pressure-notifier（JWT、caller-scoped，姿態不變）
  → RPC enqueue_blood_pressure_personal_notifications_v2(record_id, patient_id, alert_level, free_danger) → 回傳三種狀態的筆數
  → personal_notification_outbox 只存 recipient_user_id + channel
    （不存 external id、不存訊息內容）
  → personal-notification-drain（Cron + service role）解析 external id、重讀紀錄、
    依管道 render、送出、寫回逐筆狀態
```

**取捨**：血壓通知從即時變成延遲最多約 60 秒（pg_cron 最小間隔 1 分鐘）。換來的是重試、去重、逐收件人逐管道的稽核狀態——這三件事正是既有 `notification_deliveries` 與 `care_due_reminder_deliveries` 已經在做的。對照護場景而言，一分鐘內的延遲遠比「偽造或漏送」風險小。

**延遲目標定案（issue #1061 階段 D，2026-10-09）**：共用群組退場後 outbox 是危險血壓唯一的送達路徑，延遲最多約 60 秒對所有家庭都成立（owner 在 staging 實測個人路徑約晚一分鐘）。二選一取 (1)「接受並記錄」：(2)「危險級排入後立刻觸發一次 drain」需要 notifier 持有能叫 drain 的憑證，而這支 Function 刻意只拿登入者 JWT、不持 service role 也不持 cron secret（這正是 outbox 設計要守的邊界，`bloodPressureNotifier.test.ts` 鎖死）；從資料庫 trigger 以 pg_net 打 drain 則把排入與送出綁回同一個交易。owner 日後要縮短時另開票評估，不改這條邊界。

## 決策二：一個付費旗標，管道自選

`personal_notification_tier`（`'none' | 'personal'`）**不分管道**。付費解鎖的是「個人化通知」這個能力；使用者自己決定綁 Telegram、綁 LINE，或兩個都綁——都綁就兩邊都收得到。

這避免日後每加一個管道就要改一次授權模型，也讓「付費」在資料上只有一個真實來源。

**2026-10-05 語意收斂（issue #1059、[ADR-011](../adr/011-paywall-safety-boundary.md) D3）**：危險等級（`danger`／`danger-low`）的血壓個人 **Telegram** 通知對該病人所有 `care_access` 成員免費；`personal_notification_tier` 改為管「危險級以外的等級＋LINE 管道＋提醒類」。旗標本身仍是帳號級一欄，但綁定閘門變成管道別：Telegram 任何有照護對象的帳號都能綁，LINE 仍要付費。

## 決策三：LINE 的範圍澄清

`TODO.md` §0 有一條已勾選的決定「不在此 repo 新增 LINE webhook endpoint」，但同檔 P0 待辦又寫「通知管道改用 LINE Messaging API（LINE Notify 已終止）」。

§0 的原意是**不把 `../appscript` 的 LINE bot 當「輸入端」搬進來**（照護者用 LINE 打字記錄血壓）；legacy GAS 已於 2026-10-06 決定退役（紀錄在 `LEGACY_GAS_RETIREMENT.md`），血壓只從 web app 輸入，本 repo 仍不做 LINE 輸入端。本計劃新增的是**輸出端**的通知綁定 webhook，兩者不衝突。

完整決策記錄見 [`docs/adr/003-personal-notification-channels.md`](../adr/003-personal-notification-channels.md)。

## 資料模型

一支 migration：`supabase/migrations/<timestamp>_add_personal_notification_channels.sql`。

### `user_messaging_links` — 瀏覽器完全讀不到

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `user_id` | UUID NOT NULL → `auth.users(id)` ON DELETE CASCADE | |
| `channel` | TEXT NOT NULL CHECK IN (`telegram`,`line`) | |
| `external_id` | TEXT NOT NULL | Telegram chat id 或 LINE userId |
| `linked_at`, `updated_at` | TIMESTAMPTZ | |

PRIMARY KEY `(user_id, channel)`；UNIQUE `(channel, external_id)`（一個 Telegram／LINE 帳號只能綁一個 App 帳號）。

`ENABLE ROW LEVEL SECURITY` + **不建立任何 policy** + `REVOKE ALL ... FROM PUBLIC, anon, authenticated`（**不 GRANT SELECT**）。連使用者自己的 external id 都不回給前端——UI 只需要知道「已綁定／未綁定」。

`external_id` 用 TEXT 而非 BIGINT：Telegram chat id 是數字，LINE userId 是 `U` + 32 hex，必須共用一欄。

以 `auth.uid()` 為鍵而非 email，沿用 `user_settings`（`20260808090000`）立下的「帳號設定用 UID、健康資料授權用 email」慣例。

### `messaging_link_tokens` — 一次性綁定券

`token_hash TEXT PRIMARY KEY CHECK (~ '^[0-9a-f]{64}$')`（只存 SHA-256）、`user_id`、`channel`、`created_at`、`expires_at NOT NULL`、`consumed_at`。部分索引 `(user_id, channel) WHERE consumed_at IS NULL`。

RLS on、無 policy、`REVOKE ALL`。原始 token 只在「回傳給發起者」那一次存在，資料庫裡永遠只有 hash。

### `personal_notification_outbox`

`id`、`recipient_user_id`、`channel`、`patient_id` → `patients(id)` ON DELETE RESTRICT、`notification_kind` CHECK IN (`blood_pressure`, `calendar_reminder`, `care_due_reminder`)、`source_record_id`、`occurrence_key`、`occurrence_at`、`status`、`provider_http_status`、`failure_code`、`created_at`、`attempt_started_at`、`resolved_at`。

去重唯一鍵：`UNIQUE NULLS NOT DISTINCT (notification_kind, source_record_id, occurrence_key, recipient_user_id, channel)`（issue #1104，migration `20261005155810`；之前是不含 `occurrence_key` 的四欄鍵）。血壓列的 `occurrence_key` 一律 NULL，NULLS NOT DISTINCT 讓它的去重與舊鍵完全相同。

**提醒列（issue #1104）**：`source_record_id` 指向來源列，不指向群組的送達單——那兩張帳本記的是「共用群組這一次送出」，退場（階段 D，2026-10-09）後已凍結、不再寫入。

| kind | `source_record_id` | `occurrence_key` | `occurrence_at` |
| --- | --- | --- | --- |
| `blood_pressure` | `blood_pressure_records.id` | NULL | NULL |
| `calendar_reminder` | `calendar_notification_sources.id` | calendar-notifier 既有的 SHA-256（raw event id＋開始時間＋lead time；不存 raw id） | 行程開始時間 |
| `care_due_reminder` | `care_due_reminders.id` | 到期日 `YYYY-MM-DD` | NULL |

形狀由 `personal_notification_outbox_occurrence_shape_check` 綁死，提醒列也不得帶 `alert_level`。排入只走 `enqueue_reminder_personal_notifications(kind, source_record_id, occurrence_key, occurrence_at)`：`SECURITY DEFINER`、**只有 `service_role` 能執行**（兩支 cron Function 經 `_shared/reminderPersonalEnqueue.ts` 呼叫）；`patient_id` 一律由來源列推導；照護對象未封存（封存後沒有人能把提醒標成完成）、日曆來源要 `enabled` 且行程還沒開始、也不是兩分鐘內就開始（cron 每 5 分鐘才跑，lead time 少於 7 分鐘的日曆可能在開始前不到兩分鐘、甚至開始後才第一次看到行程；排進去只會被 drain 判 `delivery_expired`、讓 sweeper 發假警報；lead time 1–2 分鐘的日曆因此永遠不排私訊）、到期提醒要 `active` 且到期日等於 `occurrence_key`，否則回 0；收件人條件為該病人的 `care_access` × 已綁管道 × 病人家庭 Premium 或收件人舊旗標，且全域暫停可一律停止；提醒沒有免費路徑。RPC 冪等，cron 每一輪對每個到期 occurrence 都呼叫，放在群組送達單去重之前，晚綁定或剛付費的人會在下一輪被補上；排入失敗時，到期提醒隔天會再排一次，日曆則只在 grace window 與下一輪重疊的約 2 分鐘內還有機會——到期提醒只補到逾期第 7 天（`PERSONAL_OVERDUE_CATCH_UP_DAYS`），否則剛付費或上線第一天的人會一次收到每一筆逾期幾個月的提醒。`care-due-reminders` 讀所有家庭的提醒時以 `due_date <= 今天＋180`（threshold 上限）以 keyset 分頁讀到空頁，不讓 PostgREST 的 `max_rows` 安靜截斷。排入失敗時兩支 cron 那一輪仍回 500；#1251 起 helper 另透過 service-only RPC 留下最小失敗收據，由 sweeper 顯示 `enqueue_failed`。只有目前有付費且已綁定收件人的有效來源會留下收據；Cron 沒跑或連失敗收據都無法寫入時仍不在此偵測範圍。詳見 [提醒排入失敗的可見性](notifications.md#提醒排入失敗的可見性issue-1251)。

**搶單（issue #1104）**：drain 改用 `claim_pending_personal_notifications_v2`，`blood_pressure` 列優先、同 kind 內先進先出——每日到期提醒會一次替所有家庭排入一批，照 `created_at` 先進先出的話，之後進來的危險級血壓要排在整批後面（每分鐘只取 25 列），批次夠大時會越過 30 分鐘期限。v1 收斂成只取血壓列，留給部署窗口內的舊版 drain：它不認得提醒列，拿到會寫 `configuration_error`，唯一鍵又讓那個 occurrence 再也排不回來。

drain 依 kind 分派：提醒列不讀血壓紀錄、不走免費危險級（`reverifyRecipientAuthorization` 只對 `blood_pressure` 放行免費）；送出前重讀來源，來源停用、提醒已完成／略過、到期日改了、照護對象已封存或病人對不上，寫 `failed_terminal` ＋ `configuration_error`（與血壓「紀錄讀不到」同一個結局，sweeper 會告警——對「合理不送」的情況是誤報，改用不告警的代碼見 #1112）；日曆行程已開始就 `delivery_expired`、不送。訊息是純文字三語，標題帶照護對象顯示名稱（私訊收件人可能照護好幾個人），日曆寫台北時間的開始時刻而不是「N 分鐘後」（drain 每分鐘才取一次）；仍然不放行程標題、地點與描述。LINE 的同輪單一收訊人去重鍵改為 kind＋病人＋來源＋occurrence，避免同一本日曆的兩個行程被當成同一則。

狀態機沿用既有慣例：`pending → sending → sent | delivery_unknown | failed_terminal`。`delivery_unknown` **不得由下一輪盲目重送**，因為對方可能已經收到而只是 HTTP 回應遺失。

`failure_code` 改用 `provider_*` 前綴（`provider_http_4xx`、`provider_http_5xx`、`provider_network_unknown`、`provider_api_rejected`、`configuration_error`、`recipient_unlinked`、`recipient_unauthorized`）以涵蓋兩個管道。[ADR-007](../adr/007-notification-delivery-semantics.md) D5 已定案四張表統一用 `provider_*`：票 1（issue #958，migration `20260926155217`）把值域擴成同一份（另加 `provider_rate_limited`、`delivery_expired`、`unattempted_abandoned`），並替四張表補上 `attempt_count`、`next_attempt_at`、`claim_token`、`claim_generation`、`resolution_source`；既有兩張 cron 帳本在票 9 contract 之前仍**同時**接受 `telegram_*`（expand 窗口）。outbox 既有的 `pending` 列依上線約束 1 以 owner 核准的 `BACKFILL_CUTOFF` 分流：門檻內保留、超過的改判 `failed_terminal` ＋ `delivery_expired` 並標 `resolution_source = 'migration'`。票 3（issue #960，migration `20260926160515`）已讓 `_shared/telegram.ts` 直接產出 `provider_*`、移除 drain 的 `TELEGRAM_TO_OUTBOX_FAILURE_CODE` 對照表，並把兩張 cron 帳本的歷史 `telegram_*` 列回填成 `provider_*`（規則在 `backfill_provider_failure_codes_adr007()`，票 9 contract 前會對 expand 窗口內新寫出的舊值再跑一次）；五支 Cron Function 的 secret 比對改走 `_shared/cron.ts` 的常數時間比對。票 4（issue #961，migration `20260926163732`）落地 D4：outbox 是四條路徑裡唯一有重試者的，drain 對合法的 Telegram／LINE 429（可解析的 provider 錯誤封包）依 `planRateLimitedRetry` 把列寫回 `pending` ＋ `provider_rate_limited`——先遞增 `attempt_count` 再比對上限（`MAX_DELIVERY_ATTEMPTS = 5`）、`retry_after` 先驗證（無效用 `RETRY_MIN = 30s`、超過 `RETRY_MAX = 5 min` 直接終結）、`next_attempt_at = LEAST(now + retry_after, created_at + DELIVERY_DEADLINE)`，越過 30 分鐘期限一律 `failed_terminal` ＋ `delivery_expired`；`claim_pending_personal_notifications` 尊重 `next_attempt_at` 與期限，並在同一支 RPC 內把越界的 `pending` 就地終結，每次 claim 寫 `claim_token`、遞增 `claim_generation`；drain 每一次寫回都以 `claim_token` 圍籬，舊一代的寫回在 `WHERE` 就落空；drain 先呼叫 claim RPC、之後才依實際搶到的管道惰性讀取 `TELEGRAM_BOT_TOKEN`／`LINE_CHANNEL_ACCESS_TOKEN`，所以 secret 缺失時逾期列照樣被標成 `delivery_expired`、搶到的列寫 `failed_terminal` ＋ `configuration_error`，不會整支 500 而讓帳本停住；每一列送出前還會再查一次 `created_at + DELIVERY_DEADLINE`（一批最多 25 列逐一處理，排在後面的列到真的送出時可能已越界），越界就不呼叫 provider、直接終結為 `delivery_expired`。轉 `sent` 一律清空 `failure_code`（D2）。裸 429（解析不出封包）一律 `delivery_unknown`。

**刻意不存訊息內容**：血壓數值已在 `blood_pressure_records`，drain 時用 service role 重讀重組即可；提醒列同理，drain 重讀日曆來源（只讀 `patient_id`、`enabled`）或到期提醒列與病人顯示名稱。這沿用 `src/lib/telegramNotification.ts` 已在用的「只傳 ID、server 重讀」原則，避免健康數值在資料庫裡多出一份未受 patient 分區保護的副本。

RLS：只給 SELECT，條件為 `recipient_user_id = auth.uid()` **且**對該 `patient_id` 有 `care_access`。無任何寫入權限。

### 付費旗標

```sql
ALTER TABLE public.account_usage_limits
  ADD COLUMN IF NOT EXISTS personal_notification_tier TEXT NOT NULL DEFAULT 'none';
-- CHECK (personal_notification_tier IN ('none','personal'))
```

**重用既有的 `account_usage_limits`**（`20260730070000`）：它已經是 email-keyed、已經 `REVOKE ALL FROM anon, authenticated`（瀏覽器讀不到也改不了自己的付費身分）、已經只透過 SECURITY DEFINER 讀取。

**開新欄位而不是用 `plan_code='paid'`**：沿用 `photo_retention_tier`（`20260814100000`）立下的「每個授權軸各自一欄」先例。（當時的理由寫成「避免意外改動每日寫入配額」；2026-10-05 查明 `plan_code` 從未被任何程式讀取、每日配額只讀數字欄，所以正確的理由是「付費閘門一律走 `*_tier` 欄位」，見 [ADR-011](../adr/011-paywall-safety-boundary.md) D1。）

### RPC

全部 `SECURITY DEFINER SET search_path = public`。

| RPC | 回傳 | EXECUTE 授權 |
| --- | --- | --- |
| `create_messaging_link_token(p_channel TEXT)` | 原始 token TEXT（只此一次） | `authenticated` |
| `current_messaging_link_status()` | `(channel, linked, linked_at, notification_tier)` — **無 external id** | `authenticated` |
| `unlink_messaging_channel(p_channel TEXT)` | void | `authenticated` |
| `consume_messaging_link_token(p_token_hash, p_channel, p_external_id)` | BOOLEAN | **只有 `service_role`** |
| `unlink_messaging_channel_by_external_id(p_channel, p_external_id, p_event_timestamp_ms BIGINT)` | BOOLEAN（是否刪除一筆綁定） | **只有 `service_role`**；目前只接受 `line`（issue #982） |
| `enqueue_blood_pressure_personal_notifications(p_record_id, p_patient_id)` | (queued, unknown, delivered) | `authenticated`（舊版部署相容；只排付費收件人，#1102 第二階段才移除） |
| `enqueue_blood_pressure_personal_notifications_v2(p_record_id, p_patient_id, p_alert_level, p_free_danger)` | (queued, unknown, delivered) | `authenticated`（issue #1059 起 notifier 使用的排入入口） |
| `personal_notification_counts(p_record_id, p_patient_id)` | (queued, unknown, delivered) | `authenticated`（#1102 第一階段；`STABLE` 唯讀，只限該病人的記錄者） |

#### 狀態回看與舊入口退役（#1102）

第一階段 migration `20261014010000` 新增 `personal_notification_counts`，`readPersonalDeliveryState` 改用它回看。新 RPC 先確認登入 email、由 `auth.uid()` 解析的 `current_care_access(p_patient_id)`，再確認紀錄的 patient 與記錄者 email；只回傳這筆血壓的三種計數，不提供收件人身分。`pending`／`sending` 算 queued、`delivery_unknown` 算 unknown、`sent` 算 delivered，`failed_terminal` 不算；免費危險級與付費列都納入，也不因收件人後來降級或解除授權而把既有送達結果藏掉。

選擇新增唯讀 RPC 而不是讓瀏覽器呼叫 v2，是因為「查一下送到了沒」不應替等待期間新綁定的收件人新增通知，也不應要求瀏覽器提供警示等級。讀取前後 outbox 必須完全相同；沒有排入的紀錄回零，無權限或紀錄與病人不符則拒絕。

**部署與第二階段閘門**：本次只新增函式並遷移 caller，不刪除 legacy。2026-10-14 核對的正式分支 `013b9d8` 雖然 notifier 已呼叫 v2，前端仍呼叫兩參數入口，因此尚未符合 #1102 的「no deployed client calls it」前提。先讓 migration 與新前端完成 staging 驗證，再依正常發布批次部署；由維護者確認各環境服務中的前端／notifier 都已遷移後，才在 #1102 的後續 PR 新增 DROP migration、更新 schema 與移除 legacy 相容測試。不能把兩個步驟塞進同一批 migration，因為 migration 會先於新前端生效。

舊快取 PWA 遇到未來被移除的入口，或 preview 新前端尚未取得此 RPC 時，既有 caller 會把查詢錯誤轉成 `personalUnknown: true`，顯示「無法確認是否送達」；血壓已存檔、outbox 照常處理，不以查詢失敗重送血壓。這是失敗保護，並不取代上述部署確認。第一階段回滾前端可繼續使用保留的舊入口，無須刪除新 RPC；第二階段移除後若要回滾 notifier，必須維持使用 v2。

驗證：`telegramNotification.test.ts` 保護只傳兩個 UUID 與失敗傳遞；`bpQueueCoordinator.test.ts` 以真 Supabase client 的 404／`PGRST202` 回應驗證警告保留；`rls-authorization.sql` 的 ADR-007 與 #1059 區塊驗證三種計數、免費危險級、讀取無寫入、非記錄者／跨病人／無授權／已撤銷／缺 email 的拒絕與 anon EXECUTE 邊界。Issue 在第二階段完成前維持開啟。

`create_messaging_link_token`：**`line` 必須先確認呼叫者自己的 `personal_notification_tier = 'personal'`，否則 raise exception**；`telegram` 自 issue #1059 起只要求呼叫者至少有一筆 `care_access`（危險級免費，ADR-011 D3）。前端把未付費的按鈕停用只是體驗，任何登入者都能直接對 PostgREST 呼叫這支 RPC；若這裡不擋，未付費帳號可以繞過 UI 取得 token 並完成綁定，與「RPC 才是真正的閘門」的說法矛盾。（若日後產品要改成「先綁定、後付費」，那是需要明確決定的產品變更，不是預設行為。）

token 本身：`encode(gen_random_bytes(24),'hex')` = 48 個 hex 字元，符合 Telegram `/start` payload 限制（1–64 字元、只允許 `A-Za-z0-9_-`），192 bits 熵。只存 hash、TTL 10 分鐘、發新券時先作廢同使用者同管道未使用的舊券、每小時上限 5 張。

`enqueue_...` 的前置驗證**必須包含三項，缺一不可**：

1. caller 對 `p_patient_id` 有 `care_access`
2. **該筆紀錄的 `blood_pressure_records.patient_id` 等於 `p_patient_id`**
3. 該筆紀錄的 `recorded_by` 等於 caller email

第 2 項不能省略，也不能倚賴 `blood-pressure-notifier` 已經做過同樣檢查：**這支 RPC 授權給 `authenticated`，任何登入者都能直接對 PostgREST 呼叫它，完全繞過 Edge Function**。少了它，一個同時有 A、B 兩位病人權限的照護者可以把 A 的血壓紀錄配上 `p_patient_id = B`——outbox 會依 B 展開收件人，而 drain 用 `source_record_id` 重讀時拿到的是 A 的數值，等於把 A 的健康數值送給只該看到 B 的人。這正是 `AGENTS.md` 生理數值對象綁定不變量要防的跨病人洩漏，授權測試必須涵蓋這組 ID 不相符的呼叫。

通過驗證後，以 `care_access → auth.users → user_messaging_links → account_usage_limits` 的 JOIN 展開收件人，
`WHERE personal_notification_tier = 'personal'`，`ON CONFLICT DO NOTHING`。

**v2 的免費危險級扇出（issue #1059）**：`p_free_danger` 為真時，另以 `care_access → user_messaging_links（channel = 'telegram'）` 替所有已綁 Telegram 的成員排一列，不看 tier。`p_free_danger` 由 notifier 依 `_shared/freeDangerDelivery.ts` 算出，只是排程提示——記錄者可以偽造，所以真正的放行在 drain（見下方「drain 的硬性檢查」第 2 項）。

**收件人自己的付費狀態決定自己收不收**，不是寄件人的。走 `auth.users` 而非 `app_profiles`，因為前者才是 user_id↔email 的權威來源，且不依賴 onboarding RPC 是否補過那一列。綁兩個管道的人自然產生兩列。

## Edge Functions

| Function | verify_jwt | 授權方式 | 職責 |
| --- | --- | --- | --- |
| `blood-pressure-notifier`（修改） | true | 登入者 JWT | 驗證後呼叫 enqueue RPC。過渡期（B、C 階段）保留原本送進全域 `TELEGRAM_CHAT_ID` 的路徑（B 階段 Cron 尚未建立時才不會靜默丟棄）；**階段 D（2026-10-09）已移除**：排入是唯一路徑，排入失敗一律回 502。姿態不變，絕不引入 service role。 |
| `telegram-webhook`（新） | false | `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET`（constant-time 比較） | 接 `/start <token>`，綁定 chat id |
| `line-webhook`（新，最後一階段） | false | `X-Line-Signature` = base64(HMAC-SHA256(`LINE_CHANNEL_SECRET`, raw body)) | 接 `/link <token>`，綁定 LINE userId |
| `personal-notification-drain`（新） | false | `PERSONAL_NOTIFICATION_DRAIN_CRON_SECRET` + service role | 排空 outbox 並送出 |

### drain 的硬性檢查

drain 持有 service role，**讀取時繞過 RLS**，所以 enqueue 當下的授權判斷不能當成送出當下的授權判斷。enqueue 與實際送出之間隔著至少一輪 Cron，這中間照護者可能被撤銷 `care_access`、付費可能到期、綁定可能被解除。

因此每一列在 render 與送出**之前**都必須重新確認三件事，任一不成立就直接寫成 `failed_terminal` 並附對應 `failure_code`，不得送出、不得留在 `pending` 反覆重試：

1. 收件人對該 `patient_id` **目前仍有** `care_access` —— 否則 `recipient_unauthorized`
2. 收件人**目前仍是** `personal_notification_tier = 'personal'`，**或**這一列是 Telegram 且 drain 自己重讀紀錄與量測當下的標準、以 `_shared/freeDangerDelivery.ts` 算出免費危險級（issue #1059）—— 否則 `recipient_unauthorized`。不得採信 `outbox.alert_level`（排入端寫的提示）；LINE 列即使是危險級也不免費放行。
3. 收件人該管道**目前仍有** `user_messaging_links` 列 —— 否則 `recipient_unlinked`

重讀血壓紀錄時也**必須同時以 `source_record_id` 與該列的 `patient_id` 兩個條件查詢**，不可只用 `source_record_id`。drain 讀取繞過 RLS，這是防止「紀錄與 outbox 列的病人不一致」時把某位病人的數值送給另一位病人照護者的最後一道防線（enqueue 已擋一次，這裡是縱深防禦）；查不到就寫 `failed_terminal` + `configuration_error`，不得改用單一條件重查。

這條是本功能最重要的資料邊界：撤銷照護權限必須立即停止健康數值外送，不能因為「通知已經排進佇列」而繼續送達給已無權限的人。`AGENTS.md` 的生理數值對象綁定不變量要求通知同樣受 `patient_id` 分區保護，而 service role 路徑只有靠這裡的明確重驗才能滿足。

### 搶單必須是原子操作

兩次 Cron 重疊、或維護者手動重跑時，兩個 worker 可能讀到同一批 `pending` 列而送出重複的健康通知。outbox 的 UNIQUE 鍵只去重 **enqueue**，不去重 **消費**。

因此搶單必須是單一的條件式 UPDATE，不可先 `SELECT` 再 `UPDATE`：

```sql
UPDATE personal_notification_outbox
   SET status = 'sending', attempt_started_at = now()
 WHERE id IN (
   SELECT id FROM personal_notification_outbox
    WHERE status = 'pending'
    ORDER BY created_at
    LIMIT 25
    FOR UPDATE SKIP LOCKED   -- 重疊的 worker 直接跳過已被鎖住的列，不排隊也不重複取得
 )
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` 不只是效能考量：少了它，重疊的 worker 會互相阻塞在同一批列上，而且任何把這段改寫成「先查再更新」的重構都會靜默引入重複送出。測試必須涵蓋重疊 drain 的情境。

### 綁定 webhook 的硬性檢查

- 只接受一對一對話（Telegram `message.chat.type === 'private'`、LINE `source.type === 'user'`）。綁定群組沒有「個人化」意義，而且會把整群當成一個人。
- LINE 必須**用原始 body 位元組驗簽再 parse**，不可先 parse 再重組字串驗簽。
- payload 需先符合 token 格式再查資料庫，SHA-256 後交給 `consume_messaging_link_token`（service role）。
- LINE 每筆有效 `/link` 必須先確認 `LINE_CHANNEL_ACCESS_TOKEN` 存在，才可呼叫 consume RPC；缺少時不消耗一次性 token、不寫入綁定、不回覆，只計入該事件的 `failed`。檢查留在綁定事件內，同批 `unfollow` 仍可解除綁定；不能等資料庫寫入後才在 reply callback 發現設定缺漏。
- **永遠回 200**（無效 token 也是），避免 Telegram／LINE 進入重試迴圈；成敗改用一則三語訊息回覆使用者本人。
- 原始 token 會留在使用者的對話紀錄裡——這正是 TTL 10 分鐘 + 一次性 + 只存 hash 的理由。

### LINE 封鎖後解除綁定（issue #982）

LINE 對已封鎖帳號的 push 仍可能回 HTTP 200；所以不能由 push 成功判斷是否仍可收件。`line-webhook` 在原始 body 驗簽通過後，只接受 `unfollow`、`source.type = user`、合法 LINE userId 與正整數毫秒 timestamp，透過 `unlink_messaging_channel_by_external_id` 刪除相同 `channel + external_id` 的綁定。RPC 拒絕其他管道，撤銷 `PUBLIC`／`anon`／`authenticated` EXECUTE，只授給 `service_role`；不碰通知歷史、付費權益、健康資料與照護授權。unfollow 沒有 replyToken，不需 `LINE_CHANNEL_ACCESS_TOKEN`，不回覆 LINE；成功只增加 `unlinked` 聚合數，錯誤只增加 `failed`，不記錄 userId 或資料庫原始錯誤。所有請求仍回 200，失敗不依賴 LINE 自動重試。

[LINE 官方文件](https://developers.line.biz/en/docs/messaging-api/receiving-messages/) 說明 unfollow 由封鎖觸發，也可能重送或亂序。DELETE 內原子比對 `floor(extract(epoch FROM updated_at) * 1000) <= p_event_timestamp_ms`，避免舊事件刪掉較新的綁定；同毫秒視為可解除，重複／不存在的綁定回 false。選 `updated_at` 是因既有 `/link` upsert 會更新它，`linked_at` 則維持首次時間；不採「先查再刪」，以免兩步之間重新綁定被誤刪。這是基於綁定**處理時間**的窄保護，不是完整事件排序：晚到的 `/link` 若在較新封鎖之後才處理，仍需更廣的 lifecycle 狀態才能解決，這次不新增事件帳本。`follow`（解除封鎖／加好友）一律忽略，使用者須回 App 產生新 token 再 `/link`。

解除前已排入且尚未送出的通知，既有 drain 會重驗綁定；照護授權與付費條件仍成立時，終結為 `failed_terminal / recipient_unlinked`，不呼叫 LINE。解除後才新建的血壓通知，enqueue 因收件人已無 LINE 綁定而不建立該 outbox 列，不能要求它產生一筆 failure。已進入送出階段的通知不回溯撤回。從未加好友、webhook 沒收到或解除 RPC 失敗等情形，仍可能有 `sent` 但收不到的限制；既有加好友提醒持續保留，不宣稱 unfollow 能偵測全部未送達。

驗證：`lineUnfollowWebhook.test.ts` 驅動實際 handler（外部 client 使用 mock），`lineUnfollowMigration.test.ts` 鎖靜態契約，`supabase/tests/line-unfollow.sql` 實測 API role 拒絕、精確管道／帳號隔離、毫秒邊界、重送及重新綁定保護。staging 人工驗收見 [`line-messaging-setup.md`](../operations/line-messaging-setup.md)。

### 訊息 renderer 拆分

現有 `buildBloodPressureTelegramMessage` 直接吐 HTML（`<b>`、`<i>`），LINE 只吃純文字。拆成 `buildBloodPressureNotificationFields()` 產生結構化欄位，再由 `renderBloodPressureTelegramHtml()` 與 `renderBloodPressurePlainText()` 各自輸出；`buildBloodPressureTelegramMessage` 保留為薄包裝，既有測試不動。

### 共用模組

`supabase/functions/_shared/telegram.ts`：把目前在 `calendar-notifier` 與 `care-due-reminders` **逐字重複**的 `sendTelegramMessage` 與 `classifyTelegramDelivery` 抽出共用。順手還既有技術債，不改那兩支的行為。

`supabase/functions/_shared/line.ts`：`POST https://api.line.me/v2/bot/message/push`，`Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`，body `{ to, messages: [{ type: 'text', text }] }`，把 HTTP 狀態映射到同一組 `provider_*` failure code。

## LINE 額度考量

LINE Messaging API 的推播在免費方案有月額度上限（台灣 LINE OA 免費版約 200 則／月級距，**實際數字以帳號當期方案為準，實作前必須先確認**）。血壓通知是逐筆推播，一家人一個月很容易超過。

因此 LINE 管道排在最後一個階段，且該階段必須包含用量觀察方式——最低限度是把「以 `channel='line'` + `status='sent'` 對 `personal_notification_outbox` 做月計數」的查詢寫進運維文件。超量時的降級策略（改為每日摘要而非逐筆推播）留待後續獨立提案，不在本計劃範圍。

Telegram 沒有等價的商用額度限制，這也是它先上的原因之一。

### 額度確認結果與用量查詢（issue #604）

實作前已在 issue #604 回報確認：

- **帳號**：LINE 官方帳號（真實 Basic ID 屬 operational identifier，依 AGENTS.md 不進 Git；實際值見維運端 LINE Official Account Manager，帳號名稱略）
- **方案**：輕用量（Light，使用中，NT$0/月）
- **免費訊息則數**：200 則／月，**帳號級共用**——不是每個綁定收訊人各自 200 則，是整個 LINE OA 帳號不分收訊人共用的總額度
- **加購訊息**：輕用量方案不支援加購；超過 200 則後訊息直接發送失敗，不是額外計費。要加購需升級中用量方案（NT$800/月起，免費則數 3,000/月）

因為額度是帳號級共用而非每人各自獨立，本 issue 的 MVP 範圍刻意縮小為**單一收訊人、即時推播**：只送給帳號擁有者（premium 使用者）本人，不做「同一筆通知廣播給多個綁定家人」的家族群發。收訊人固定 1 位，額度壓力遠低於「N 個家人 × 逐筆」，在正常記錄頻率下 200 則/月應可支撐；家族群發、多收訊人推播與超量後的降級策略（例如改每日摘要）留待額度或方案調整後的後續提案，不在本次實作範圍。

用量觀察查詢——依月份統計 LINE 管道實際送達則數，追蹤是否逼近 200 則/月上限：

```sql
SELECT date_trunc('month', resolved_at) AS month, count(*)
FROM personal_notification_outbox
WHERE channel = 'line' AND status = 'sent'
GROUP BY 1 ORDER BY 1 DESC;
```

運維建議：每月人工核對一次這個查詢的最新一列，若單月已逼近 200 則（例如超過 150 則），先確認是否有非預期的重複觸發，再評估是否需要提前申請中用量方案或延後推動多收訊人範圍。

## 前端

- `src/lib/messagingLinks.ts`：`fetchMessagingLinkStatus()`、`createMessagingLinkUrl(channel)`、`unlinkMessagingChannel(channel)`。副作用以參數注入，比照 `src/lib/telegramNotification.ts` 的 `InvokeLike` 寫法。
- `src/components/settings/PersonalNotificationSettings.tsx`：比照 `src/components/settings/ReadingScaleSettings.tsx` 的自給自足元件慣例（不接 props、自己管狀態），避免再往 `SettingsPage` 已經很長的 props 清單塞東西。非同步寫入走 `src/hooks/useSaveStatus.ts`，錯誤用 `describeSaveError`。
- 每個管道一列：已綁定顯示綁定時間與解除按鈕，未綁定顯示連結按鈕。閘門分管道（issue #1059）：Telegram 對免費帳號開放，LINE 未付費時停用；未付費時顯示「免費：危險等級；Premium：所有等級＋LINE」——前端只是體驗，真正的閘門在 RPC。
- 掛載於 `src/features/system-admin/pages/SettingsPage.tsx`。
- 新公開環境變數 `VITE_TELEGRAM_BOT_USERNAME`、`VITE_LINE_OA_BASIC_ID`（bot handle 本來就是公開資訊）。
- 所有文案三語 inline `LocalizedText`，屬性順序 `{ id, zh, en }`。

## 測試

沿用 repo 的兩層慣例：純函式測試（副作用以參數注入）+ 對原始碼字串做契約斷言的 static source-contract 測試。全部用 `bun test`。

`tests/unit/personalNotificationChannelsMigration.test.ts` 是其中最重要的一支，負責把安全邊界鎖死：

- `user_messaging_links` 有 `REVOKE ALL ... FROM PUBLIC, anon, authenticated`，且**沒有**任何對 `authenticated` 的 `GRANT SELECT`
- `current_messaging_link_status` 的定義**不含** `external_id`
- `consume_messaging_link_token` 只 `GRANT EXECUTE ... TO service_role`
- `enqueue_...` 是 `RETURNS integer`，不是回傳 external id 的 table
- `channel` 與 `personal_notification_tier` 的 CHECK 值域、outbox 的 UNIQUE 去重鍵、檔尾 `NOTIFY pgrst, 'reload schema';`

`personalNotificationDrainFunction.test.ts` 必須涵蓋三條送出前的重驗路徑（`care_access` 撤銷、tier 降級、綁定解除）各自寫成正確的 `failed_terminal` + `failure_code` 而非送出、重讀時 `source_record_id` 與 `patient_id` 不相符時不送出，以及重疊 drain 不會重複取得同一列。

授權測試另需涵蓋 **enqueue RPC 的跨病人呼叫**：caller 同時有 A、B 權限時，以 A 的 `record_id` 配 B 的 `patient_id` 呼叫必須被拒絕，不得產生任何 outbox 列。

另有 `messagingLinks.test.ts`（前端）、`telegramWebhookFunction.test.ts`、`lineWebhookFunction.test.ts`（含簽章 vector），並擴充 `bloodPressureNotifier.test.ts`（既有訊息斷言不得改動；階段 D 之後改為反向斷言：不得再有直送、Telegram secret、訂閱查詢或群組帳本）。`supabase/tests/rls-authorization.sql` 補反向斷言：`authenticated` 無法 SELECT `user_messaging_links`、無法 EXECUTE `consume_messaging_link_token`。

## 分階段上線

| 階段 | 內容 | 全域 `TELEGRAM_CHAT_ID` |
| --- | --- | --- |
| A | 資料層 + Telegram 綁定 + 設定頁 UI。notifier 尚未改。 | 照舊，唯一送達路徑 |
| B | notifier **額外**呼叫 enqueue（全域送出仍保留）；Cron 尚未建立。人工檢查 outbox 列是否正確產生。 | 照舊，仍是唯一實際送達路徑 |
| C | 建立 Cron，drain 開始送出。已綁定又付費的人會**暫時收到兩則**（群組 + 私訊），已知且可接受的過渡狀態。 | 保留 |
| 閘門（#1061，已落地） | migration `20261005155025`：共用群組釘在恰好一個家庭，別的家庭的病人開通訂閱或日曆來源一律被資料庫拒絕。三支 Function 的送出程式不變。接第二個家庭不必等階段 D。 | 保留，只送被釘住的家庭 |
| 提醒個人路徑（#1104） | migration `20261005155810`：日曆提醒與照護到期提醒也排進 outbox（只給付費且已綁定者）；兩支 cron Function 每個到期 occurrence 都排入，群組送出不變。到期提醒的個人路徑涵蓋每個家庭；日曆來源仍受 #1061 閘門限制（啟用中的來源＝群組路由），所以日曆私訊目前只有被釘住的家庭用得到。 | 保留，只送被釘住的家庭 |
| D（已落地，2026-10-09，migration `20261009093000`） | 共用群組退場。前置都已進 staging：#1059（PR #1101，免費危險級個人 Telegram）、#1104（PR #1110，提醒的個人送達路徑）、#1100 閘門。做了：停用所有 telegram 訂閱（帶稽核）→ 拆四個 guard trigger → 帶稽核 DELETE 釘選列 → DROP 釘選表與七支函式 → 凍結兩張群組帳本（殘留 `pending` 終結）；三支 Function 移除全域送出、Telegram secret 讀取、群組帳本寫入與訂閱查詢，`blood-pressure-notifier` 排入失敗一律 502；`TELEGRAM_CHAT_ID` 與 `BLOOD_PRESSURE_NOTIFIER_IN_REQUEST_RETRY` 從 `required-secrets.json` 移除；`rls-authorization.sql` 改成退場斷言。`calendar_notification_sources.enabled` 的兩個意思靠「移除群組那個意思」拆開，schema 不動。**仍是 owner 動作**：核心照護帳號完成個人綁定（AGENTS.md § 3.4）、要收提醒與非危險級血壓的人設為付費 tier、production 先有 A1／A6 Cron 再 promotion。**另開 follow-up**：兩支 cron Function 的個人化排入失敗由 #1251 補上最小收據、sweeper 與三語橫幅（staging 失敗注入驗收仍須完成）；退場後的死碼（直送 helper、前端 `in_progress` 回看、直送帳本 RPC、`notification_subscriptions` 與後台分頁）。 | **已停用** |
| E | LINE 管道上線。 | 已停用 |

## 驗收

每個階段跑：`bun test tests/unit` → `bun run lint` → `npx tsc --noEmit` → `bun run check:migrations`。

Staging 實機（階段 C 之後），以主要家屬（owner）帳號與看護帳號對病人本人的 patient 各驗一次：

- 已綁定 + 付費 → 收到
- 已綁定 + 未付費 → 不收到
- 未綁定 + 付費 → 不收到，且不留 `pending` 殘留

再以未授權帳號確認 RLS 拒絕，並直接打 PostgREST `/rest/v1/user_messaging_links` 確認回 401/403（瀏覽器永遠拿不到任何 external id）。

**必須保住 `AGENTS.md` 的核心照護授權不變量**：上述兩個帳號對病人本人 patient 的 read／care-write／medication-manage 權限不受影響。

## 一次性平台設定（由維護者執行，Agent 不得代做）

1. BotFather 建立／確認 Telegram bot，記下 username。
2. 呼叫 Telegram `setWebhook`，帶 `secret_token`（= `TELEGRAM_WEBHOOK_SECRET`）。
3. 建立 LINE 官方帳號並在 LINE Official Account Manager 啟用 Messaging API（不能直接在 Developers Console 建，也不是 LINE Login channel），取得 channel secret／access token 並設定 webhook URL（最後一階段才需要）。逐步操作、兩個環境各一個官方帳號的理由與 staging 驗收見 [`docs/operations/line-messaging-setup.md`](../operations/line-messaging-setup.md)。
4. 在 staging 與 production **分別**設定所有新 secret，不可複製共用。
5. 建立每分鐘的 Supabase Cron job 呼叫 drain。
6. 標記付費會員：`UPDATE account_usage_limits SET personal_notification_tier = 'personal' WHERE LOWER(profile_email) = ...`。

## 實作拆分

工作拆成 7 個 GitHub issue，依序相依：

1. ADR-003：架構決策與 LINE 範圍澄清（純文件，先合）
2. 資料層：多管道綁定、付費旗標與 outbox migration
3. Telegram 綁定 webhook 與 `_shared/telegram.ts` 抽取
4. 設定頁綁定 UI
5. 送出管線：notifier 改 enqueue + outbox drain
6. 文件與分階段上線
7. LINE 管道：webhook 簽章驗證、push sender 與額度觀察

## 回滾與限制

暫停個人化通知優先把使用者的 `personal_notification_tier` 改回 `'none'` 或停用 Cron，而不是刪除 outbox 稽核列。回滾程式時先停 Cron，再回退 notifier；既有 `delivery_unknown` 不可為了補送而改回 `pending`。移除資料表或大量刪除通知紀錄屬於破壞性資料操作，需另行明確授權。
