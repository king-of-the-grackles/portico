import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Agents } from "../core/agents";
import type { Changes } from "../core/changes";
import { HTTP_STATUS, PorticoError } from "../core/errors";
import { inboxWaitMs } from "../core/inbox-waits";
import { DELIVERY_BATCH_MAX, type Messages } from "../core/messages";
import { parseStatusReport, type Presence } from "../core/presence";
import { errorName, log } from "../log";
import { type AgentEnv, requireAgent, requireSession, type Resolver, unauthorized } from "./auth";
import { jsonBodyLimit } from "./limits";
import type { AgentViews } from "./views";

const SendBody = z.object({
  to: z.string().optional(),
  subject: z.string(),
  text: z.string(),
  reply_to: z.string().optional(),
});
const AckIds = z.array(z.string()).max(DELIVERY_BATCH_MAX).default([]);
const AckBody = z.object({ messages: AckIds, updates: AckIds });

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new PorticoError("bad_request", "The request body must be JSON.");
  }
}

/** Every route's errors, as `{ error, message }`. */
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

export interface AgentRestDeps {
  agents: Agents;
  messages: Messages;
  presence: Presence;
  views: AgentViews;
  resolver: Resolver;
  changes: Changes;
  now: () => Date;
}

/** The agent API under /api/agent: the agent list, messages, the inbox, and sessions' deliveries and status. */
export function agentRestRoutes(deps: AgentRestDeps): Hono<AgentEnv> {
  const { agents, messages, presence, views } = deps;
  const api = new Hono<AgentEnv>();

  api.use("*", jsonBodyLimit());
  api.use("*", requireAgent(deps.resolver));

  api.get("/agents", (c) => {
    const agent = c.get("agent");
    agents.checkedIn(agent);
    return c.json({ agents: agents.entries(agent.id).map(views.entry) });
  });

  api.post("/messages", async (c) => {
    const body = SendBody.parse(await readJson(c));
    const agent = c.get("agent");
    const { message, delivery, note } = messages.send(agent, {
      to: body.to,
      subject: body.subject,
      text: body.text,
      replyTo: body.reply_to,
    });
    agents.checkedIn(agent);
    return c.json({ message: views.message(message), delivery, ...(note ? { note } : {}) }, 201);
  });

  // With ?wait=N, answers as soon as something arrives, or after N seconds (capped) with nothing.
  api.get("/inbox", async (c) => {
    const agent = c.get("agent");
    const waitMs = inboxWaitMs(c.req.query("wait"));
    if (waitMs > 0) {
      const outcome = await messages.waitForInbox(agent, waitMs, {
        signal: c.req.raw.signal,
        valid: () => deps.resolver.agent(c.req.header("authorization"), c.req.header("x-portico-session"))?.id === agent.id,
      });
      // The caller went away: what it would pick up stays waiting for its next check.
      if (outcome === "aborted") return c.body(null, 204);
      if (outcome === "gone") return unauthorized(c, deps.resolver);
    }
    const { messages: picked, updates } = messages.inbox(agent);
    return c.json({ messages: picked.map(views.delivery), updates: updates.map(views.update) });
  });

  // Peek and ack, for sessions' plugins: a GET changes nothing, and only the ack marks what was delivered.
  api.get("/deliveries", (c) => {
    const agent = c.get("agent");
    requireSession(agent, "use deliveries; apps and connectors call check_inbox");
    const pending = messages.pending(agent);
    return c.json({ messages: pending.messages.map(views.delivery), updates: pending.updates.map(views.update) });
  });

  api.post("/deliveries/ack", async (c) => {
    const agent = c.get("agent");
    requireSession(agent, "use deliveries");
    const body = AckBody.parse(await readJson(c));
    return c.json({ acked: messages.ack(agent, body) });
  });

  // Sessions' live status, kept in memory. The text is cleaned here; nothing about it is logged.
  api.post("/status", async (c) => {
    const agent = c.get("agent");
    requireSession(agent, "report status");
    const report = parseStatusReport(await readJson(c));
    const before = presence.get(agent.id);
    presence.report(agent.id, report, deps.now().toISOString());
    agents.touch(agent);
    // The plugin repeats an unchanged report as a heartbeat; only a change is worth every open page's refetch.
    const changed =
      !before ||
      before.status !== report.status ||
      before.doing !== report.doing ||
      before.repo !== report.repo ||
      before.branch !== report.branch;
    if (changed) deps.changes.emit("agents");
    return c.json({ ok: true });
  });

  api.onError(handleError);
  return api;
}
