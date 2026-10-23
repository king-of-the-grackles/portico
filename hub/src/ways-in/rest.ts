import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Directory } from "../core/directory";
import { HTTP_STATUS, PorticoError } from "../core/errors";
import { parseStatusReport, type Presence } from "../core/presence";
import { DELIVERY_BATCH_MAX, type PorticoService } from "../core/service";
import type { SessionRegistry } from "../core/sessions";
import type { PorticoConfig } from "../core/types";
import { errorName, log } from "../log";
import { type AgentEnv, type AgentResolver, inboxTakesMessages, type PrincipalResolver, requireAgent } from "./auth";
import { jsonBodyLimit } from "./limits";
import {
  directoryEntryView,
  eventView,
  inboxTaskView,
  messageDeliveryView,
  messageView,
  resultDeliveryView,
  taskView,
} from "./views";

const SendTaskBody = z.object({ to: z.string(), instructions: z.string(), idempotency_key: z.string().optional() });
const SendMessageBody = z.object({ to: z.string().optional(), text: z.string(), reply_to: z.string().optional() });
const FinishBody = z.object({ result: z.string().optional(), failed_reason: z.string().optional() });
const EventBody = z.object({ name: z.string(), details: z.string().optional() });
const AckIds = z.array(z.string()).max(DELIVERY_BATCH_MAX).default([]);
const AckBody = z.object({ tasks: AckIds, results: AckIds, messages: AckIds });

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new PorticoError("bad_request", "Request body must be JSON.");
  }
}

export function handleError(err: unknown, c: Context): Response {
  if (err instanceof PorticoError) {
    return c.json({ error: err.code, message: err.message }, HTTP_STATUS[err.code] as ContentfulStatusCode);
  }
  if (err instanceof z.ZodError) {
    const message = err.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ");
    return c.json({ error: "bad_request", message }, 400);
  }
  log("error", "unhandled_error", { error: errorName(err), route: c.req.routePath });
  return c.json({ error: "internal", message: "Something went wrong." }, 500);
}

export function restRoutes(
  service: PorticoService,
  config: PorticoConfig,
  resolvers: { agent: AgentResolver; principal: PrincipalResolver },
  directory: Directory,
  status: { presence: Presence; sessions: SessionRegistry; now: () => Date },
): Hono<AgentEnv> {
  const api = new Hono<AgentEnv>();

  api.use("*", jsonBodyLimit(config));

  api.use("*", requireAgent(resolvers.agent, resolvers.principal));

  api.get("/agents", (c) => c.json({ agents: service.listAgents(c.get("agent")).map(directoryEntryView) }));

  api.post("/tasks", async (c) => {
    const body = SendTaskBody.parse(await readJson(c));
    const task = service.sendTask(c.get("agent"), {
      to: body.to,
      instructions: body.instructions,
      idempotencyKey: body.idempotency_key,
    });
    return c.json({ task: taskView(task), delivery: service.deliveryFor(task), approval: service.approvalFor(task) }, 201);
  });

  api.post("/messages", async (c) => {
    const body = SendMessageBody.parse(await readJson(c));
    const { message, delivery } = service.sendMessage(c.get("agent"), { to: body.to, text: body.text, replyTo: body.reply_to });
    return c.json({ message: messageView(message), delivery }, 201);
  });

  api.get("/inbox", (c) => {
    const agent = c.get("agent");
    const { tasks, results, messages } = service.checkInbox(agent, {
      messages: inboxTakesMessages(directory, agent, c.req.header("x-portico-session")),
    });
    return c.json({
      tasks: tasks.map(inboxTaskView),
      results: results.map(resultDeliveryView),
      messages: messages.map(messageDeliveryView),
    });
  });

  // Peek and ack, for push agents' plugins: a GET changes nothing, and only the ack claims what was delivered.
  const requirePush = (agent: string) => {
    if (!directory.isPush(agent)) {
      throw new PorticoError("not_allowed", "Only push agents use deliveries; pull agents call check_inbox.");
    }
  };

  api.get("/deliveries", (c) => {
    requirePush(c.get("agent"));
    const { tasks, results, messages } = service.pendingDeliveries(c.get("agent"));
    return c.json({
      tasks: tasks.map(inboxTaskView),
      results: results.map(resultDeliveryView),
      messages: messages.map(messageDeliveryView),
    });
  });

  api.post("/deliveries/ack", async (c) => {
    requirePush(c.get("agent"));
    const body = AckBody.parse(await readJson(c));
    return c.json({ acked: service.ackDeliveries(c.get("agent"), body) });
  });

  // Push members' live status, kept in memory (spec §5.3). The text is cleaned here; nothing about it is logged.
  api.post("/status", async (c) => {
    const agent = c.get("agent");
    if (!directory.isPush(agent)) throw new PorticoError("not_allowed", "Only push agents report status.");
    const report = parseStatusReport(await readJson(c));
    status.presence.report(agent, report, status.now().toISOString());
    status.sessions.touch(agent);
    return c.json({ ok: true });
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
