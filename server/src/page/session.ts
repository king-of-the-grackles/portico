import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { PorticoConfig } from "../core/types";

export const SESSION_COOKIE = "portico_session";
export const SESSION_DAYS = 7;
const DAY_MS = 86_400_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Every session token has been signed with this purpose since v1; old approval links used "link". */
const PURPOSE = "session";

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${PURPOSE}:${payload}`).digest();
}

/** `<base64url JSON claims>.<base64url HMAC>`, the same bytes every hub has signed since v1. */
function signSession(secret: string, expiresAt: string): string {
  const payload = Buffer.from(JSON.stringify({ expiresAt })).toString("base64url");
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

/** Well formed, signed for sessions with this secret, and not expired. */
function validSession(secret: string, token: string, now: Date): boolean {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false;
  const [payload, signature] = parts as [string, string];
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { expiresAt?: unknown } | null;
    return typeof claims?.expiresAt === "string" && Date.parse(claims.expiresAt) > now.getTime();
  } catch {
    return false;
  }
}

const NEXT_PATH = /^\/hub(\/[A-Za-z0-9._~%-]+)*\/?(\?[A-Za-z0-9._~%=&+-]*)?$/;

/**
 * The page to return to after sign-in. Only paths under /hub are allowed, so a crafted link can't send anyone
 * elsewhere. Anything else, including dot segments (plain or percent-encoded) and the sign-in page, becomes /hub.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !NEXT_PATH.test(value)) return "/hub";
  const path = value.split("?")[0]!;
  if (path.startsWith("/hub/login")) return "/hub";
  const unsafe = path.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  });
  return unsafe ? "/hub" : value;
}

/** The sign-in page for a signed-out visit, carrying the page to return to. */
export function loginPath(requestUrl: string): string {
  const url = new URL(requestUrl);
  const next = safeNext(url.pathname + url.search);
  return next === "/hub" ? "/hub/login" : `/hub/login?next=${encodeURIComponent(next)}`;
}

/** Constant-time comparison of fixed-length digests. */
export function passwordMatches(config: PorticoConfig, given: string): boolean {
  return timingSafeEqual(sha256(given), sha256(config.adminPassword));
}

/** A signed, stateless session token. Changing PORTICO_SIGNING_SECRET signs everyone out. */
export function newSessionToken(config: PorticoConfig, now: Date): string {
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString();
  return signSession(config.signingSecret, expiresAt);
}

export function hasSession(c: Context, config: PorticoConfig, now: Date): boolean {
  const token = getCookie(c, SESSION_COOKIE);
  return token !== undefined && validSession(config.signingSecret, token, now);
}

/** Ten failed sign-ins in fifteen minutes lock sign-in until the window passes (spec §11). */
export class LoginLimiter {
  private failures: number[] = [];

  constructor(
    private readonly now: () => Date,
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}

  blocked(): boolean {
    const cutoff = this.now().getTime() - this.windowMs;
    this.failures = this.failures.filter((at) => at > cutoff);
    return this.failures.length >= this.max;
  }

  recordFailure(): void {
    this.failures.push(this.now().getTime());
  }
}

/** True when a post carries no Origin header, or the hub's own origin. SameSite=Strict is the first defense. */
export function sameOrigin(c: Context, config: PorticoConfig): boolean {
  const origin = c.req.header("origin");
  return origin === undefined || origin === new URL(config.publicUrl).origin;
}
