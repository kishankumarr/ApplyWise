import { resolve } from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "server-only": resolve(__dirname, "test/server-only-stub.ts"),
      // next-auth is only needed by route handlers; services are tested directly.
      "@/auth": resolve(__dirname, "test/auth-stub.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: "test",
      AUTH_SECRET: "test-auth-secret-test-auth-secret-000",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      SIGNING_SECRET: "test-signing-secret-test-signing-secret-000",
      DATABASE_URL: "postgresql://applywise:applywise@localhost:5433/applywise_unit",
      APP_URL: "http://localhost:3000",
      AI_DISABLED: "true",
      QUEUE_DRIVER: "inline",
      STORAGE_LOCAL_DIR: ".storage-test",
      EMAIL_PROVIDER: "dev",
      EMAIL_OUTBOX_DIR: ".outbox-test",
      RATE_LIMIT_ENABLED: "true",
      INBOUND_EMAIL_DOMAIN: "in.applywise.test",
      INBOUND_EMAIL_SECRET: "unit-inbound-secret-0123456789abcdef",
      FEEDS_SCHEDULER: "off",
    },
  },
});
