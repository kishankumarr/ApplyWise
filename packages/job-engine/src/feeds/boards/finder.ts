import { FeedProviderError, type BoardAdapter, type BoardProbe, type FeedContext } from "../types";
import { SUGGESTED_COMPANIES, type SuggestedCompany } from "./directory";
import { companyKey, companyKeyWithoutLegal, nameParts } from "./slugs";

/**
 * "Follow a company" by name: the seed directory first (no guessing), then slug candidates probed
 * across the ATS providers with a small request budget.
 */

/** Candidates probed per provider, in probe order. Total = the ~24-request budget per name. */
const PROBE_PLAN: [provider: string, candidates: number][] = [
  ["greenhouse", 6],
  ["lever", 4],
  ["ashby", 4],
  ["smartrecruiters", 3],
  ["workable", 4],
  ["recruitee", 3],
];
export const MAX_BOARD_PROBES = PROBE_PLAN.reduce((n, [, c]) => n + c, 0);
const CONCURRENCY = 3;
/**
 * The whole search runs inside a user's request: stop probing after this long and answer with
 * what was confirmed (each probe alone may take up to the 15 s request timeout).
 */
export const FIND_BOARDS_DEADLINE_MS = 25_000;

export function lookupSuggestedCompanies(name: string): SuggestedCompany[] {
  const keys = new Set([companyKey(name), companyKeyWithoutLegal(name)].filter(Boolean));
  return SUGGESTED_COMPANIES.filter((c) =>
    [c.name, ...(c.aliases ?? [])].some((n) => keys.has(companyKey(n)) || keys.has(companyKeyWithoutLegal(n))),
  );
}

export function boardPageUrl(provider: string, slug: string): string {
  const s = encodeURIComponent(slug);
  switch (provider) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${s}`;
    case "lever":
      return `https://jobs.lever.co/${s}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${s}`;
    case "smartrecruiters":
      return `https://careers.smartrecruiters.com/${s}`;
    case "workable":
      return `https://apply.workable.com/${s}/`;
    default:
      return `https://${s}.recruitee.com/`;
  }
}

/**
 * Does the name a board reports (Greenhouse company_name, Workable/SmartRecruiters/Recruitee
 * name) belong to the company searched for? "Razorpay" ~ "Razorpay Software Private Limited",
 * "Mercari" ~ "Mercari, Inc. (India)". Boards without a name (Lever, Ashby) are not rejected.
 */
export function boardNameMatches(query: string, companyName: string | null): boolean {
  if (!companyName) return true;
  const brand = nameParts(query)?.brand ?? companyKey(query);
  const name = companyKeyWithoutLegal(companyName);
  if (!brand || !name) return true;
  return name.includes(brand) || brand.includes(name);
}

function rank(probes: BoardProbe[]): BoardProbe[] {
  const seen = new Set<string>();
  return probes
    .filter((p) => {
      const key = `${p.provider}:${p.slug.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.jobCount - a.jobCount);
}

/** Probe order: round-robin by candidate rank so every provider's best guess goes first. */
export function buildProbePlan(adapters: BoardAdapter[], name: string): { adapter: BoardAdapter; slug: string }[] {
  const lists = PROBE_PLAN.flatMap(([id, count]) => {
    const adapter = adapters.find((a) => a.id === id);
    return adapter ? [{ adapter, slugs: adapter.slugCandidates(name).slice(0, count) }] : [];
  });
  const plan: { adapter: BoardAdapter; slug: string }[] = [];
  const depth = Math.max(0, ...lists.map((l) => l.slugs.length));
  for (let i = 0; i < depth; i++) {
    for (const { adapter, slugs } of lists) if (slugs[i]) plan.push({ adapter, slug: slugs[i]! });
  }
  return plan.slice(0, MAX_BOARD_PROBES);
}

export async function findBoardsWith(adapters: BoardAdapter[], name: string, outer: FeedContext): Promise<BoardProbe[]> {
  const query = name.trim().slice(0, 120);
  if (!query) return [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FIND_BOARDS_DEADLINE_MS);
  const onAbort = () => controller.abort();
  if (outer.signal?.aborted) controller.abort();
  else outer.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return await findWithin(adapters, query, { ...outer, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outer.signal?.removeEventListener("abort", onAbort);
  }
}

async function findWithin(adapters: BoardAdapter[], query: string, ctx: FeedContext): Promise<BoardProbe[]> {
  // 1. Seed directory: one live probe per known board (falls back to the snapshot if unreachable).
  const known = lookupSuggestedCompanies(query);
  if (known.length > 0) {
    const results = await Promise.all(
      known.map(async (c): Promise<BoardProbe | null> => {
        const adapter = adapters.find((a) => a.id === c.provider);
        if (!adapter) return null;
        const snapshot = { provider: c.provider, slug: c.slug, companyName: c.name, jobCount: c.indiaJobs, boardUrl: boardPageUrl(c.provider, c.slug) };
        try {
          const live = await adapter.probe(c.slug, ctx);
          return live ? { ...live, companyName: live.companyName ?? c.name } : null;
        } catch (err) {
          if (err instanceof FeedProviderError && err.retryable) return snapshot;
          return null;
        }
      }),
    );
    const confirmed = results.filter((p): p is BoardProbe => p !== null);
    if (confirmed.length > 0) return rank(confirmed);
    // Every directory board is gone: fall through to guessing.
  }

  // 2. Slug candidates, at most CONCURRENCY in flight, one confirmed board per provider.
  const plan = buildProbePlan(adapters, query);
  const found: BoardProbe[] = [];
  const confirmedProviders = new Set<string>();
  let retryableFailures = 0;
  let cutOff = false;
  let next = 0;
  const worker = async () => {
    while (next < plan.length) {
      if (ctx.signal?.aborted) {
        cutOff = true;
        return;
      }
      const item = plan[next++]!;
      if (confirmedProviders.has(item.adapter.id)) continue;
      try {
        const probe = await item.adapter.probe(item.slug, ctx);
        // A guessed slug can belong to a namesake: require the board's own name to match.
        if (probe && boardNameMatches(query, probe.companyName) && !confirmedProviders.has(item.adapter.id)) {
          confirmedProviders.add(item.adapter.id);
          found.push(probe);
        }
      } catch (err) {
        if (err instanceof FeedProviderError && err.retryable) retryableFailures++;
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  // Nothing confirmed but some boards were never checked (down, or out of time): don't claim "not found".
  if (found.length === 0 && (retryableFailures > 0 || cutOff)) {
    throw new FeedProviderError("Some job boards could not be checked right now. Try again later.", true);
  }
  return rank(found);
}
