import { describe, expect, test } from "bun:test";
import { MODERN_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "../src/agent-api/mcp";
import { addAppAgent, addOwner, makePortico, PUBLIC_URL } from "./helpers";

const local = (url: string) => url.slice(PUBLIC_URL.length);

describe("machine-readable descriptions of what is here", () => {
  test("the API catalog is a linkset whose every link answers", async () => {
    const p = makePortico();
    const res = await p.app.request("/.well-known/api-catalog");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/linkset+json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const { linkset } = (await res.json()) as { linkset: Record<string, any>[] };
    expect(linkset.map((entry) => entry.anchor)).toEqual([`${PUBLIC_URL}/api/agent`, `${PUBLIC_URL}/mcp`]);
    for (const entry of linkset) {
      for (const rel of ["service-desc", "service-doc", "status"]) {
        const [link] = entry[rel];
        const answer = await p.app.request(local(link.href));
        expect(answer.status).toBe(200);
        expect(answer.headers.get("content-type")).toStartWith(link.type);
      }
    }
    expect((await p.app.request("/sign-in")).headers.get("link")).toContain('</.well-known/api-catalog>; rel="api-catalog"');
  });

  test("the MCP server card says what the server itself says once connected", async () => {
    const p = makePortico();
    const agent = addAppAgent(p, await addOwner(p), "muse-work");
    const wellKnown = await p.app.request("/.well-known/mcp/server-card.json");
    expect(wellKnown.headers.get("content-type")).toBe("application/json");
    const card = (await wellKnown.json()) as Record<string, any>;
    const hosted = await p.app.request("/mcp/server-card");
    expect(hosted.headers.get("content-type")).toBe("application/mcp-server-card+json");
    expect(await hosted.json()).toEqual(card);

    // The card as the extension's schema has it: the required fields and their patterns.
    expect(card.$schema).toBe("https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json");
    expect(card.name).toBe("com.example.portico/portico");
    expect(card.name).toMatch(/^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
    expect(card.description.length).toBeLessThanOrEqual(100);
    expect(card.remotes).toEqual([{ type: "streamable-http", url: `${PUBLIC_URL}/mcp`, supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS] }]);
    expect(card.transport).toEqual({ type: "streamable-http", endpoint: `${PUBLIC_URL}/mcp` });

    const init = await p.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
    });
    const { result } = (await init.json()) as { result: Record<string, any> };
    expect(card.serverInfo).toEqual(result.serverInfo);
    expect(card.version).toBe(result.serverInfo.version);
    for (const capability of Object.keys(card.capabilities)) expect(result.capabilities).toHaveProperty(capability);

    // The card names sign-in the way the server asks for it: a 401 that points at the same metadata.
    const refused = await p.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain(card.authentication.resourceMetadata);
    expect((await p.app.request(local(card.authentication.resourceMetadata))).status).toBe(200);
  });

  test("the skills index lists the join steps, with the digest of what the address serves", async () => {
    const p = makePortico();
    const res = await p.app.request("/.well-known/agent-skills/index.json");
    const index = (await res.json()) as { $schema: string; skills: Record<string, string>[] };
    expect(index.$schema).toBe("https://schemas.agentskills.io/discovery/0.2.0/schema.json");
    expect(index.skills).toHaveLength(1);
    const skill = index.skills[0]!;
    expect(skill.name).toBe("join-portico");
    expect(skill.type).toBe("skill-md");
    const served = await p.app.request(local(skill.url!));
    expect(served.headers.get("content-type")).toContain("text/markdown");
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(skill.digest).toBe(`sha256:${new Bun.CryptoHasher("sha256").update(bytes).digest("hex")}`);
    const text = new TextDecoder().decode(bytes);
    expect(text).toStartWith("---\nname: join-portico\ndescription: ");
    // The skill is the join page: the same Markdown the page gives.
    const page = await (await p.app.request("/join", { headers: { accept: "text/markdown" } })).text();
    expect(text).toEndWith(`---\n\n${page}`);
  });

  test("the AI catalog lists the card, the API and the skill, each at an address that answers", async () => {
    const p = makePortico();
    const res = await p.app.request("/.well-known/ai-catalog.json");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const catalog = (await res.json()) as { specVersion: string; host: Record<string, string>; entries: Record<string, any>[] };
    expect(catalog.specVersion).toBe("1.0");
    expect(catalog.host).toEqual({ displayName: "Portico", identifier: PUBLIC_URL });
    expect(catalog.entries.map((entry) => entry.identifier)).toEqual([
      "urn:air:portico.example.com:mcp:portico",
      "urn:air:portico.example.com:api:agent",
      "urn:air:portico.example.com:skill:join-portico",
    ]);
    for (const entry of catalog.entries) {
      expect(entry.data).toBeUndefined();
      expect(entry.representativeQueries.length).toBeGreaterThanOrEqual(2);
      expect((await p.app.request(local(entry.url))).status).toBe(200);
    }
  });

  test("auth.md names the two real ways to a credential, and claims no registration protocol", async () => {
    const p = makePortico();
    const res = await p.app.request("/auth.md");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toStartWith("# Portico auth.md\n");
    // A flow Portico doesn't offer isn't named, even to say so: scanners read the name alone as support.
    expect(text).not.toMatch(/id-jag|identity.assertion|verified.email|anonymous|service_auth/i);
    // What the file says is what the server does: the 401's header, the metadata and the join route.
    const refused = await p.app.request("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(text).toContain(`WWW-Authenticate: ${refused.headers.get("www-authenticate")}`);
    const metadata = (await (await p.app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(metadata.agent_auth).toBeUndefined();
    expect(metadata.registration_endpoint).toBe(`${PUBLIC_URL}/oauth/register`);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(metadata.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    const asked = await p.app.request("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "agent", name: "muse-work", client: "muse" }) });
    expect(Object.keys((await asked.json()) as object)).toEqual(expect.arrayContaining(["id", "link", "poll_secret", "expires_at", "show"]));
    expect(await (await p.app.request("/robots.txt")).text()).toContain("Allow: /auth.md\n");
  });

  test("the OAuth documents and the MCP endpoint answer as before", async () => {
    const p = makePortico();
    const preflight = await p.app.request("/.well-known/oauth-authorization-server", {
      method: "OPTIONS",
      headers: { origin: "https://client.example", "access-control-request-method": "GET" },
    });
    expect(preflight.headers.get("access-control-allow-methods")).toBe("GET,POST,OPTIONS");
    expect((await p.app.request("/.well-known/oauth-protected-resource/mcp")).status).toBe(200);
    expect((await p.app.request("/mcp")).status).toBe(405);
    expect((await p.app.request("/.well-known/nothing")).status).toBe(404);
  });
});
