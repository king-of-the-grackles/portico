import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import type { Agents } from "../core/agents";
import { defang } from "../core/framing";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../core/limits";
import { hashSecret, sameSecret } from "../core/tokens";
import type { Agent } from "../core/types";
import { log } from "../log";

/** Access tokens last an hour; refresh tokens 90 days, and each refresh replaces both. */
export const ACCESS_TOKEN_MS = HOUR_MS;
export const REFRESH_TOKEN_MS = 90 * DAY_MS;
export const CODE_MS = 10 * MINUTE_MS;

const MAX_REDIRECT_URIS = 10;
const MAX_URI_CHARS = 2000;
const MAX_CLIENT_NAME = 60;
/** Schemes a redirect URI may never use. Private-use schemes of native apps (e.g. `cursor://`) are allowed. */
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "about:", "blob:", "filesystem:"]);
/** RFC 7636: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** An S256 challenge: a SHA-256 digest, base64url without padding. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/** An OAuth error, answered as `{ error, error_description }` (RFC 6749 §5.2). */
export class OAuthProblem extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status: 400 | 401 | 429 | 503 = 400,
  ) {
    super(description);
    this.name = "OAuthProblem";
  }
}

export interface OAuthClient {
  clientId: string;
  name: string;
  redirectUris: string[];
  createdAt: string;
}

interface ClientRow {
  client_id: string;
  name: string;
  redirect_uris: string;
  created_at: string;
}

export interface TokenSet {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
}

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** A redirect URI a client may register: absolute, no fragment, https (http only on loopback) or a private-use scheme. */
export function checkRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URI_CHARS) {
    throw new OAuthProblem("invalid_redirect_uri", "Each redirect URI must be a string of at most 2000 characters.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthProblem("invalid_redirect_uri", "Each redirect URI must be an absolute URL.");
  }
  if (url.hash || value.includes("#")) throw new OAuthProblem("invalid_redirect_uri", "A redirect URI can't have a fragment.");
  if (FORBIDDEN_SCHEMES.has(url.protocol)) {
    throw new OAuthProblem("invalid_redirect_uri", `A redirect URI can't use the ${url.protocol} scheme.`);
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    throw new OAuthProblem("invalid_redirect_uri", "A redirect URI must use https, or http on localhost.");
  }
  return value;
}

/** A client's name for the consent page: one line, at most 60 characters. */
function clientName(value: unknown): string {
  const cleaned = typeof value === "string" ? defang(value).replace(/\s+/g, " ").trim() : "";
  const chars = Array.from(cleaned);
  return (chars.length > MAX_CLIENT_NAME ? `${chars.slice(0, MAX_CLIENT_NAME - 1).join("")}…` : cleaned) || "An MCP client";
}

/** The S256 challenge for a verifier. */
export function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function validChallenge(value: unknown): value is string {
  return typeof value === "string" && CHALLENGE.test(value);
}

export interface OAuthStoreDeps {
  db: Database;
  agents: Agents;
  now: () => Date;
  newId: () => string;
}

/**
 * Connector sign-in with OAuth: registered clients (RFC 7591), one-time authorization codes bound to a client, a
 * redirect URI and a PKCE challenge, and the access and refresh tokens the agents module stores. Clients are public:
 * PKCE, not a client secret, proves the code's owner.
 */
export class OAuthStore {
  constructor(private readonly deps: OAuthStoreDeps) {}

  register(input: { redirect_uris?: unknown; client_name?: unknown }): OAuthClient {
    const uris = input.redirect_uris;
    if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS) {
      throw new OAuthProblem("invalid_redirect_uri", "redirect_uris must list 1 to 10 redirect URIs.");
    }
    const client: OAuthClient = {
      clientId: randomBytes(16).toString("base64url"),
      name: clientName(input.client_name),
      redirectUris: [...new Set(uris.map(checkRedirectUri))],
      createdAt: this.iso(),
    };
    this.deps.db
      .query(
        `INSERT INTO oauth_clients (id, client_id, name, redirect_uris, created_at)
         VALUES ($id, $clientId, $name, $uris, $createdAt)`,
      )
      .run({
        id: this.deps.newId(),
        clientId: client.clientId,
        name: client.name,
        uris: JSON.stringify(client.redirectUris),
        createdAt: client.createdAt,
      });
    log("info", "oauth_client_registered", { client_id: client.clientId });
    return client;
  }

  client(clientId: unknown): OAuthClient | null {
    if (typeof clientId !== "string" || clientId === "") return null;
    const row = this.deps.db.query("SELECT * FROM oauth_clients WHERE client_id = $clientId").get({ clientId }) as ClientRow | null;
    if (!row) return null;
    return { clientId: row.client_id, name: row.name, redirectUris: JSON.parse(row.redirect_uris) as string[], createdAt: row.created_at };
  }

  /** A one-time code for the agent, returned only here. Exchanged within 10 minutes, with the matching verifier. */
  issueCode(input: { clientId: string; agentId: string; redirectUri: string; challenge: string }): string {
    const code = randomBytes(32).toString("base64url");
    const at = this.deps.now();
    this.deps.db
      .query(
        `INSERT INTO oauth_codes (id, code_hash, client_id, agent_id, redirect_uri, challenge, created_at, expires_at)
         VALUES ($id, $hash, $clientId, $agentId, $redirectUri, $challenge, $createdAt, $expiresAt)`,
      )
      .run({
        id: this.deps.newId(),
        hash: hashSecret(code),
        clientId: input.clientId,
        agentId: input.agentId,
        redirectUri: input.redirectUri,
        challenge: input.challenge,
        createdAt: at.toISOString(),
        expiresAt: new Date(at.getTime() + CODE_MS).toISOString(),
      });
    return code;
  }

  /**
   * Exchanges a code for tokens. The code works once, for its client, its redirect URI and the verifier of its
   * challenge. A second use revokes the tokens the first one got (RFC 6749 §4.1.2).
   */
  exchangeCode(input: { code: unknown; clientId: unknown; redirectUri: unknown; verifier: unknown }): TokenSet {
    const { db } = this.deps;
    if (typeof input.code !== "string" || input.code === "") throw new OAuthProblem("invalid_request", "code is required.");
    if (typeof input.clientId !== "string" || input.clientId === "") {
      throw new OAuthProblem("invalid_client", "client_id is required.", 401);
    }
    if (typeof input.verifier !== "string" || !VERIFIER.test(input.verifier)) {
      throw new OAuthProblem("invalid_request", "code_verifier must be 43 to 128 unreserved characters.");
    }
    if (!this.client(input.clientId)) throw new OAuthProblem("invalid_client", "Unknown client_id.", 401);
    const verifier = input.verifier;
    const outcome = db.transaction((): TokenSet | OAuthProblem => {
      const row = db.query("SELECT * FROM oauth_codes WHERE code_hash = $hash").get({ hash: hashSecret(input.code as string) }) as {
        id: string;
        client_id: string;
        agent_id: string;
        redirect_uri: string;
        challenge: string;
        expires_at: string;
        used_at: string | null;
      } | null;
      if (!row || row.client_id !== input.clientId) throw new OAuthProblem("invalid_grant", "The code isn't valid for this client.");
      if (row.used_at) {
        // Returned, not thrown, so the revocation commits.
        this.revokeClientTokens(row.agent_id, row.client_id);
        log("warn", "oauth_code_reused", { agent_id: row.agent_id, client_id: row.client_id });
        return new OAuthProblem("invalid_grant", "The code was already used.");
      }
      if (Date.parse(row.expires_at) <= this.deps.now().getTime()) throw new OAuthProblem("invalid_grant", "The code expired.");
      if (input.redirectUri !== undefined && input.redirectUri !== row.redirect_uri) {
        throw new OAuthProblem("invalid_grant", "redirect_uri doesn't match the authorization request.");
      }
      if (!sameSecret(s256(verifier), row.challenge)) throw new OAuthProblem("invalid_grant", "code_verifier doesn't match.");
      db.query("UPDATE oauth_codes SET used_at = $at WHERE id = $id").run({ id: row.id, at: this.iso() });
      const agent = this.deps.agents.get(row.agent_id);
      if (!agent) throw new OAuthProblem("invalid_grant", "The agent was removed.");
      log("info", "oauth_tokens_issued", { agent_id: agent.id, client_id: row.client_id, grant: "authorization_code" });
      return this.tokensFor(agent, row.client_id);
    })();
    if (outcome instanceof OAuthProblem) throw outcome;
    return outcome;
  }

  /** Swaps a refresh token for a new access token and a new refresh token. The old refresh token stops working. */
  refresh(input: { refreshToken: unknown; clientId: unknown }): TokenSet {
    const { db } = this.deps;
    if (typeof input.refreshToken !== "string" || input.refreshToken === "") {
      throw new OAuthProblem("invalid_request", "refresh_token is required.");
    }
    const refreshToken = input.refreshToken;
    return db.transaction(() => {
      const row = db
        .query("SELECT agent_id, client_id, expires_at FROM agent_tokens WHERE token_hash = $hash AND kind = 'refresh'")
        .get({ hash: hashSecret(refreshToken) }) as { agent_id: string; client_id: string | null; expires_at: string | null } | null;
      if (!row || (row.expires_at !== null && Date.parse(row.expires_at) <= this.deps.now().getTime())) {
        throw new OAuthProblem("invalid_grant", "The refresh token isn't valid.");
      }
      if (input.clientId !== undefined && input.clientId !== row.client_id) {
        throw new OAuthProblem("invalid_grant", "The refresh token belongs to another client.");
      }
      const agent = this.deps.agents.get(row.agent_id);
      if (!agent || !row.client_id) throw new OAuthProblem("invalid_grant", "The refresh token isn't valid.");
      this.deps.agents.revokeToken(refreshToken);
      log("info", "oauth_tokens_issued", { agent_id: agent.id, client_id: row.client_id, grant: "refresh_token" });
      return this.tokensFor(agent, row.client_id);
    })();
  }

  private tokensFor(agent: Agent, clientId: string): TokenSet {
    const at = this.deps.now().getTime();
    const access = this.deps.agents.issueToken(agent.id, "access", {
      clientId,
      expiresAt: new Date(at + ACCESS_TOKEN_MS).toISOString(),
    });
    const refresh = this.deps.agents.issueToken(agent.id, "refresh", {
      clientId,
      expiresAt: new Date(at + REFRESH_TOKEN_MS).toISOString(),
    });
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_MS / 1000, refresh_token: refresh };
  }

  private revokeClientTokens(agentId: string, clientId: string): void {
    this.deps.db.query("DELETE FROM agent_tokens WHERE agent_id = $agentId AND client_id = $clientId").run({ agentId, clientId });
  }

  private iso(): string {
    return this.deps.now().toISOString();
  }
}
