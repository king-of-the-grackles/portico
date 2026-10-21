import { Hono } from "hono";
import { pageRoutes } from "./page/routes";
import { approvalRoutes } from "./approvals/routes";
import type { Directory } from "./core/directory";
import type { PermissionRelay, PermissionRequest } from "./core/permissions";
import type { BridgeService } from "./core/service";
import type { Pusher } from "./approvals/ntfy";
import type { BridgeConfig } from "./core/types";
import { a2aRoutes } from "./ways-in/a2a";
import type { AgentResolver, PrincipalResolver } from "./ways-in/auth";
import { mcpRoutes } from "./ways-in/mcp";
import { openApiDocument } from "./ways-in/openapi";
import { permissionRoutes } from "./ways-in/permissions";
import { handleError, restRoutes } from "./ways-in/rest";
import { type StreamHub, streamRoutes } from "./ways-in/stream";

export interface AppDeps {
  service: BridgeService;
  config: BridgeConfig;
  directory: Directory;
  resolvers: { principal: PrincipalResolver; agent: AgentResolver };
  streams: StreamHub;
  relay: PermissionRelay;
  push: Pusher;
  onPermissionRequest: (request: PermissionRequest) => void;
  now: () => Date;
  heartbeatMs?: number;
}

export function buildApp(deps: AppDeps): Hono {
  const { service, config, directory, streams, relay } = deps;
  const app = new Hono();
  const resolveAgent = deps.resolvers.agent;

  // Clients and proxies that probe the root get a 200, not a 404. Reveals no version, agents or tasks.
  app.get("/", (c) => c.json({ openapi: "/api/openapi.json", health: "/healthz" }));
  app.get("/healthz", (c) => c.json({ ok: true }));
  const openApi = openApiDocument(config);
  app.get("/api/openapi.json", (c) => c.json(openApi));
  // Routes under /api that aren't part of the web API group are mounted before it, so they answer first.
  app.route(
    "/api/stream",
    streamRoutes({
      service,
      directory,
      streams,
      resolveAgent,
      heartbeatMs: deps.heartbeatMs,
      onConnect: (agent) => relay.redeliver(agent),
    }),
  );
  app.route(
    "/api/permission-requests",
    permissionRoutes({ config, directory, relay, resolveAgent, onCreated: deps.onPermissionRequest }),
  );
  app.route("/api", restRoutes(service, config, resolveAgent, directory));
  app.route("/mcp", mcpRoutes(service, config, resolveAgent));
  app.route("/a2a", a2aRoutes(service, config, resolveAgent));

  app.get("/hub/", (c) => c.redirect("/hub", 303));
  app.route("/hub", pageRoutes({ service, relay, streams, config, now: deps.now }));
  app.route("/", approvalRoutes({ service, relay, config, push: deps.push, now: deps.now }));

  app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  app.onError(handleError);
  return app;
}
