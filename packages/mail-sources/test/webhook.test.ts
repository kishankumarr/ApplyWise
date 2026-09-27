import { createHash, createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkcePair, verifyInboundSignature } from "../src";

const secret = "s".repeat(48);
const body = Buffer.from("From: jobalerts-noreply@linkedin.com\r\nSubject: Jobs\r\n\r\nhello");
const now = 1_790_000_000;
const TO = "jobs-abc123def456@in.applywise.test";
const sign = (ts: string, b: Buffer, key = secret, to = TO) => createHmac("sha256", key).update(`${ts}.${to}.`).update(b).digest("hex");

describe("verifyInboundSignature", () => {
  it("accepts a valid signature inside the window", () => {
    const ts = String(now - 30);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sign(ts, body), body, now })).toBe(true);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sign(ts, body).toUpperCase(), body, now })).toBe(true);
    // `now` in milliseconds is accepted too.
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sign(ts, body), body, now: now * 1000 })).toBe(true);
  });

  it("uses the current time by default", () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sign(ts, body), body })).toBe(true);
  });

  it("rejects a tampered body, timestamp or wrong secret", () => {
    const ts = String(now);
    const sig = sign(ts, body);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sig, body: Buffer.concat([body, Buffer.from("!")]), now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: String(now + 1), signature: sig, body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret: "other-secret", timestamp: ts, signature: sig, body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: sign(ts, body, "other-secret"), body, now })).toBe(false);
  });

  it("rejects expired or future timestamps", () => {
    const old = String(now - 301);
    const future = String(now + 301);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: old, signature: sign(old, body), body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: future, signature: sign(future, body), body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: old, signature: sign(old, body), body, now, toleranceSec: 600 })).toBe(true);
  });

  it("rejects malformed input without throwing", () => {
    const ts = String(now);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: "abc", body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: ts, signature: "z".repeat(64), body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: "12.5", signature: sign("12.5", body), body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret, timestamp: "", signature: "", body, now })).toBe(false);
    expect(verifyInboundSignature({ envelopeTo: TO, secret: "", timestamp: ts, signature: sign(ts, body, ""), body, now })).toBe(false);
  });
});

describe("createPkcePair", () => {
  it("creates an S256 pair", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(createPkcePair().verifier).not.toBe(verifier);
  });
});
