export type AiEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * - anthropic: Claude via the official Anthropic SDK (default).
 * - ollama: a local open-weight model served by Ollama (native /api/chat, JSON-schema constrained output).
 * - openai_compatible: any OpenAI-compatible server (vLLM, LM Studio, llama.cpp server, hosted open-model APIs).
 */
export const AI_PROVIDERS = ["anthropic", "ollama", "openai_compatible"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export interface AiConfig {
  provider: AiProvider;
  /** Anthropic key, or optional bearer key for OpenAI-compatible servers. */
  apiKey: string | null;
  /** Base URL for ollama / openai_compatible providers. */
  baseUrl: string | null;
  /** Model ID (configurable per provider). */
  model: string;
  effort: AiEffort;
  maxAttempts: number;
  baseBackoffMs: number;
  timeoutMs: number;
  /** Server-side refusal fallbacks (Anthropic beta). Disable when routing through a proxy that rejects it. */
  serverFallbacks: boolean;
  /** Context window requested from local models (Ollama defaults are too small for CVs). */
  numCtx: number;
  /** Sampling temperature for local models (Claude uses its defaults). */
  temperature: number;
  /** Force the deterministic fallback even if a provider is configured (tests, offline demos). */
  disabled: boolean;
}

export const DEFAULT_MODEL = "claude-opus-5";
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

const num = (v: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && v !== undefined && v !== "" ? Math.min(max, Math.max(min, n)) : fallback;
};

export function getAiConfig(env: Record<string, string | undefined> = process.env): AiConfig {
  const rawProvider = (env.AI_PROVIDER ?? "anthropic").trim().toLowerCase();
  const provider: AiProvider = (AI_PROVIDERS as readonly string[]).includes(rawProvider) ? (rawProvider as AiProvider) : "anthropic";
  const effort = (env.ANTHROPIC_EFFORT ?? "medium") as AiEffort;
  const local = provider !== "anthropic";

  let apiKey: string | null = null;
  let baseUrl: string | null = null;
  let model: string;
  if (provider === "anthropic") {
    apiKey = env.ANTHROPIC_API_KEY?.trim() || null;
    model = env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL;
  } else if (provider === "ollama") {
    baseUrl = (env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
    model = env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  } else {
    baseUrl = env.OPENAI_COMPAT_BASE_URL?.trim().replace(/\/+$/, "") || null;
    apiKey = env.OPENAI_COMPAT_API_KEY?.trim() || null;
    model = env.OPENAI_COMPAT_MODEL?.trim() || "";
  }

  return {
    provider,
    apiKey,
    baseUrl,
    model,
    effort: ["low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : "medium",
    maxAttempts: Math.round(num(env.AI_MAX_ATTEMPTS, 3, 1, 5)),
    baseBackoffMs: num(env.AI_BACKOFF_MS, 500, 0, 30_000),
    // Local models on consumer GPUs are slow; give them more time by default.
    timeoutMs: num(env.AI_TIMEOUT_MS, local ? 300_000 : 120_000, 5_000, 900_000),
    serverFallbacks: env.ANTHROPIC_SERVER_FALLBACKS !== "false",
    numCtx: Math.round(num(env.OLLAMA_NUM_CTX, 8192, 2048, 131_072)),
    temperature: num(env.AI_TEMPERATURE, 0.2, 0, 1.5),
    disabled: env.AI_DISABLED === "true",
  };
}

export function isAiConfigured(config: AiConfig = getAiConfig()): boolean {
  if (config.disabled) return false;
  switch (config.provider) {
    case "anthropic":
      return !!config.apiKey;
    case "ollama":
      return !!config.baseUrl && !!config.model;
    case "openai_compatible":
      return !!config.baseUrl && !!config.model;
  }
}

/** Does this provider send data to a third party (vs. a model on our own infrastructure)? */
export function providerIsExternal(config: AiConfig): boolean {
  if (config.provider === "anthropic") return true;
  if (!config.baseUrl) return false;
  try {
    const host = new URL(config.baseUrl).hostname;
    return !["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"].includes(host);
  } catch {
    return true;
  }
}

/** Human-readable description of the active AI provider, for consent and status UI. */
export function describeAiProvider(config: AiConfig = getAiConfig()): {
  provider: AiProvider;
  configured: boolean;
  model: string;
  label: string;
  /** For sentences: "Claude (claude-opus-5)", "the Ollama model qwen2.5:7b"… */
  shortLabel: string;
  external: boolean;
  disabled: boolean;
} {
  const configured = isAiConfigured(config);
  const external = providerIsExternal(config);
  const label =
    config.provider === "anthropic"
      ? `Anthropic Claude (${config.model})`
      : config.provider === "ollama"
        ? `Ollama - ${config.model}${external ? ` at ${config.baseUrl}` : " (local model, data stays on this server)"}`
        : `OpenAI-compatible server - ${config.model || "model not set"}${external ? ` at ${config.baseUrl}` : " (local)"}`;
  const shortLabel =
    config.provider === "anthropic"
      ? `Claude (${config.model})`
      : config.provider === "ollama"
        ? `the Ollama model ${config.model}`
        : `the OpenAI-compatible model ${config.model || "(not set)"}`;
  return { provider: config.provider, configured, model: config.model, label, shortLabel, external, disabled: config.disabled };
}
