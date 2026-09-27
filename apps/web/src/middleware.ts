import NextAuth from "next-auth";
import { NextResponse } from "next/server";
import { authConfig } from "./auth.config";

const { auth } = NextAuth(authConfig);

/** Endpoints that authenticate with a bearer extension token instead of the session cookie. */
/** Also exempt: the signed inbound-email webhook (server-to-server, verified by HMAC in the handler). */
const BEARER_API_PREFIXES = ["/api/extension/", "/api/jobs/import/browser", "/api/inbound/"];

/**
 * - Protects authenticated pages (redirects to /sign-in).
 * - Adds a request id to every request/response.
 * - CSRF: mutating same-site API calls must come from our own origin. Bearer-token
 *   extension endpoints are exempt here and validated in the handler instead.
 */
export default auth((req) => {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();
  const isApi = pathname.startsWith("/api/");
  const mutating = !["GET", "HEAD", "OPTIONS"].includes(method);

  if (isApi && mutating && !pathname.startsWith("/api/auth/") && !BEARER_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    const origin = req.headers.get("origin");
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const sameOrigin = origin ? (() => {
      try {
        return new URL(origin).host === host;
      } catch {
        return false;
      }
    })() : req.headers.get("sec-fetch-site") === "same-origin";
    if (!sameOrigin) {
      return NextResponse.json(
        { success: false, error: { code: "FORBIDDEN", message: "Cross-site request blocked." }, requestId },
        { status: 403, headers: { "x-request-id": requestId } },
      );
    }
  }

  const headers = new Headers(req.headers);
  headers.set("x-request-id", requestId);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", requestId);
  return res;
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
