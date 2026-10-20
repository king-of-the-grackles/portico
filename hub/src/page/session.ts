import { createHash, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { signToken, verifyToken } from "../approvals/links";
import type { BridgeConfig } from "../core/types";

export const SESSION_COOKIE = "bridge_session";
export const SESSION_DAYS = 7;
const DAY_MS = 86_400_000;

const sha256 = (value: string) => createHash("sha256").update(value).digest();

/** Constant-time comparison of fixed-length digests. */
export function passwordMatches(config: BridgeConfig, given: string): boolean {
  return timingSafeEqual(sha256(given), sha256(config.adminPassword));
}

/** A signed, stateless session token. Changing BRIDGE_SIGNING_SECRET signs everyone out. */
export function newSessionToken(config: BridgeConfig, now: Date): string {
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * DAY_MS).toISOString();
  return signToken(config.signingSecret, "session", { expiresAt });
}

export function hasSession(c: Context, config: BridgeConfig, now: Date): boolean {
  const token = getCookie(c, SESSION_COOKIE);
  return token !== undefined && verifyToken(config.signingSecret, "session", token, now) !== null;
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
export function sameOrigin(c: Context, config: BridgeConfig): boolean {
  const origin = c.req.header("origin");
  return origin === undefined || origin === new URL(config.publicUrl).origin;
}
