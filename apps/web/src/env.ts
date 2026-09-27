import "server-only";
import { z } from "zod";

/**
 * Server environment, validated with Zod at first use. Secrets never reach the client:
 * only NEXT_PUBLIC_* variables are inlined into client bundles.
 */
const bool = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

const serverSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    APP_URL: z.url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
    ENCRYPTION_KEY: z
      .string()
      .min(1, "ENCRYPTION_KEY is required")
      .refine((v) => Buffer.from(v, "base64").length === 32, "ENCRYPTION_KEY must be 32 bytes, base64 encoded"),
    SIGNING_SECRET: z.string().min(32, "SIGNING_SECRET must be at least 32 characters"),

    STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
    STORAGE_LOCAL_DIR: z.string().default(".storage"),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().default("auto"),
    S3_ENDPOINT: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: bool,
    MAX_UPLOAD_MB: z.coerce.number().min(1).max(25).default(5),
    MALWARE_SCANNER: z.enum(["none", "clamav"]).default("none"),
    CLAMAV_HOST: z.string().optional(),
    CLAMAV_PORT: z.coerce.number().default(3310),

    ANTHROPIC_API_KEY: z.string().optional(),
    ANTHROPIC_MODEL: z.string().default("claude-opus-5"),
    AI_PROVIDER: z.enum(["anthropic", "ollama", "openai_compatible"]).default("anthropic"),
    OLLAMA_BASE_URL: z.url().optional(),
    OLLAMA_MODEL: z.string().optional(),
    OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).max(131072).optional(),
    OPENAI_COMPAT_BASE_URL: z.url().optional(),
    OPENAI_COMPAT_MODEL: z.string().optional(),
    OPENAI_COMPAT_API_KEY: z.string().optional(),
    AI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(900000).optional(),
    AI_TEMPERATURE: z.coerce.number().min(0).max(1.5).optional(),
    AI_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).optional(),
    AI_BACKOFF_MS: z.coerce.number().int().min(0).max(30000).optional(),
    ANTHROPIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    ANTHROPIC_SERVER_FALLBACKS: z.enum(["true", "false"]).optional(),
    AI_DISABLED: bool,

    QUEUE_DRIVER: z.enum(["inline", "memory", "bullmq"]).default("memory"),
    REDIS_URL: z.string().optional(),

    EMAIL_PROVIDER: z.enum(["dev", "smtp", "resend"]).default("dev"),
    EMAIL_FROM: z.string().default("ApplyWise <no-reply@applywise.test>"),
    EMAIL_OUTBOX_DIR: z.string().default(".outbox"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.string().optional(),
    SMTP_SECURE: z.string().optional(),
    SMTP_USER: z.string().optional(),
    SMTP_PASS: z.string().optional(),
    SMTP_DELIVERS_EXTERNALLY: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),

    // Automatic job sources
    FEEDS_SCHEDULER: z.enum(["on", "off"]).default("on"),
    FEEDS_TICK_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
    ADZUNA_APP_ID: z.string().optional(),
    ADZUNA_APP_KEY: z.string().optional(),
    ADZUNA_DAILY_LIMIT: z.coerce.number().int().min(1).max(100000).default(200),
    ADZUNA_WEEKLY_LIMIT: z.coerce.number().int().min(1).max(1000000).default(900),
    ADZUNA_MONTHLY_LIMIT: z.coerce.number().int().min(1).max(10000000).default(2300),
    THE_MUSE_API_KEY: z.string().optional(),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    MICROSOFT_CLIENT_ID: z.string().optional(),
    MICROSOFT_TENANT: z.enum(["consumers", "common", "organizations"]).default("common"),
    INBOUND_EMAIL_DOMAIN: z.string().optional(),
    INBOUND_EMAIL_SECRET: z.string().min(24).optional(),
    ALLOW_CUSTOM_IMAP_HOST: bool,

    // Automation (discovery -> match -> rules -> prepare -> route -> execute)
    AUTOMATION_SCHEDULER: z.enum(["on", "off"]).default("on"),
    AUTOMATION_TICK_SECONDS: z.coerce.number().int().min(15).max(3600).default(60),
    /** Upper bound for a user's maxApplicationsPerDay. */
    AUTOMATION_MAX_DAILY_LIMIT: z.coerce.number().int().min(1).max(500).default(50),
    /** Applications prepared per run (bounds AI cost). */
    AUTOMATION_MAX_PREPARE_PER_RUN: z.coerce.number().int().min(1).max(500).default(25),
    /** Jobs evaluated per run. */
    AUTOMATION_MAX_JOBS_PER_RUN: z.coerce.number().int().min(10).max(5000).default(500),
    APPLY_QUEUE_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    /** The demo provider (DEMO CONTENT) is available outside production, or when explicitly enabled. */
    DEMO_PROVIDER_ENABLED: z.enum(["true", "false"]).optional(),
    // Browser executor (Playwright + Chromium inside the worker). Off by default.
    BROWSER_EXECUTOR_ENABLED: bool,
    /** Providers the browser executor may run for, e.g. "demo" or "demo,greenhouse,lever,ashby" (experimental). */
    BROWSER_EXECUTOR_PROVIDERS: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : ["demo"])),
    /** Fill forms but never press the final submit button (the application ends in a manual handoff). */
    BROWSER_EXECUTOR_DRY_RUN: bool,
    BROWSER_EXECUTOR_HEADLESS: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v !== "false"),
    BROWSER_EXECUTOR_TIMEOUT_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
    WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65535).default(3200),

    EXTENSION_ORIGINS: z
      .string()
      .optional()
      .transform((v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [])),
    RATE_LIMIT_ENABLED: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => v !== "false"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    ENABLE_DEMO_ADMIN: bool,
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "s3" && !env.S3_BUCKET) ctx.addIssue({ code: "custom", path: ["S3_BUCKET"], message: "S3_BUCKET is required for s3 storage" });
    if (env.QUEUE_DRIVER === "bullmq" && !env.REDIS_URL) ctx.addIssue({ code: "custom", path: ["REDIS_URL"], message: "REDIS_URL is required for bullmq" });
    if (env.AI_PROVIDER === "openai_compatible" && (!env.OPENAI_COMPAT_BASE_URL || !env.OPENAI_COMPAT_MODEL)) {
      ctx.addIssue({ code: "custom", path: ["OPENAI_COMPAT_BASE_URL"], message: "OPENAI_COMPAT_BASE_URL and OPENAI_COMPAT_MODEL are required for the openai_compatible provider" });
    }
  })
  // Demo admin tooling is development-only: always off in production builds.
  .transform((env) => ({ ...env, ENABLE_DEMO_ADMIN: env.ENABLE_DEMO_ADMIN && env.NODE_ENV !== "production" }));

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function env(): ServerEnv {
  if (cached) return cached;
  // `KEY=` in .env means "not set", not an empty value to validate.
  const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ""));
  const parsed = serverSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  // Links in emails (confirmation, reminders) are built from APP_URL.
  if (cached.NODE_ENV === "production" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(cached.APP_URL).hostname)) {
    console.warn(`[config] APP_URL is ${cached.APP_URL} in production: links in emails will not work for users. Set APP_URL to the public URL.`);
  }
  return cached;
}

export const APP_NAME = process.env.NEXT_PUBLIC_APP_NAME ?? "ApplyWise";
