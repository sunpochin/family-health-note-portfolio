<!--
檔案用途：付款人 web 畫面（#1185，MONETIZE P3）的現行狀態：誰看得到什麼、畫面清單、與 P1 後端契約的對照、還沒接線的部分與接線時要遵守的規則。
所在層：docs/features；畫面層的單一真相文件，設計來源是 docs/product/monetization-plan.md §3.3／§5.2／§5.3／§6.1／§6.2 與 docs/adr/012-household-entitlement-and-subscription-lifecycle.md（兩份都已在 staging）；後端契約以 supabase/migrations/20261006183520_add_subscription_state_machine_and_payment_ledger.sql 為準。
主要關聯：src/features/subscription/*、tests/unit/billingAudience.test.ts、tests/unit/subscriptionScreensRender.test.ts。
-->

# 付款人 web 畫面 / Payer Screens（issue #1185）

## 目前做到哪

**畫面層已完成並有測試，型別與政策已對齊 P1 的真實契約；資料 hook 與路由還沒接。**

- P1（#1182，PR #1203）已進 staging：`household_subscriptions`、`payment_orders`、價格與取消／恢復／建單 RPC 都存在。
- P2（#1184，藍新建單與通知）**還沒進 staging**：沒有 `newebpay-period-checkout`（把訂單送去藍新付款）與 `newebpay-period-alter`（向藍新終止委託）。所以目前**付不了款、取消也送不出去**——取消會停在 `cancel_requested`、`terminating`。
- 因此這些元件**沒有掛進 `App.tsx` 或設定頁**：升級頁走不完、取消走不完的畫面不該被使用者看到。

| 元件 | 做什麼 |
| --- | --- |
| `SubscriptionBanner` | 寬限橫幅（含「更新付款方式」）、付款人已離開橫幅、續約前 7 天提醒橫幅 |
| `SubscriptionSection` | 設定頁「訂閱」區：狀態、到期日、取消（兩步確認）、撤回取消、收據列表 |
| `UpgradeDisclosure` | `/upgrade` 的購買前揭露；條款與七日解除權例外是**兩個獨立勾選框** |
| `lib/billingAudience.ts` | 顯示矩陣與動作權限的唯一來源，元件不自己判斷角色 |

## 誰看得到什麼（矩陣測試鎖住）

| 身分 | 橫幅 | 訂閱區 | 升級頁／更新付款方式 | 取消 | 撤回取消 |
| --- | --- | --- | --- | --- | --- |
| 付款人（`payer_user_id` 吻合） | ✅ | ✅ | 仍是 owner 才有 | ✅（`active`、`grace`） | ✅（僅 `cancel_requested` 且由付款人或 owner 發起） |
| 家庭 owner | ✅ | ✅ | ✅ | ✅（`active`、`grace`） | ❌（只有付款人本人） |
| caregiver／viewer | **永遠沒有** | **永遠沒有** | **永遠沒有** | — | — |
| 未登入、尚未讀到角色 | **永遠沒有** | **永遠沒有** | **永遠沒有** | — | — |
| 原生殼內的任何人 | 全部不渲染（ADR-012 D9） | | | | |

- 付款人身分看訂閱列的 `payer_user_id`，不看目前有沒有家庭角色：付款人被降成 caregiver、甚至被移出家庭後，卡還在被扣，仍要看得到訂閱區與取消入口（但不會變成 owner，沒有升級入口）。P1 的 RLS（`payer_user_id = auth.uid() OR is_household_owner(...)`）本來就讓他讀得到自己那一列。
- 付款人看不到「更新付款方式」按鈕若他已不是 owner：建單 RPC 只接受 owner（`not_household_owner`），顯示了只會被拒絕。
- `payer_user_id` 在付款人刪帳號後是 `NULL`；比對前必須先擋 `userId === null`，否則未登入者會與「付款人已離開」的那一列 `null === null` 誤判（測試有專門一條）。
- **寬限期（`grace`）可以取消**：P1 的 `cancel_household_subscription` 允許 `active` 與 `grace`，並記住 `status_before_cancel`，撤回時回到寬限狀態。
- **不是所有取消都能撤回**：刪帳號（`payer_deleted`）、招待（`admin_grant`）、退款（`refund`）發起的取消，`resume_household_subscription` 會拒絕，畫面也就不顯示撤回按鈕。
- `terminating`（取消請求已送給供應商、還沒確認）對付款人仍是「取消處理中」，不能說已取消。

## 與 P1 後端契約的對照（接線時照這張表）

| 畫面的 view model | 後端來源 |
| --- | --- |
| `SubscriptionSummary` | `household_subscriptions`（RLS：付款人或家庭 owner 可讀）：`id`、`status`、`payer_user_id`、`current_period_end`、`grace_until`、`cancel_reason` |
| 「目前這張」 | 唯一一列 `active`／`grace`／`cancel_requested`／`cancelled`（partial UNIQUE 保證最多一列）；沒有時才看 `terminating`；`downgraded`／`superseded` 是歷史 |
| `PlanOffer` | `rpc premium_plan_offer()`：`plan_code`、`amount`、`currency`、`ai_draft_daily_limit`、`care_recipient_limit`、`photo_retention_days`、`terms_version`（金額 150 是 owner 定價前的佔位） |
| `ReceiptRow` | `payment_orders` 中 `status IN ('paid','paid_late')`：`id`（即藍新訂單號）、`paid_at`、`amount`、`currency`；**表上沒有期間欄**，`periodStart`／`periodEnd` 傳 `null`，元件會隱藏 |
| 取消 | `rpc cancel_household_subscription(p_subscription_id)`；錯誤 `subscription_not_found`、`subscription_not_cancellable` |
| 撤回取消 | `rpc resume_household_subscription(p_subscription_id)`；錯誤 `subscription_not_found`、`cancellation_already_dispatched`、`subscription_not_resumable`、`cancellation_not_resumable` |
| 換語言 | `rpc set_subscription_payer_locale(p_subscription_id, p_locale)`（只有付款人本人） |
| 建單 | `rpc create_household_premium_order(p_household_id, p_plan_code, p_terms_version, p_refund_waiver, p_locale, p_replaces_subscription_id)`；之後要呼叫 P2 的 `newebpay-period-checkout`（**尚不存在**）。錯誤 `not_household_owner`、`paid_terms_version_outdated`、`refund_waiver_required`、`subscription_in_progress`、`replaced_subscription_not_found` |

## 接線時要遵守

1. **取消按鈕**：`SubscriptionSection` 的 `cancellationAvailable` 預設 `false`。要等 P2 的 `newebpay-period-alter` 部署後才傳 `true`，否則取消會永遠停在 `cancel_requested`（#1185 Codex 第三輪）。
2. **建單不要提前呼叫**：在 P2 的 checkout Function 存在前呼叫 `create_household_premium_order` 只會留下一張付不了的 pending 訂單（還會把家庭先前的 pending 標為 superseded）。
3. **價格與配額不硬編碼**：全部來自 `PlanOffer`；畫面上沒有任何價格數字，只有 `GRACE_PERIOD_DAYS`（寬限 7 天，owner 5.6.2）與 `RENEWAL_REMINDER_DAYS`（續約前 7 天，owner 5.6.1）兩個天數常數。
4. **建單送出**：`onCheckout` 帶 `{ locale, termsVersion, refundWaiverAccepted: true }`；`refundWaiverAccepted` 型別就是 `true`，沒勾選不可能呼叫。整合層要把 `locale` 傳給 `p_locale`、`termsVersion` 傳給 `p_terms_version`。
5. **換語言時更新 `payer_locale`**（#1185 Codex 第四輪）：由整合層在付款人切語言時呼叫 `set_subscription_payer_locale`，元件本身不做。
6. **不推播、不寄信**：續約前提醒信由 P1 的 cron 寄，本畫面只渲染橫幅（#1185 Codex 第二輪）。
7. **看護畫面零帳務元素**：整合層只能在確認 `resolveBillingAudience !== 'none'` 後才掛這些元件；元件自身也會再擋一次。

## 文案狀態

「七日解除權」與「付費條款」兩段的法律字句是**暫定**。L1（#1183）已合併，但它的條款文字與本畫面的勾選框文案還沒逐字比對；要回來對一次（見 `subscriptionCopy.ts` 檔頭）。

## 還沒做

- 資料 hook（讀訂閱列、收據、價格）與取消／恢復／換語言／建單的呼叫，以及「選出目前這張」的規則
- `/upgrade` 路由、設定頁掛載、App 殼層橫幅掛載
- 付款人已降級後的「Premium 已於 X 日到期」橫幅（monetization-plan §5.3 提到、#1185 範圍清單未列，另開 issue 或隨整合補）
- #1185 完成條件 2、3：staging 假家庭走完四個畫面與看護帳號截圖，需要 P2 上 staging
