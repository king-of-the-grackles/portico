import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { BridgeError, HTTP_STATUS } from "../core/errors";
import { type BridgeService, DELIVERY_BATCH_MAX } from "../core/service";
import { type BridgeConfig, isPushAgent } from "../core/types";
import { errorName, log } from "../log";
import { type AgentEnv, type AgentResolver, requireAgent } from "./auth";
import { jsonBodyLimit } from "./limits";
import { agentView, eventView, inboxTaskView, resultDeliveryView, taskView } from "./views";

const SendTaskBody = z.object({ to: z.string(), instructions: z.string(), idempotency_key: z.string().optional() });
const FinishBody = z.object({ result: z.string().optional(), failed_reason: z.string().optional() });
const EventBody = z.object({ name: z.string(), details: z.string().optional() });
const AckIds = z.array(z.string()).max(DELIVERY_BATCH_MAX).default([]);
const AckBody = z.object({ tasks: AckIds, results: AckIds, messages: AckIds });

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new BridgeError("bad_request", "Request body must be JSON.");
  }
}

export function handleError(err: unknown, c: Context): Response {
  if (err instanceof BridgeError) {
    return c.json({ error: err.code, message: err.message }, HTTP_STATUS[err.code] as ContentfulStatusCode);
  }
  if (err instanceof z.ZodError) {
    const message = err.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return c.json({ error: "bad_request", message }, 400);
  }
  log("error", "unhandled_error", { error: errorName(err), route: c.req.routePath });
  return c.json({ error: "internal", message: "Something went wrong." }, 500);
}

export function restRoutes(service: BridgeService, config: BridgeConfig, resolveAgent: AgentResolver): Hono<AgentEnv> {
  const api = new Hono<AgentEnv>();

  api.use("*", jsonBodyLimit(config));

  api.use("*", requireAgent(resolveAgent));

  api.get("/agents", (c) => c.json({ agents: service.listAgents(c.get("agent")).map(agentView) }));

  api.post("/tasks", async (c) => {
    const body = SendTaskBody.parse(await readJson(c));
    const task = service.sendTask(c.get("agent"), {
      to: body.to,
      instructions: body.instructions,
      idempotencyKey: body.idempotency_key,
    });
    return c.json({ task: taskView(task) }, 201);
  });

  api.get("/inbox", (c) => {
    const { tasks, results } = service.checkInbox(c.get("agent"));
    return c.json({ tasks: tasks.map(inboxTaskView), results: results.map(taskView) });
  });

  // Peek and ack, for push agents' plugins: a GET changes nothing, and only the ack claims what was delivered.
  const requirePush = (agent: string) => {
    if (!isPushAgent(config, agent)) {
      throw new BridgeError("not_allowed", "Only push agents use deliveries; pull agents call check_inbox.");
    }
  };

  api.get("/deliveries", (c) => {
    requirePush(c.get("agent"));
    const { tasks, results } = service.pendingDeliveries(c.get("agent"));
    return c.json({ tasks: tasks.map(inboxTaskView), results: results.map(resultDeliveryView), messages: [] });
  });

  api.post("/deliveries/ack", async (c) => {
    requirePush(c.get("agent"));
    const body = AckBody.parse(await readJson(c));
    // Messages are accepted and ignored until the hub has them.
    const acked = service.ackDeliveries(c.get("agent"), { tasks: body.tasks, results: body.results });
    return c.json({ acked: { ...acked, messages: 0 } });
  });

  api.post("/tasks/:id/finish", async (c) => {
    const body = FinishBody.parse(await readJson(c));
    const task = service.finishTask(c.get("agent"), {
      taskId: c.req.param("id"),
      result: body.result,
      failedReason: body.failed_reason,
    });
    return c.json({ task: taskView(task) });
  });

  api.get("/tasks/:id", (c) => c.json({ task: taskView(service.getTask(c.get("agent"), c.req.param("id"))) }));

  api.post("/events", async (c) => {
    const body = EventBody.parse(await readJson(c));
    const { event, tasks } = service.reportEvent(c.get("agent"), { name: body.name, details: body.details ?? "" });
    return c.json({ event: eventView(event), tasks: tasks.map(taskView) }, 201);
  });

  api.onError(handleError);
  return api;
}
