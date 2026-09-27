import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type InboundEmail } from "../../../infra/cloudflare-email-worker/worker";
import { parseRawEmail, verifyInboundSignature } from "../src";

/** The Cloudflare relay and the webhook verifier must agree on the signing scheme. */
const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, "fixtures", "naukri-alert.eml"));
const env = { WEBHOOK_URL: "https://applywise.example/api/inbound/email", INBOUND_SECRET: `relay-${"x".repeat(40)}` };

function message(to: string, bytes: Buffer = raw): InboundEmail & { rejected: string[] } {
  const rejected: string[] = [];
  return { from: "bounces@naukri.com", to, rawSize: bytes.length, raw: new Blob([bytes]).stream(), setReject: (r) => void rejected.push(r), rejected };
}

afterEach(() => vi.unstubAllGlobals());

describe("cloudflare email worker", () => {
  it("posts the raw email with a signature verifyInboundSignature accepts", async () => {
    const posted: { url: string; headers: Headers; body: Buffer }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      posted.push({ url, headers: new Headers(init.headers), body: Buffer.from(init.body as Uint8Array) });
      return new Response("{}", { status: 200 });
    });
    const m = message("jobs-7kq2abcd9x@in.applywise.example");
    await worker.email(m, env);
    expect(m.rejected).toEqual([]);
    const p = posted[0]!;
    expect(p.url).toBe(env.WEBHOOK_URL);
    expect(p.body.equals(raw)).toBe(true);
    expect(p.headers.get("content-type")).toBe("message/rfc822");
    expect(p.headers.get("x-aw-envelope-to")).toBe("jobs-7kq2abcd9x@in.applywise.example");
    expect(p.headers.get("x-aw-envelope-from")).toBe("bounces@naukri.com");
    const signed = { timestamp: p.headers.get("x-aw-timestamp") ?? "", signature: p.headers.get("x-aw-signature") ?? "", envelopeTo: p.headers.get("x-aw-envelope-to") ?? "", body: p.body };
    expect(verifyInboundSignature({ secret: env.INBOUND_SECRET, ...signed })).toBe(true);
    expect(verifyInboundSignature({ secret: "another-secret-value-000000", ...signed })).toBe(false);
    // The signature is bound to the recipient: it cannot be replayed to another user's address.
    expect(verifyInboundSignature({ secret: env.INBOUND_SECRET, ...signed, envelopeTo: "jobs-otheruser0001@in.applywise.example" })).toBe(false);
    expect((await parseRawEmail(p.body)).from).toBe("jobalerts@naukri.com");
  });

  it("rejects unknown recipients and oversized mail, and throws on non-2xx so Cloudflare does not accept it", async () => {
    const fetchMock = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const spam = message("postmaster@in.applywise.example");
    await worker.email(spam, env);
    expect(spam.rejected).toEqual(["Unknown address"]);
    const big = message("jobs-7kq2abcd9x@in.applywise.example", Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    await worker.email(big, env);
    expect(big.rejected).toEqual(["Message too large"]);
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(worker.email(message("jobs-7kq2abcd9x@in.applywise.example"), env)).rejects.toThrow("ApplyWise webhook responded 503");
  });

  it("never follows a redirect with the signed email, and refuses a non-https webhook", async () => {
    const inits: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      inits.push(init);
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.example/" } });
    });
    await expect(worker.email(message("jobs-7kq2abcd9x@in.applywise.example"), env)).rejects.toThrow("ApplyWise webhook responded 307");
    expect(inits[0]?.redirect).toBe("manual");

    await expect(worker.email(message("jobs-7kq2abcd9x@in.applywise.example"), { ...env, WEBHOOK_URL: "http://applywise.example/api/inbound/email" })).rejects.toThrow(/https/);
    expect(inits).toHaveLength(1);
  });
});
