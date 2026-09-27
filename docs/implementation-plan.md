# Implementation plan

Starting point: empty repository (greenfield). Stack as specified: pnpm monorepo, Next.js 15 App Router, React 19,
TypeScript strict, Tailwind v4 + shadcn/ui-style primitives, React Hook Form + Zod, TanStack Query, Prisma 6 + PostgreSQL,
Auth.js v5 credentials (JWT), Anthropic TypeScript SDK, Vitest, Playwright, Plasmo.

| Phase | Scope | Status |
| --- | --- | --- |
| 0 Inspect | Empty repo → initialise workspace; this plan | done |
| 1 Foundation | Workspace, shared config, types, validation, Prisma schema + migration + seed, Auth.js, env validation, logger, route wrapper, CI | done |
| 2 Onboarding | Consent → upload (validation, malware stub, encrypted storage) → parse task → fact verification → YOE/locations/work mode/roles/notice/salary | done |
| 3 Jobs & matching | Connectors (manual, paste, CSV, forwarded email, career-page URL, browser import, seeded demo, disabled stubs), JD normaliser, taxonomy, deterministic scoring, inbox filters/sort, job detail | done |
| 4 AI & questionnaire | Claude client (structured outputs, retries, fallbacks), versioned prompts, claim validator, questionnaire, tailored-resume planner, screening answers, cover letter, email | done |
| 5 Applications | State machine, batch preparation, drafts editing, approval → tailored version, PDF/DOCX/TXT/HTML export, email preview + confirmation-token send, apply-page tracking, reminders, audit log | done |
| 6 Extension | Plasmo MV3 popup, user-triggered import with preview, prefill with field preview/selection, ATS adapters, generic matcher, no-submit guarantees | done |
| 7 Hardening | Unit + integration + E2E tests, lint/typecheck, accessibility basics (labels, focus, skip link, aria-live), responsive layouts, empty/loading/error states, docs | done |
| 8 Automation orchestration | Gap analysis ([AUTOMATION_GAP_ANALYSIS.md](AUTOMATION_GAP_ANALYSIS.md)) and design ([AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md)); additive migrations (`automation_orchestration`, `automation_backfill`, `automation_hardening`: run-lease owner and executor-found form questions); modes MANUAL / REVIEW / AUTO with the `AUTO_APPLY` consent; deterministic rule engine (IGNORE / RECOMMEND / REVIEW / AUTO_ELIGIBLE, explained checks); orchestrator (discover → match → rules → prepare → route) with run history; question classifier + verified answer resolver, reusable `CandidateAnswer`s and NEEDS_INFORMATION; automatic resume selection with override; truth gate for automatic approval; provider registry with honest capability matrix and encrypted provider connections; executors (demo API, email, Playwright browser executor in the worker - off by default, manual handoff) behind one execution service with idempotency per canonical job, atomic daily limit, quiet hours, leases and crash recovery; extended compare-and-set state machine with event actors; `apply` queue lane, dedicated worker process (`pnpm worker`: queues + scheduler + health endpoint); status-email tracking (metadata only) and provider status sync; notifications with dedupe and quiet hours; Automation control centre, runs, review queue, job-source cards, reusable answers and dashboard UI; extension manual handoffs and prefill for handed-off applications (still never submits); demo provider (110 jobs + duplicates, scripted outcomes) with `pnpm demo:automation`; unit, DB-backed concurrency and service-level acceptance tests, narrowed no-auto-submit E2E guard; docs | done |

Key decisions

- **Deterministic core, optional AI.** Matching is rules-only; every AI workflow has a deterministic fallback, so the full
  product works without an API key and tests are reproducible.
- **Truth bank.** All generated claims cite `TruthBankItem`/profile fact ids; a claim validator guards Claude output.
- **Shared data helpers** (`packages/database/src/{jobs,candidate,profile-import,demo}.ts`) are used by both the seed and
  the web services; user-scoped repositories/services live in the web app.
- **Queue abstraction** with inline/memory/BullMQ drivers and a `BackgroundTask` table for status tracking.
- **Safety by construction**: the web UI, the API routes and the extension never submit third-party forms; manual email
  sending is bound to a content digest.
- **Automation extends, never duplicates** (phase 8): one matching engine (the rules read its report), one job model and
  merge, one queue (a new lane, not a new system), one state machine, one truth model and claim validator, one email
  adapter, one mailbox layer. Submission is allowed in exactly one place - `applicationExecutionService.execute` in the
  worker - and only in REVIEW (after approval) or AUTO (standing consent + every check); MANUAL stays the default and
  behaves like phases 0-7. Platforms whose terms forbid automation (LinkedIn, Naukri, Indeed, …) are discovery-only and
  end in a manual handoff; CAPTCHA, MFA and login walls are never bypassed.
