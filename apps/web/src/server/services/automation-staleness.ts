import "server-only";
import { prisma } from "@applywise/database";

/**
 * An automation decision is only as fresh as its inputs. Rules changes bump AutomationSettings.rulesVersion; profile,
 * preference and fact changes bump CandidateProfile.factsVersion and recompute the job's match score. A decision made
 * before either of those is stale: the AUTO policy must not act on it (the application goes back to the user).
 */
export async function automationDecisionIsStale(userId: string, app: { jobId: string; evaluatedAt: Date | null }): Promise<boolean> {
  if (!app.evaluatedAt) return true;
  const [score, profile] = await Promise.all([
    prisma.jobMatchScore.findUnique({ where: { userId_jobId: { userId, jobId: app.jobId } }, select: { computedAt: true, factsVersion: true } }),
    prisma.candidateProfile.findUnique({ where: { userId }, select: { factsVersion: true } }),
  ]);
  if (!score || !profile) return true;
  return score.factsVersion !== profile.factsVersion || score.computedAt > app.evaluatedAt;
}
