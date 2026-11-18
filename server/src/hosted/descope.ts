import { PorticoError } from "../core/errors";
import type { Account } from "../core/types";

/** Says whose account a sign-in token belongs to. Hosted Portico uses Descope; tests pass their own. */
export interface AccountCheck {
  /** The account's ID, or `unauthorized` for a token that doesn't check out. */
  accountFor(token: unknown): Promise<string>;
  /** The account with what else the token says about it. Optional: a check without it names the account only. */
  account?(token: unknown): Promise<Account>;
}

/** The whole account from any check: one that names only the ID has no email or name to give. */
export async function accountFrom(check: AccountCheck, token: unknown): Promise<Account> {
  return check.account ? check.account(token) : { id: await check.accountFor(token), email: null, name: null };
}

export interface DescopeOptions {
  now?: () => Date;
  /** The project's public keys; by default fetched from Descope. */
  fetchKeys?: () => Promise<JsonWebKey[]>;
}

type Jwk = JsonWebKey & { kid?: string };

/** A fresh look at the keys happens at most this often, so unknown key IDs can't make Portico hammer Descope. */
const KEY_REFRESH_MS = 60_000;
/** Keys are fetched again this often, so a key Descope withdrew stops being trusted. */
const KEY_MAX_AGE_MS = 60 * 60_000;
const CLOCK_SKEW_S = 30;
const MAX_TOKEN_CHARS = 8192;
const MAX_ACCOUNT_CHARS = 200;

const refused = () => new PorticoError("unauthorized", "The sign-in didn't check out. Sign in again.");

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Checks a Descope session token: signed by the project's own key (RS256), issued by the project, not expired, and a
 * session token, not a refresh token. Portico checks the token once, when the browser signs in on the base domain,
 * and uses its own cookie from then on. Only the account's ID is read, so Portico holds no Descope secret.
 */
export class Descope implements AccountCheck {
  private readonly now: () => Date;
  private readonly fetchKeys: () => Promise<JsonWebKey[]>;
  private keys = new Map<string, CryptoKey>();
  /** When the keys last arrived, and when Portico last asked: a failed fetch counts as asking. */
  private fetchedAt = 0;
  private askedAt = 0;
  private fetching: Promise<void> | null = null;

  constructor(
    private readonly projectId: string,
    opts: DescopeOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.fetchKeys =
      opts.fetchKeys ??
      (async () => {
        const res = await fetch(`https://api.descope.com/${encodeURIComponent(projectId)}/.well-known/jwks.json`, {
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) throw new Error(`Descope keys answered ${res.status}`);
        const body = (await res.json()) as { keys?: JsonWebKey[] } | JsonWebKey[];
        return Array.isArray(body) ? body : (body.keys ?? []);
      });
  }

  async accountFor(token: unknown): Promise<string> {
    return (await this.account(token)).id;
  }

  /**
   * The account, with the email address and name when the project's token template adds them. An email address counts
   * only when Descope says the address was verified.
   */
  async account(token: unknown): Promise<Account> {
    if (typeof token !== "string" || token.length > MAX_TOKEN_CHARS) throw refused();
    const parts = token.split(".");
    if (parts.length !== 3) throw refused();
    const [head, body, signature] = parts as [string, string, string];
    const header = decodePart(head);
    const claims = decodePart(body);
    if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") throw refused();
    const key = await this.key(header.kid);
    if (!key) throw refused();
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      Buffer.from(signature, "base64url"),
      Buffer.from(`${head}.${body}`),
    );
    if (!valid) throw refused();

    const seconds = this.now().getTime() / 1000;
    const { iss, exp, nbf, sub, drn } = claims;
    if (iss !== this.projectId && iss !== `https://api.descope.com/${this.projectId}`) throw refused();
    if (typeof exp !== "number" || exp <= seconds) throw refused();
    if (typeof nbf === "number" && nbf > seconds + CLOCK_SKEW_S) throw refused();
    // "DS" marks a session token. A refresh token ("DSR") lives for weeks and is never sent to Portico.
    if (drn !== "DS") throw refused();
    if (typeof sub !== "string" || sub === "" || sub.length > MAX_ACCOUNT_CHARS) throw refused();
    const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" && value.length <= 320 ? value.trim() : null);
    // A token template writes the claim as true or as the text "true", under either name.
    const yes = (value: unknown) => value === true || value === "true";
    const verified = yes(claims.email_verified) || yes(claims.verifiedEmail);
    return { id: sub, email: verified ? text(claims.email) : null, name: text(claims.name) };
  }

  /**
   * The key with this ID. An unknown ID means Descope may have changed keys, and old keys may have been withdrawn, so
   * the keys are fetched again: at most once a minute, whether or not the fetch works.
   */
  private async key(kid: string): Promise<CryptoKey | null> {
    const now = this.now().getTime();
    const fresh = this.fetchedAt !== 0 && now - this.fetchedAt < KEY_MAX_AGE_MS;
    const known = this.keys.get(kid);
    if (known && fresh) return known;
    if (this.fetching === null && this.askedAt !== 0 && now - this.askedAt < KEY_REFRESH_MS) return known ?? null;
    this.askedAt = now;
    this.fetching ??= this.load().finally(() => {
      this.fetching = null;
    });
    try {
      await this.fetching;
    } catch (err) {
      // Descope can't be reached. Keys already held keep working; with none, the trouble is the server's to report.
      if (known) return known;
      throw err;
    }
    return this.keys.get(kid) ?? null;
  }

  private async load(): Promise<void> {
    const keys = new Map<string, CryptoKey>();
    for (const jwk of (await this.fetchKeys()) as Jwk[]) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string") continue;
      try {
        // Only what an RSA public key needs: the rest of what Descope sends (use, alg) can't change what the key does.
        const key = await crypto.subtle.importKey(
          "jwk",
          { kty: "RSA", n: jwk.n, e: jwk.e },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        );
        keys.set(jwk.kid, key);
      } catch {
        // A key Portico can't read is skipped; tokens signed with that key are refused.
      }
    }
    this.keys = keys;
    this.fetchedAt = this.now().getTime();
  }
}
