import "server-only";
import { prisma } from "@applywise/database";
import { registerSkillAliases } from "@applywise/job-engine";
import { env } from "@/env";
import { logger } from "./logger";

/**
 * Recurring workflows shared by the dedicated worker (apps/web/src/worker/main.ts) and the in-process scheduler
 * used in development (instrumentation-node.ts). Every tick only claims work atomically (conditional updates and
 * leases), so any number of instances can run it at once without duplicating work.
 */

/** Load admin-extensible skill aliases into the matcher. */
export async function loadSkillAliases(): Promise<void> {
  try {
    const skills = await prisma.skill.findMany({ select: { name: true, aliases: true, related: true } });
    registerSkillAliases(
      skills.flatMap((s) => [{ alias: s.name, canonical: s.name, related: s.related }, ...s.aliases.map((alias) => ({ alias, canonical: s.name, related: s.related }))]),
    );
  } catch (e) {
    logger.warn("skill_aliases.load_failed", { error: e instanceof Error ? e.name : "unknown" });
  }
}

export interface SchedulerState {
  startedAt: string;
  lastFeedsTickAt: string | null;
  lastAutomationTickAt: string | null;
  lastError: string | null;
  lastAutomationResult: Record<string, number> | null;
}

export const schedulerState: SchedulerState = { startedAt: new Date().toISOString(), lastFeedsTickAt: null, lastAutomationTickAt: null, lastError: null, lastAutomationResult: null };

/** feeds.sync for due automatic job sources (existing behaviour). */
export async function feedsTick(): Promise<void> {
  try {
    const { jobFeedsService } = await import("./services/job-feeds.service");
    await jobFeedsService.tick();
    schedulerState.lastFeedsTickAt = new Date().toISOString();
  } catch (e) {
    schedulerState.lastError = e instanceof Error ? e.name : "unknown";
    logger.warn("feeds.tick_failed", { error: schedulerState.lastError });
  }
}

/** automation.run, deferred executions, execution recovery, status sync, notifications.dispatch, daily.summary. */
export async function automationTick(): Promise<void> {
  try {
    const { automationOrchestrator } = await import("./services/automation-orchestrator.service");
    const result = await automationOrchestrator.schedulerTick();
    schedulerState.lastAutomationResult = result;
    schedulerState.lastAutomationTickAt = new Date().toISOString();
    // Steps are isolated from each other; a failed one is still reported on the health endpoint.
    if (result.failedSteps) schedulerState.lastError = `automation tick: ${result.failedSteps} step(s) failed`;
  } catch (e) {
    schedulerState.lastError = e instanceof Error ? e.name : "unknown";
    logger.warn("automation.tick_failed", { error: schedulerState.lastError });
  }
}

/**
 * Start both recurring loops. A loop never overlaps itself in one process (a slow tick makes the next one skip).
 * Returns a stop function: no new ticks start, and it resolves once the ticks in flight have finished.
 */
export function startScheduler(opts: { feeds: boolean; automation: boolean; initialDelayMs?: number }): () => Promise<void> {
  const timers: NodeJS.Timeout[] = [];
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  const loop = (tick: () => Promise<void>) => {
    let running = false;
    return () => {
      if (stopped || running) return;
      running = true;
      const p = tick().finally(() => {
        running = false;
        inFlight.delete(p);
      });
      inFlight.add(p);
    };
  };
  const delay = opts.initialDelayMs ?? 20_000;
  if (opts.feeds) {
    const run = loop(feedsTick);
    timers.push(setTimeout(run, delay));
    timers.push(setInterval(run, env().FEEDS_TICK_SECONDS * 1000));
  }
  if (opts.automation) {
    const run = loop(automationTick);
    timers.push(setTimeout(run, delay));
    timers.push(setInterval(run, env().AUTOMATION_TICK_SECONDS * 1000));
  }
  for (const t of timers) t.unref?.();
  return async () => {
    stopped = true;
    timers.forEach((t) => clearTimeout(t));
    await Promise.allSettled([...inFlight]);
  };
}
