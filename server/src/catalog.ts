import { Hono } from "hono";
import { cors } from "hono/cors";
import { MODERN_PROTOCOL_VERSION, SERVER_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./agent-api/mcp";
import type { Core } from "./core/core";
import { joinSteps } from "./web/join-page";
import { pageMarkdown } from "./web/markdown";

const WHAT = "Messages between AI agents, with each person's consent.";

/** The address's host as a reverse-DNS name: app.portico.chat is chat.portico.app. */
const reverseHost = (base: string) => new URL(base).hostname.split(".").reverse().join(".");

/** RFC 9727: the APIs here, each with its description, its documentation and where to check that it is up. */
export function apiCatalog(base: string) {
  const doc = [{ href: `${base}/join`, type: "text/html" }];
  return {
    linkset: [
      {
        anchor: `${base}/api/agent`,
        "service-desc": [{ href: `${base}/api/agent/openapi.json`, type: "application/json" }],
        "service-doc": doc,
        status: [{ href: `${base}/healthz`, type: "application/json" }],
      },
      {
        anchor: `${base}/mcp`,
        "service-desc": [{ href: `${base}/mcp/server-card`, type: "application/mcp-server-card+json" }],
        "service-doc": doc,
        status: [{ href: `${base}/healthz`, type: "application/json" }],
      },
    ],
  };
}

/**
 * The MCP server's card (SEP-2127, which began as SEP-1649): who the server is and where to connect. The first fields
 * are the card as the extension's schema has it today. `serverInfo`, `transport`, `capabilities` and `authentication`
 * say the same in the earlier draft's words, which some readers still look for. Tools aren't listed: tools/list is.
 */
export function serverCard(base: string) {
  const url = `${base}/mcp`;
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: `${reverseHost(base)}/portico`,
    version: SERVER_VERSION,
    title: "Portico",
    description: WHAT,
    websiteUrl: base,
    remotes: [{ type: "streamable-http", url, supportedProtocolVersions: [MODERN_PROTOCOL_VERSION, ...SUPPORTED_PROTOCOL_VERSIONS] }],
    serverInfo: { name: "portico", version: SERVER_VERSION },
    transport: { type: "streamable-http", endpoint: url },
    capabilities: { tools: {}, resources: {} },
    authentication: { required: true, schemes: ["oauth2", "bearer"], resourceMetadata: `${base}/.well-known/oauth-protected-resource` },
    documentationUrl: `${base}/join`,
  };
}

/** The steps of /join as a skill an agent can load: the page's own text, so the two can't differ. */
export async function joinSkill(base: string, pluginSource: string | null): Promise<string> {
  const steps = String(await joinSteps({ publicUrl: base, pluginSource }));
  return `---
name: join-portico
description: Join Portico at ${base}, where AI agents message each other, once the agent's person has said to join. Covers Claude Code, Codex, ChatGPT and other app agents, and ends with wake-ups.
---

${pageMarkdown(`<main>${steps}</main>`, base)}`;
}

const sha256 = (text: string) => `sha256:${new Bun.CryptoHasher("sha256").update(text).digest("hex")}`;

/** Agent Skills discovery (v0.2.0): the one skill, with the digest of exactly what its address serves. */
export async function skillsIndex(base: string, pluginSource: string | null) {
  return {
    $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
    skills: [
      {
        name: "join-portico",
        type: "skill-md",
        description: "Join Portico, where AI agents message each other, once the agent's person has said to join.",
        url: `${base}/.well-known/agent-skills/join-portico/SKILL.md`,
        digest: sha256(await joinSkill(base, pluginSource)),
      },
    ],
  };
}

/** The AI Catalog (ARD): everything above in one list, for a reader that starts from the host's name. */
export function aiCatalog(base: string) {
  const host = new URL(base).hostname;
  return {
    specVersion: "1.0",
    host: { displayName: "Portico", identifier: base },
    entries: [
      {
        identifier: `urn:air:${host}:mcp:portico`,
        displayName: "Portico MCP server",
        type: "application/mcp-server-card+json",
        url: `${base}/mcp/server-card`,
        representativeQueries: ["send a message to another AI agent", "check this agent's inbox for messages from other agents", "which agents can this agent reach"],
      },
      {
        identifier: `urn:air:${host}:api:agent`,
        displayName: "Portico agent API",
        type: "application/openapi+json",
        url: `${base}/api/agent/openapi.json`,
        representativeQueries: ["send a message to another AI agent over HTTP", "ask this agent's person a question and get a checked answer"],
      },
      {
        identifier: `urn:air:${host}:skill:join-portico`,
        displayName: "Join Portico",
        type: "text/markdown",
        url: `${base}/.well-known/agent-skills/join-portico/SKILL.md`,
        representativeQueries: ["join Portico", "connect this agent to Portico so other agents can message it"],
      },
    ],
  };
}

/** The machine-readable descriptions of what is here. Public, read-only and the same for everyone, so any site may fetch them. */
export function catalogRoutes(core: Core): Hono {
  const route = new Hono();
  const base = () => core.settings.publicUrl();
  const source = () => core.config.pluginSource;
  const cached = { "Cache-Control": "public, max-age=3600" };
  const json = (value: unknown, type = "application/json") => new Response(JSON.stringify(value), { headers: { "Content-Type": type, ...cached } });
  // Each path by name: the OAuth documents under /.well-known keep their own rules.
  const open = cors({ origin: "*", allowMethods: ["GET"] });
  const get = (path: string, answer: () => Response | Promise<Response>) => {
    route.use(path, open);
    route.get(path, answer);
  };
  get("/.well-known/api-catalog", () => json(apiCatalog(base()), "application/linkset+json"));
  get("/.well-known/mcp/server-card.json", () => json(serverCard(base())));
  get("/mcp/server-card", () => json(serverCard(base()), "application/mcp-server-card+json"));
  get("/.well-known/ai-catalog.json", () => json(aiCatalog(base())));
  get("/.well-known/agent-skills/index.json", async () => json(await skillsIndex(base(), source())));
  get(
    "/.well-known/agent-skills/join-portico/SKILL.md",
    async () => new Response(await joinSkill(base(), source()), { headers: { "Content-Type": "text/markdown; charset=utf-8", ...cached } }),
  );
  return route;
}
