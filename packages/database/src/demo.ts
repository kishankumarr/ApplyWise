import type { PrismaClient } from "@prisma/client";
import { CONNECTORS, DEMO_JOBS } from "@applywise/job-engine";
import { persistNormalizedJob } from "./jobs";

/** (Re)create the shared DEMO job catalogue. Demo jobs are fictional and flagged isDemo. */
export async function seedDemoJobs(prisma: PrismaClient, appUrl: string): Promise<number> {
  await prisma.job.deleteMany({ where: { isDemo: true, ownerUserId: null } });
  const raws = await CONNECTORS.seeded.importJobs({ payload: { appUrl } });
  for (const [i, raw] of raws.entries()) {
    const job = await CONNECTORS.seeded.normalize(raw);
    const spec = DEMO_JOBS[i]!;
    await persistNormalizedJob(prisma, { job, raw, ownerUserId: null, importedByUserId: null, connector: "seeded", id: `demo_${spec.key.replace(/-/g, "_")}` });
  }
  return raws.length;
}
