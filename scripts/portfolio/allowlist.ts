/*
檔案用途：PORTFOLIO-01 產線的 allowlist 設定——只有這裡列出的路徑會被複製進公開作品集輸出目錄。
所在層：scripts/portfolio，供 build.ts 讀取；本檔案本身不執行任何動作。
主要關聯：docs/operations/portfolio-pipeline.md 第 3.1 節；新增任何私有內容時，只要不在這份清單裡就不會外流（default-deny）。
*/

// 為什麼用 allowlist 而不是「複製全部再排除」：新增檔案（例如某次不小心產生的 CSV 或 SQL dump）
// 若沒有明確加進這份清單，就永遠不會進入公開輸出，不必仰賴「記得排除它」。

// 遞迴複製的目錄（相對於 repo root）。
//
// ⚠️ scripts/portfolio 絕不能整個加進這裡：owner 執行 build 時，scripts/portfolio/
// 目錄底下就正躺著含真實個資的 replacements.local.json 與 forbidden.local.json
// （兩者都已加進 .gitignore，但 cpSync 遞迴複製是直接操作檔案系統，完全不理會
// .gitignore；只要這個目錄被整個當成 ALLOWLIST_DIRS 的一員，這兩份私有設定檔就會被
// 原封不動複製進公開輸出目錄）。這個產線自己的原始碼要公開，只能像下面
// ALLOWLIST_FILES 那樣逐一列出安全的 .ts／.example 檔案，永遠不能用目錄遞迴複製。
export const ALLOWLIST_DIRS = [
  'src',
  'public',
  'docs/architecture',
  'docs/features',
  'tests/unit',
]

// 單一檔案（相對於 repo root）。
export const ALLOWLIST_FILES = [
  'package.json', // 會另外做 script 欄位篩選，見 build.ts pruneScripts()
  'bun.lock',
  // 沒有它，bun test 不會 preload tests/unit/helpers/reactHookHarnessPreload.ts，
  // 公開版跑較小檔案子集時就會重新踩到 issue #608 的 react hook mock 檔案順序脆弱性。
  'bunfig.toml',
  'tsconfig.json',
  'tsconfig.app.json',
  'tsconfig.node.json',
  'vite.config.ts',
  'eslint.config.js',
  'playwright.config.ts',
  'index.html',
  '.env.example',
  // 公開版 README 說 Bun 版本釘在 .bun-version、授權是 MIT；這兩個檔案不進 allowlist 的話，
  // 公開 repo 就是在宣稱一個自己沒有的檔案（Codex review 在 PR #1013 抓到）。
  '.bun-version',
  'LICENSE',
  // PORTFOLIO-01 產線自己的原始碼——逐一列出，見上方 ALLOWLIST_DIRS 的警告：
  // 絕不能把 scripts/portfolio 整個目錄加進 ALLOWLIST_DIRS。
  'scripts/portfolio/allowlist.ts',
  'scripts/portfolio/build.ts',
  'scripts/portfolio/check.ts',
  'scripts/portfolio/release.ts',
  'scripts/portfolio/verify.ts',
  'scripts/portfolio/checkLogic.ts',
  'scripts/portfolio/releaseLogic.ts', // tests/unit/portfolioReleaseLogic.test.ts 依賴
  'scripts/portfolio/testPruneLogic.ts', // build.ts 與 tests/unit/portfolioTestPruneLogic.test.ts 依賴
  'scripts/portfolio/checkStamp.ts', // check.ts、release.ts 與 tests/unit/portfolioCheckStamp.test.ts 依賴
  'scripts/portfolio/publish.ts',
  'scripts/portfolio/replacements.local.json.example',
  'scripts/portfolio/forbidden.local.json.example',
  // 管理頁會直接匯入這份純政策常數；只收錄此檔才能讓公開版建置成功，同時維持 supabase/ 預設不公開。
  'supabase/functions/_shared/paidFeatureEntitlementPolicy.ts',
  // 管理頁需要共用的資料契約才能載入；只公開這兩份純函式，避免把 CLI、worker 與配對流程一起輸出。
  'packages/agent-mission-control/src/cloud-model.ts',
  'packages/agent-mission-control/src/model.ts',
  'tests/bp-contract-tests.json', // tests/unit/contract.test.ts 依賴，不屬於 tests/unit/ 目錄本身
  'CHANGELOG.md', // src/features/system-admin/pages/ReleasesPage.tsx 用 `?raw` 靜態 import，vite build 需要這個檔案存在；
                  // 內容只有 release-please 產生的功能/修正條目與 commit 連結，無個資（連結指向私有 repo，公開版點了會 404，可接受）。
]

// tests/*.spec.ts（Playwright，位於 tests/ 根目錄，不在 tests/unit/ 遞迴範圍內）。
export const ALLOWLIST_GLOB_SPEC_FILES = [
  'tests/calendarSchedule.spec.ts',
  'tests/caregiverInvitation.spec.ts',
  'tests/dailyCareDisplay.spec.ts',
  'tests/nutrition.spec.ts',
  'tests/readingScale.spec.ts',
  'tests/smoke.spec.ts',
  'tests/webview-warning.spec.ts',
]

// 在已允許的目錄範圍內，仍要排除的個別檔案。
//
// 為什麼這份清單是「跑過 bun test 找出來的」而不是單靠 grep 猜的：第一版只 grep 了
// import scripts/ 的測試（5 個），結果實際在輸出目錄跑 `bun test tests/unit` 才發現
// 還有 43 個測試因為讀取 supabase/（migrations、functions）、ios/（Info.plist）、
// 或 root 設定檔（vercel.json）而在載入階段就整份 crash——grep import 語句抓不到
// `readFileSync(new URL('../../supabase/migrations/...'))` 這種動態路徑讀檔。
// 教訓：改動這份清單後必須實際在輸出目錄跑一次 bun test 驗證，不能只用 grep 推論。
//
// 2026-09 起，「依賴未公開檔案」這一類改由 build.ts 自動偵測移除（見 testPruneLogic.ts），
// 下面這類既有條目保留作為明確紀錄；新增這類測試不需要再手動補進來。
// 仍然必須手動列的，是自動偵測抓不到的原因：依賴真實個資值、測試 harness 順序敏感等。
export const EXCLUDE_WITHIN_ALLOWLIST = [
  // 依賴 scripts/（備份、匯入等維運腳本，未進 allowlist）：
  'tests/unit/importMoaAnimalDrugs.test.ts',
  'tests/unit/databaseBackupV2.test.ts',
  'tests/unit/medicationCatalogBackfill.test.ts',
  'tests/unit/importNhiTcmProducts.test.ts',
  'tests/unit/tfdaDrugImport.test.ts',
  // 依賴 supabase/migrations/*.sql 內容（migration 逐條驗證測試；P0 決策：整個
  // supabase/ 不進 allowlist，見文件 1.2 第 4 點）：
  'tests/unit/calendarNotificationMigration.test.ts',
  'tests/unit/careDueRemindersMigration.test.ts',
  'tests/unit/careEventPhotoMigration.test.ts',
  'tests/unit/careEventPhotoRetentionMigration.test.ts',
  'tests/unit/caregiverInvitationsMigration.test.ts',
  'tests/unit/dailyCarePreferenceMigration.test.ts',
  'tests/unit/fourDailyWeightMigration.test.ts',
  'tests/unit/healthConsentTypeUpgradeMigration.test.ts',
  'tests/unit/medicationAppearancePhotoRetentionMigration.test.ts',
  'tests/unit/medicationTimelineMigration.test.ts',
  'tests/unit/motherPatientOnlyAccessMigration.test.ts',
  'tests/unit/nutritionMigration.test.ts',
  'tests/unit/patientAccessMigration.test.ts',
  'tests/unit/patientInvitationSharingMigration.test.ts',
  'tests/unit/patientShareLinkRedemptionMigration.test.ts',
  'tests/unit/patientShareLinksMigration.test.ts',
  'tests/unit/prnMedicationMigration.test.ts',
  'tests/unit/publicHealthDataAccessMigration.test.ts',
  'tests/unit/shareLinkManagementMigration.test.ts',
  'tests/unit/weightLegacyRetentionMigration.test.ts',
  'tests/unit/weightRetentionMigration.test.ts',
  'tests/unit/securityReviewFollowupsMigration.test.ts',
  'tests/unit/analytics.test.ts', // 同樣以 readFileSync 讀取一個 migration 檔案驗證版本號
  // 依賴 supabase/functions/*（Edge Function 原始碼，未進 allowlist）：
  'tests/unit/adminListUsers.test.ts',
  'tests/unit/adminListUsersFunction.test.ts',
  'tests/unit/bloodPressureNotifier.test.ts',
  'tests/unit/calendarAgendaFunction.test.ts',
  'tests/unit/calendarAgendaRules.test.ts',
  'tests/unit/calendarNotifier.test.ts',
  'tests/unit/careDueRemindersFunction.test.ts',
  'tests/unit/careEventPhotoRetention.test.ts',
  'tests/unit/googleCalendarClient.test.ts',
  'tests/unit/invitationEmail.test.ts',
  'tests/unit/medicationAppearancePhotoRetention.test.ts',
  'tests/unit/medicationOcr.test.ts',
  'tests/unit/medicationOcrFunction.test.ts',
  'tests/unit/sendInvitationEmailFunction.test.ts',
  'tests/unit/shareCors.test.ts',
  'tests/unit/shareLinkExchange.test.ts',
  'tests/unit/shareLinkFunctionsCors.test.ts',
  'tests/unit/shareSession.test.ts',
  'tests/unit/shareSummary.test.ts',
  // 依賴 ios/（Capacitor 原生殼，未進 allowlist）：
  'tests/unit/nativeAuth.test.ts',
  // 依賴 root 設定檔（未進 allowlist）：
  'tests/unit/vercelHeaders.test.ts', // 讀取 vercel.json
  'tests/unit/temperature.test.ts', // 同時讀取一個 migration 檔案驗證欄位定義
  // 斷言帳號字面值（產線套用替換規則後斷言會失敗）：
  'tests/unit/auth.test.ts',
  'tests/unit/medicationToday.test.ts',
  // 依賴自訂 React hook 測試 harness 對 bun:test `mock.module('react', ...)` 的
  // 全域、跨檔案共用行為（見這兩個檔案自己的註解：「bun 的 mock.module 是整個測試程序共用的」）。
  // 這個環境依賴對「哪些檔案、用什麼順序跑」很敏感——完整跑 227 個測試檔時順序沒踩到問題，
  // 但公開版只有 88 個檔案，執行順序不同，讓 harness 沒能正確接管 useContext，
  // 產生 LocaleProvider／useI18n 相關的假失敗。跟個資／安全無關，純粹是測試環境的檔案子集
  // 順序敏感性；公開 repo 自己的 portfolio-ci.yml 跑第一次（341 → 341 個檔案，commit
  // aad50de）就踩到了這個問題，才發現需要排除。
  'tests/unit/reactStateHooks.test.ts',
  'tests/unit/latestVitalsRender.test.ts',
]

// package.json 的 scripts 欄位裡，只保留跟「跑得起來這個 repo」直接相關的指令；
// 其餘（native app 建置、私有維運腳本、資料匯入／備份／種子）對應的檔案本來就不在
// allowlist 裡，留著這些 script 只會讓公開版的 `bun run xxx` 指到不存在的檔案。
export const KEPT_PACKAGE_JSON_SCRIPTS = ['dev', 'build', 'lint', 'preview', 'test:e2e', 'test:unit', 'test:coverage']
