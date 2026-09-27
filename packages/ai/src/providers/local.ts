import { z } from "zod";
import type { AiConfig } from "../config";

/**
 * Transports for self-hosted / open-weight models.
 *
 * - Ollama: native `POST /api/chat` with `format: <JSON Schema>` (grammar-constrained decoding),
 *   `options.num_ctx` (Ollama's default context is too small for CVs) and `stream: false`.
 * - OpenAI-compatible: `POST {base}/chat/completions` with `response_format: json_schema`.
 *
 * Output is always re-validated with Zod by the caller; nothing here trusts the model.
 */

export class LocalProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LocalProviderError";
  }
}

export interface LocalCallInput {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
}

export interface LocalCallResult {
  text: string;
  model: string;
  truncated: boolean;
  inputTokens?: number;
  outputTokens?: number;
}

/** Zod schema -> plain JSON Schema object suitable for constrained decoding. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", unrepresentable: "any" }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/** Small models follow the schema better when it is also stated in the instructions. */
export function withSchemaInstructions(system: string, jsonSchema: Record<string, unknown>): string {
  return `${system}\n\nRespond with a single JSON object only - no prose, no markdown fences. It must conform to this JSON Schema:\n${JSON.stringify(jsonSchema)}`;
}

/** Parse model text as JSON, tolerating stray code fences. */
export function parseJsonText(text: string): unknown {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new LocalProviderError("Model output was not valid JSON", true);
  }
}

async function postJson(url: string, body: unknown, headers: Record<string, string>, timeoutMs: number): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // Connection refused / DNS / timeout: the server may be starting or busy.
    const name = e instanceof Error ? e.name : "Error";
    // A timed-out generation would just time out again (and hold the GPU); fall back instead.
    if (name === "TimeoutError") throw new LocalProviderError("Local model request timed out", false);
    throw new LocalProviderError("Could not reach the local model server", true);
  }
  if (!res.ok) {
    let detail = "";
    try {
      detail = ((await res.json()) as { error?: string | { message?: string } })?.error as string;
      if (detail && typeof detail === "object") detail = (detail as { message?: string }).message ?? "";
    } catch {
      /* ignore */
    }
    const retryable = res.status === 408 || res.status === 429 || res.status >= 500;
    const hint = res.status === 404 ? " (is the model pulled? try `ollama pull <model>`)" : "";
    throw new LocalProviderError(`Local model server returned ${res.status}${hint}${detail ? `: ${String(detail).slice(0, 200)}` : ""}`, retryable, res.status);
  }
  return res.json();
}

export async function callOllama(config: AiConfig, input: LocalCallInput): Promise<LocalCallResult> {
  const data = (await postJson(
    `${config.baseUrl}/api/chat`,
    {
      model: config.model,
      stream: false,
      format: input.jsonSchema,
      keep_alive: "15m",
      options: { temperature: config.temperature, num_ctx: config.numCtx, num_predict: input.maxTokens },
      messages: [
        { role: "system", content: withSchemaInstructions(input.system, input.jsonSchema) },
        { role: "user", content: input.user },
      ],
    },
    {},
    config.timeoutMs,
  )) as { model?: string; message?: { content?: string }; done_reason?: string; prompt_eval_count?: number; eval_count?: number };
  return {
    text: data.message?.content ?? "",
    model: data.model ?? config.model,
    truncated: data.done_reason === "length",
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
  };
}

export async function callOpenAiCompatible(config: AiConfig, input: LocalCallInput): Promise<LocalCallResult> {
  const data = (await postJson(
    `${config.baseUrl}/chat/completions`,
    {
      model: config.model,
      temperature: config.temperature,
      max_tokens: input.maxTokens,
      response_format: { type: "json_schema", json_schema: { name: "result", schema: input.jsonSchema, strict: true } },
      messages: [
        { role: "system", content: withSchemaInstructions(input.system, input.jsonSchema) },
        { role: "user", content: input.user },
      ],
    },
    config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
    config.timeoutMs,
  )) as { model?: string; choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const choice = data.choices?.[0];
  return {
    text: choice?.message?.content ?? "",
    model: data.model ?? config.model,
    truncated: choice?.finish_reason === "length",
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

export interface ProviderHealth {
  ok: boolean;
  message: string;
  models?: string[];
}

/** Lightweight reachability check used by the integrations page and the eval script. */
export async function checkLocalProvider(config: AiConfig): Promise<ProviderHealth> {
  if (!config.baseUrl) return { ok: false, message: "No base URL configured." };
  try {
    if (config.provider === "ollama") {
      const res = await fetch(`${config.baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return { ok: false, message: `Ollama responded with ${res.status}.` };
      const tags = (await res.json()) as { models?: { name: string }[] };
      const models = (tags.models ?? []).map((m) => m.name);
      const wanted = config.model.includes(":") ? config.model : `${config.model}:latest`;
      const installed = models.includes(config.model) || models.includes(wanted);
      return installed
        ? { ok: true, message: `Ollama is running and ${config.model} is installed.`, models }
        : { ok: false, message: `Ollama is running but ${config.model} is not pulled. Run: ollama pull ${config.model}`, models };
    }
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? { ok: true, message: "OpenAI-compatible server is reachable." } : { ok: false, message: `Server responded with ${res.status}.` };
  } catch {
    return { ok: false, message: `Cannot reach ${config.baseUrl}. Is the model server running?` };
  }
}
