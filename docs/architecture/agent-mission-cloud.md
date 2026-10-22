<!--
檔案用途：既有網站派工到本機 CLI 的雲端佇列設計與驗收界線。
所在層：docs/architecture；工程工具，與照護資料流程分離。
主要關聯：packages/agent-mission-control、system-admin、mission_control_* RPC、agent-mission-control.md。
-->

# 網站派工與本機領單

使用者選擇從既有網站派工，iPhone 不需要 Tailscale。網站沿用 Supabase session 與管理頁，Mac 主動透過 HTTPS 領單及回報，CLI 登入與 GitHub credential 留在原主機；Mac 仍須開機、連網。私有入口是獨立套件的另一種使用方式，不是網站模式的前提。

## 最小實作

沿用既有 Supabase PostgreSQL／REST RPC，不新增雲端 Agent、SDK、訊息服務或 Vercel server。兩張專用表存 worker 的雜湊配對密鑰、repo/base、快照／heartbeat，以及耐久工作單；不保存 issue 正文、照護資料、CLI OAuth 或 service-role key。管理 RPC 僅認既有 runtime 管理者且 owner uid 一致，原始表不授予 client 直接讀寫。Mac 的 capability 只能領取自己那個 repo 的工作，不能查健康表或另一台 worker。匿名 HTTP 呼叫仍須 256-bit secret；只存 SHA-256，不以 anon key 當派工密碼。

雲端配對後只由網站派工與控制，本機／私人頁保留清單和進度，拒絕直接 enqueue／retry／cancel／pause。配對前須先完成或取消本機待辦；共同佇列也擋本機插隊，避免雲端尚未領取的同票再跑一次。不增加兩邊佇列的 reservation 同步協定。

首次設定明列 repo script 與解包 CLI 兩種入口，不假設 tarball 已在 PATH 安裝全域指令。分享包使用者替換實際套件／checkout 路徑；CLI 印出的啟動／停止提示以實際 Bun、CLI 與 checkout 路徑加 shell 引用，避免空白或引號讓配對後的下一步失敗。

配對 CLI 在建立 cloud 設定／顯示配對碼之前，先耐久保存升級的 v2 state（含既有歷史）；舊 local-only CLI 先因版本不符拒絕載入，不能在新 daemon 尚未啟動時忽略網站單另派同一票。

Mac 一次性產生配對碼，擁有者在已登入的管理頁登記 repo/base。之後套件只需要私有 runtime 設定即可重啟，不需要重新複製 ticket。設定保存在 Git common directory，權限 0600，不進 package 或 Git；其他 repo 使用自己的配對與 local state。撤銷 worker 立即拒絕後續領單，既有本機工作只照取消／發布邊界處理。重新配對前停止服務，cloud-unlink 封存舊設定／保留歷史並取消未開始的舊單；新世代不回報或執行舊單。

雲端領單與回報的請求同時受十秒逾時及服務停止訊號控制；停止立即中止仍在等待 headers／body 的請求，再等待本機收尾。不能延長 CLI 停止期限來掩蓋卡住的連線；未確認回應的 claim nonce／進度仍保留耐久狀態，重啟後核對同一工作，不重派。

## 工作與未知結果

POST 工作單附 UUID request id；斷線重送只取得原單。資料庫鎖住 worker 並原子 claim，一個 worker 同時只有一件未終結 claim。claim nonce 在送出前寫進本機 runtime，回應遺失時只查同一 nonce；不猜別的 worker 是否已開始。新 executor 將既有 v1 state 保留工作升為 v2，舊 executor 因版本不符拒絕載入，避免忽略新增的雲端來源。每一代配對有耐久 link id，cloud claim/link id 同本機工作原子保存；重啟沒有 bridge、回應未知或世代不符都拒絕執行／發布。雲端工作 id 對應耐久 local job id，恢復時不重新 enqueue 已存在的工作。網路錯誤只補送狀態，不能重跑 model 或 GitHub publication。沒有自動逾時回收／重新派工；失聯顯示最後 heartbeat，已領單要由原 Mac 回復或人工查驗。

網站每次授權重試遞增工程工作單的 `retry_revision`，Mac 把世代與 queued 同一次保存；相同世代不重啟，也不再解開 quota／登入暫停。回報帶已接受的世代，資料庫忽略晚到的舊 report，新 attempt 即使立即 blocked／failed／interrupted 也 ACK 並清除 retry flag；已核准取消仍可由舊終結結果確認。worker RPC 使用 protocol 2 的明確雙向契約，舊 CLI／舊 endpoint 拒絕工作，不猜相容；未新增 runtime dependency、健康資料欄位或新計費方式。

取消先在雲端記錄，Mac 再經既有 cancel 路徑處理；publishing 不偽裝成取消。pause 只阻止下一件，保留正在執行的工作；取消後回工作卡片重新派工；明確取消被接受，或取消回應遺失後權威清單確認同一單已取消，才結束原派工 UUID，新工作使用新 UUID。未確認的普通派工重送仍沿用原 UUID；retry 僅限明確安全的失敗／阻擋／中斷，由網站授權後再交 Mac，不允許 publication-unknown／已完成工作重新執行。取消優先於尚未執行的 retry；舊失敗回報可確認取消，但未知發布絕不偽裝成取消。只同步封閉 status、已遮蔽且限長的 summary/reason、同 repo PR URL，不上傳任意 workspace、環境或 transcript。

管理清單每頁 100 張工程單，以不可變 `created_at/id` 游標往較早頁查詢；後端先確認游標屬同一 owner／worker，回應一律去除 claim／request id。更新仍留在同一頁，翻頁先等在途讀取完成；派工／撤銷後回最新頁，未知 UUID 不因翻頁重置。深頁連接被另一裝置撤銷而 forbidden 時，仍由同一 owner RPC 重讀最新頁，成功才清 cursor；一般網路失敗保留原頁。這讓第 101 張以上的待辦仍可查看／取消，不採一次無限載入或用終結歷史上限藏掉待辦（#1303）。

網站配對指令帶上目前 `--locale`，與共用 CLI zh／id／en 字庫一致；配對、解除及下一步命令一次只顯示一種語言，不在同一行混印翻譯（#1302）。

## 選擇與排除

- Tailscale 程式碼更少，但手機需額外連線，使用者已選網站直接操作，因此不作網站模式前提。
- 不用 GitHub comments／labels 當 queue，避免工程留言、通知與 claim 控制混在一起。
- 不在 Vercel 執行 CLI，避免改成 API 計費及長任務受請求生命週期限制。
- 不新增 Edge Function 或 service-role secret：狀態與 claim 是資料交易，用現有 REST RPC 即可。敏感授權與輸入驗證仍在資料庫。
- 不使用 lease 到期自動重跑；AI／push 是否已發生不能由 heartbeat 推定。

## 驗收與發布

驗證匿名／非管理者／其他 owner／錯密鑰／撤銷／錯 repo 都被拒絕，重送 UUID、claim nonce、雙領單、取消、重啟與未知 publication 有實際可執行測試；完整 migration replay 及既有 care access RLS 測試必須通過。介面具 zh/id/en、44px 觸控、原生欄位 2px 高對比邊框，結果連結使用可承載最小高度的 display，並具載入／斷線／未配對狀態，三語手機尺寸與本機假 repo 端到端驗證。

先交付 staging／preview。新增 migration 只新增兩張工程表與 RPC／權限，沒有病人／照護表變更、真人 seed、既有 auth policy 放寬；自動 migration 仍需在提交前說明。既有正式網站啟用需遵守 AGENTS.md「正式環境發布與批次管理」，不能把 PR 完成當成 production 已可用。
