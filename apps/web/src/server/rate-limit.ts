/**
 * Fixed-window rate limiter. In-memory for the MVP (single instance); swap the store for
 * Redis in multi-instance deployments (same interface).
 */

export interface RateLimitRule {
  /** Bucket name, e.g. "ai", "upload". */
  name: string;
  limit: number;
  windowMs: number;
}

export const RATE_LIMITS = {
  auth: { name: "auth", limit: 10, windowMs: 60_000 },
  ai: { name: "ai", limit: 30, windowMs: 60_000 },
  upload: { name: "upload", limit: 10, windowMs: 60_000 },
  emailSend: { name: "email-send", limit: 5, windowMs: 60_000 },
  verifyEmail: { name: "verify-email", limit: 3, windowMs: 10 * 60_000 },
  verifyConfirm: { name: "verify-confirm", limit: 10, windowMs: 60_000 },
  feedLookup: { name: "feed-lookup", limit: 20, windowMs: 60_000 },
  feedSync: { name: "feed-sync", limit: 10, windowMs: 60_000 },
  mailboxConnect: { name: "mailbox-connect", limit: 5, windowMs: 10 * 60_000 },
  inbound: { name: "inbound-email", limit: 600, windowMs: 60_000 },
  jobImport: { name: "job-import", limit: 30, windowMs: 60_000 },
  default: { name: "default", limit: 120, windowMs: 60_000 },
} satisfies Record<string, RateLimitRule>;

interface Bucket {
  count: number;
  resetAt: number;
}

const store = new Map<string, Bucket>();

export function checkRateLimit(rule: RateLimitRule, key: string, now = Date.now()): { allowed: boolean; remaining: number; retryAfterSec: number } {
  if (process.env.RATE_LIMIT_ENABLED === "false") return { allowed: true, remaining: rule.limit, retryAfterSec: 0 };
  const id = `${rule.name}:${key}`;
  let bucket = store.get(id);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + rule.windowMs };
    store.set(id, bucket);
  }
  bucket.count += 1;
  if (store.size > 50_000) {
    for (const [k, b] of store) if (b.resetAt <= now) store.delete(k);
  }
  const allowed = bucket.count <= rule.limit;
  return { allowed, remaining: Math.max(0, rule.limit - bucket.count), retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) };
}

export function resetRateLimits(): void {
  store.clear();
}
