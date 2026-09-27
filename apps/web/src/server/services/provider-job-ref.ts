import "server-only";
import { prisma, type Prisma } from "@applywise/database";
import { applicationProviderForJob, sourceProviderIdForJob, type JobProvider, type ProviderJobRef } from "@applywise/job-engine";
import { Errors } from "../errors";

export const providerJobInclude = {
  sources: { orderBy: { createdAt: "asc" }, take: 1, select: { metadata: true } },
  feed: { select: { provider: true } },
} satisfies Prisma.JobInclude;

type JobWithSource = Prisma.JobGetPayload<{ include: typeof providerJobInclude }>;
type JobRefInput = Pick<JobWithSource, "id" | "platform" | "title" | "company" | "applyMethod" | "applyUrl" | "sourceUrl" | "sourceExternalId" | "hrEmail" | "isDemo" | "sources" | "feed">;

/** What providers and executors may know about a job (never candidate data). */
export function providerJobRef(job: JobRefInput): ProviderJobRef {
  return {
    jobId: job.id,
    platform: job.platform,
    title: job.title,
    company: job.company,
    applyMethod: job.applyMethod,
    applyUrl: job.applyUrl,
    sourceUrl: job.sourceUrl,
    sourceExternalId: job.sourceExternalId,
    hrEmail: job.hrEmail,
    isDemo: job.isDemo,
    feedProvider: job.feed?.provider ?? null,
    sourceMetadata: ((job.sources[0]?.metadata ?? {}) as Record<string, unknown>) ?? {},
  };
}

/** Job visible to the user (own or shared catalogue), with what the provider layer needs. */
export async function loadProviderJob(userId: string, jobId: string): Promise<{ job: JobWithSource; ref: ProviderJobRef; provider: JobProvider; sourceProviderId: string }> {
  const job = await prisma.job.findFirst({ where: { id: jobId, OR: [{ ownerUserId: null }, { ownerUserId: userId }] }, include: providerJobInclude });
  if (!job) throw Errors.notFound("Job");
  const ref = providerJobRef(job);
  return { job, ref, provider: applicationProviderForJob(ref), sourceProviderId: sourceProviderIdForJob(ref) };
}

/** Cross-source identity used for idempotency: merged duplicates share Job.matchKey. */
export function canonicalJobKey(job: { matchKey: string | null; dedupeKey: string }): string {
  return job.matchKey ?? `dedupe:${job.dedupeKey}`;
}
