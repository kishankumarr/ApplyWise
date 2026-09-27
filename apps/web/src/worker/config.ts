/**
 * Configuration helpers for the worker process and the CLI scripts. Pure (no server imports), so they can run before
 * the environment is loaded or validated.
 */

export const DEFAULT_WORKER_ROLES = ["worker", "scheduler"] as const;
export const KNOWN_WORKER_ROLES: readonly string[] = DEFAULT_WORKER_ROLES;

/**
 * WORKER_ROLES as a set. Unset, empty or blank (`WORKER_ROLES=` in .env, or only commas/spaces) means the default
 * roles - an empty value must never start a worker that does nothing.
 */
export function parseWorkerRoles(raw: string | undefined): Set<string> {
  const roles = (raw ?? "")
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  return new Set(roles.length ? roles : DEFAULT_WORKER_ROLES);
}

/** An optional override from the environment: empty or blank counts as not set (like `KEY=` in .env). */
export function envOverride(value: string | undefined, fallback: string): string {
  const v = value?.trim();
  return v ? v : fallback;
}
