import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { redirect } from "next/navigation";
import { ZodError, type z } from "zod";
import type { ApiEnvelope } from "@applywise/types";
import { auth } from "@/auth";
import { AppError, Errors } from "./errors";
import { authenticateExtensionRequest } from "./services/extension.service";
import { createLogger, reportError, type Logger } from "./logger";
import { checkRateLimit, RATE_LIMITS, type RateLimitRule } from "./rate-limit";

export interface RouteContext<B, Q, P> {
  req: NextRequest;
  params: P;
  body: B;
  query: Q;
  userId: string;
  requestId: string;
  log: Logger;
}

interface RouteOptions<BS extends z.ZodType | undefined, QS extends z.ZodType | undefined> {
  /** "user" = session cookie; "extension" = bearer extension token (or session); "public" = no auth. */
  auth?: "user" | "extension" | "public";
  rateLimit?: RateLimitRule;
  body?: BS;
  query?: QS;
  /** Body is multipart/form-data (the handler reads req.formData()). */
  multipart?: boolean;
}

type Infer<S> = S extends z.ZodType ? z.infer<S> : undefined;

export function zodFieldErrors(error: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

export function envelope<T>(requestId: string, data: T, status = 200, headers: Record<string, string> = {}): NextResponse {
  const body: ApiEnvelope<T> = { success: true, data, requestId };
  return NextResponse.json(body, { status, headers: { "x-request-id": requestId, "cache-control": "no-store", ...headers } });
}

export function errorEnvelope(requestId: string, err: AppError, headers: Record<string, string> = {}): NextResponse {
  const body: ApiEnvelope<never> = {
    success: false,
    error: { code: err.code, message: err.message, ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}) },
    requestId,
  };
  return NextResponse.json(body, { status: err.status, headers: { "x-request-id": requestId, "cache-control": "no-store", ...headers } });
}

function clientKey(req: NextRequest, userId: string | null): string {
  if (userId) return `u:${userId}`;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${fwd ?? "local"}`;
}

/**
 * Wrap a route handler: request id, authentication, rate limiting, Zod validation of
 * body/query, typed JSON envelope, and PII-safe error handling.
 */
export function route<P extends Record<string, string> = Record<string, never>, BS extends z.ZodType | undefined = undefined, QS extends z.ZodType | undefined = undefined, R = unknown>(
  options: RouteOptions<BS, QS>,
  handler: (ctx: RouteContext<Infer<BS>, Infer<QS>, P>) => Promise<R | NextResponse>,
) {
  return async (req: NextRequest, context: { params: Promise<P> }): Promise<NextResponse> => {
    const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
    const log = createLogger({ requestId, method: req.method, path: req.nextUrl.pathname });
    const started = Date.now();
    let extraHeaders: Record<string, string> = {};
    try {
      let userId: string | null = null;
      const mode = options.auth ?? "user";
      if (mode === "extension") {
        const ext = await authenticateExtensionRequest(req);
        extraHeaders = ext.corsHeaders;
        userId = ext.userId;
        if (!userId) {
          const session = await auth();
          userId = session?.user?.id ?? null;
        }
        if (!userId) throw Errors.unauthenticated();
      } else if (mode === "user") {
        const session = await auth();
        userId = session?.user?.id ?? null;
        if (!userId) throw Errors.unauthenticated();
      }

      const rule = options.rateLimit ?? RATE_LIMITS.default;
      const rl = checkRateLimit(rule, clientKey(req, userId));
      if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterSec);

      let body: unknown = undefined;
      if (options.body) {
        let json: unknown;
        try {
          json = await req.json();
        } catch {
          throw Errors.validation("Request body must be valid JSON.");
        }
        body = options.body.parse(json);
      }
      let query: unknown = undefined;
      if (options.query) {
        query = options.query.parse(Object.fromEntries(req.nextUrl.searchParams.entries()));
      }
      const params = (await context.params) ?? ({} as P);
      const result = await handler({
        req,
        params,
        body: body as Infer<BS>,
        query: query as Infer<QS>,
        userId: userId ?? "",
        requestId,
        log: log.child({ userId }),
      });
      log.info("request.completed", { status: 200, durationMs: Date.now() - started });
      if (result instanceof NextResponse) {
        result.headers.set("x-request-id", requestId);
        for (const [k, v] of Object.entries(extraHeaders)) result.headers.set(k, v);
        return result;
      }
      return envelope(requestId, result, 200, extraHeaders);
    } catch (err) {
      if (err instanceof ZodError) {
        return errorEnvelope(requestId, Errors.validation("Some fields are invalid.", zodFieldErrors(err)), extraHeaders);
      }
      if (err instanceof AppError) {
        log.warn("request.failed", { code: err.code, status: err.status, durationMs: Date.now() - started });
        return errorEnvelope(requestId, err, extraHeaders);
      }
      reportError(err, { requestId, path: req.nextUrl.pathname });
      return errorEnvelope(requestId, new AppError("INTERNAL_ERROR", "Something went wrong. Please try again.", 500), extraHeaders);
    }
  };
}

/** Current user id for server components/pages; null if signed out. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return session?.user?.id ?? null;
}

/** For server pages: redirect to sign-in when there is no session (pages render in parallel with layouts). */
export async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) redirect("/sign-in");
  return userId;
}
