<!--
檔案用途：公開作品集 README 原稿，讓訪客先看到產品、合成畫面與閱讀入口。
所在層：scripts/portfolio；build.ts 將本檔複製到公開輸出根目錄。
主要關聯：scripts/portfolio/build.ts、docs/architecture/portfolio-walkthrough.md、docs/operations/portfolio-pipeline.md。
為什麼：長篇工程說明集中於導讀；本檔只使用公開輸出內的路徑，避免下次匯出覆蓋人工整理或引入私有連結。
-->

# 家健錄 Family Health Note

**A shared care notebook: quick daily records for caregivers, clear trends and visit preparation for families.**

A mobile-first app for vitals, medication and care events, with Traditional Chinese, Indonesian and English interfaces.

> **Sanitized portfolio edition.** This is a curated source snapshot with fictional demo data. The local Demo works without a backend; the complete backend and native projects are not included.

[Try the local Demo](#try-the-local-demo) · [Architecture](docs/architecture/overview.md) · [Engineering walkthrough](docs/architecture/portfolio-walkthrough.md) · [Browse the code](src/features/)

<p align="center">
  <img src="public/pwa-screenshot-narrow-en.png" alt="English daily-care illustration with fictional demo readings" width="220">
  <img src="public/pwa-screenshot-narrow.png" alt="Traditional Chinese daily-care illustration with fictional demo readings" width="220">
</p>

*Illustrative screens generated from fixed fictional data. Run the Demo to explore the interactive app.*

## What it helps people do

| For | Everyday task |
| --- | --- |
| Caregivers | Record vitals, medication and care events on a phone, in a familiar language |
| Family members | Follow trends, medication changes and upcoming care tasks for each patient |
| Clinic visits | Bring a structured summary of recorded facts and questions to discuss with the doctor |

The app organizes facts and questions; it does not diagnose or recommend medication changes.

## Three engineering decisions to explore

1. **Patient identity is a data boundary.** Health records, caches and drafts belong to an explicit `patient_id`; the full system enforces access through Supabase RLS. [Authorization design](docs/architecture/auth-and-rls.md) · [Data model](docs/architecture/data-model.md)
2. **Saving a record and delivering a notification are separate outcomes.** Notification failures do not undo saved readings, and retry paths account for uncertain delivery and duplicate writes. [Vitals](docs/features/vitals.md) · [Notifications](docs/features/notifications.md)
3. **Care has to cross languages and handoffs.** Typed trilingual text and a rule-based pre-visit brief connect daily records to family review. [i18n checks](tests/unit/i18n.test.ts) · [Pre-visit brief](docs/features/pre-visit-brief.md)

## Try the local Demo

Use the Bun version pinned in [.bun-version](.bun-version):

```bash
bun install
bun run dev
```

Open [http://localhost:5100/demo](http://localhost:5100/demo). Demo mode uses fictional patients and browser storage. No Supabase project is needed for this path.

**Backend limitation:** pointing the app at an empty Supabase project will not make the full system work. Migrations, database policies, RPCs and operational Edge Functions are omitted. The snapshot includes only a few shared contracts needed by the frontend; backend design is documented under `docs/`.

## Choose a reading path

| Interested in | Start here |
| --- | --- |
| System structure and tradeoffs | [Architecture overview](docs/architecture/overview.md) → [Engineering walkthrough](docs/architecture/portfolio-walkthrough.md) |
| Patient authorization | [Auth and RLS](docs/architecture/auth-and-rls.md) → [Care-access identity binding](docs/architecture/care-access-identity-binding.md) |
| Product behavior | [Medical trajectory](docs/features/medical-trajectory.md) · [Pre-visit brief](docs/features/pre-visit-brief.md) |
| Implementation and checks | [Feature modules](src/features/) · [Data adapters and rules](src/lib/) · [Unit tests](tests/unit/) |

Stack: **React · TypeScript · Vite · Tailwind CSS · Supabase · PWA · Capacitor**. Backend and native-shell descriptions refer to the complete system; this snapshot focuses on the web frontend.

## 中文摘要

家健錄協助看護用手機記錄每日照護，讓家屬查看趨勢、整理藥單變更與回診問題。介面提供繁中、印尼文、英文；系統只整理事實與提問，不診斷、不建議調藥。

這份公開作品集包含去識別化的前端、設計文件與測試；可直接啟動本機 Demo。完整後端、維運與原生專案未公開。程式註解與多數技術文件使用繁體中文。

## Snapshot scope and development

An allowlist-based export pipeline replaces private identifiers and excludes operational files and private test dependencies. See the [walkthrough](docs/architecture/portfolio-walkthrough.md#snapshot-boundaries) for scope and validation limits.

```bash
bun run lint
bun run test:unit
bun run build
```

`test:unit` uses `bun test --isolate`. Other available scripts are listed in [package.json](package.json). Links in `CHANGELOG.md` may point to the private source repository; the file is retained for the app's release-notes page.

## License

MIT — see [LICENSE](LICENSE).
