import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { type OAuthClientProvider, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { authorizeReturnPath, guessKind } from "../src/oauth";
import { s256 } from "../src/oauth/store";
import { safeNext } from "../src/web/layout";
import {
  addAppAgent,
  addMember,
  addOwner,
  copyProblems,
  DAY,
  HOUR,
  makePortico,
  MINUTE,
  PUBLIC_URL,
  signIn,
  visibleCopy,
} from "./helpers";

type P = ReturnType<typeof makePortico>;
const REDIRECT = "http://localhost:4567/callback";
const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: s256(verifier) };
}

async function register(p: P, body: unknown) {
  return p.app.request(`${PUBLIC_URL}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function client(p: P, name = "Claude Duet", redirectUris = [REDIRECT]) {
  const res = await register(p, { client_name: name, redirect_uris: redirectUris, token_endpoint_auth_method: "none" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
}

function authorizeQuery(clientId: string, challenge: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "state-123",
    resource: `${PUBLIC_URL}/mcp`,
    ...extra,
  }).toString();
}

function getAuthorize(p: P, query: string, cookie?: string) {
  return p.app.request(`${PUBLIC_URL}/oauth/authorize?${query}`, { headers: cookie ? { cookie } : {} });
}

/** The consent form's POST as its script sends it: JSON, the cookie and Portico's own Origin. */
function postConsent(p: P, cookie: string | null, fields: Record<string, unknown>, origin = PUBLIC_URL) {
  const headers: Record<string, string> = { "content-type": "application/json", origin, host: "portico.example.com" };
  if (cookie) headers.cookie = cookie;
  return p.app.request(`${PUBLIC_URL}/oauth/authorize`, { method: "POST", headers, body: JSON.stringify(fields) });
}

function consentFields(clientId: string, challenge: string, extra: Record<string, unknown> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: "state-123",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${PUBLIC_URL}/mcp`,
    name: "duet",
    kind: "claude-duet",
    ...extra,
  };
}

function token(p: P, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return p.app.request(`${PUBLIC_URL}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function mcpTools(p: P, accessToken: string): Promise<Response> {
  return p.app.request(`${PUBLIC_URL}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

interface Tokens {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

/** Signed in, a registered client, consent given: a code ready to exchange. */
async function authorized(opts: { name?: string } = {}) {
  const p = makePortico();
  const chris = await addOwner(p);
  const cookie = signIn(p, chris);
  const clientId = await client(p, opts.name);
  const { verifier, challenge } = pkce();
  const { next } = await json<{ next: string }>(postConsent(p, cookie, consentFields(clientId, challenge)));
  const code = new URL(next).searchParams.get("code")!;
  return { p, chris, cookie, clientId, verifier, challenge, code, next };
}

function exchange(p: P, clientId: string, code: string, verifier: string) {
  return token(p, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: REDIRECT });
}

describe("metadata", () => {
  test("protected resource and authorization server metadata point at Portico's public URL", async () => {
    const p = makePortico();
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await p.app.request(path);
      expect(await res.json()).toMatchObject({ resource: `${PUBLIC_URL}/mcp`, authorization_servers: [PUBLIC_URL] });
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    }
    expect(await json(p.app.request("/.well-known/oauth-authorization-server"))).toEqual({
      issuer: PUBLIC_URL,
      authorization_endpoint: `${PUBLIC_URL}/oauth/authorize`,
      token_endpoint: `${PUBLIC_URL}/oauth/token`,
      registration_endpoint: `${PUBLIC_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  test("/mcp without a token points the client at the metadata", async () => {
    const p = makePortico();
    const res = await p.app.request(`${PUBLIC_URL}/mcp`, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(
      `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
    );
  });
});

describe("registration", () => {
  test("a public client: Portico answers token_endpoint_auth_method none whatever was asked", async () => {
    const p = makePortico();
    const res = await register(p, { client_name: "ChatGPT", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      client_id: expect.any(String),
      client_name: "ChatGPT",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
  });

  test("redirect URIs: https, http on loopback and private-use schemes; never plain http elsewhere or script schemes", async () => {
    const p = makePortico();
    for (const uri of ["https://claude.ai/api/mcp/auth_callback", "http://127.0.0.1:33418/", "cursor://anysphere.cursor-retrieval/oauth/callback"]) {
      expect((await register(p, { redirect_uris: [uri] })).status).toBe(201);
    }
    for (const uri of ["http://evil.example/cb", "javascript:alert(1)", "https://a.example/cb#frag", "not a url"]) {
      const res = await register(p, { redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_redirect_uri" });
    }
    expect(await json(register(p, {}))).toMatchObject({ error: "invalid_redirect_uri" });
    const garbage = await p.app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: "[" });
    expect(await garbage.json()).toMatchObject({ error: "invalid_client_metadata" });
  });

  test("closed until setup is done", async () => {
    const p = makePortico({ setup: false });
    expect((await register(p, { redirect_uris: [REDIRECT] })).status).toBe(503);
  });
});

describe("the consent page", () => {
  test("signed out goes to sign in, carrying the whole authorize request in a next that safeNext keeps", async () => {
    const p = makePortico();
    await addOwner(p);
    const clientId = await client(p);
    const query = authorizeQuery(clientId, pkce().challenge, { state: "a b!*'()~é", scope: "claudeai mcp" });
    const res = await getAuthorize(p, query);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!, PUBLIC_URL);
    expect(location.pathname).toBe("/sign-in");
    const next = location.searchParams.get("next")!;
    expect(safeNext(next)).toBe(next);
    const back = new URL(next, PUBLIC_URL);
    expect(back.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(back.searchParams)).toEqual(Object.fromEntries(new URLSearchParams(query)));
  });

  test("a signed-in person sees D2: the client asks, a Name and a kind, then Cancel and Add agent", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    const clientId = await client(p);
    const res = await getAuthorize(p, authorizeQuery(clientId, pkce().challenge), cookie);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Claude Duet wants to add an agent to Portico");
    expect(html).toContain("Requested at");
    // The client picks its own name; where approval sends access is what can be trusted.
    expect(html).toContain("Approving sends access to <strong>localhost:4567</strong>.");
    expect(html).toContain('value="claude-duet" aria-describedby="c-name-help"');
    expect(html).toMatch(/value="claude-duet" checked>Claude Duet/);
    expect(html).toContain("Other agents use this name when sending messages.");
    expect(html).toContain("Once approved, this agent can message every agent on Portico and get replies.");
    expect(html.indexOf(">Cancel</a>")).toBeLessThan(html.indexOf(">Add agent</button>"));
    expect(html).toContain(`href="${REDIRECT}?error=access_denied&amp;state=state-123"`);
    expect(html).toContain("Chris</span></header>");
    expect(res.headers.get("content-security-policy")).toContain("form-action 'self' http://localhost:4567;");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("ChatGPT means Dots, and a taken name gets the first free form", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    addAppAgent(p, chris, "dots", { kind: "dots" });
    const clientId = await client(p, "ChatGPT");
    const html = await (await getAuthorize(p, authorizeQuery(clientId, pkce().challenge), signIn(p, chris))).text();
    expect(html).toContain('value="dots-2" aria-describedby');
    expect(html).toMatch(/value="dots" checked>Dots/);
    expect(guessKind("Claude Duet")).toBe("claude-duet");
    expect(guessKind("Cursor")).toBe("other");
  });

  test("an unknown client or an unregistered redirect URI gets a page, never a redirect", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    const clientId = await client(p);
    const { challenge } = pkce();
    const unknown = await getAuthorize(p, authorizeQuery("nope", challenge), cookie);
    expect(unknown.status).toBe(400);
    const wrong = await getAuthorize(p, authorizeQuery(clientId, challenge, { redirect_uri: "http://localhost:9999/evil" }), cookie);
    expect(wrong.status).toBe(400);
    expect(wrong.headers.get("location")).toBeNull();
    expect(copyProblems(visibleCopy(await unknown.text()) + visibleCopy(await wrong.text()))).toEqual([]);
  });

  test("other problems show on a page too: anyone can register a redirect URI, so errors never bounce there", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    const clientId = await client(p);
    const { challenge } = pkce();
    const cases: [Record<string, string>, string][] = [
      [{ code_challenge: "" }, "no PKCE code challenge"],
      [{ code_challenge_method: "plain" }, "other than S256"],
      [{ response_type: "token" }, "response type other than code"],
      [{ resource: "https://elsewhere.example/mcp" }, "resource other than"],
    ];
    for (const [extra, problem] of cases) {
      for (const who of [cookie, undefined]) {
        const res = await getAuthorize(p, authorizeQuery(clientId, challenge, extra), who);
        expect(res.status).toBe(400);
        expect(res.headers.get("location")).toBeNull();
        const html = await res.text();
        expect(html).toContain(problem);
        expect(copyProblems(visibleCopy(html))).toEqual([]);
      }
    }
  });

  test("a claim still waiting for approval can't add agents", async () => {
    const p = makePortico();
    await addOwner(p);
    const cookie = signIn(p, await addMember(p, "Priya", "pending"));
    const res = await getAuthorize(p, authorizeQuery(await client(p), pkce().challenge), cookie);
    expect(res.status).toBe(403);
    expect(copyProblems(visibleCopy(await res.text()))).toEqual([]);
  });
});

describe("adding the agent", () => {
  test("Add agent creates the connector for the signed-in person and sends a code back with the state", async () => {
    const { p, chris, next } = await authorized();
    const back = new URL(next);
    expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.agents.byAddress("duet")).toMatchObject({ type: "connector", kind: "claude-duet", ownerId: chris.id });
  });

  test("another site, a signed-out browser, a taken name and an unknown kind are refused", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const cookie = signIn(p, chris);
    addAppAgent(p, chris, "duet");
    const clientId = await client(p);
    const { challenge } = pkce();
    expect((await postConsent(p, cookie, consentFields(clientId, challenge), "https://evil.example")).status).toBe(403);
    expect((await postConsent(p, null, consentFields(clientId, challenge))).status).toBe(401);
    const taken = await postConsent(p, cookie, consentFields(clientId, challenge));
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ error: "conflict", message: "The name duet is already in use." });
    expect((await postConsent(p, cookie, consentFields(clientId, challenge, { name: "duet-2", kind: "muse" }))).status).toBe(400);
    expect((await postConsent(p, cookie, consentFields(clientId, challenge, { name: "duet-2", redirect_uri: "http://localhost:1/x" }))).status).toBe(400);
    expect((p.db.query("SELECT COUNT(*) AS n FROM oauth_codes").get() as { n: number }).n).toBe(0);
  });

  test("without JavaScript the form posts and the browser follows a redirect", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    const clientId = await client(p);
    const fields = consentFields(clientId, pkce().challenge) as Record<string, string>;
    const res = await p.app.request(`${PUBLIC_URL}/oauth/authorize`, {
      method: "POST",
      headers: { cookie, origin: PUBLIC_URL, host: "portico.example.com", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
    expect(res.status).toBe(303);
    expect(new URL(res.headers.get("location")!).searchParams.get("code")).toBeTruthy();
  });
});

describe("tokens", () => {
  test("the code and its verifier get an hour-long access token that works on /mcp, and a refresh token", async () => {
    const { p, clientId, code, verifier } = await authorized();
    const res = await exchange(p, clientId, code, verifier);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const tokens = (await res.json()) as Tokens;
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tokens.access_token).toStartWith("pt_");
    expect(tokens.refresh_token).toStartWith("pr_");
    expect((await mcpTools(p, tokens.access_token)).status).toBe(200);
    // A refresh token isn't an access token.
    expect((await mcpTools(p, tokens.refresh_token)).status).toBe(401);
    p.clock.advance(HOUR);
    expect((await mcpTools(p, tokens.access_token)).status).toBe(401);
  });

  test("a wrong verifier, client or redirect URI, and an expired code, are invalid_grant", async () => {
    const { p, clientId, code, verifier } = await authorized();
    const other = await client(p, "Other");
    const cases = [
      token(p, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: pkce().verifier }),
      token(p, { grant_type: "authorization_code", client_id: other, code, code_verifier: verifier }),
      token(p, { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: "http://localhost:1/x" }),
    ];
    for (const res of await Promise.all(cases)) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_grant", error_description: expect.any(String) });
    }
    expect(await json(token(p, { grant_type: "authorization_code", client_id: "nope", code, code_verifier: verifier }))).toMatchObject({
      error: "invalid_client",
    });
    expect(await json(token(p, { grant_type: "password", client_id: clientId }))).toMatchObject({ error: "unsupported_grant_type" });
    p.clock.advance(10 * MINUTE);
    expect(await json(exchange(p, clientId, code, verifier))).toMatchObject({ error: "invalid_grant", error_description: "The code expired." });
  });

  test("a code works once; using the code again revokes what the first use got", async () => {
    const { p, clientId, code, verifier } = await authorized();
    const first = await json<Tokens>(exchange(p, clientId, code, verifier));
    const again = await exchange(p, clientId, code, verifier);
    expect(await again.json()).toMatchObject({ error: "invalid_grant", error_description: "The code was already used." });
    expect((await mcpTools(p, first.access_token)).status).toBe(401);
  });

  test("refresh rotates: a new pair, and the old refresh token stops working", async () => {
    const { p, clientId, code, verifier } = await authorized();
    const first = await json<Tokens>(exchange(p, clientId, code, verifier));
    p.clock.advance(2 * HOUR);
    const second = await json<Tokens>(token(p, { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }));
    expect(second.access_token).toStartWith("pt_");
    expect((await mcpTools(p, second.access_token)).status).toBe(200);
    expect(await json(token(p, { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }))).toMatchObject({
      error: "invalid_grant",
    });
    const other = await client(p, "Other");
    expect(await json(token(p, { grant_type: "refresh_token", client_id: other, refresh_token: second.refresh_token }))).toMatchObject({
      error: "invalid_grant",
    });
    // HTTP Basic client authentication names the client too; its secret is ignored.
    const basic = `Basic ${Buffer.from(`${clientId}:ignored`).toString("base64")}`;
    const third = await token(p, { grant_type: "refresh_token", refresh_token: second.refresh_token }, { authorization: basic });
    expect(third.status).toBe(200);
  });

  test("refresh tokens last 90 days", async () => {
    const { p, clientId, code, verifier } = await authorized();
    const first = await json<Tokens>(exchange(p, clientId, code, verifier));
    p.clock.advance(90 * DAY);
    expect(await json(token(p, { grant_type: "refresh_token", client_id: clientId, refresh_token: first.refresh_token }))).toMatchObject({
      error: "invalid_grant",
    });
  });

  test("removing the agent ends its tokens", async () => {
    const { p, chris, clientId, code, verifier } = await authorized();
    const tokens = await json<Tokens>(exchange(p, clientId, code, verifier));
    p.agents.remove(chris.id, p.agents.byAddress("duet")!.id);
    expect((await mcpTools(p, tokens.access_token)).status).toBe(401);
    expect(await json(token(p, { grant_type: "refresh_token", client_id: clientId, refresh_token: tokens.refresh_token }))).toMatchObject({
      error: "invalid_grant",
    });
  });

  test("the daily sweep drops expired codes and tokens, and clients that never got a token", async () => {
    const { p, clientId, code, verifier } = await authorized();
    await client(p, "Never used");
    await exchange(p, clientId, code, verifier);
    p.clock.advance(8 * DAY);
    const swept = p.computers.sweep();
    expect(swept).toMatchObject({ oauthCodes: 1, tokens: 1, oauthClients: 1 });
    expect((p.db.query("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n).toBe(1);
  });
});

describe("an MCP SDK client end to end", () => {
  test("discovers, registers, gets consent from a signed-in person, exchanges the code and lists tools", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    const fetchApp = async (url: string | URL, init?: RequestInit) => p.app.request(url instanceof URL ? url.href : url, init);

    class MemoryProvider implements OAuthClientProvider {
      info: OAuthClientInformationMixed | undefined;
      saved: OAuthTokens | undefined;
      verifier = "";
      authorizationUrl: URL | undefined;
      get redirectUrl() {
        return REDIRECT;
      }
      get clientMetadata() {
        return {
          client_name: "Claude Duet",
          redirect_uris: [REDIRECT],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        };
      }
      state() {
        return "sdk-state";
      }
      clientInformation() {
        return this.info;
      }
      saveClientInformation(info: OAuthClientInformationMixed) {
        this.info = info;
      }
      tokens() {
        return this.saved;
      }
      saveTokens(tokens: OAuthTokens) {
        this.saved = tokens;
      }
      redirectToAuthorization(url: URL) {
        this.authorizationUrl = url;
      }
      saveCodeVerifier(verifier: string) {
        this.verifier = verifier;
      }
      codeVerifier() {
        return this.verifier;
      }
    }

    const provider = new MemoryProvider();
    const serverUrl = new URL(`${PUBLIC_URL}/mcp`);
    const first = new Client({ name: "portico-test", version: "1.0.0" });
    await expect(first.connect(new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: fetchApp }))).rejects.toThrow(
      UnauthorizedError,
    );
    expect(provider.info?.client_id).toBeTruthy();
    expect(provider.authorizationUrl?.pathname).toBe("/oauth/authorize");

    // The person's browser: the consent page, then Add agent.
    const page = await p.app.request(provider.authorizationUrl!.href, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    const hidden = Object.fromEntries(
      [...html.matchAll(/<input type="hidden" name="([a-z_]+)" value="([^"]*)">/g)].map(([, name, value]) => [
        name!,
        value!.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'"),
      ]),
    );
    expect(hidden).toMatchObject({ client_id: provider.info!.client_id, redirect_uri: REDIRECT, state: "sdk-state" });
    const { next } = await json<{ next: string }>(postConsent(p, cookie, { ...hidden, name: "duet", kind: "claude-duet" }));
    const back = new URL(next);
    expect(back.searchParams.get("state")).toBe("sdk-state");

    const transport = new StreamableHTTPClientTransport(serverUrl, { authProvider: provider, fetch: fetchApp });
    await transport.finishAuth(back.searchParams.get("code")!);
    expect(provider.saved?.access_token).toStartWith("pt_");

    const connected = new Client({ name: "portico-test", version: "1.0.0" });
    await connected.connect(transport);
    const { tools } = await connected.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["list_agents", "send_message", "check_inbox", "list_tasks", "get_task", "update_profile"]);
    const listed = await connected.callTool({ name: "list_agents", arguments: {} });
    expect(listed.isError).toBeFalsy();
    expect(p.agents.byAddress("duet")?.type).toBe("connector");
    await connected.close();
  });
});

describe("return paths", () => {
  test("any authorize query survives sign-in as a path safeNext keeps", () => {
    const path = authorizeReturnPath(`${PUBLIC_URL}/oauth/authorize?state=${encodeURIComponent("x/y?z=1&(!)'*")}&redirect_uri=http://localhost:1/cb`);
    expect(safeNext(path)).toBe(path);
    expect(new URL(path, PUBLIC_URL).searchParams.get("state")).toBe("x/y?z=1&(!)'*");
    expect(authorizeReturnPath(`${PUBLIC_URL}/oauth/authorize`)).toBe("/oauth/authorize");
  });
});
