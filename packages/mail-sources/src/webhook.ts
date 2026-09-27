import { createHmac, timingSafeEqual } from "node:crypto";

/** Canonical form of the envelope recipient covered by the signature. */
export function canonicalRecipient(to: string): string {
  return to.trim().toLowerCase();
}

/**
 * Verifies a signed inbound-email webhook (see infra/cloudflare-email-worker): `signature` is the hex
 * HMAC-SHA256 of "<timestamp>.<envelope recipient>." + raw body with the shared secret, so a captured
 * delivery cannot be replayed to another user's address. Rejects timestamps more than `toleranceSec`
 * (default 300) away from `now` (unix seconds; defaults to the current time).
 */
export function verifyInboundSignature(p: {
  secret: string;
  timestamp: string;
  signature: string;
  /** The x-aw-envelope-to header (the address the email was delivered to). */
  envelopeTo: string;
  body: Buffer;
  toleranceSec?: number;
  now?: number;
}): boolean {
  if (!p.secret || !/^\d{1,12}$/.test(p.timestamp)) return false;
  const signature = p.signature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(signature)) return false;
  const ts = Number(p.timestamp);
  // Accept `now` in milliseconds too, since Date.now() is the obvious thing to pass.
  const now = p.now == null ? Date.now() / 1000 : p.now > 1e11 ? p.now / 1000 : p.now;
  if (Math.abs(now - ts) > (p.toleranceSec ?? 300)) return false;
  const expected = createHmac("sha256", p.secret).update(`${p.timestamp}.${canonicalRecipient(p.envelopeTo)}.`).update(p.body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}
