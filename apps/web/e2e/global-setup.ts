import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { resolve } from "node:path";
import { E2E_BASE_URL, E2E_DATABASE_URL } from "../playwright.config";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Prepare the dedicated E2E database (migrate + seed demo data) and generate CV fixtures.
 * Uses `migrate deploy` (non-destructive); the seed itself replaces the demo user and demo jobs.
 */
export default async function globalSetup() {
  const dbDir = resolve(here, "../../../packages/database");
  const env = { ...process.env, DATABASE_URL: E2E_DATABASE_URL, APP_URL: E2E_BASE_URL };
  execSync("npx prisma migrate deploy", { cwd: dbDir, env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { cwd: dbDir, env, stdio: "pipe" });
  execSync("npx tsx e2e/make-fixtures.ts", { cwd: resolve(here, ".."), env, stdio: "pipe" });
}
