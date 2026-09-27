/**
 * ApplyWise inbound-email relay (Cloudflare Email Worker).
 *
 * Email Routing (catch-all rule "Send to a Worker") -> this Worker -> signed POST of the raw message to
 * ApplyWise (POST /api/inbound/email). The signature is the hex HMAC-SHA256 of
 * "<unix seconds>.<recipient lowercased>." + raw bytes with INBOUND_SECRET, checked by
 * verifyInboundSignature in @applywise/mail-sources (the recipient binding stops cross-user replays).
 *
 * The Worker stores nothing and logs nothing about the message. Self-contained: no dependencies.
 */

export interface Env {
  /** e.g. https://applywise.example.com/api/inbound/email */
  WEBHOOK_URL: string;
  /** Same value as INBOUND_EMAIL_SECRET in ApplyWise. Set with `wrangler secret put INBOUND_SECRET`. */
  INBOUND_SECRET: string;
}

/** The part of Cloudflare's ForwardableEmailMessage used here (avoids a @cloudflare/workers-types dependency). */
export interface InboundEmail {
  /** Envelope MAIL FROM. */
  readonly from: string;
  /** Envelope RCPT TO: identifies the ApplyWise user (Gmail forwarding keeps the original To: header). */
  readonly to: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
}

/** ApplyWise accepts at most 5 MB; job alerts are far smaller. */
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 20_000;
/** Private forwarding addresses look like jobs-<token>@<INBOUND_EMAIL_DOMAIN>; anything else is spam. */
const RECIPIENT_RE = /^jobs-[a-z0-9]{8,64}@/i;

export default {
  async email(message: InboundEmail, env: Env): Promise<void> {
    if (!env.WEBHOOK_URL || !env.INBOUND_SECRET) throw new Error("Relay is not configured (WEBHOOK_URL, INBOUND_SECRET)");
    // Email content never travels in clear text.
    if (!env.WEBHOOK_URL.startsWith("https://")) throw new Error("WEBHOOK_URL must be an https:// URL");
    if (!RECIPIENT_RE.test(message.to)) {
      message.setReject("Unknown address");
      return;
    }
    if (message.rawSize > MAX_BYTES) {
      message.setReject("Message too large");
      return;
    }
    const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
    if (raw.byteLength > MAX_BYTES) {
      message.setReject("Message too large");
      return;
    }
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const to = headerValue(message.to);
    const signature = await sign(env.INBOUND_SECRET, timestamp, to, raw);
    const res = await fetch(env.WEBHOOK_URL, {
      method: "POST",
      body: raw,
      headers: {
        "content-type": "message/rfc822",
        "x-aw-envelope-to": to,
        "x-aw-envelope-from": headerValue(message.from),
        "x-aw-timestamp": timestamp,
        "x-aw-signature": signature,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A redirect would re-send the signed email elsewhere (307/308) or drop it (301/302); treat it as a failure.
      redirect: "manual",
    });
    // Throwing makes Cloudflare refuse the delivery, so the sending server retries or bounces it.
    // ApplyWise answers 200 for unknown recipients, so only real failures end up here.
    if (!res.ok) throw new Error(`ApplyWise webhook responded ${res.status}`);
  },
};

/** hex(HMAC-SHA256(secret, "<timestamp>.<recipient>." + raw)). */
export async function sign(secret: string, timestamp: string, to: string, raw: Uint8Array): Promise<string> {
  const enc = new TextEncoder();
  const prefix = enc.encode(`${timestamp}.${to.trim().toLowerCase()}.`);
  const signed = new Uint8Array(prefix.length + raw.length);
  signed.set(prefix);
  signed.set(raw, prefix.length);
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Header values must be printable ASCII (SMTPUTF8 addresses would make fetch throw). */
function headerValue(s: string): string {
  return s.replace(/[^\x20-\x7e]/g, "?").slice(0, 320);
}
