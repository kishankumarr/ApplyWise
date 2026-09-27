import { execSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Apply migrations to the dedicated unit-test database (never the dev database).
 * Non-destructive: tests create uniquely named users, so no reset is required.
 */
export default function setup() {
  const url = "postgresql://applywise:applywise@localhost:5433/applywise_unit";
  execSync("npx prisma migrate deploy", {
    cwd: resolve(__dirname, "../../../packages/database"),
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
