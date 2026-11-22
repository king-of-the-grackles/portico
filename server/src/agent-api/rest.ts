import { Hono } from "hono";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { Agents } from "../core/agents";
import type { Changes } from "../core/changes";
import { HTTP_STATUS, PorticoError } from "../core/errors";
import type { Files } from "../core/files";
import { inboxWaitMs } from "../core/inbox-waits";
import { DELIVERY_BATCH_MAX, type Messages } from "../core/messages";
import type { Tasks } from "../core/tasks";
import type { WakeUrls } from "../core/wake-urls";
import type { Feedback } from "../core/feedback";
import type { AgentNotices } from "../core/notices";
import { parseStatusReport, type Presence } from "../core/presence";
import { errorName, log } from "../log";
import { type AgentEnv, requireAgent, requireSession, type Resolver, unauthorized } from "./auth";
import { jsonBodyLimit } from "./limits";
import { getAgentTask, listAgentTasks } from "./tasks";
import { type AgentViews, UNTRUSTED_PROFILES } from "./views";
import { runPorticoTool, PORTICO_TOOL_NAMES, type PorticoToolDeps, porticoFilter } from "./portico-tools";

const SendBody = z.object({
  to: z.string().optional(),
  subject: z.string(),
  text: z.string(),
  reply_to: z.string().optional(),
  summary: z.string().optional(),
  done: z.boolean().nullish(),
  key: z.string().nullish(),
  attachments: z.array(z.string()).nullish(),
});
const UploadBody = z.object({
  name: z.string(),
  type: z.string().nullish(),
  size: z.number().nullish(),
  text: z.string().nullish(),
});
const FeedbackBody = z.object({ kind: z.string(), title: z.string(), details: z.string() });
const ProfileBody = z.object({ description: z.string().nullish(), doing: z.string().nullish() });
const WakeBody = z.union([z.object({ url: z.string(), key: z.string() }), z.object({ schedule_minutes: z.number().nullable() })]);
const AckIds = z.array(z.string()).max(DELIVERY_BATCH_MAX).default([]);
const AckBody = z.object({ messages: AckIds, updates: AckIds, notices: AckIds });

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
  tasks: Tasks;
  files: Files;
  presence: Presence;
  wakeUrls: WakeUrls;
  feedback: Feedback;
  views: AgentViews;
  resolver: Resolver;
  changes: Changes;
  now: () => Date;
  porticoTools: PorticoToolDeps;
  /** Portico's own notices to agents, delivered beside messages and outcomes. */
  notices: AgentNotices;
}

/**
 * The agent API under /api/agent: the agent list, messages, the inbox, the agent's tasks and its own profile, and
 * sessions' deliveries and status.
 */
export function agentRestRoutes(deps: AgentRestDeps): Hono<AgentEnv> {
  const { agents, messages, presence, views } = deps;
  const api = new Hono<AgentEnv>();

  api.use("*", jsonBodyLimit());
  api.use("*", requireAgent(deps.resolver));

  api.get("/agents", (c) => {
    const agent = c.get("agent");
    agents.checkedIn(agent);
    return c.json(views.list(agent, porticoFilter(deps.porticoTools.workspaces, agent, c.req.query("portico"))));
  });

  // The Portico tools, one route for all: the body is the tool's arguments, as on /mcp.
  api.post("/portico-tools/:name", async (c) => {
    const agent = c.get("agent");
    const name = c.req.param("name");
    if (!PORTICO_TOOL_NAMES.includes(name)) throw new PorticoError("not_found", "No such tool.");
    const body = c.req.header("content-length") === "0" ? {} : await readJson(c).catch(() => ({}));
    const args = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    agents.checkedIn(agent);
    return c.json(runPorticoTool(deps.porticoTools, agent, name, args));
  });

  api.post("/messages", async (c) => {
    const body = SendBody.parse(await readJson(c));
    const agent = c.get("agent");
    await deps.files.settle(agent, body.attachments);
    const { message, delivery, note, workspace } = messages.send(agent, {
      to: body.to,
      subject: body.subject,
      text: body.text,
      replyTo: body.reply_to,
      summary: body.summary,
      done: body.done,
      key: body.key,
      attachments: body.attachments,
    });
    agents.checkedIn(agent);
    return c.json({ ...views.sent(message, delivery, workspace, agent), ...(note ? { note } : {}) }, 201);
  });

  // Starts a file to attach. Small text comes in the call; anything else gets an address to PUT the bytes to.
  api.post("/files", async (c) => {
    const body = UploadBody.parse(await readJson(c));
    const agent = c.get("agent");
    const { file, upload } = await deps.files.createUpload(agent, body);
    agents.checkedIn(agent);
    return c.json({ file: { ...views.file(file), status: file.status }, ...(upload ? { upload } : {}) }, 201);
  });

  // A file's own address: checks the caller may have the file, then sends the caller on to a short-lived download.
  api.get("/files/:id", async (c) => {
    const agent = c.get("agent");
    const file = deps.files.forAgent(agent, c.req.param("id"));
    if (!file) throw new PorticoError("not_found", "No such file among this agent's files.");
    const link = await deps.files.link(file);
    return c.redirect(link.url, 302);
  });

  api.get("/tasks", (c) => {
    const agent = c.get("agent");
    const q = (name: string) => c.req.query(name);
    return c.json(
      listAgentTasks(deps, agent, { outcome: q("outcome"), with: q("with"), since: q("since"), before: q("before"), limit: q("limit") }),
    );
  });

  api.get("/tasks/:id", async (c) => c.json(await getAgentTask(deps, c.get("agent"), c.req.param("id"))));

  // The agent's own description and doing line; the person who manages it can still change the description.
  api.patch("/profile", async (c) => {
    const body = ProfileBody.parse(await readJson(c));
    const agent = agents.updateOwn(c.get("agent"), body);
    agents.checkedIn(agent);
    return c.json({ agent: views.entry(agents.entry(agent)) });
  });

  // An app's own webhook trigger, registered while joining, so no person has to paste the address and key. The key
  // goes in once and never comes back out. The agent's page shows the host, and Activity records each change.
  // Portico sends one test wake at once, and the answer says how the test went. An app that can't be woken states the
  // minutes between its scheduled checks here instead.
  api.put("/wake", async (c) => {
    const body = WakeBody.parse(await readJson(c));
    const agent = c.get("agent");
    if ("schedule_minutes" in body) {
      const updated = agents.setCheckMinutes(agent, body.schedule_minutes);
      agents.checkedIn(updated);
      return c.json(views.wakeStatus(updated));
    }
    const wake = await deps.wakeUrls.set(agent, null, body);
    const test = await deps.wakeUrls.test(agent, agents.display(agent));
    agents.checkedIn(agent);
    const status = views.wakeStatus(agent);
    return c.json({ ...status, wake: { host: wake.host, test, ...status.wake } });
  });

  // Where this agent's wake-ups stand, and what is left to do while they aren't on.
  api.get("/wake", (c) => c.json(views.wakeStatus(c.get("agent"))));

  api.delete("/wake", (c) => {
    const agent = c.get("agent");
    deps.wakeUrls.clear(agent, null);
    agents.checkedIn(agent);
    return c.body(null, 204);
  });

  // With ?wait=N, answers as soon as something arrives, or after N seconds (capped) with nothing.
  api.get("/inbox", async (c) => {
    const agent = c.get("agent");
    const waitMs = inboxWaitMs(c.req.query("wait"));
    if (waitMs > 0) {
      const outcome = await messages.waitForInbox(agent, waitMs, {
        // Each terminal or Codex conversation in a folder gets its own allowance of waiting calls.
        slot: c.get("runId") ?? undefined,
        signal: c.req.raw.signal,
        valid: () => deps.resolver.agent(c.req.header("authorization"), c.req.header("x-portico-session"))?.id === agent.id,
      });
      // The caller went away: what it would pick up stays waiting for its next check.
      if (outcome === "aborted") return c.body(null, 204);
      if (outcome === "gone") return unauthorized(c, deps.resolver);
    }
    const { messages: picked, updates } = messages.inbox(agent);
    return c.json({
      messages: picked.map((m) => views.delivery(m, agent)),
      updates: updates.map((m) => views.update(m, agent)),
      notices: deps.notices.take(agent.id).map(views.notice),
      ...views.heldForPerson(agent),
      ...views.wakeStatus(agent),
    });
  });

  // Peek and ack, for sessions' plugins: a GET changes nothing, and only the ack marks what was delivered.
  api.get("/deliveries", (c) => {
    const agent = c.get("agent");
    requireSession(agent, "use deliveries; apps and connectors call check_inbox");
    const pending = messages.pending(agent);
    return c.json({
      messages: pending.messages.map((m) => views.delivery(m, agent)),
      updates: pending.updates.map((m) => views.update(m, agent)),
      notices: deps.notices.waiting(agent.id, DELIVERY_BATCH_MAX).map(views.notice),
    });
  });

  // Feedback about Portico: saved, and nothing else happens.
  api.post("/feedback", async (c) => {
    const body = FeedbackBody.parse(await readJson(c));
    const agent = c.get("agent");
    const saved = deps.feedback.submit(agent, body);
    agents.checkedIn(agent);
    return c.json(views.feedbackSaved(saved.id), 201);
  });

  api.post("/deliveries/ack", async (c) => {
    const agent = c.get("agent");
    requireSession(agent, "use deliveries");
    const body = AckBody.parse(await readJson(c));
    return c.json({ acked: { ...messages.ack(agent, body), notices: deps.notices.ack(agent.id, body.notices) } });
  });

  // Sessions' live status, kept in memory. The text is cleaned here; nothing about it is logged.
  api.post("/status", async (c) => {
    const agent = c.get("agent");
    requireSession(agent, "report status");
    const report = parseStatusReport(await readJson(c));
    const before = presence.get(agent.id);
    const runId = c.get("runId");
    presence.report(agent.id, runId ?? agent.id, report, deps.now().toISOString());
    agents.touch(agent, runId);
    // The plugin repeats an unchanged report as a heartbeat; only a change in what the agent shows (the busiest run's
    // report) is worth every open page's refetch.
    const after = presence.get(agent.id);
    const changed =
      !before ||
      !after ||
      before.status !== after.status ||
      before.doing !== after.doing ||
      before.repo !== after.repo ||
      before.branch !== after.branch;
    if (changed) deps.changes.about({ agents: [agent.id] }, "agents");
    return c.json({ ok: true });
  });

  api.onError(handleError);
  return api;
}
