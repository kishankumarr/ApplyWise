import { describe, expect, it } from "vitest";
import { Errors } from "@/server/errors";
import { redact, redactString } from "@/server/logger";
import { checkRateLimit, resetRateLimits } from "@/server/rate-limit";
import { assertOwned, jobVisibleTo } from "@/server/repositories/ownership";
import { decryptBuffer, decryptText, encryptBuffer, encryptText, signToken, verifyToken } from "@/server/crypto";
import { StubScanner } from "@/server/malware";

describe("permission checks", () => {
  it("assertOwned returns owned records and 404s others", () => {
    expect(assertOwned({ userId: "u1", x: 1 }, "u1")).toEqual({ userId: "u1", x: 1 });
    expect(() => assertOwned({ userId: "u2" }, "u1")).toThrow(/not found/);
    expect(() => assertOwned(null, "u1")).toThrow(/not found/);
    try {
      assertOwned({ userId: "u2" }, "u1", "Application");
    } catch (e) {
      expect((e as { status: number }).status).toBe(404);
    }
  });

  it("jobs are visible only if shared or owned", () => {
    expect(jobVisibleTo("u1")).toEqual({ OR: [{ ownerUserId: null }, { ownerUserId: "u1" }] });
  });

  it("error helpers carry safe status codes", () => {
    expect(Errors.unauthenticated().status).toBe(401);
    expect(Errors.consentRequired("x").code).toBe("CONSENT_REQUIRED");
    expect(Errors.rateLimited(3).status).toBe(429);
  });
});

describe("rate limiting", () => {
  it("blocks after the limit within a window and resets after it", () => {
    resetRateLimits();
    const rule = { name: "t", limit: 3, windowMs: 1000 };
    const now = 1_000_000;
    expect(checkRateLimit(rule, "k", now).allowed).toBe(true);
    expect(checkRateLimit(rule, "k", now).allowed).toBe(true);
    expect(checkRateLimit(rule, "k", now).allowed).toBe(true);
    const blocked = checkRateLimit(rule, "k", now);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(1);
    expect(checkRateLimit(rule, "other", now).allowed).toBe(true);
    expect(checkRateLimit(rule, "k", now + 1001).allowed).toBe(true);
  });
});

describe("PII-safe logging", () => {
  it("redacts sensitive keys and scrubs emails, phones and tokens", () => {
    const out = redact({
      requestId: "3f1b2f5e-8a8e-4d7b-9d4b-1a2b3c4d5e6f",
      email: "a@b.com",
      body: "full email body",
      extractedText: "resume text",
      note: "contact me at priya@example.test or +91 98765 43210",
      auth: "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      nested: { password: "x", count: 3 },
    }) as Record<string, unknown>;
    expect(out.requestId).toBe("3f1b2f5e-8a8e-4d7b-9d4b-1a2b3c4d5e6f");
    expect(out.email).toBe("[REDACTED]");
    expect(out.body).toBe("[REDACTED]");
    expect(out.extractedText).toBe("[REDACTED]");
    expect(out.note).not.toMatch(/priya@|98765/);
    expect(out.auth).not.toMatch(/abcdefghij/);
    expect(out.nested).toEqual({ password: "[REDACTED]", count: 3 });
    expect(redactString("x".repeat(1000)).length).toBeLessThan(320);
  });
});

describe("encryption and signed tokens", () => {
  it("round-trips encrypted buffers and text, and detects tampering", () => {
    const enc = encryptBuffer(Buffer.from("secret resume"));
    expect(enc.includes(Buffer.from("secret resume"))).toBe(false);
    expect(decryptBuffer(enc).toString()).toBe("secret resume");
    expect(decryptText(encryptText("héllo"))).toBe("héllo");
    enc[enc.length - 1] = enc[enc.length - 1]! ^ 0xff;
    expect(() => decryptBuffer(enc)).toThrow();
  });

  it("verifies purpose-bound expiring tokens", () => {
    const t = signToken("prefill", { applicationId: "a1" }, 60_000);
    expect(verifyToken<{ applicationId: string }>("prefill", t).applicationId).toBe("a1");
    expect(() => verifyToken("other-purpose", t)).toThrow();
    expect(() => verifyToken("prefill", `${t}x`)).toThrow();
    const expired = signToken("prefill", { applicationId: "a1" }, -1);
    expect(() => verifyToken("prefill", expired)).toThrow(/expired/);
  });
});

describe("upload malware stub", () => {
  it("flags PDFs with active content", async () => {
    const s = new StubScanner();
    expect((await s.scan(Buffer.from("%PDF-1.7 /JavaScript (app.alert)"))).clean).toBe(false);
    expect((await s.scan(Buffer.from("%PDF-1.7 plain"))).clean).toBe(true);
  });
});
