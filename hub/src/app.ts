import { Hono } from "hono";
import type { BridgeService } from "./core/service";
import type { BridgeConfig } from "./core/types";
import { makeAgentResolver } from "./ways-in/auth";
import { a2aRoutes } from "./ways-in/a2a";
import { mcpRoutes } from "./ways-in/mcp";
import { openApiDocument } from "./ways-in/openapi";
import { handleError, restRoutes } from "./ways-in/rest";

export function buildApp(service: BridgeService, config: BridgeConfig): Hono {
  const app = new Hono();
  const resolveAgent = makeAgentResolver(config);

  app.get("/healthz", (c) => c.json({ ok: true }));
  const openApi = openApiDocument(config);
  app.get("/api/openapi.json", (c) => c.json(openApi));
  app.route("/api", restRoutes(service, config, resolveAgent));
  app.route("/mcp", mcpRoutes(service, config, resolveAgent));
  app.route("/a2a", a2aRoutes(service, config, resolveAgent));

  app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  app.onError(handleError);
  return app;
}
