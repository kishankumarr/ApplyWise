/**
 * ApplyWise worker process - runs the automation in the backend so the user never keeps job sites open.
 *
 *   pnpm --filter @applywise/web worker
 *   (node --conditions=react-server --import tsx src/worker/main.ts; the react-server condition makes the
 *    "server-only" guard resolve to its no-op build outside Next.js)
 *
 * WORKER_ROLES (comma list, default "worker,scheduler"; empty means the default):
 *   worker    - consume the BullMQ queues (applywise, applywise-feeds, applywise-apply). With QUEUE_DRIVER=memory the
 *               in-process lanes run whatever this process enqueues.
 *   scheduler - feeds.sync ticks + automation ticks (runs, deferred executions, crash recovery, status sync,
 *               notification dispatch, daily summaries). Safe to run on several instances (atomic claims).
 * Health: GET http://localhost:$WORKER_HEALTH_PORT/health (0 disables the endpoint).
 * Shutdown (SIGINT / SIGTERM): stop the scheduler, let running ticks and queue jobs finish (bounded), close the queue
 * connections and the database, then exit. Work cut off by the grace period is recovered by the leases.
 */
import { createServer } from "node:http";
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { KNOWN_WORKER_ROLES, parseWorkerRoles } from "./config";

// Same single .env at the repository root as next.config.ts.
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const roles = parseWorkerRoles(process.env.WORKER_ROLES);
/** Upper bound for a graceful shutdown (container orchestrators usually send SIGKILL after 30 s). */
const SHUTDOWN_GRACE_MS = 25_000;

async function main() {
  const { env } = await import("../env");
  env();
  const { prisma } = await import("@applywise/database");
  const { logger } = await import("../server/logger");
  const { loadSkillAliases, schedulerState, startScheduler } = await import("../server/scheduler");
  await loadSkillAliases();

  const unknown = [...roles].filter((r) => !KNOWN_WORKER_ROLES.includes(r));
  if (unknown.length) logger.warn("worker.unknown_roles", { roles: unknown.join(","), known: KNOWN_WORKER_ROLES.join(",") });

  let lanes: string[] = [];
  if (roles.has("worker")) {
    const { startWorkers } = await import("../server/queue");
    lanes = (await startWorkers()).lanes;
  }
  const stopScheduler: () => Promise<void> = roles.has("scheduler") ? startScheduler({ feeds: true, automation: true, initialDelayMs: 5_000 }) : async () => undefined;

  const port = env().WORKER_HEALTH_PORT;
  const server =
    port > 0
      ? createServer(async (req, res) => {
          if (req.url !== "/health") {
            res.writeHead(404).end();
            return;
          }
          let db = true;
          try {
            await prisma.$queryRaw`SELECT 1`;
          } catch {
            db = false;
          }
          const body = { ok: db, roles: [...roles], queueDriver: env().QUEUE_DRIVER, lanes, database: db, scheduler: schedulerState };
          res.writeHead(db ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify(body));
        }).listen(port)
      : null;

  logger.info("worker.started", { roles: [...roles].join(","), queueDriver: env().QUEUE_DRIVER, lanes: lanes.join(","), healthPort: port });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("worker.stopping", { signal });
    const force = setTimeout(() => {
      logger.warn("worker.shutdown_timeout", { graceMs: SHUTDOWN_GRACE_MS });
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();
    server?.close();
    // No new ticks; wait for a tick that is claiming work right now.
    await stopScheduler().catch(() => undefined);
    // BullMQ: stop taking jobs, wait for the active ones, close the queue connections (when the queue module offers it).
    const queue = (await import("../server/queue")) as unknown as { stopWorkers?: () => Promise<void> };
    if (typeof queue.stopWorkers === "function") {
      await queue.stopWorkers().catch((e: unknown) => logger.warn("worker.queue_close_failed", { error: e instanceof Error ? e.name : "unknown" }));
    }
    await prisma.$disconnect().catch(() => undefined);
    clearTimeout(force);
    logger.info("worker.stopped", { signal });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((e: unknown) => {
  console.error(JSON.stringify({ level: "error", msg: "worker.failed_to_start", error: e instanceof Error ? e.message : "unknown" }));
  process.exit(1);
});
