import "server-only";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { env } from "@/env";

/** AES-256-GCM encryption for PII at rest (resume files, extracted text). Format: v1:<iv>:<tag>:<ciphertext> (base64). */
function key(): Buffer {
  return Buffer.from(env().ENCRYPTION_KEY, "base64");
}

export function encryptBuffer(plain: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from("AWE1"), iv, tag, enc]);
}

export function decryptBuffer(payload: Buffer): Buffer {
  if (payload.subarray(0, 4).toString() !== "AWE1") throw new Error("Unknown encryption format");
  const iv = payload.subarray(4, 16);
  const tag = payload.subarray(16, 32);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(32)), decipher.final()]);
}

export function encryptText(plain: string): string {
  return `v1:${encryptBuffer(Buffer.from(plain, "utf8")).toString("base64")}`;
}

export function decryptText(value: string): string {
  if (!value.startsWith("v1:")) throw new Error("Unknown encrypted text format");
  return decryptBuffer(Buffer.from(value.slice(3), "base64")).toString("utf8");
}

export function sha256Hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Compact signed token: base64url(JSON).base64url(HMAC). Purpose-bound to prevent token reuse across features. */
export function signToken<T extends object>(purpose: string, payload: T, ttlMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + ttlMs, purpose })).toString("base64url");
  const sig = createHmac("sha256", env().SIGNING_SECRET).update(`${purpose}.${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken<T extends object>(purpose: string, token: string): T & { exp: number } {
  const [body, sig] = token.split(".");
  if (!body || !sig) throw new Error("Malformed token");
  const expected = createHmac("sha256", env().SIGNING_SECRET).update(`${purpose}.${body}`).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error("Invalid token signature");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T & { exp: number; purpose: string };
  if (payload.purpose !== purpose) throw new Error("Token purpose mismatch");
  if (payload.exp < Date.now()) throw new Error("Token expired");
  return payload;
}

/** One-way hash for identifiers kept after deletion (e.g. anonymised audit entries). */
export function anonymize(id: string): string {
  return createHmac("sha256", env().SIGNING_SECRET).update(`anon.${id}`).digest("hex").slice(0, 24);
}
