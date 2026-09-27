# Running ApplyWise: API keys, AI models and day-to-day tips

## 1. Everyday start / stop

```bash
# once per boot: database (5433) + Mailpit email catcher (8025)
pnpm db:up
# the app (http://localhost:3000) - keep this terminal open
pnpm dev
```

- Sign in: `demo@applywise.test` / `DemoPass2026!` (fictional demo profile), or create your own account.
- Stop the app with `Ctrl+C`; stop Docker services with `pnpm db:down`.
- After pulling new code: `pnpm install && pnpm db:migrate`.
- Refresh demo data at any time: `pnpm db:seed` (only touches demo data; it recreates the demo user, so the demo
  user's automation settings, runs and applications start over).
- Faster pages (production mode): `pnpm build && pnpm start`. `pnpm dev` uses Turbopack, which still compiles each
  page on its first visit (a few seconds once, then fast); `pnpm --filter @applywise/web dev:webpack` is the webpack
  fallback if Turbopack misbehaves.
- `pnpm dev` alone runs everything in development: the web app, the in-process scheduler (job sources every 5 minutes,
  automation every minute) and the in-process queue. The dedicated worker is optional locally - see
  [section 4](#4-automation-worker-and-demo).

## 2. Where API keys go

All configuration lives in **one file: `.env` in the repository root** (copied from `.env.example`).

- It is git-ignored - never commit it or paste keys into code.
- Keys are only read on the server; nothing in `.env` is sent to the browser (except `NEXT_PUBLIC_APP_NAME`).
- **Restart `pnpm dev` (and `pnpm worker`, if running) after every change** to `.env`. The worker and the demo script
  read the same root `.env`.
- Values are validated at start-up; a bad value prints `Invalid environment configuration: <VARIABLE>: <problem>`.
- `KEY=` (empty) means "not set" - also for `WORKER_ROLES`, `DEMO_EMAIL` and `DEMO_QUEUE_DRIVER`, which are read
  outside the validated configuration (an empty or blank value falls back to their default).

### Required secrets (already generated for your local `.env`)

| Variable | What | How to generate |
| --- | --- | --- |
| `AUTH_SECRET` | Signs login sessions | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `ENCRYPTION_KEY` | Encrypts stored CVs (32 bytes, base64) | same command |
| `SIGNING_SECRET` | Signs email-send confirmations and extension codes | `node -e "console.log(require('crypto').randomBytes(36).toString('hex'))"` |

Changing `ENCRYPTION_KEY` makes previously uploaded CVs unreadable - keep it stable (and backed up in production).

### AI provider (pick one with `AI_PROVIDER`)

| `AI_PROVIDER` | Needs | Data leaves your machine? |
| --- | --- | --- |
| `ollama` (current local setup) | Ollama running + `OLLAMA_MODEL` pulled | No |
| `anthropic` | `ANTHROPIC_API_KEY` | Yes, to Anthropic |
| `openai_compatible` | `OPENAI_COMPAT_BASE_URL`, `OPENAI_COMPAT_MODEL`, optional `OPENAI_COMPAT_API_KEY` | Only if the URL is remote |

With no provider configured (or `AI_DISABLED=true`) everything still works using the built-in rule-based parser and drafts.

**Local Qwen via Ollama (what is configured now)**

```ini
AI_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=qwen2.5:7b
OLLAMA_NUM_CTX=8192
```

**Claude**

1. Create a key at https://console.anthropic.com → *API keys*.
2. In `.env`:
   ```ini
   AI_PROVIDER=anthropic
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-opus-5
   ```
3. Restart `pnpm dev`.

**Other OpenAI-compatible servers** (vLLM, LM Studio, llama.cpp server, or hosted open-model APIs such as Together or Groq):

```ini
AI_PROVIDER=openai_compatible
OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1     # LM Studio example; hosted: https://<provider>/v1
OPENAI_COMPAT_MODEL=qwen2.5-7b-instruct
OPENAI_COMPAT_API_KEY=                              # only if the server requires one
```

**Turn it on per user:** AI is only used for users who enable **AI processing** (onboarding step 1, or Settings → Privacy).
The consent remembers whether it was given for a local model or an external provider: if you switch from Ollama to Claude
(or a remote server), each user has to enable AI processing again before their data is sent out.

**Check it:** Settings → Integrations → *AI provider* shows the active provider and, for Ollama, whether the server is reachable
and the model is pulled.

### Email sending (optional)

By default (`EMAIL_PROVIDER=dev`) "sent" emails are written to `.outbox/` and never delivered.

| Goal | Settings |
| --- | --- |
| See emails in Mailpit (http://localhost:8025) | `EMAIL_PROVIDER=smtp`, `SMTP_HOST=localhost`, `SMTP_PORT=1025` |
| Mailtrap sandbox | `EMAIL_PROVIDER=smtp`, `SMTP_HOST=sandbox.smtp.mailtrap.io`, `SMTP_PORT=2525`, `SMTP_USER=…`, `SMTP_PASS=…` |
| Real delivery via Resend | `EMAIL_PROVIDER=resend`, `RESEND_API_KEY=re_…`, `EMAIL_FROM="You <you@your-verified-domain>"` |
| Real delivery via an SMTP relay | `EMAIL_PROVIDER=smtp`, `SMTP_HOST/PORT/USER/PASS`, `SMTP_SECURE=true` (port 465), `SMTP_DELIVERS_EXTERNALLY=true` |

Before anything can be sent, each user must:

1. **Confirm their email address.** A link is emailed at sign-up (resend it from the yellow banner). Open it and press
   **Confirm** - opening the link alone does not confirm anything. With Mailpit configured, open http://localhost:8025
   to find the email. With the file outbox (`EMAIL_PROVIDER=dev`) nothing is delivered: in development the banner's
   **Get a confirmation link** button shows the link directly (never in production). The demo account is pre-confirmed;
   accounts created before this check existed must confirm too.
2. Enable **Email sending** in Settings → Privacy. (This consent covers application emails only; the confirmation email
   goes to your own address and does not need it.)
3. Review the final confirmation screen for every send.

Automatic email applications (Review / Auto mode) additionally need **allow email applications** on the Automation page
and an `smtp` or `resend` provider: with `EMAIL_PROVIDER=dev` they are always handed to the user, and in production an
SMTP server without `SMTP_DELIVERS_EXTERNALLY=true` is refused. They are only sent when the job post asks for
applications to that exact address.

In production set `APP_URL` to the public address - links in emails are built from it (the server warns at start-up if
it is still `localhost`).

### Other optional keys

| Area | Variables |
| --- | --- |
| Cloud file storage (S3 / Cloudflare R2 / MinIO) | `STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` (R2/MinIO), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Redis-backed background jobs | `QUEUE_DRIVER=bullmq`, `REDIS_URL=redis://localhost:6379` (`docker compose --profile queue up -d redis`) |
| Automation limits and scheduler | `AUTOMATION_SCHEDULER`, `AUTOMATION_TICK_SECONDS`, `AUTOMATION_MAX_DAILY_LIMIT`, `AUTOMATION_MAX_JOBS_PER_RUN`, `AUTOMATION_MAX_PREPARE_PER_RUN`, `APPLY_QUEUE_CONCURRENCY` (section 4) |
| Browser executor (worker) | `BROWSER_EXECUTOR_ENABLED`, `BROWSER_EXECUTOR_PROVIDERS`, `BROWSER_EXECUTOR_DRY_RUN`, `BROWSER_EXECUTOR_HEADLESS`, `BROWSER_EXECUTOR_TIMEOUT_MS` (section 4) |
| Worker process | `WORKER_ROLES`, `WORKER_HEALTH_PORT`, `APPLYWISE_DISABLE_WORKER` (section 4) |
| Demo provider | `DEMO_PROVIDER_ENABLED` (on outside production by default) |
| Virus scanning | `MALWARE_SCANNER=clamav`, `CLAMAV_HOST`, `CLAMAV_PORT` |
| Job-board partner APIs | `ENABLE_PARTNER_API`, `PARTNER_API_URL`, `PARTNER_API_KEY` (and `…_FEED_…`) - only with a signed partner agreement |
| Browser extension | Not in `.env`: create a token in Settings → Integrations and paste it into the extension |
| Provider API keys for automatic applications | Not in `.env`: each user connects a provider that officially issues keys in Settings → Job sources (today only the demo provider) |

### Automatic job sources

Jobs arrive automatically once you set up **Jobs → Job sources** (also the last onboarding step):

- **Job alerts** from Naukri, LinkedIn, Indeed, Foundit and others: create alerts on those sites, then connect the
  mailbox they arrive in. Gmail/Yahoo/iCloud/Zoho: an app password (2 minutes). Outlook needs `MICROSOFT_CLIENT_ID`.
- **Companies**: type a name (Razorpay, CRED, Meesho, ...) or paste a careers URL and press Follow.
- **Saved searches**: remote jobs work without keys; Indian city searches need a free Adzuna key
  (`ADZUNA_APP_ID`, `ADZUNA_APP_KEY`).

Details, Google/Microsoft setup and troubleshooting: [docs/job-sources.md](job-sources.md).

## 3. Running the local model effectively

**Keep Ollama running.** It starts with Windows (tray icon). Check with `ollama ps` / `ollama list`, or open
http://localhost:11434 (should say "Ollama is running").

**Expect these timings** on this laptop (RTX 1000 Ada, 6 GB): about 20 tokens/second. The first request after a while also
loads the model (10-20 s); it then stays in memory for 15 minutes.

| Step | Typical time with qwen2.5:7b |
| --- | --- |
| CV parsing (background) | 45-75 s |
| Job-description parsing (pasted jobs) | 20-30 s |
| Job questions | 60-75 s (the page waits for this) |
| Tailored resume / cover letter / email (background, "Prepare application") | 30-60 s each |

**If output fails a check,** ApplyWise retries once with the reason ("body is 114 words…"), then falls back to its
rule-based draft. Drafts show which was used ("Generated with qwen2.5:7b" vs "Deterministic draft").

**Test a model before using it:**

```bash
pnpm --filter @applywise/ai eval                                  # all 7 workflows
EVAL_ONLY=questionnaire,application-email pnpm --filter @applywise/ai eval      # Git Bash / macOS / Linux
```

```powershell
$env:EVAL_ONLY = "questionnaire,application-email"; pnpm --filter @applywise/ai eval; Remove-Item Env:EVAL_ONLY
```

It reports, per workflow, whether the model output was accepted or why it fell back, plus timings and token counts.
`EVAL_ONLY` limits the drafting steps; the CV and job parsers always run first because the other steps use their output.

**Tuning options**

| Want | Do |
| --- | --- |
| Faster, lower quality | `ollama pull qwen2.5:3b`, set `OLLAMA_MODEL=qwen2.5:3b` (fits fully in 6 GB VRAM) |
| Less VRAM for the context | Set Windows user environment variables `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`, then restart Ollama |
| Longer CVs | Raise `OLLAMA_NUM_CTX` (e.g. 12288); uses more memory |
| Better quality | A bigger model (e.g. `qwen2.5:14b`) - runs, but partly on CPU and roughly 2-3× slower here |
| More deterministic output | Lower `AI_TEMPERATURE` (default 0.2) |
| Avoid timeouts on slow hardware | Raise `AI_TIMEOUT_MS` (default 300000 for local models). A timed-out local request is not retried; the rule-based draft is used |
| Fewer / more retries | `AI_MAX_ATTEMPTS` (1-5, default 3) and `AI_BACKOFF_MS` (default 500) |
| Claude only | `ANTHROPIC_EFFORT` (`low`…`max`, default `medium`); `ANTHROPIC_SERVER_FALLBACKS=false` disables server-side refusal fallbacks |

## 4. Automation, worker and demo

The automation is **off** for every account until the user turns it on in **Automation**, and starts in **Manual**
mode (prepare only, never submit). What it does and why: [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md).

### Try it on fictional demo data

```bash
pnpm db:seed                                   # demo user, resume variants, reusable answers, Auto-mode settings (automation off)
AI_DISABLED=true pnpm demo:automation          # Git Bash / macOS / Linux
```

```powershell
pnpm db:seed
$env:AI_DISABLED = "true"; pnpm demo:automation; Remove-Item Env:AI_DISABLED
```

`pnpm demo:automation` (= `pnpm --filter @applywise/web demo:automation`) connects the fictional demo provider for the
demo user (its token is encrypted like any provider credential), turns the automation on (the seed configured Auto mode
with the `AUTO_APPLY` consent, 30 applications per day) and runs one pass through the real pipeline with the inline
queue: sync of 110 demo jobs + 14 cross-provider duplicates → merge → deterministic matching → rules → preparation from
verified facts → routing → executors → simulated employer replies (status sync). It prints the run metrics,
the applications by status and the dashboard numbers, then exits. Open **Automation**, **Automation → Runs**,
**Review** and **Applications** in the web app to inspect the result.

- **Use `AI_DISABLED=true`.** The demo user has AI consent, so with Ollama every prepared application (up to 60 in the
  demo pass, each with a tailored resume, a cover letter, answers and possibly an email at 30-60 s per draft) would go
  through the local model and take hours. The deterministic drafts exercise the same pipeline.
- The script raises `AUTOMATION_MAX_PREPARE_PER_RUN` to 60 unless it is set in `.env` or the shell. Overrides (set
  them in the shell; empty means the default): `DEMO_QUEUE_DRIVER` (default `inline`), `DEMO_EMAIL` (default
  `demo@applywise.test`).
- A few demo listings use the local demo career pages and the browser executor: when they are prepared they end in a
  manual handoff ("Browser automation is disabled on this server") unless `BROWSER_EXECUTOR_ENABLED=true` and Chromium
  is installed (below). Listings scripted as LinkedIn/Naukri-style platforms always end in a manual handoff, and others
  are scripted to hit a CAPTCHA, a sign-in wall, MFA, an unknown required question or a failure, so every path shows up.
- Run it again after `pnpm db:seed` for a clean slate; a second run on the same data submits nothing twice.
- In the web app, **Automation → Try the demo** does the same for your own account (it never changes your mode,
  thresholds or consents).

### Dedicated worker

```bash
pnpm worker                                    # = pnpm --filter @applywise/web worker
curl http://localhost:3200/health              # { ok, roles, queueDriver, lanes, database, scheduler }
```

| Setting | Meaning |
| --- | --- |
| `WORKER_ROLES` | `worker` (consume the queues), `scheduler` (job-source and automation ticks), or both (default `worker,scheduler`; empty or blank also means both) |
| `WORKER_HEALTH_PORT` | Health endpoint port (default 3200, `0` disables it); 503 when the database is unreachable |
| `QUEUE_DRIVER=bullmq` + `REDIS_URL` | Needed for the worker to receive the web app's tasks (Run now, Approve & apply, preparations). With `memory`, each process only runs what it enqueued itself |
| `APPLYWISE_DISABLE_WORKER=true` | On the web process: Next.js only enqueues; the worker consumes every queue |
| `FEEDS_SCHEDULER=off`, `AUTOMATION_SCHEDULER=off` | On the web process when the worker runs the scheduler (running both is safe, only redundant). The worker's scheduler role ignores these flags |

Local setup with a separate worker:

```bash
docker compose --profile queue up -d redis
# .env: QUEUE_DRIVER=bullmq, REDIS_URL=redis://localhost:6379, FEEDS_SCHEDULER=off, AUTOMATION_SCHEDULER=off, APPLYWISE_DISABLE_WORKER=true
pnpm dev            # terminal 1: web (enqueues only)
pnpm worker         # terminal 2: queues + scheduler (reads the same .env; set WORKER_ROLES only to split roles)
```

Stopping the worker (`Ctrl+C`, `SIGTERM`) is graceful: the scheduler stops, BullMQ workers finish their active jobs and
the queue connections and the database are closed, within 25 seconds (then it exits anyway; interrupted work is
recovered through the leases).

Production (same checkout and environment for both processes):

```bash
# web
QUEUE_DRIVER=bullmq REDIS_URL=redis://… FEEDS_SCHEDULER=off AUTOMATION_SCHEDULER=off APPLYWISE_DISABLE_WORKER=true pnpm start
# worker (one or more instances)
QUEUE_DRIVER=bullmq REDIS_URL=redis://… WORKER_ROLES=worker,scheduler pnpm --filter @applywise/web worker
```

### Automation limits

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTOMATION_SCHEDULER`, `AUTOMATION_TICK_SECONDS` | `on`, `60` | In-process automation loop of the web server |
| `AUTOMATION_MAX_DAILY_LIMIT` | `50` | Highest daily limit a user may set (the per-user default is 10) |
| `AUTOMATION_MAX_JOBS_PER_RUN` | `500` | Jobs evaluated per run |
| `AUTOMATION_MAX_PREPARE_PER_RUN` | `25` | Applications prepared per run: each preparation calls the AI provider (tailored resume, cover letter, answers, email), so this bounds AI cost and time |
| `APPLY_QUEUE_CONCURRENCY` | `2` | Parallel submissions in the BullMQ apply queue |
| `DEMO_PROVIDER_ENABLED` | unset | Unset: on outside production, off in production |

### Browser executor (optional, off by default)

The browser executor fills and submits application forms with Playwright + Chromium **inside the worker** (with the
memory driver in development: inside the `pnpm dev` server process) - never in the user's browser. It stops at CAPTCHA,
MFA, sign-in walls and unknown required questions and hands the application to the user. It only works on pages inside
the adapter's URL allowlist: main-frame navigations elsewhere are blocked and the URL is re-checked after every
navigation, before filling and around submit (an HTTP redirect target off the allowlist is still fetched once with a
GET before the flow stops; nothing is read, filled or submitted there).

```bash
pnpm --filter @applywise/web exec playwright-core install chromium    # Linux servers: add --with-deps
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `BROWSER_EXECUTOR_ENABLED` | `false` | Master switch |
| `BROWSER_EXECUTOR_PROVIDERS` | `demo` | `demo` = the local demo career pages (`/demo/ats/*` on `APP_URL`); `greenhouse`, `lever`, `ashby` are **experimental** and not validated against the live sites |
| `BROWSER_EXECUTOR_DRY_RUN` | `false` | Fill the form but never press submit (ends in a manual handoff) - use it to validate an adapter |
| `BROWSER_EXECUTOR_HEADLESS` | `true` | `false` shows the browser window (local debugging) |
| `BROWSER_EXECUTOR_TIMEOUT_MS` | `60000` | Navigation/action timeout and how long to wait for the confirmation |

The Chromium installed by `pnpm --filter @applywise/web e2e:install` for the E2E tests is the same build and works too.

## 5. Tests

```bash
pnpm lint && pnpm typecheck && pnpm test    # unit + integration (uses database applywise_unit)
pnpm test:e2e                               # browser tests on port 3100 (database applywise_e2e)
```

Tests never call a real AI model: unit tests mock the transports, E2E runs with `AI_DISABLED=true`. `pnpm test` includes
the automation suites - pure modules in `packages/job-engine/test` (rules, questions, resume selection, providers, demo
provider, status emails) and DB-backed tests in `apps/web/test` (orchestrator, settings, execution idempotency and the
daily limit under concurrency, executors, notifications, provider connections, reusable answers, email tracking,
extension handoffs, state machine) - and the service-level acceptance test
`apps/web/test/automation-acceptance.test.ts`, which runs the whole pipeline on the demo provider with the inline queue. Run a single file with `pnpm --filter @applywise/web exec vitest run test/automation-acceptance.test.ts`.
E2E uses the inline queue, so the in-process scheduler never starts and no automation runs in the background during
browser tests.

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid environment configuration: …` | Fix the named variable in `.env`, restart |
| Drafts always say "Deterministic draft" | Check Settings → Integrations; enable **AI processing** for your user; for Ollama run `ollama pull <model>` |
| `EPERM … query_engine-windows.dll.node` on `pnpm install` | Stop `pnpm dev` first (it locks the Prisma engine), then re-run install |
| Port 3000 / 5433 in use | Stop the other process, or change the port in `package.json` / `docker-compose.yml` and `DATABASE_URL` |
| Emails not arriving | `EMAIL_PROVIDER=dev` never delivers; use Mailpit/Resend as above, and enable **Email sending** consent |
| "Confirm your email address first" | Open the confirmation link (Mailpit at http://localhost:8025 locally) or resend it from the banner |
| Server log shows `ai.guard.rejected` | The model's output failed a safety/format check; the reason is in the log with quoted text removed (no CV content is logged) |
| Server log shows `ai.call.failed` with `reason: "context_overflow"` | The prompt did not fit the model's context window; raise `OLLAMA_NUM_CTX` (e.g. 12288) |
| Banner says email delivery is not configured | `EMAIL_PROVIDER=dev` only writes files; configure Mailpit/SMTP/Resend (above) to deliver confirmation links |
| `pnpm demo:automation` is very slow / seems stuck | It is preparing applications through your local model (Ollama). Stop it and run it with `AI_DISABLED=true` (section 4) |
| `Demo user demo@applywise.test not found - run "pnpm db:seed" first.` | Run `pnpm db:seed` against the same `DATABASE_URL` |
| "The demo provider is disabled on this server" | `NODE_ENV=production` or `DEMO_PROVIDER_ENABLED=false`; set `DEMO_PROVIDER_ENABLED=true` only for a demo deployment |
| "An automation run is already in progress" | One run per user at a time; wait for it. A running run renews its lease; a crashed or stalled run's lease expires 15 minutes after its last renewal, and the run is then closed as failed ("interrupted") |
| Automation is on but nothing is submitted | Open **Automation**: the readiness list names every blocker (mode Manual/Review, auto-apply consent, no provider with automatic submission on this server, daily limit 0, missing profile data). Most job boards are manual handoffs by design. Auto applications with an answer drafted by the generator, or whose rules / profile changed after the evaluation, wait in **Review** |
| Applications stay APPROVED ("Queued for submission") | No process consumes the apply queue: with `QUEUE_DRIVER=bullmq` start `pnpm worker`; check `http://localhost:3200/health`. Quiet hours and a full daily limit also defer submissions (the application shows when); a daily limit of 0 submits nothing; a provider that needs reconnecting holds them. A lost task is re-queued automatically after 15 minutes |
| "The previous attempt may already have been submitted" | The automation stopped after it may have reached the employer (`SUBMISSION_UNCERTAIN`). Check on the employer's page: mark it submitted, or confirm it was not received and press **Retry** (nothing retries it automatically) |
| Handoff says "Browser automation is disabled on this server" | Expected unless `BROWSER_EXECUTOR_ENABLED=true` and the provider is in `BROWSER_EXECUTOR_PROVIDERS` |
| "The browser could not be started on the worker" (log `executor.browser.launch_failed`) | Install Chromium where the apply lane runs: `pnpm --filter @applywise/web exec playwright-core install chromium` (Linux: `--with-deps`) |
| Worker exits with `Invalid environment configuration: REDIS_URL…` | `QUEUE_DRIVER=bullmq` needs `REDIS_URL` (`docker compose --profile queue up -d redis`) |
| Worker health returns 503 | The worker cannot reach PostgreSQL: check `DATABASE_URL` and `pnpm db:up` |
