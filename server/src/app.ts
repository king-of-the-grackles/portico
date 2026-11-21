import { Hono } from "hono";
import { makeResolver } from "./agent-api/auth";
import { mcpRoutes } from "./agent-api/mcp";
import { openApiDocument } from "./agent-api/openapi";
import { agentRestRoutes, handleError } from "./agent-api/rest";
import { streamRoutes } from "./agent-api/stream";
import { agentViews } from "./agent-api/views";
import { wakeStateOf } from "./core/wake-setup";
import { personApi } from "./api";
import { computerApi } from "./computer-api";
import { fileRoutes } from "./file-api";
import type { Core } from "./core/core";
import { oauthRoutes } from "./oauth";
import { joinApi } from "./join-api";
import { webRoutes } from "./web";
import { narrowPage } from "./web/layout";
import { html } from "hono/html";
import { bodyLimit } from "hono/body-limit";
import { MAX_BODY_BYTES } from "./core/limits";

/**
 * Every surface over the core. Order matters: the agent, computer and join routes answer before the person
 * API's catch-all middleware under /api, and pages come last.
 */
export function buildApp(core: Core, opts: { heartbeatMs?: number; retiredHosts?: string[] } = {}): Hono {
  const app = new Hono();

  // An address this server no longer answers on: every path there says Gone and names the address to use, before
  // anything else looks at the request. A client still set up for the old address then fails with a plain reason.
  const retired = new Set(opts.retiredHosts ?? []);
  if (retired.size > 0) {
    app.use("*", async (c, next) => {
      const host = (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");
      if (!retired.has(host)) return next();
      const now = core.settings.publicUrl();
      const message = `Portico no longer answers at ${host}. Portico is at ${now}. An agent or connector set up for ${host} joins again there: ${now}/join`;
      c.header("Cache-Control", "no-store");
      return /\btext\/html\b/.test(c.req.header("accept") ?? "") && c.req.method === "GET"
        ? narrowPage(c, { title: "This address is retired", status: 410, main: html`<div><h1>This address is retired</h1><p class="lead">Portico no longer answers at ${host}. Portico is at <a href="${now}">${now}</a>.</p></div>
<p class="help">An agent or connector set up for ${host} joins again at <a href="${now}/join">${now}/join</a>.</p>` })
        : c.json({ error: "gone", message }, 410);
    });
  }
  const resolver = makeResolver(core.agents, core.computers, () => core.settings.publicUrl());
  const views = agentViews(core.agents, core.people, core.files, core.workspaces, () => core.settings.publicUrl(), (personId) => core.approvals.heldFor(personId).length, (agent) => wakeStateOf(core, agent));
  const { agents, messages, files } = core;
  const toolDeps = { agents, people: core.people, workspaces: core.workspaces, shares: core.shares, consents: core.consents, publicUrl: () => core.settings.publicUrl() };
  const notices = core.agentNotices;

  // The server's own backstop rises to the file limit when uploads come through Portico. Everything but the upload
  // route keeps the backstop there was before.
  const backstop = bodyLimit({
    maxSize: MAX_BODY_BYTES * 2,
    onError: (c) => c.json({ error: "too_large", message: "The request body is too large." }, 413),
  });
  app.use("*", (c, next) => (c.req.path.startsWith("/files/") ? next() : backstop(c, next)));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/agent/openapi.json", (c) => c.json(openApiDocument(core.settings.publicUrl())));
  app.route("/api/agent/stream", streamRoutes({ agents, messages, streams: core.agentStreams, resolver, heartbeatMs: opts.heartbeatMs }));
  app.route(
    "/api/agent",
    agentRestRoutes({ agents, messages, tasks: core.tasks, files, presence: core.presence, wakeUrls: core.wakeUrls, views, resolver, changes: core.changes, now: core.now, porticoTools: toolDeps, notices }),
  );
  app.route("/files", fileRoutes(core));
  app.route("/api/computer", computerApi(core));
  app.route("/api/join", joinApi(core));
  app.route("/mcp", mcpRoutes({ agents, messages, tasks: core.tasks, files, events: core.events, wakeUrls: core.wakeUrls, views, resolver, porticoTools: toolDeps, notices }));
  // Resend reports bounces and complaints here. The signature is the only credential; the body is read as sent.
  app.post("/api/mail/resend", async (c) => {
    const ok = core.mail.webhook(
      { id: c.req.header("svix-id"), timestamp: c.req.header("svix-timestamp"), signature: c.req.header("svix-signature") },
      await c.req.text(),
    );
    return ok ? c.json({ ok: true }) : c.json({ error: "unauthorized", message: "The signature doesn't check out." }, 401);
  });
  app.route("/", oauthRoutes(core));
  app.route("/api", personApi(core, opts));
  app.route("/", webRoutes(core));

  app.notFound((c) => {
    if (/^\/(api|mcp|oauth|\.well-known)(\/|$)/.test(c.req.path)) {
      return c.json({ error: "not_found", message: "No such endpoint." }, 404);
    }
    return narrowPage(c, { title: "Not found", status: 404, main: html`<h1>Nothing here</h1><p class="lead"><a href="/">Go to Today</a></p>` });
  });
  app.onError(handleError);
  return app;
}
