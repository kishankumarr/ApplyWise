import { NextResponse, type NextRequest } from "next/server";
import { verifyInboundSignature } from "@applywise/mail-sources";
import { env } from "@/env";
import { logger } from "@/server/logger";
import { checkRateLimit, RATE_LIMITS } from "@/server/rate-limit";
import { jobFeedsService } from "@/server/services/job-feeds.service";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Inbound job-alert emails from the relay (see infra/cloudflare-email-worker). Server-to-server:
 * authenticated by an HMAC over "<timestamp>.<recipient>." + raw email with INBOUND_EMAIL_SECRET,
 * 5-minute window; the recipient is bound so a delivery cannot be replayed to another user.
 * Returns 200 for accepted or unknown recipients (so the relay does not retry forever), 401 for bad
 * signatures and 413 for oversized messages.
 */
export async function POST(req: NextRequest) {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const secret = env().INBOUND_EMAIL_SECRET;
  if (!secret || !env().INBOUND_EMAIL_DOMAIN) return NextResponse.json({ ok: false, error: "not configured" }, { status: 404 });
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "relay";
  if (!checkRateLimit(RATE_LIMITS.inbound, ip).allowed) return NextResponse.json({ ok: false }, { status: 429 });
  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length > MAX_BYTES) return NextResponse.json({ ok: false, error: "too large" }, { status: 413 });
  const envelopeTo = req.headers.get("x-aw-envelope-to") ?? "";
  const ok = verifyInboundSignature({
    secret,
    timestamp: req.headers.get("x-aw-timestamp") ?? "",
    signature: req.headers.get("x-aw-signature") ?? "",
    envelopeTo,
    body: raw,
  });
  if (!ok) {
    logger.warn("inbound.bad_signature", { requestId });
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  try {
    const result = await jobFeedsService.handleInbound(envelopeTo, raw, requestId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    logger.error("inbound.failed", { requestId, error: e instanceof Error ? e.name : "unknown" });
    // 5xx lets the relay retry later.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}
