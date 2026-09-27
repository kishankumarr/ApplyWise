import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { env } from "@/env";
import { logger } from "../logger";

/**
 * Background job abstraction compatible with BullMQ.
 *
 * Drivers:
 *  - inline : run the handler immediately and await it (tests, deterministic E2E).
 *  - memory : in-process worker (development default) - enqueue returns immediately.
 *  - bullmq : Redis-backed BullMQ queue + worker (production).
 * Every task is tracked in the BackgroundTask table so the UI can show per-job status.
 */

export type TaskName =
  | "cv.parse"
  | "job.normalize"
  | "job.match"
  | "application.prepare"
  | "email.draft"
  | "email.send"
  | "email.verification"
  | "feeds.sync"
  | "reminder.dispatch"
  // Automation (see docs/AUTOMATION_ARCHITECTURE.md for the mapping to the workflow names)
  | "automation.run"
  | "application.evaluate"
  | "application.execute"
  | "application.status_sync"
  | "notification.dispatch"
  | "summary.daily"
  | "execution.recover";

export type TaskHandler = (payload: Record<string, unknown>, ctx: { taskId: string; userId: string | null }) => Promise<void>;

const handlers = new Map<TaskName, TaskHandler>();
let handlersLoaded: Promise<unknown> | null = null;

/** Handlers import services, so load them lazily to avoid import cycles. */
function ensureHandlers(): Promise<unknown> {
  return (handlersLoaded ??= import("./handlers"));
}

export function registerHandler(name: TaskName, handler: TaskHandler): void {
  handlers.set(name, handler);
}

async function runTask(taskId: string, name: TaskName, payload: Record<string, unknown>, userId: string | null): Promise<void> {
  await ensureHandlers();
  const handler = handlers.get(name);
  if (!handler) throw new Error(`No handler registered for ${name}`);
  await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "RUNNING", startedAt: new Date(), attempts: { increment: 1 } } });
  try {
    await handler(payload, { taskId, userId });
    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "SUCCEEDED", finishedAt: new Date(), lastError: null } });
  } catch (err) {
    const message = err instanceof Error ? err.message.slice(0, 500) : "unknown error";
    await prisma.backgroundTask.update({ where: { id: taskId }, data: { status: "FAILED", finishedAt: new Date(), lastError: message } });
    logger.error("task.failed", { taskId, name, error: message });
    throw err;
  }
}

// ---------------------------------------------------------------- memory driver
type MemoryItem = { id: string; name: TaskName; payload: Record<string, unknown>; userId: string | null; attempt: number; dedupeKey?: string };
/**
 * Three lanes: automatic job-source syncs and automation runs ("feeds"), submissions ("apply", which may drive a
 * headless browser) and everything else never wait behind each other. Each memory lane runs one task at a time.
 */
type Lane = "default" | "feeds" | "apply";
const laneOf = (name: TaskName): Lane => (name.startsWith("feeds.") || name === "automation.run" ? "feeds" : name === "application.execute" ? "apply" : "default");
const memoryQueues: Record<Lane, MemoryItem[]> = { default: [], feeds: [], apply: [] };
const memoryRunning: Record<Lane, boolean> = { default: false, feeds: false, apply: false };
/** Memory-driver equivalent of BullMQ job ids: a queued or running task with the same key is not queued again. */
const memoryDedupe = new Set<string>();
const MAX_MEMORY_ATTEMPTS = 3;

function pushMemory(item: MemoryItem): void {
  const lane = laneOf(item.name);
  memoryQueues[lane].push(item);
  void drainMemory(lane);
}

async function drainMemory(lane: Lane): Promise<void> {
  if (memoryRunning[lane]) return;
  memoryRunning[lane] = true;
  const queue = memoryQueues[lane];
  try {
    while (queue.length) {
      const item = queue.shift()!;
      try {
        await runTask(item.id, item.name, item.payload, item.userId);
        if (item.dedupeKey) memoryDedupe.delete(item.dedupeKey);
      } catch {
        if (item.attempt + 1 < MAX_MEMORY_ATTEMPTS) {
          const delay = 500 * 2 ** item.attempt;
          setTimeout(() => pushMemory({ ...item, attempt: item.attempt + 1 }), delay);
        } else if (item.dedupeKey) memoryDedupe.delete(item.dedupeKey);
      }
    }
  } finally {
    memoryRunning[lane] = false;
  }
}

// ---------------------------------------------------------------- bullmq driver
type BullQueue = { add: (name: string, data: unknown, opts?: unknown) => Promise<unknown> };
/** Automatic job-source syncs get their own queue and workers, so they never delay user-facing tasks. */
const BULL_QUEUES: Record<Lane, { name: string; concurrency: () => number }> = {
  default: { name: "applywise", concurrency: () => 4 },
  feeds: { name: "applywise-feeds", concurrency: () => 2 },
  apply: { name: "applywise-apply", concurrency: () => env().APPLY_QUEUE_CONCURRENCY },
};
const bullQueues: Partial<Record<Lane, BullQueue>> = {};
const bullWorkersStarted: Partial<Record<Lane, boolean>> = {};
const bullWorkers: { close: () => Promise<void> }[] = [];

async function getBullQueue(lane: Lane): Promise<BullQueue> {
  const existing = bullQueues[lane];
  if (existing) return existing;
  const { Queue } = await import("bullmq");
  const connection = { url: env().REDIS_URL! };
  const { name } = BULL_QUEUES[lane];
  const queue = new Queue(name, { connection }) as unknown as BullQueue;
  bullQueues[lane] = queue;
  if (process.env.APPLYWISE_DISABLE_WORKER !== "true") await startBullWorker(lane);
  return queue;
}

async function startBullWorker(lane: Lane): Promise<void> {
  if (bullWorkersStarted[lane]) return;
  bullWorkersStarted[lane] = true;
  const { Worker } = await import("bullmq");
  const { name, concurrency } = BULL_QUEUES[lane];
  const worker = new Worker(
    name,
    async (job) => {
      const data = job.data as { taskId: string; name: TaskName; payload: Record<string, unknown>; userId: string | null };
      await runTask(data.taskId, data.name, data.payload, data.userId);
    },
    { connection: { url: env().REDIS_URL! }, concurrency: concurrency() },
  );
  bullWorkers.push(worker as unknown as { close: () => Promise<void> });
}

/**
 * Graceful shutdown of this process's queue consumers: BullMQ workers stop taking jobs and wait for the active ones,
 * then queue connections close. (Memory lanes need nothing: unfinished work is recovered by the leases.)
 */
export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(bullWorkers.splice(0).map((w) => w.close()));
  const queues = Object.values(bullQueues) as unknown as { close?: () => Promise<void> }[];
  await Promise.allSettled(queues.map((q) => q.close?.()));
}

/**
 * Start consuming every lane in this process (the dedicated worker process, apps/web/src/worker/main.ts).
 * With the memory driver the in-process lanes already run wherever tasks are enqueued.
 */
export async function startWorkers(): Promise<{ driver: string; lanes: string[] }> {
  const driver = env().QUEUE_DRIVER;
  if (driver === "bullmq") {
    for (const lane of Object.keys(BULL_QUEUES) as Lane[]) await startBullWorker(lane);
    return { driver, lanes: Object.values(BULL_QUEUES).map((q) => q.name) };
  }
  return { driver, lanes: Object.keys(memoryQueues) };
}

export async function enqueue(
  name: TaskName,
  payload: Record<string, unknown>,
  opts: { userId: string | null; runAt?: Date; /** Collapses duplicate queued jobs (BullMQ jobId). */ dedupeKey?: string } = { userId: null },
): Promise<{ taskId: string }> {
  const task = await prisma.backgroundTask.create({
    data: { type: name, userId: opts.userId, payload: payload as Prisma.InputJsonValue, runAt: opts.runAt ?? new Date() },
  });
  const driver = env().QUEUE_DRIVER;
  const delay = opts.runAt ? Math.max(0, opts.runAt.getTime() - Date.now()) : 0;
  if (driver === "inline" && delay === 0) {
    await runTask(task.id, name, payload, opts.userId);
  } else if (driver === "bullmq") {
    const q = await getBullQueue(laneOf(name));
    await q.add(name, { taskId: task.id, name, payload, userId: opts.userId }, {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      delay,
      removeOnComplete: 1000,
      // A dedupe key collapses queued/active duplicates only: once finished the id is freed (like the memory driver),
      // otherwise BullMQ would silently ignore every later task with the same key while the job is retained.
      ...(opts.dedupeKey ? { jobId: opts.dedupeKey.replace(/:/g, "_"), removeOnComplete: true, removeOnFail: true } : {}),
    });
  } else {
    if (opts.dedupeKey) {
      if (memoryDedupe.has(opts.dedupeKey)) {
        await prisma.backgroundTask.update({ where: { id: task.id }, data: { status: "SUCCEEDED", finishedAt: new Date(), lastError: "duplicate of a queued task" } });
        return { taskId: task.id };
      }
      memoryDedupe.add(opts.dedupeKey);
    }
    const push = () => pushMemory({ id: task.id, name, payload, userId: opts.userId, attempt: 0, dedupeKey: opts.dedupeKey });
    if (delay > 0) setTimeout(push, Math.min(delay, 2_147_000_000));
    else push();
  }
  return { taskId: task.id };
}
