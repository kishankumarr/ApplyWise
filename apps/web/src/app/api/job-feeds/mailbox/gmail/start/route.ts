import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { currentUserId } from "@/server/http";
import { GMAIL_COOKIE, GMAIL_COOKIE_PATH } from "@/server/gmail-oauth";
import { jobFeedsService } from "@/server/services/job-feeds.service";

/** GET: redirect to Google's consent screen (read-only Gmail scope). */
export async function GET(req: NextRequest) {
  const userId = await currentUserId();
  const base = env().APP_URL.replace(/\/$/, "");
  if (!userId) return NextResponse.redirect(`${base}/sign-in`);
  try {
    const loginHint = req.nextUrl.searchParams.get("email") ?? undefined;
    const { url, cookie } = await jobFeedsService.gmailStart(userId, loginHint);
    const res = NextResponse.redirect(url);
    res.cookies.set(GMAIL_COOKIE, cookie, { httpOnly: true, secure: base.startsWith("https://"), sameSite: "lax", path: GMAIL_COOKIE_PATH, maxAge: 600 });
    return res;
  } catch (e) {
    const capacity = e instanceof Error && /at most/.test(e.message);
    return NextResponse.redirect(`${base}/jobs/sources?error=${capacity ? "gmail_failed&reason=capacity" : "gmail_not_configured"}`);
  }
}
