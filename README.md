<!--
檔案用途：公開作品集版（sanitized portfolio edition）的 README 原稿，由 scripts/portfolio/build.ts 原樣複製到輸出目錄根部。
所在層：scripts/portfolio；只在私有 repo 維護，公開 repo 看到的是複製後的檔案（這段導覽註解會一起帶過去，無妨）。
主要關聯：scripts/portfolio/build.ts（copyPublicReadme）、docs/operations/portfolio-pipeline.md 第 4 節；
內容只能引用公開輸出裡真的存在的路徑，且不得出現任何真實 email／網域／project ref／家庭成員資訊——
它會跟其他文字檔一樣經過替換規則與禁字掃描，但寫的時候就不該依賴那道防線。
-->

# 家健錄 Family Health Note — Sanitized Portfolio Edition

[![portfolio-ci](https://github.com/demo-xq7/jia-jian-log-portfolio/actions/workflows/portfolio-ci.yml/badge.svg)](https://github.com/demo-xq7/jia-jian-log-portfolio/actions/workflows/portfolio-ci.yml)
![React 18](https://img.shields.io/badge/React-18-61dafb?logo=react&logoColor=111827)
![TypeScript 5.6](https://img.shields.io/badge/TypeScript-5.6-3178c6?logo=typescript&logoColor=white)
![Supabase RLS](https://img.shields.io/badge/Supabase-Postgres%20%2B%20RLS-3ecf8e?logo=supabase&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-1.4-f9f1e1?logo=bun&logoColor=111827)

> **This is a sanitized snapshot of a private repository, not the full source.** It is produced by an automated,
> reproducible pipeline (`scripts/portfolio/`) that copies only an explicit allowlist, rewrites identifiers, strips
> tests that depend on private files, and refuses to publish if anything on a private forbidden-string list survives.
> Personal data, production keys, infrastructure identifiers and private ops tooling are removed or replaced with
> synthetic values. Some design docs still reference private paths (`supabase/migrations/…`, `AGENTS.md`);
> those describe the private repo and are kept because the design reasoning is the point.
>
> Code comments and the design docs under `docs/` are written in Traditional Chinese; this README is in English.

## 中文摘要

家健錄是一個 **mobile-first 的家庭健康照護紀錄 App**：讓看護在手機上兩分鐘內記完血壓、服藥、體溫、體重、飲食與照護事件，讓家屬在另一台裝置上看到趨勢、調整藥單、收到警示通知，並在回診時帶著整理好的摘要去問醫師。介面同時提供繁體中文、印尼文、英文三種語言（看護與家屬常常不說同一種語言）。

技術上是 **Vite + React 18 + TypeScript** 的 SPA，後端是 **Supabase（Postgres + Row Level Security + Edge Functions）**，另有 PWA 離線支援與 Capacitor iOS/Android 原生殼。這份公開版刻意只放前端原始碼、架構文件與可獨立執行的單元測試；migration 歷史、Edge Function 原始碼與維運腳本留在私有 repo，其設計以 `docs/architecture/` 的文件呈現。

## What problem it solves

A family caring for an elderly relative at home has a coordination problem, not a data-entry problem:

- The person taking the readings (often a live-in caregiver) needs a form that works one-handed on a phone, in her own language, with a clear "measure again in 60 seconds" flow.
- Family members elsewhere need trends, not raw rows: is the evening blood pressure drifting low again, did this morning's medication get taken, what changed since the last clinic visit.
- Everyone involved needs to be certain that a value they are looking at belongs to *this* patient, even when the same account also cares for a second person or a pet.

The app is built around that last point. `patient_id` is the only identity a health record can belong to, the database enforces who may read or write each patient, and the front end is treated as convenience, not as a security boundary.

<p align="center">
  <img src="public/pwa-screenshot-narrow-en.png" alt="Daily care screen in demo mode" width="260">
  &nbsp;&nbsp;
  <img src="public/pwa-screenshot-narrow.png" alt="每日照護畫面（展示模式）" width="260">
</p>

## Try it without a backend

```bash
bun install
bun run dev          # http://localhost:5100
```

Open `/demo`. Demo mode runs entirely on fixed fictional patients in browser storage; with no `VITE_SUPABASE_URL`
configured the app only logs a warning and the demo keeps working. The demo has a guided tutorial and a
"start recording my own family" handoff that carries over module preferences but never any health values.

Running against a real Supabase project is **not** something this snapshot can do on its own: the `supabase/`
tree (migrations, RLS policies, RPCs, Edge Functions) is deliberately left out, so `.env.example` only tells
you which variables the app reads, and pointing it at an empty project leaves every table and endpoint missing.
The demo is the supported way to run the snapshot; the backend design is documented under `docs/`.
Nothing in this repo contains a real key.

## Architecture at a glance

```text
Google Identity Services (ID token + nonce)
        │
Supabase Auth session ──► profiles / households / care_access  ◄── the authorization truth
        │
   patient UUID (never an email, name or "self" shortcut)
        │
vitals · medication · care timeline · nutrition · pets · reminders · labs
        │
Dashboard, daily-care hub, pre-visit brief, printable handover, read-only share link
```

| Layer | Where | Role |
| --- | --- | --- |
| App shell | `src/App.tsx`, `src/components/system/` | login, public routes, bottom navigation, consent gates, PWA/update prompts |
| Features | `src/features/*` (12 domains) | one folder per care domain: `vitals`, `medication`, `care-family`, `nutrition`, `pet-care`, `postop-care`, `reminders`, `labs`, `dementia-care`, `today`, `visit`, `system-admin` |
| Shared UI | `src/components/` | tab headers, pickers, subject switcher, settings panels, tutorial overlay |
| Domain & data | `src/lib/` | Supabase adapters, blood-pressure rules, care-day logic, i18n, caches, demo data |
| Rules as data | `src/config/` | blood-pressure alert levels and named standards (general adult, elderly, post-op, CKD/diabetes) as JSON |
| Design docs | `docs/architecture/`, `docs/features/` | why each boundary exists, what was rejected, incident-driven rules |

Start with [`docs/architecture/overview.md`](docs/architecture/overview.md), then
[`auth-and-rls.md`](docs/architecture/auth-and-rls.md) and [`data-model.md`](docs/architecture/data-model.md).

## Things worth a closer look

**Every health value is bound to a patient, and the database enforces it.**
Authorization lives in one table, `care_access(user_id, patient_id, can_record, can_manage_medication, …)`, whose own
policy only ever returns the caller's rows. Roughly a hundred downstream policies check `access.user_id = auth.uid()`
through that table; the migration that switched them from email matching to `auth.uid()` verifies itself via `pg_depend`
and fails the deploy if any policy still compares emails. Because RLS cannot express "this row must not move to
another patient", a `BEFORE UPDATE` trigger rejects any change to `patient_id` on every patient-scoped table, and a
catalog-level test fails if a new table forgets it. "Self" is also a patient: the logged-in user's UUID is never used as
the measured person. Design: [`docs/architecture/auth-and-rls.md`](docs/architecture/auth-and-rls.md),
[`care-access-identity-binding.md`](docs/architecture/care-access-identity-binding.md).

**Login is Google Identity Services into Supabase Auth, with the allowlist in the database.**
The official Google button returns an ID token; the app calls `signInWithIdToken()` with a per-login nonce
(SHA-256 to Google, raw value to Supabase). Only accounts present in `profiles` can do anything, and that is enforced
by RLS, not by the route guard. The native shell uses PKCE through the system browser with a strict callback parser
(`src/lib/nativeAuth.ts`); the LINE in-app browser is detected and redirected out because it cannot complete GIS.

**Four small primitives keep the read layer honest** ([`overview.md`](docs/architecture/overview.md) §讀取層):

| Problem | Module |
| --- | --- |
| A slow response from the *previous* patient must not overwrite the screen after switching | `src/hooks/useLatestRequest.ts` — each query takes a token; stale results are dropped |
| Supabase, network and browser errors arrive in different shapes | `src/lib/dataErrors.ts` — one extractor, and messages are returned as `LocalizedText`, so a caller cannot show an untranslated string |
| Offline cache must never mix patients or crash on broken storage | `src/lib/localCache.ts` — `patientScopedCacheKey()` puts the patient in the key; storage failures degrade to "no offline copy" |
| A blood-pressure write that times out must not create a duplicate on retry | `src/lib/bloodPressurePendingQueue.ts` + `bloodPressureRecords.ts` — client-side UUID, `23505` is read back as `already-existed`, only transient errors are queued |

**A failed notification never rolls back a health record.**
After a successful insert the browser sends only `recordId` and `patientId` to an Edge Function, which re-reads the row
through the caller's own RLS context and requires `recorded_by` to match the JWT. Deliveries go through a ledger with
five states (`pending → sending → sent | delivery_unknown | failed_terminal`): a conditional `UPDATE` claims the row and
returns a `claim_token`, the message is sent only when the claim succeeded, and the resolve step is one-way and
token-checked so a late retry cannot overwrite a newer outcome. `delivery_unknown` is never retried blindly, because the
message may already be on someone's phone. Specs: [`docs/features/vitals.md`](docs/features/vitals.md),
[`notifications.md`](docs/features/notifications.md), [`personal-notifications.md`](docs/features/personal-notifications.md).

**Trilingual UI, enforced at the type level and by a test.**
`LocalizedText = Record<'zh' | 'id' | 'en', string>`; data-boundary functions return `LocalizedText`, so a missing
locale is a compile error. `tests/unit/i18n.test.ts` scans every file under `src/` for placeholder translations,
Chinese fallbacks inside English strings, and language mixing between Indonesian and English (with an explicit
allowlist for shared loanwords and brand names).

**Offline and update behaviour are designed together.**
The PWA uses `registerType: 'prompt'`; an update is never applied while any mounted form, including a hidden tab,
still has unsaved input (`src/lib/pwaUpdateGuard.tsx`). Supabase endpoints and `/version.json` are network-only, so a
stale service worker can never serve old data or hide which build is running. Build provenance (version, commit, build
time) is injected by `vite.config.ts` and shown in the app.

**Native shell without a native rewrite.**
Capacitor wraps the same Vite build. The TypeScript side of the iOS lock-screen countdown
(`src/lib/bloodPressureLiveActivity.ts`) allowlists the payload so the lock screen never shows a name, patient ID or
reading; the optional Face ID app lock (`src/hooks/useAppLock.ts`, `AppLockGate.tsx`) fails closed when it cannot prove
how long the app was in the background. The Swift side is private; its review notes are in
[`docs/features/native-app-lock.md`](docs/features/native-app-lock.md) and
[`blood-pressure-live-activity.md`](docs/features/blood-pressure-live-activity.md).

**The pipeline that produced this repo is itself a security-engineering exercise** (`scripts/portfolio/`).
Default-deny allowlist (a new CSV or SQL dump can never leak by omission), fail-closed configuration (a missing or
template-only replacement/forbidden list is an error, not an empty scan), case-insensitive and regex-escaped literal
replacement with a function replacer so a `$` in a value cannot re-inject the original, automatic pruning of tests that
reference private paths, a check step that hard-rejects `.csv`/`.sql`/`.env*`/`.git` and then runs install, lint,
typecheck, tests and build on the *output* directory in a minimal environment, and a release step that refuses to run
if the private repo has a remote pointing at the public one and never force-pushes. The identity scan runs only on the
private side because the forbidden list is itself sensitive; this repo's CI runs lint, typecheck, tests, build and
gitleaks. The pipeline's logic has its own unit tests (`tests/unit/portfolio*.test.ts`).

## Testing strategy

| Layer | What | Notes |
| --- | --- | --- |
| Unit | `bun test --isolate tests/unit` (160+ files in this snapshot) | `bun:test`, no network — Supabase is always mocked. `--isolate` is required: since Bun 1.4 test files share globals by default and the React hook harness (`tests/unit/helpers/`) leaked state between files. |
| Rules | `tests/unit/contract.test.ts` + `tests/bp-contract-tests.json` | 28 frozen (systolic, diastolic, pulse) → alert-level cases. The JSON is never edited; it is the proof that the nine-level table has not drifted. |
| i18n | `tests/unit/i18n.test.ts` | source scan described above |
| Render | `*Render.test.ts` | component output checked through a small element-tree helper, no DOM library |
| E2E | `bun run test:e2e` (Playwright, Chromium) | 7 specs against the demo mode and public routes; starts its own dev server |
| CI | `.github/workflows/portfolio-ci.yml` | lint → `tsc --noEmit` → unit tests → build → gitleaks |

Private-only tests are stripped from this snapshot by the pipeline: migration replay assertions, the SQL authorization
suite that runs every RLS policy as the `authenticated` role with test JWT claims, Edge Function tests, native-shell
tests and ops-script tests. Their existence is documented in the architecture docs; their code is not here.

## Scripts

| Command | Purpose |
| --- | --- |
| `bun run dev` | Vite dev server on port 5100 (`PORT` to override) |
| `bun run build` | `tsc -b && vite build` |
| `bun run lint` | ESLint (`react-hooks/rules-of-hooks` is an error) |
| `bun run test:unit` | unit tests |
| `bun run test:coverage` | unit tests with coverage |
| `bun run test:e2e` | Playwright |
| `bun run preview` | serve the production build |

Bun version is pinned in `.bun-version` (1.4.2). Environment variables are documented in `.env.example`.

## What this snapshot intentionally leaves out

- **Supabase migrations, seed data and the RLS test suite.** The schema and policy design is described in
  `docs/architecture/`; the executable history stays private because it also encodes the real household's history.
- **Edge Function source** (notifier, calendar agenda, share links, admin tools, AI medication draft). Their contracts
  and boundaries are in `docs/features/`.
- **Ops tooling**: deploy workflows, database backup and restore, data-import scripts for the official drug catalog,
  staging seeders.
- **Native projects** (`ios/`, `android/`) and the agent-collaboration rules the private repo is developed under.
- Any real identifier: accounts, domains, project refs, chat IDs, calendar IDs. Where a doc needs an example it uses
  `example.com`-style placeholders or the fixed fictional demo family.

Links in `CHANGELOG.md` point at the private repository and will 404; the file is kept because the in-app release
notes page imports it at build time.

## Repository map

```text
src/
  App.tsx                 shell: session, consent gates, tabs
  components/             shared UI (auth, settings, system, tutorial, ui)
  config/                 blood-pressure rules and standards as JSON
  features/<domain>/      pages, components, hooks per care domain
  hooks/                  cross-feature hooks (auth, subject, save status, latest-request)
  lib/                    data adapters, domain rules, i18n, caches, demo mode
  types/database/         table types split by domain
tests/
  unit/                   bun:test suites (+ helpers/, fixtures/)
  *.spec.ts               Playwright
  bp-contract-tests.json  frozen alert-level contract
docs/
  architecture/           layering, auth & RLS, data model, audit design, maintainability reviews
  features/               per-feature specs and boundaries
scripts/portfolio/        the sanitization pipeline (build / check / release / publish)
public/                   PWA icons, share image, demo illustrations — all generated from fictional data
```

## License

MIT — see [`LICENSE`](LICENSE).
