import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { getAiConfig, isAiConfigured, type AiConfig } from "./config";
import { repairNote } from "./prompts";
import { callOllama, callOpenAiCompatible, LocalProviderError, parseJsonText, toJsonSchema } from "./providers/local";

/**
 * Isolated AI client. All AI calls in ApplyWise go through `callStructured`, which:
 *  - uses structured JSON outputs (Claude: output_config.format; local models: JSON-schema
 *    constrained decoding) and re-validates everything with Zod,
 *  - retries retryable failures with exponential backoff,
 *  - returns safe metadata only (never prompt or completion text) for logging.
 */

export interface AiLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
}

const noopLogger: AiLogger = { info: () => {}, warn: () => {} };

/** "claude" = Anthropic API; "ollama" / "openai_compatible" = self-hosted models; "fallback" = deterministic rules. */
export type AiCallProvider = "claude" | "ollama" | "openai_compatible" | "fallback";

export interface AiCallMeta {
  workflow: string;
  provider: AiCallProvider;
  modelId: string | null;
  promptVersion: string;
  attempts: number;
  durationMs: number;
  fallbackReason?: string;
  /** Number of guard-feedback repair rounds used before the output was accepted. */
  repairs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "not_configured" | "refusal" | "invalid_output" | "api_error" | "truncated" | "context_overflow",
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

let cachedClient: { key: string; client: Anthropic } | null = null;

function getClient(config: AiConfig): Anthropic {
  if (!config.apiKey) throw new AiUnavailableError("ANTHROPIC_API_KEY is not set", "not_configured");
  if (cachedClient?.key === config.apiKey) return cachedClient.client;
  // We own retries (below) so validation failures and API errors share one backoff policy.
  const client = new Anthropic({ apiKey: config.apiKey, maxRetries: 0, timeout: config.timeoutMs });
  cachedClient = { key: config.apiKey, client };
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(error: unknown): boolean {
  if (error instanceof LocalProviderError) return error.retryable;
  if (error instanceof Anthropic.RateLimitError) return true;
  if (error instanceof Anthropic.InternalServerError) return true;
  if (error instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (error instanceof Anthropic.APIError) return error.status === 408 || error.status === 409 || error.status === 529;
  return false;
}

export interface StructuredCallInput<S extends z.ZodType> {
  workflow: string;
  promptVersion: string;
  system: string;
  user: string;
  schema: S;
  maxTokens?: number;
  /** Rejection reason from a previous attempt; appended to the prompt so the model can correct itself. */
  feedback?: string;
  config?: AiConfig;
  logger?: AiLogger;
}

interface Attempt {
  parsed: unknown;
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function attemptClaude<S extends z.ZodType>(config: AiConfig, input: StructuredCallInput<S>): Promise<Attempt> {
  const response = await getClient(config).beta.messages.parse({
    model: config.model,
    max_tokens: input.maxTokens ?? 16000,
    system: input.system,
    messages: [{ role: "user", content: input.user + repairNote(input.feedback) }],
    output_config: { format: betaZodOutputFormat(input.schema), effort: config.effort },
    ...(config.serverFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  if (response.stop_reason === "refusal") throw new AiUnavailableError("Claude declined the request", "refusal");
  if (response.stop_reason === "max_tokens") throw new AiUnavailableError("Claude output was truncated", "truncated");
  return {
    parsed: response.parsed_output,
    modelId: response.model ?? config.model,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
}

async function attemptLocal<S extends z.ZodType>(config: AiConfig, input: StructuredCallInput<S>): Promise<Attempt> {
  const call = config.provider === "ollama" ? callOllama : callOpenAiCompatible;
  const jsonSchema = toJsonSchema(input.schema);
  const user = input.user + repairNote(input.feedback);
  // Ollama silently drops the start of prompts that exceed num_ctx; refuse instead (conservative ~3.5 chars/token).
  const promptTokens = Math.ceil((input.system.length + user.length + 2 * JSON.stringify(jsonSchema).length) / 3.5);
  const room = config.numCtx - promptTokens;
  if (config.provider === "ollama" && room < 1024) {
    throw new AiUnavailableError("Prompt is too large for the local model context window (raise OLLAMA_NUM_CTX)", "context_overflow");
  }
  const result = await call(config, {
    system: input.system,
    user,
    jsonSchema,
    // Local models: cap output so a runaway generation cannot occupy the GPU for minutes.
    maxTokens: Math.min(input.maxTokens ?? 4096, 4096, config.provider === "ollama" ? room : 4096),
  });
  if (config.provider === "ollama" && result.inputTokens != null && result.inputTokens >= config.numCtx - 8) {
    throw new AiUnavailableError("Prompt filled the local model context window", "context_overflow");
  }
  if (result.truncated) throw new AiUnavailableError("Local model output was truncated", "truncated");
  let parsed: unknown;
  try {
    parsed = parseJsonText(result.text);
  } catch {
    throw new AiUnavailableError("Local model output was not valid JSON", "invalid_output");
  }
  return { parsed, modelId: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens };
}

export async function callStructured<S extends z.ZodType>(
  input: StructuredCallInput<S>,
): Promise<{ data: z.infer<S>; meta: AiCallMeta }> {
  const config = input.config ?? getAiConfig();
  const logger = input.logger ?? noopLogger;
  if (!isAiConfigured(config)) throw new AiUnavailableError("No AI provider is configured", "not_configured");
  const provider: AiCallProvider = config.provider === "anthropic" ? "claude" : config.provider;
  const started = Date.now();
  let lastError: unknown = null;
  let retryNote: string | undefined;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const attemptInput = retryNote ? { ...input, feedback: [input.feedback, retryNote].filter(Boolean).join(" ") } : input;
      const result = config.provider === "anthropic" ? await attemptClaude(config, attemptInput) : await attemptLocal(config, attemptInput);
      const validated = input.schema.safeParse(result.parsed);
      if (!validated.success) throw new AiUnavailableError("Model output failed schema validation", "invalid_output");
      const meta: AiCallMeta = {
        workflow: input.workflow,
        provider,
        modelId: result.modelId,
        promptVersion: input.promptVersion,
        attempts: attempt,
        durationMs: Date.now() - started,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      };
      logger.info("ai.call.succeeded", { ...meta });
      return { data: validated.data, meta };
    } catch (error) {
      lastError = error;
      const retryable =
        isRetryable(error) || (error instanceof AiUnavailableError && (error.reason === "invalid_output" || error.reason === "truncated"));
      logger.warn("ai.call.failed", {
        workflow: input.workflow,
        provider,
        promptVersion: input.promptVersion,
        attempt,
        retryable,
        errorType: error instanceof Error ? error.name : "unknown",
        // e.g. "context_overflow" (raise OLLAMA_NUM_CTX) or "truncated"; never includes model output.
        reason: error instanceof AiUnavailableError ? error.reason : undefined,
        status: error instanceof Anthropic.APIError ? error.status : error instanceof LocalProviderError ? error.status : undefined,
      });
      if (!retryable || attempt === config.maxAttempts) break;
      if (error instanceof AiUnavailableError && error.reason === "truncated") {
        retryNote = "Your previous answer was cut off because it was too long; answer much more concisely.";
      }
      const jitter = Math.random() * config.baseBackoffMs;
      await sleep(config.baseBackoffMs * 2 ** (attempt - 1) + jitter);
    }
  }
  if (lastError instanceof AiUnavailableError) throw lastError;
  throw new AiUnavailableError(lastError instanceof Error ? lastError.message : "AI request failed", "api_error");
}

/**
 * Run an AI workflow with a deterministic fallback. The fallback is used when no provider is
 * configured, the call fails, or the domain guard rejects the output.
 */
/** Guard reasons for logs: quoted fragments (claim text, names) are replaced. */
export function safeReason(reason: string): string {
  return reason.replace(/"[^"]*"/g, '"…"').replace(/\[[^\]]*\]/g, "[…]").slice(0, 160);
}

export async function withFallback<T>(opts: {
  workflow: string;
  promptVersion: string;
  fallbackVersion: string;
  /** Called with the previous guard rejection (if any) so the model can repair its answer. */
  run: (feedback?: string) => Promise<{ data: T; meta: AiCallMeta }>;
  guard?: (data: T) => string | null;
  fallback: () => T | Promise<T>;
  /** Extra model attempts after a guard rejection (default 1). Transport/format retries happen inside callStructured. */
  repairAttempts?: number;
  logger?: AiLogger;
  config?: AiConfig;
}): Promise<{ data: T; meta: AiCallMeta }> {
  const config = opts.config ?? getAiConfig();
  const logger = opts.logger ?? noopLogger;
  const started = Date.now();
  let reason = "not_configured";
  if (isAiConfigured(config)) {
    const rounds = 1 + Math.max(0, opts.repairAttempts ?? 1);
    let feedback: string | undefined;
    for (let round = 0; round < rounds; round++) {
      try {
        const result = await opts.run(feedback);
        const rejection = opts.guard?.(result.data) ?? null;
        if (!rejection) return { data: result.data, meta: { ...result.meta, repairs: round } };
        reason = `guard_rejected: ${rejection}`;
        feedback = rejection;
        // Rejection reasons can quote CV-derived text; log them with quoted content removed.
        logger.warn("ai.guard.rejected", { workflow: opts.workflow, provider: result.meta.provider, round, reason: safeReason(rejection) });
      } catch (error) {
        // Transport and format errors were already retried with backoff inside callStructured.
        reason = error instanceof AiUnavailableError ? error.reason : "api_error";
        break;
      }
    }
  }
  const data = await opts.fallback();
  return {
    data,
    meta: {
      workflow: opts.workflow,
      provider: "fallback",
      modelId: null,
      promptVersion: opts.fallbackVersion,
      attempts: 0,
      durationMs: Date.now() - started,
      fallbackReason: reason,
    },
  };
}
