/**
 * DEMO CONTENT - run the complete automation pipeline for the seeded demo user without real job-platform accounts.
 *
 *   pnpm db:seed                                   # demo user, profile, resume variants, reusable answers, settings
 *   pnpm --filter @applywise/web demo:automation    # this script
 *
 * Adds the fictional demo provider as a job source, connects it with a demo token (encrypted like any provider
 * credential), turns the automation on (Auto mode was configured by the seed, with the AUTO_APPLY consent) and runs
 * one automation pass through the real pipeline: feed sync -> normalise/dedupe/merge -> deterministic matching ->
 * rules -> preparation from verified facts -> routing -> executors -> status sync. Prints the run metrics.
 * Uses the inline queue driver unless QUEUE_DRIVER is set, so the whole pass completes before the script exits.
 */
import { resolve } from "node:path";
import { config as loadEnv } from "dotenv";
import { envOverride } from "../worker/config";

loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });
// Empty overrides (`DEMO_QUEUE_DRIVER=`) count as unset: an empty QUEUE_DRIVER would silently fall back to the
// memory driver and the script would exit before the pass completes.
process.env.QUEUE_DRIVER = envOverride(process.env.DEMO_QUEUE_DRIVER, "inline");
process.env.FEEDS_SCHEDULER = "off";
process.env.AUTOMATION_SCHEDULER = "off";
// Prepare every worthwhile demo job in one pass (the default per-run cap bounds AI cost in real use).
process.env.AUTOMATION_MAX_PREPARE_PER_RUN = envOverride(process.env.AUTOMATION_MAX_PREPARE_PER_RUN, "60");

const DEMO_EMAIL = envOverride(process.env.DEMO_EMAIL, "demo@applywise.test");

async function main() {
  const { env } = await import("../env");
  env();
  const { prisma } = await import("@applywise/database");
  const { loadSkillAliases } = await import("../server/scheduler");
  await loadSkillAliases();
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { id: true } });
  if (!user) throw new Error(`Demo user ${DEMO_EMAIL} not found - run "pnpm db:seed" first.`);

  const { automationSettingsService } = await import("../server/services/automation-settings.service");
  const { demoAutomationService } = await import("../server/services/demo-automation.service");
  const { applicationStatusSyncService } = await import("../server/services/application-status-sync.service");
  const { dashboardService } = await import("../server/services/dashboard.service");

  await automationSettingsService.ensure(user.id);
  await automationSettingsService.update(user.id, { enabled: true });
  const { run } = await demoAutomationService.setup(user.id, { run: true });
  // Employers "respond" to the demo applications (interviews, assessments, rejections, offers via simulated emails).
  const sync = await applicationStatusSyncService.syncUser(user.id, { force: true });

  const finished = run ? await prisma.automationRun.findUnique({ where: { id: run.id } }) : null;
  const statuses = await prisma.application.groupBy({ by: ["status"], where: { userId: user.id }, _count: true });
  const summary = await dashboardService.summary(user.id);
  process.stdout.write(
    `${JSON.stringify(
      {
        run: finished && {
          id: finished.id,
          status: finished.status,
          providersChecked: finished.providersChecked,
          jobsFound: finished.jobsFound,
          newJobs: finished.newJobs,
          duplicates: finished.duplicates,
          jobsMatched: finished.jobsMatched,
          ignored: finished.ignored,
          recommended: finished.recommended,
          reviewRequired: finished.reviewRequired,
          autoEligible: finished.autoEligible,
          applicationsPrepared: finished.applicationsPrepared,
          applicationsSubmitted: finished.applicationsSubmitted,
          needsInformation: finished.needsInformation,
          manualActions: finished.manualActions,
          failures: finished.failures,
        },
        statusSync: sync,
        applicationsByStatus: Object.fromEntries(statuses.map((s) => [s.status, s._count])),
        dashboard: summary,
      },
      null,
      2,
    )}
`,
  );
  await prisma.$disconnect();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
