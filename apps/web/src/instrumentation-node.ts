import { env } from "./env";
import { loadSkillAliases } from "./server/scheduler";

// Fail fast on invalid configuration.
env();

// Load admin-extensible skill aliases into the matcher.
await loadSkillAliases();

// In-process scheduler (development / single-instance deployments). Production deployments run the dedicated
// worker (src/worker/main.ts, WORKER_ROLES=worker,scheduler) and set FEEDS_SCHEDULER=off and AUTOMATION_SCHEDULER=off
// here. Every tick claims work atomically, so running it in several places is safe, only redundant.
const g = globalThis as { __applywiseScheduler?: () => void };
const feeds = env().FEEDS_SCHEDULER === "on";
const automation = env().AUTOMATION_SCHEDULER === "on";
if ((feeds || automation) && env().QUEUE_DRIVER !== "inline" && !g.__applywiseScheduler && process.env.NEXT_PHASE !== "phase-production-build") {
  const { startScheduler } = await import("./server/scheduler");
  g.__applywiseScheduler = startScheduler({ feeds, automation });
}
