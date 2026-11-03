<!--
檔案用途：公開作品集的工程導讀，保留 README 精簡後的架構脈絡、代表性實作與驗證邊界。
所在層：docs/architecture；此路徑在公開匯出 allowlist 內，不可放入私有營運資訊。
主要關聯：overview.md、auth-and-rls.md、data-model.md、../../README.md。
為什麼：讓首頁能快速讀完，深入閱讀仍有單一入口；連結以本檔位置解析，避免搬動文字後相對路徑失效。
-->

# Family Health Note — engineering walkthrough

This guide connects the product overview to representative implementation paths. It describes the complete system's design; the public snapshot contains the web frontend, selected shared contracts, design documents and runnable tests. Backend and native implementations mentioned here are not all included.

[Back to the project README](../../README.md)

## Architecture at a glance

```text
Google Identity Services → Supabase Auth session
                                 │
                 profiles / households / care_access
                                 │
                     authorized patient UUID
                                 │
          vitals · medication · care events · reminders · labs
                                 │
              daily care · trends · pre-visit brief
```

| Layer | Representative path | Responsibility |
| --- | --- | --- |
| App shell | [App.tsx](../../src/App.tsx) | Session, public routes, navigation and consent gates |
| Features | [src/features/](../../src/features/) | Pages, components and hooks grouped by care domain |
| Shared UI | [src/components/](../../src/components/) | Pickers, settings, tutorials and reusable controls |
| Data and rules | [src/lib/](../../src/lib/) | Supabase adapters, clinical rules, i18n, caches and demo storage |
| Rules as data | [src/config/](../../src/config/) | Blood-pressure standards and alert configuration |

Read the [architecture overview](overview.md), then [authorization](auth-and-rls.md) and the [data model](data-model.md) for the full design context.

## Patient identity and authorization

Every health record belongs to an explicit `patient_id`, including records for the signed-in person's own care. The operator's user ID describes who acted; it does not identify whose reading was recorded.

In the full backend, `care_access` grants patient-specific capabilities and RLS checks the authenticated user. Patient-switch handling also matters in the browser: a late response, draft or cached value must not appear under the next patient. Frontend visibility is never a substitute for database authorization.

Design: [Auth and RLS](auth-and-rls.md), [care-access identity binding](care-access-identity-binding.md).

## Four small data-layer primitives

| Failure to account for | Implementation to inspect |
| --- | --- |
| A previous patient's slow response overwrites the current screen | [useLatestRequest.ts](../../src/hooks/useLatestRequest.ts): request tokens reject stale results |
| Supabase, network and browser errors have different shapes | [dataErrors.ts](../../src/lib/dataErrors.ts): shared extraction and localized messages |
| Offline storage mixes patients or fails to parse | [localCache.ts](../../src/lib/localCache.ts): patient-scoped keys and guarded storage access |
| A timed-out write is submitted twice on retry | [bloodPressurePendingQueue.ts](../../src/lib/bloodPressurePendingQueue.ts) and [bloodPressureRecords.ts](../../src/lib/bloodPressureRecords.ts): stable client IDs and duplicate handling |

## Saving and notification delivery

Saving a health record and notifying a family member have different failure modes. A notification failure must not undo the saved record. The complete system uses a delivery ledger, conditional claims and token-checked resolution; an uncertain delivery outcome is not blindly retried.

The public snapshot documents this backend contract rather than supplying the operational notifier. Read [vitals](../features/vitals.md), [notifications](../features/notifications.md) and [personal notifications](../features/personal-notifications.md).

## Language, offline work and native boundaries

- **Three locales:** `LocalizedText` requires `zh`, `id` and `en`; [i18n.test.ts](../../tests/unit/i18n.test.ts) checks source text for placeholder translations and language mixing.
- **Unsaved work:** [pwaUpdateGuard.tsx](../../src/lib/pwaUpdateGuard.tsx) tracks unsaved forms so a PWA update can wait. This is a design mechanism, not evidence that every browser or device scenario passed acceptance.
- **Native privacy:** [bloodPressureLiveActivity.ts](../../src/lib/bloodPressureLiveActivity.ts) restricts lock-screen payloads; [useAppLock.ts](../../src/hooks/useAppLock.ts) handles app-lock state. The native projects are omitted from the public snapshot. See [native app lock](../features/native-app-lock.md) and [Live Activity](../features/blood-pressure-live-activity.md).

## Testing and its limits

| Layer | Entry point | What it establishes |
| --- | --- | --- |
| Unit | `bun run test:unit` | Isolated `bun:test` checks; mocked adapters do not prove hosted RLS |
| Blood-pressure rules | [contract.test.ts](../../tests/unit/contract.test.ts), [frozen cases](../../tests/bp-contract-tests.json) | Regression coverage for the declared rule cases |
| Language | [i18n.test.ts](../../tests/unit/i18n.test.ts) | Automated source checks, alongside human translation review |
| Browser | `bun run test:e2e` | The flows and browser configured in [playwright.config.ts](../../playwright.config.ts) |
| Public CI | `.github/workflows/portfolio-ci.yml` | Lint, typecheck, unit tests, build and secret scanning for that snapshot revision |

`--isolate` prevents test mocks from leaking between files. A passing test suite is not a claim of physical-device, Safari, offline, accessibility, clinical or production acceptance.

## Snapshot boundaries

The source repository maintains an allowlist-based export pipeline: it replaces configured identifiers, removes tests that depend on omitted files, and checks the generated output. The private replacement and forbidden-string lists are not published. The public CI cannot reproduce that private identity scan.

The public snapshot omits:

- Database migrations, seed data and executable RLS authorization suites.
- Operational Edge Functions, secrets, deployment, backup and import tooling.
- Native projects and private agent-operation files.
- Real people, accounts, infrastructure identifiers and health records.

A few pure shared contracts under `supabase/` and `packages/` are included so frontend imports resolve. Their presence does not make this a deployable backend. Some design documents describe private implementation paths; those references document design rather than promising that the files are present.

The supported starting point is the local `/demo` route. To inspect behavior, use fictional data and the included tests. Connecting an empty Supabase project does not recreate the omitted backend.
