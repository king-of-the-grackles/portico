import { Hono } from "hono";
import type { BridgeService } from "./core/service";
import type { BridgeConfig } from "./core/types";
import { makeAgentResolver } from "./ways-in/auth";
import { handleError, restRoutes } from "./ways-in/rest";

export function buildApp(service: BridgeService, config: BridgeConfig): Hono {
  const app = new Hono();
  const resolveAgent = makeAgentResolver(config);

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api", restRoutes(service, config, resolveAgent));

  app.notFound((c) => c.json({ error: "not_found", message: "No such endpoint." }, 404));
  app.onError(handleError);
  return app;
}
