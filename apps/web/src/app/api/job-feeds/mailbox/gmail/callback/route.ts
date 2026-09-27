import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { AppError } from "@/server/errors";
import { GMAIL_COOKIE, GMAIL_COOKIE_PATH } from "@/server/gmail-oauth";
import { currentUserId } from "@/server/http";
import { logger } from "@/server/logger";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** GET: Google redirects here with ?code&state (or ?error when the user declined). */
export async function GET(req: NextRequest) {
  const base = env().APP_URL.replace(/\/$/, "");
  const userId = await currentUserId();
  if (!userId) return NextResponse.redirect(`${base}/sign-in`);
  const q = req.nextUrl.searchParams;
  const done = (params: string) => {
    const res = NextResponse.redirect(`${base}/jobs/sources?${params}`);
    res.cookies.delete({ name: GMAIL_COOKIE, path: GMAIL_COOKIE_PATH });
    return res;
  };
  if (q.get("error") || !q.get("code") || !q.get("state")) return done("error=gmail_cancelled");
  try {
    await jobFeedsService.gmailCallback(userId, { code: q.get("code")!, state: q.get("state")!, cookie: req.cookies.get(GMAIL_COOKIE)?.value }, req.headers.get("x-request-id") ?? undefined);
    return done("connected=gmail");
  } catch (e) {
    const reason = failureReason(e);
    logger.warn("feed.gmail_connect_failed", { error: e instanceof Error ? e.name : "unknown", reason });
    // Only a fixed reason code travels in the URL (the page maps it to fixed text).
    return done(`error=gmail_failed&reason=${reason}`);
  }
}

function failureReason(e: unknown): "missing_scope" | "no_refresh_token" | "capacity" | "expired" | "forbidden" | "other" {
  if (!(e instanceof Error)) return "other";
  if (e instanceof AppError && e.code === "FORBIDDEN") return "forbidden";
  if (/at most/i.test(e.message)) return "capacity";
  if (/expired|another browser/i.test(e.message) && e instanceof AppError) return "expired";
  if (e.name === "MailAuthError" && /permission|tick|scope/i.test(e.message)) return "missing_scope";
  if (e.name === "MailAuthError" && /refresh|offline/i.test(e.message)) return "no_refresh_token";
  if (e.name === "MailAuthError" && /expired|revoked/i.test(e.message)) return "expired";
  return "other";
}
