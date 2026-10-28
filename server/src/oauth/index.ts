import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { jsonBodyLimit } from "../agent-api/limits";
import { handleError, readJson } from "../agent-api/rest";
import { sameOrigin } from "../api";
import { type PersonEnv, currentPerson, loadPerson } from "../api/context";
import { clientIp } from "../client-ip";
import { WindowLimiter } from "../computer-api/limiter";
import type { Core } from "../core/core";
import { PorticoError } from "../core/errors";
import { HOUR_MS, LIMITS } from "../core/limits";
import type { AgentKind } from "../core/types";
import { slugify } from "../core/words";
import { log } from "../log";
import { notSetUpPage } from "../web/layout";
import { type AuthorizeRequest, badRequestPage, CONNECTOR_CHOICES, consentPage, waitingPage } from "./consent";
import { OAuthProblem, type OAuthClient, OAuthStore, validChallenge } from "./store";

/** Registrations are open to anyone, so they're capped: at most this many an hour. */
const REGISTRATIONS_PER_HOUR = 100;
const MAX_STATE = 1000;

type Fields = Record<string, unknown>;

function text(fields: Fields, key: string): string | undefined {
  const value = fields[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** Percent-encodes everything but letters, digits and `-._~`, so a return path passes safeNext unchanged. */
function encodeStrict(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** The authorize request as a path to come back to after sign-in, with its query re-encoded strictly. */
export function authorizeReturnPath(requestUrl: string): string {
  const pairs = [...new URL(requestUrl).searchParams].map(([key, value]) => `${encodeStrict(key)}=${encodeStrict(value)}`);
  return pairs.length > 0 ? `/oauth/authorize?${pairs.join("&")}` : "/oauth/authorize";
}

/** The client's redirect URI with the answer added to its query. */
function redirectWith(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  return url.href;
}

/** Dots run in ChatGPT; Claude Duet names itself. Anything else is Other until the person says otherwise. */
export function guessKind(clientName: string): AgentKind {
  if (/\b(dots|chatgpt|openai)\b/i.test(clientName)) return "dots";
  if (/\bduet\b/i.test(clientName)) return "claude-duet";
  return "other";
}

export interface OAuthRoutesOptions {
  store?: OAuthStore;
}

/**
 * Connector sign-in with OAuth 2.1, mounted at the root: protected-resource metadata (RFC 9728), authorization server
 * metadata (RFC 8414), dynamic client registration (RFC 7591), the consent page at /oauth/authorize, and /oauth/token
 * for authorization codes with PKCE S256 and rotating refresh tokens. Middleware here is per path: this router sees
 * every request.
 */
export function oauthRoutes(core: Core, opts: OAuthRoutesOptions = {}): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const store = opts.store ?? new OAuthStore({ db: core.db, agents: core.agents, now: core.now, newId: core.newId });
  const registrations = new WindowLimiter(core.now, REGISTRATIONS_PER_HOUR, HOUR_MS);
  const base = () => core.settings.publicUrl();

  // Discovery, registration and tokens carry no cookies, so browser-based MCP clients may call them from anywhere.
  const openCors = cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["authorization", "content-type", "mcp-protocol-version"],
    maxAge: 600,
  });
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/token",
  ]) {
    route.use(path, openCors);
  }

  const resourceMetadata = (c: Context) =>
    c.json({
      resource: `${base()}/mcp`,
      authorization_servers: [base()],
      bearer_methods_supported: ["header"],
      resource_name: "Portico",
    });
  route.get("/.well-known/oauth-protected-resource", resourceMetadata);
  route.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);

  route.get("/.well-known/oauth-authorization-server", (c) =>
    c.json({
      issuer: base(),
      authorization_endpoint: `${base()}/oauth/authorize`,
      token_endpoint: `${base()}/oauth/token`,
      registration_endpoint: `${base()}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    }),
  );

  // RFC 7591. Clients are public: whatever authentication a client asks for, Portico answers "none" and relies on PKCE.
  route.post("/oauth/register", jsonBodyLimit(), async (c) => {
    if (!core.settings.setupDone()) throw setupRequired();
    const address = clientIp(c);
    if (registrations.blocked(address)) throw new OAuthProblem("temporarily_unavailable", "Too many client registrations. Try again later.", 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new OAuthProblem("invalid_client_metadata", "The registration must be a JSON object.");
    }
    if (typeof body !== "object" || body === null) throw new OAuthProblem("invalid_client_metadata", "The registration must be a JSON object.");
    const client = store.register(body as Fields);
    registrations.record(address);
    return c.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(Date.parse(client.createdAt) / 1000),
        client_name: client.name,
        redirect_uris: client.redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201,
      { "Cache-Control": "no-store" },
    );
  });

  /** The client and redirect URI, checked before anything is sent back to the client: a mismatch never redirects. */
  const checkClient = (fields: Fields): { client: OAuthClient; redirectUri: string } | { problem: string } => {
    const client = store.client(text(fields, "client_id"));
    if (!client) return { problem: "The app sent a client ID Portico doesn't know." };
    const asked = text(fields, "redirect_uri");
    const redirectUri = asked ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
      return { problem: "The app sent a redirect address that doesn't match the one registered." };
    }
    return { client, redirectUri };
  };

  /**
   * The rest of the request. A problem here shows on a page rather than redirecting back to the client: anyone can
   * register a redirect URI, so an automatic error redirect would make Portico an open redirector (RFC 9700 §4.11).
   */
  const checkRequest = (fields: Fields): { request: Omit<AuthorizeRequest, "clientId" | "redirectUri"> } | { problem: string } => {
    if (fields.response_type !== undefined && fields.response_type !== "code") {
      return { problem: "The app asked for a response type other than code." };
    }
    const challenge = fields.code_challenge;
    if (!validChallenge(challenge)) return { problem: "The app sent no PKCE code challenge." };
    if (fields.code_challenge_method !== "S256") return { problem: "The app asked for a PKCE method other than S256." };
    const state = text(fields, "state") ?? null;
    if (state !== null && state.length > MAX_STATE) return { problem: "The app sent a state value that is too long." };
    const resource = text(fields, "resource") ?? null;
    if (resource !== null && !sameResourceOrigin(resource, base())) {
      return { problem: `The app asked for a resource other than ${base()}/mcp.` };
    }
    return { request: { state, challenge, resource } };
  };

  route.get("/oauth/authorize", loadPerson(core.accounts), async (c) => {
    if (!core.settings.setupDone()) return notSetUpPage(c);
    const fields = c.req.query() as Fields;
    if (fields.response_type === undefined) fields.response_type = "code";
    const checked = checkClient(fields);
    if ("problem" in checked) return badRequestPage(c, checked.problem);
    const { client, redirectUri } = checked;
    const state = text(fields, "state");
    const rest = checkRequest(fields);
    if ("problem" in rest) return badRequestPage(c, rest.problem);
    const person = c.get("person");
    if (!person) return c.redirect(`/sign-in?next=${encodeURIComponent(authorizeReturnPath(c.req.url))}`, 303);
    if (person.status !== "active") return waitingPage(c);
    const kind = guessKind(client.name);
    return consentPage(c, {
      person,
      client,
      request: { clientId: client.clientId, redirectUri, ...rest.request },
      name: freeAgentName(core, defaultName(kind, client.name)),
      kind,
      requestedAt: core.now(),
      cancelUrl: redirectWith(redirectUri, { error: "access_denied", state }),
    });
  });

  // The consent form: from the page's own script as JSON (answered with `next`), or as a plain form post (redirected).
  route.post("/oauth/authorize", loadPerson(core.accounts), jsonBodyLimit(), async (c) => {
    if (!core.settings.setupDone()) throw setupRequired();
    if (!sameOrigin(c, base())) throw new PorticoError("not_allowed", "Requests from other sites aren't accepted.");
    const person = currentPerson(c);
    const json = (c.req.header("content-type") ?? "").includes("application/json");
    const fields = (json ? await readJson(c) : await c.req.parseBody()) as Fields | null;
    if (!fields || typeof fields !== "object") throw new PorticoError("bad_request", "The form is empty.");
    const checked = checkClient(fields);
    if ("problem" in checked) throw new PorticoError("bad_request", checked.problem);
    const rest = checkRequest(fields);
    if ("problem" in rest) throw new PorticoError("bad_request", rest.problem);
    const kind = CONNECTOR_CHOICES.find((choice) => choice.kind === fields.kind)?.kind;
    if (!kind) throw new PorticoError("bad_request", "Pick Dots, Claude Duet or Other.");
    const { client, redirectUri } = checked;
    const { agent, code } = core.db.transaction(() => {
      const agent = core.agents.create({ ownerId: person.id, name: fields.name, kind, type: "connector" });
      const code = store.issueCode({ clientId: client.clientId, agentId: agent.id, redirectUri, challenge: rest.request.challenge });
      return { agent, code };
    })();
    log("info", "connector_authorized", { agent_id: agent.id, client_id: client.clientId });
    const next = redirectWith(redirectUri, { code, state: rest.request.state });
    return json ? c.json({ next }) : c.redirect(next, 303);
  });

  route.post("/oauth/token", jsonBodyLimit(), async (c) => {
    const json = (c.req.header("content-type") ?? "").includes("application/json");
    let fields: Fields;
    try {
      fields = (json ? await c.req.json() : await c.req.parseBody()) as Fields;
    } catch {
      throw new OAuthProblem("invalid_request", "The token request must be form-encoded.");
    }
    const clientId = text(fields, "client_id") ?? basicClientId(c.req.header("authorization"));
    const grant = fields.grant_type;
    const tokens =
      grant === "authorization_code"
        ? store.exchangeCode({
            code: fields.code,
            clientId,
            redirectUri: text(fields, "redirect_uri"),
            verifier: fields.code_verifier,
          })
        : grant === "refresh_token"
          ? store.refresh({ refreshToken: fields.refresh_token, clientId })
          : null;
    if (!tokens) throw new OAuthProblem("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
    return c.json(tokens, 200, { "Cache-Control": "no-store", Pragma: "no-cache" });
  });

  route.onError((err, c) => {
    if (err instanceof OAuthProblem) {
      return c.json({ error: err.error, error_description: err.description, message: err.description }, err.status, {
        "Cache-Control": "no-store",
      });
    }
    return handleError(err, c);
  });
  return route;
}

function setupRequired(): PorticoError {
  return new PorticoError("setup_required", "Portico isn't set up yet. Run portico setup on the host for a setup link.");
}

/** The client ID from HTTP Basic client authentication, when a client sends one. Its secret is ignored. */
function basicClientId(authorization: string | undefined): string | undefined {
  const match = /^Basic\s+(\S+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return undefined;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  let id: string;
  try {
    id = decodeURIComponent(colon < 0 ? decoded : decoded.slice(0, colon));
  } catch {
    throw new OAuthProblem("invalid_client", "The client credentials can't be read.", 401);
  }
  return id || undefined;
}

function sameResourceOrigin(resource: string, publicUrl: string): boolean {
  try {
    return new URL(resource).origin === new URL(publicUrl).origin;
  } catch {
    return false;
  }
}

/** The name the consent page suggests: the kind's own name, or the client's name as a slug. */
function defaultName(kind: AgentKind, clientName: string): string {
  if (kind === "dots") return "dots";
  if (kind === "claude-duet") return "claude-duet";
  return slugify(clientName, "connector");
}

/** The first free form of a name: `<base>`, `<base>-2`, … */
function freeAgentName(core: Core, wanted: string): string {
  if (!core.agents.byAddress(wanted)) return wanted;
  const base = wanted.slice(0, LIMITS.maxNameChars - 3).replace(/-+$/, "") || "connector";
  if (!core.agents.byAddress(base)) return base;
  for (let n = 2; n < 100; n++) if (!core.agents.byAddress(`${base}-${n}`)) return `${base}-${n}`;
  return base;
}
