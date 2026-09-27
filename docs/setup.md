# Local setup

## 1. Install

```bash
node -v            # >= 20.11
npm i -g pnpm@9
pnpm install       # also runs `prisma generate`
```

## 2. Configure

```bash
cp .env.example .env
node -e "console.log('AUTH_SECRET='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('base64'))"
node -e "console.log('SIGNING_SECRET='+require('crypto').randomBytes(36).toString('hex'))"
```

Paste the three values into `.env`. For AI, either set `ANTHROPIC_API_KEY`, or use a free local model:
install [Ollama](https://ollama.com), run `ollama pull qwen2.5:7b` and set `AI_PROVIDER=ollama`. With neither, deterministic
fallbacks are used. Full details: [running-guide.md](running-guide.md).

The automation defaults in `.env.example` are safe for development: the in-process schedulers are on, the browser
executor is off, the demo provider is available (outside production) and every account starts with automation off in
Manual mode. All variables: [AUTOMATION_ARCHITECTURE.md](AUTOMATION_ARCHITECTURE.md#configuration).

## 3. Services

```bash
pnpm db:up                      # postgres (localhost:5433) + mailpit (http://localhost:8025)
docker compose --profile queue up -d redis   # only if QUEUE_DRIVER=bullmq (e.g. to run the dedicated worker separately)
```

## 4. Database

```bash
pnpm db:migrate    # prisma migrate dev
pnpm db:seed       # demo user + demo jobs + automation demo data (safe to re-run; recreates the demo user)
```

`pnpm db:reset` drops and recreates the development database. **Destructive** - run it yourself only against a local dev database.

## 5. Run

```bash
pnpm dev           # http://localhost:3000  (demo@applywise.test / DemoPass2026!)
```

In development `pnpm dev` also runs the job-source and automation schedulers and the background queue in-process.

Optional: send development email to Mailpit instead of the file outbox:

```
EMAIL_PROVIDER=smtp
SMTP_HOST=localhost
SMTP_PORT=1025
```

## 6. Automation demo and worker

```bash
AI_DISABLED=true pnpm demo:automation     # whole pipeline on fictional demo data for the demo user, prints the metrics
pnpm worker                               # dedicated worker: queues + scheduler, health on http://localhost:3200/health
```

On PowerShell: `$env:AI_DISABLED = "true"; pnpm demo:automation; Remove-Item Env:AI_DISABLED`.

The demo needs `pnpm db:seed` first. The worker only receives the web app's tasks with `QUEUE_DRIVER=bullmq` and
`REDIS_URL` (see section 3); with the default memory driver it only runs its own scheduler's tasks, so locally you
normally do not need it. Worker roles, production commands and the optional browser executor (Chromium):
[running-guide.md](running-guide.md#4-automation-worker-and-demo).

## 7. Tests

```bash
docker exec -it $(docker compose ps -q postgres) psql -U applywise \
  -c "CREATE DATABASE applywise_unit;" -c "CREATE DATABASE applywise_e2e;"
pnpm --filter @applywise/web e2e:install
pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e
```

Unit/integration tests apply migrations to `applywise_unit` (non-destructively) and create uniquely named users. They
run with `QUEUE_DRIVER=inline`, `AI_DISABLED=true` and the schedulers off, and include the automation acceptance test
(`apps/web/test/automation-acceptance.test.ts`: the whole pipeline on the demo provider, no network).
E2E applies migrations to `applywise_e2e`, re-seeds demo data, builds the app and serves it on port 3100 with the inline
queue (no background automation); `E2E_SKIP_BUILD=1` reuses an existing build.

## 8. Extension

```bash
pnpm ext:build     # apps/extension/build/chrome-mv3-prod
```

Load it unpacked from `chrome://extensions`, then create a connection token in **Settings → Integrations**.

## Troubleshooting

- `EPERM ... query_engine-windows.dll.node` during install on Windows: stop running dev servers and workers (they lock
  the Prisma engine). A stopped `next dev` can leave `node.exe` children behind: end only the processes whose command
  line contains this repository's path.
- `Invalid environment configuration`: the message lists the failing variables (see `apps/web/src/env.ts`).
- Port 5433 busy: change the mapping in `docker-compose.yml` and `DATABASE_URL`.
- Port 3200 busy (worker health): set `WORKER_HEALTH_PORT` to another port, or `0` to disable the endpoint.
- `pnpm demo:automation` slow: run it with `AI_DISABLED=true` (a local model would draft every prepared application).
- More (automation, worker, browser executor): [running-guide.md](running-guide.md#6-troubleshooting).
