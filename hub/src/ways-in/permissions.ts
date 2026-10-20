import { Hono } from "hono";
import { z } from "zod";
import { BridgeError } from "../core/errors";
import type { PermissionRelay, PermissionRequest } from "../core/permissions";
import { type BridgeConfig, isPushAgent } from "../core/types";
import { clip, log } from "../log";
import { type AgentEnv, type AgentResolver, requireAgent } from "./auth";
import { jsonBodyLimit } from "./limits";
import { handleError, readJson } from "./rest";
import { permissionView } from "./views";

const PermissionBody = z.object({
  request_id: z.string(),
  tool_name: z.string(),
  description: z.string().optional(),
  input_preview: z.string().optional(),
});

export interface PermissionRouteDeps {
  config: BridgeConfig;
  relay: PermissionRelay;
  resolveAgent: AgentResolver;
  /** Runs once for each new prompt, e.g. to send the push. */
  onCreated: (request: PermissionRequest) => void;
}

export function permissionRoutes(deps: PermissionRouteDeps): Hono<AgentEnv> {
  const { config, relay } = deps;
  const route = new Hono<AgentEnv>();
  route.use("*", jsonBodyLimit(config));
  route.use("*", requireAgent(deps.resolveAgent));

  route.post("/", async (c) => {
    const agent = c.get("agent");
    if (!isPushAgent(config, agent)) {
      throw new BridgeError("not_allowed", "Only push agents can relay permission prompts.");
    }
    const body = PermissionBody.parse(await readJson(c));
    const { request, created } = relay.add(agent, {
      requestId: body.request_id,
      toolName: body.tool_name,
      description: body.description,
      inputPreview: body.input_preview,
    });
    if (created) {
      log("info", "permission_requested", { agent, request_id: request.requestId, tool: clip(request.toolName, 60) });
      deps.onCreated(request);
    }
    return c.json({ request: permissionView(request) }, created ? 201 : 200);
  });

  route.onError(handleError);
  return route;
}
