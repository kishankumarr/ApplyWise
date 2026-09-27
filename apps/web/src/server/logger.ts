/**
 * Structured JSON logger with PII redaction.
 *
 * - Keys that commonly hold PII or secrets are replaced with "[REDACTED]".
 * - String values are scrubbed for emails, phone numbers and bearer tokens.
 * - Long strings are truncated so raw resume text / email bodies can never be dumped.
 */

type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEYS =
  /^(password|passwordhash|token|secret|authorization|cookie|apikey|api_key|body|text|html|content|rawtext|extractedtext|resume|cv|email|phone|to|cc|subject|answer|freetext|salary|expectedsalarymin|expectedsalarymax|description|summary|notes|raw|payload)$/i;

/** Opaque identifiers that are safe (and needed) in logs. */
const SAFE_ID_KEYS = new Set(["requestId", "userId", "taskId", "entityId", "applicationId", "jobId", "resumeId", "digest"]);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?\d[\d\s-]{8,}\d)/g;
const BEARER_RE = /(bearer\s+)[a-z0-9._~+/-]+=*/gi;
const TOKENISH_RE = /\b[a-z0-9_-]{32,}\b/gi;

export function redactString(value: string): string {
  const scrubbed = value
    .replace(BEARER_RE, "$1[REDACTED]")
    .replace(EMAIL_RE, "[email]")
    .replace(PHONE_RE, "[phone]")
    .replace(TOKENISH_RE, "[token]");
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 300)}…[truncated]` : scrubbed;
}

export function redact(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (depth > 5) return "[depth]";
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SAFE_ID_KEYS.has(k) && typeof v === "string") out[k] = v.slice(0, 64);
      else out[k] = SENSITIVE_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

function currentLevel(): Level {
  const l = (process.env.LOG_LEVEL ?? "info") as Level;
  return l in LEVELS ? l : "info";
}

function write(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[currentLevel()]) return;
  if (process.env.NODE_ENV === "test" && level !== "error") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta ? (redact(meta) as object) : {}) });
  if (level === "error" || level === "warn") console.error(line);
  else process.stdout.write(`${line}\n`);
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  return {
    debug: (m, meta) => write("debug", m, { ...bindings, ...meta }),
    info: (m, meta) => write("info", m, { ...bindings, ...meta }),
    warn: (m, meta) => write("warn", m, { ...bindings, ...meta }),
    error: (m, meta) => write("error", m, { ...bindings, ...meta }),
    child: (b) => createLogger({ ...bindings, ...b }),
  };
}

export const logger = createLogger({ service: "applywise-web" });

/** Error-reporting abstraction (wire Sentry or similar here in production). */
export function reportError(error: unknown, context: Record<string, unknown> = {}): void {
  logger.error("error.reported", { ...context, error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
}
