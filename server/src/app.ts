import { Hono } from "hono";
import { makeResolver } from "./agent-api/auth";
import { mcpRoutes } from "./agent-api/mcp";
import { openApiDocument } from "./agent-api/openapi";
import { popupAnswerRoutes } from "./agent-api/popup-answers";
import { agentRestRoutes, handleError } from "./agent-api/rest";
import { streamRoutes } from "./agent-api/stream";
import { agentViews } from "./agent-api/views";
import { personApi } from "./api";
import { computerApi } from "./computer-api";
import type { Core } from "./core/core";
import { oauthRoutes } from "./oauth";
import { signInRequestApi } from "./sign-in-api";
import { webRoutes } from "./web";
import { narrowPage } from "./web/layout";
import { html } from "hono/html";

/**
 * Every surface over the core. Order matters: the agent, computer and sign-in-request routes answer before the person
 * API's catch-all middleware under /api, and pages come last.
 */
export function buildApp(core: Core, opts: { heartbeatMs?: number } = {}): Hono {
  const app = new Hono();
  const resolver = makeResolver(core.agents, core.computers, () => core.settings.publicUrl());
  const views = agentViews(core.agents, core.people);
  const { agents, messages } = core;

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/api/agent/openapi.json", (c) => c.json(openApiDocument(core.settings.publicUrl())));
  app.route("/api/agent/stream", streamRoutes({ agents, messages, streams: core.agentStreams, resolver, heartbeatMs: opts.heartbeatMs }));
  app.route("/api/agent/approvals", popupAnswerRoutes({ approvals: core.approvals, desk: core.desk, views, resolver }));
  app.route(
    "/api/agent",
    agentRestRoutes({ agents, messages, tasks: core.tasks, presence: core.presence, views, resolver, changes: core.changes, now: core.now }),
  );
  app.route("/api/computer", computerApi(core));
  app.route("/api/sign-in-requests", signInRequestApi(core));
  app.route("/mcp", mcpRoutes({ agents, messages, tasks: core.tasks, events: core.events, views, resolver }));
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
