import { createHash, randomBytes } from "node:crypto";

/** PKCE pair (RFC 7636, S256): the verifier stays server-side, the challenge goes in the auth URL. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/** Space-delimited OAuth scope string contains `scope` (case-insensitive). */
export function hasScope(granted: string, scope: string): boolean {
  const want = scope.toLowerCase();
  return granted
    .split(/\s+/)
    .map((s) => s.toLowerCase())
    .includes(want);
}

/**
 * Claims of an id_token received directly from the token endpoint over TLS (OIDC Core 3.1.3.7 allows
 * skipping signature checks in that case). Returns {} for anything malformed.
 */
export function decodeJwtClaims(token: string | null): Record<string, unknown> {
  const payload = token?.split(".")[1];
  if (!payload) return {};
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return claims && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
