import "server-only";
import { prisma, recomputeMatchScores, seedDemoJobs } from "@applywise/database";
import { env } from "@/env";
import { audit } from "../audit";
import { Errors } from "../errors";

function assertEnabled() {
  if (!env().ENABLE_DEMO_ADMIN || env().NODE_ENV === "production") throw Errors.notFound("Page");
}

export const demoService = {
  async status() {
    assertEnabled();
    const [demoJobs, users, applications] = await Promise.all([
      prisma.job.count({ where: { isDemo: true } }),
      prisma.user.count(),
      prisma.application.count(),
    ]);
    return { demoJobs, users, applications };
  },

  async reset(userId: string, requestId?: string) {
    assertEnabled();
    const count = await seedDemoJobs(prisma, env().APP_URL);
    await recomputeMatchScores(prisma, userId);
    await audit(userId, "demo.reset", { requestId, metadata: { demoJobs: count } });
    return { demoJobs: count };
  },
};
