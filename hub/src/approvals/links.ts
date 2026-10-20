import { createHmac, timingSafeEqual } from "node:crypto";

/** Separates link tokens from session tokens, so one can never be used as the other. */
export type TokenPurpose = "link" | "session";

export interface LinkClaims {
  /** What the link decides: a task waiting for approval, or a relayed permission prompt. */
  subject: "task" | "permission";
  /** The task ID, or the permission prompt's request ID. */
  id: string;
  /** The agent that relayed a permission prompt. Absent for tasks. */
  agent?: string;
  action: "approve" | "deny";
  expiresAt: string;
}

function mac(secret: string, purpose: TokenPurpose, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${purpose}:${payload}`).digest();
}

/** Returns `<base64url JSON claims>.<base64url HMAC>`. Claims should include an ISO `expiresAt`. */
export function signToken(secret: string, purpose: TokenPurpose, claims: object): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${mac(secret, purpose, payload).toString("base64url")}`;
}

/** Returns the claims if the token is well formed, signed for this purpose, and not expired; otherwise null. */
export function verifyToken(
  secret: string,
  purpose: TokenPurpose,
  token: string,
  now: Date,
): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const [payload, signature] = parts as [string, string];
  const expected = mac(secret, purpose, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof claims !== "object" || claims === null || Array.isArray(claims)) return null;
  const expiresAt = (claims as { expiresAt?: unknown }).expiresAt;
  if (typeof expiresAt !== "string" || !(Date.parse(expiresAt) > now.getTime())) return null;
  return claims as Record<string, unknown>;
}

export function signLink(secret: string, claims: LinkClaims): string {
  return signToken(secret, "link", claims);
}

export function verifyLink(secret: string, token: string, now: Date): LinkClaims | null {
  const claims = verifyToken(secret, "link", token, now);
  if (!claims) return null;
  const { subject, id, agent, action, expiresAt } = claims;
  if (subject !== "task" && subject !== "permission") return null;
  if (typeof id !== "string" || id === "") return null;
  if (action !== "approve" && action !== "deny") return null;
  if (subject === "permission" && typeof agent !== "string") return null;
  return { subject, id, action, expiresAt: expiresAt as string, ...(typeof agent === "string" ? { agent } : {}) };
}

export function linkUrl(publicUrl: string, token: string, action: "approve" | "deny"): string {
  return `${publicUrl}/${action}/${token}`;
}
