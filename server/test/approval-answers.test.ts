import { afterEach, describe, expect, test } from "bun:test";
import { approvalRoutes } from "../src/approvals/routes";
import { createPortico } from "../src/portico";
import { captureLogs } from "../src/log";
import { openDb } from "../src/db";
import {
  callAs,
  flush,
  HOUR,
  joinMachine,
  makeApp,
  mintAssistant,
  openSessionStream,
  type SseEvent,
  signIn,
  testConfig,
} from "./helpers";

// BASE_YAML sends every task for muse through an ask rule ("*" → muse).
type Ctx = ReturnType<typeof makeApp>;
const streams: { cancel(): Promise<void> }[] = [];
afterEach(async () => {
  for (const events of streams.splice(0)) await events.cancel();
});

async function popupSession(ctx: Ctx, token: string, key: string, repo: string, folder = "a") {
  const session = await openSessionStream(ctx, token, { key, repo, folderId: folder.repeat(64), popup: true });
  streams.push(session.events);
  return { ...session, auth: { token, key } };
}

const request = (event: SseEvent) => event.data as { taskId: string; nonce: string };
const answer = (ctx: Ctx, auth: { token: string; key: string }, taskId: string, body: unknown) =>
  callAs(ctx, auth, "POST", `/api/approvals/${taskId}`, body);

/** Runs fn with the hub's log lines captured, and returns them parsed. */
async function logsOf(fn: () => Promise<void>): Promise<Record<string, unknown>[]> {
  const lines: string[] = [];
  captureLogs((line) => lines.push(line));
  try {
    await fn();
  } finally {
    captureLogs(null);
  }
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("pop-up approvals", () => {
  test("each machine's oldest pop-up session gets the request; Approve from one closes the others", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx, "macbook");
    const studio = joinMachine(ctx, "studio");
    const first = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const second = await popupSession(ctx, mac.token, "key-mac-second", "web", "b");
    const other = await popupSession(ctx, studio.token, "key-studio-one", "notes");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });

    const sent = await first.events.next();
    expect(sent).toEqual({
      event: "approval_request",
      data: {
        taskId: task.id,
        nonce: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/),
        from: "grok-bot",
        to: "muse",
        instructions: "Summarize the inbox",
        expiresAt: task.expiresAt,
      },
    });
    const studioSent = await other.events.next();
    expect(studioSent.event).toBe("approval_request");
    expect(request(studioSent).nonce).not.toBe(request(sent).nonce);
    await expect(second.events.next(150)).rejects.toThrow("timed out");

    const res = await answer(ctx, first.auth, task.id, { nonce: request(sent).nonce, decision: "approve" });
    expect(res.status).toBe(200);
    expect((await res.json()).task.status).toBe("queued");
    const closed = { event: "approval_closed", data: { taskId: task.id, outcome: "approved" } };
    expect(await other.events.next()).toEqual(closed);
    expect(await first.events.next()).toEqual(closed);
  });

  test("Deny carries the note as the task's reason; a note sent with Approve is ignored", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const denied = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    const first = request(await session.events.next());
    expect((await answer(ctx, session.auth, denied.id, { nonce: first.nonce, decision: "deny", note: "Not this week" })).status).toBe(200);
    expect(ctx.service.findTask(denied.id)).toMatchObject({ status: "denied", reason: "Not this week" });
    expect((await session.events.next()).event).toBe("approval_closed");
    const approved = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "two" });
    const second = request(await session.events.next());
    expect((await answer(ctx, session.auth, approved.id, { nonce: second.nonce, decision: "approve", note: "ignored" })).status).toBe(200);
    expect(ctx.service.findTask(approved.id)).toMatchObject({ status: "queued", reason: null });
  });

  test("an expired task closes its pop-ups with the outcome expired", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    await session.events.next();
    ctx.clock.advance(25 * HOUR);
    ctx.service.expireDue();
    expect(await session.events.next()).toEqual({ event: "approval_closed", data: { taskId: task.id, outcome: "expired" } });
  });
});

describe("the answer path refuses", () => {
  test("a wrong nonce, another session's nonce, an unknown task and callers that aren't sessions, and the task keeps waiting", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const holder = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const bystander = await popupSession(ctx, mac.token, "key-mac-second", "web", "b");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const { nonce } = request(await holder.events.next());
    const refused = { error: "not_allowed", message: "No approval request for this session matches." };

    const wrong = await answer(ctx, holder.auth, task.id, { nonce: "A".repeat(32), decision: "approve" });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual(refused);
    const stolen = await answer(ctx, bystander.auth, task.id, { nonce, decision: "approve" });
    expect(stolen.status).toBe(403);
    expect(await stolen.json()).toEqual(refused);
    expect((await answer(ctx, holder.auth, "no-such-task", { nonce, decision: "approve" })).status).toBe(403);
    const agent = await ctx.call("grok-bot", "POST", `/api/approvals/${task.id}`, { nonce, decision: "approve" });
    expect(agent.status).toBe(403);
    expect((await agent.json()).message).toBe("Only a session on a joined machine answers approval requests.");
    const assistant = mintAssistant(ctx, "helper");
    const byAssistant = await callAs(ctx, { token: assistant.token }, "POST", `/api/approvals/${task.id}`, { nonce, decision: "approve" });
    expect(byAssistant.status).toBe(403);
    expect((await byAssistant.json()).message).toBe("Only a session on a joined machine answers approval requests.");
    expect((await ctx.call(null, "POST", `/api/approvals/${task.id}`, { nonce, decision: "approve" })).status).toBe(401);
    expect((await callAs(ctx, { token: mac.token }, "POST", `/api/approvals/${task.id}`, { nonce, decision: "approve" })).status).toBe(401);
    expect((await answer(ctx, holder.auth, task.id, { nonce, decision: "maybe" })).status).toBe(400);
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
  });

  test("a decision on the hub page closes every pop-up, and a later pop-up answer gets 409", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const { nonce } = request(await session.events.next());
    const cookie = await signIn(ctx.app);
    const page = await ctx.app.request(`/hub/tasks/${task.id}/deny`, { method: "POST", headers: { cookie }, body: new URLSearchParams({ note: "No" }) });
    expect(page.status).toBe(200);
    expect(await session.events.next()).toEqual({ event: "approval_closed", data: { taskId: task.id, outcome: "denied" } });
    const late = await answer(ctx, session.auth, task.id, { nonce, decision: "approve" });
    expect(late.status).toBe(409);
    expect((await late.json()).error).toBe("wrong_status");
    expect(ctx.service.findTask(task.id)?.status).toBe("denied");
  });

  test("an answer that loses the race to another decision gets 409, and is logged as refused", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    await session.events.next();
    // The desk still holds the request open, as in the moment between a decision and its close arriving.
    const route = approvalRoutes({
      config: ctx.config,
      service: ctx.service,
      directory: ctx.directory,
      desk: { check: () => "open" },
      resolvers: ctx.resolvers,
    });
    ctx.service.approveTask(task.id);
    let res!: Response;
    const logged = await logsOf(async () => {
      res = await route.request(`/${task.id}`, {
        method: "POST",
        headers: { authorization: `Bearer ${mac.token}`, "x-portico-session": "key-mac-first", "content-type": "application/json" },
        body: JSON.stringify({ nonce: "C".repeat(32), decision: "deny" }),
      });
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("wrong_status");
    expect(logged).toContainEqual(
      expect.objectContaining({ level: "warn", msg: "approval_answer_refused", task_id: task.id, agent: "api-claude@macbook", why: "decided" }),
    );
    expect(ctx.service.findTask(task.id)?.status).toBe("queued");
  });

  test("a note larger than max_text_kb is refused with 413 and the task keeps waiting", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const { nonce } = request(await session.events.next());
    const res = await answer(ctx, session.auth, task.id, { nonce, decision: "deny", note: "x".repeat(21 * 1024) });
    expect(res.status).toBe(413);
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
  });

  test("nonces, notes and task text never reach the logs", async () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    let nonce = "";
    try {
      const ctx = makeApp();
      const mac = joinMachine(ctx);
      const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
      const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "SECRET-TASK" });
      nonce = request(await session.events.next()).nonce;
      await answer(ctx, session.auth, task.id, { nonce: "B".repeat(32), decision: "approve" });
      await answer(ctx, session.auth, task.id, { nonce, decision: "deny", note: "SECRET-NOTE" });
    } finally {
      captureLogs(null);
    }
    const text = lines.join("\n");
    expect(text).not.toContain(nonce);
    expect(text).not.toMatch(/SECRET-/);
    const msgs = lines.map((line) => JSON.parse(line).msg);
    for (const msg of ["approval_request_sent", "approval_answer_refused", "approval_answered"]) expect(msgs).toContain(msg);
  });
});

describe("when sessions come and go", () => {
  test("the holder's stream closing moves the request to the next session on the machine, with its own nonce", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const holder = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const next = await popupSession(ctx, mac.token, "key-mac-second", "web", "b");
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const first = request(await holder.events.next());
    await holder.events.cancel();
    const moved = request(await next.events.next());
    expect(moved.taskId).toBe(task.id);
    expect(moved.nonce).not.toBe(first.nonce);
    expect((await answer(ctx, next.auth, task.id, { nonce: moved.nonce, decision: "approve" })).status).toBe(200);
  });

  test("a machine whose first pop-up session connects while a request is open gets it", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    await flush(); // the request opens once the task is committed
    const session = await popupSession(ctx, mac.token, "key-mac-first", "api");
    expect(await session.events.next()).toMatchObject({ event: "approval_request", data: { taskId: task.id } });
  });

  test("a session without X-Portico-Popup is never sent a request", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const plain = await openSessionStream(ctx, mac.token, { key: "key-mac-plain", repo: "api" });
    streams.push(plain.events);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    await expect(plain.events.next(150)).rejects.toThrow("timed out");
    expect(ctx.service.approvalFor(task)?.popups).toEqual([]);
  });

  test("removing a machine closes its pop-ups without moving the request to another of its sessions", async () => {
    const ctx = makeApp();
    const mac = joinMachine(ctx);
    const holder = await popupSession(ctx, mac.token, "key-mac-first", "api");
    const other = await popupSession(ctx, mac.token, "key-mac-second", "web", "b");
    ctx.service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    expect((await holder.events.next()).event).toBe("approval_request");
    const cookie = await signIn(ctx.app);
    const removed = await ctx.app.request("/hub/network/machines/macbook/remove", { method: "POST", headers: { cookie } });
    expect(removed.status).toBe(303);
    // Any event at all, an approval_request included, would be returned here instead of the stream ending.
    await expect(other.events.next()).rejects.toThrow("stream ended");
    await expect(holder.events.next()).rejects.toThrow("stream ended");
  });

  test("a task waiting when the hub starts pops up once a session connects", async () => {
    const db = openDb(":memory:");
    const config = testConfig();
    const before = createPortico(config, { db });
    const task = before.service.sendTask("grok-bot", { to: "muse", instructions: "Still waiting" });
    let after!: ReturnType<typeof createPortico>;
    const logged = await logsOf(async () => {
      after = createPortico(config, { db, heartbeatMs: 50 });
    });
    expect(logged).toContainEqual(expect.objectContaining({ level: "info", msg: "approval_requests_restored", count: 1 }));
    const mac = joinMachine(after);
    const session = await openSessionStream(after, mac.token, { key: "key-restart-01", repo: "api", popup: true });
    streams.push(session.events);
    expect(await session.events.next()).toMatchObject({ event: "approval_request", data: { taskId: task.id } });
  });
});

describe("send_task's approval info", () => {
  test("REST names the machines showing a pop-up and links the task page; other statuses get null", async () => {
    const ctx = makeApp();
    const none = await (await ctx.call("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "a" })).json();
    const url = (id: string) => `https://portico.test/hub/tasks/${id}`;
    expect(none.approval).toEqual({
      url: url(none.task.id),
      popups: [],
      note: `Waiting for the owner's approval at ${url(none.task.id)}. No joined machine is online to show a pop-up.`,
    });
    const mac = joinMachine(ctx, "macbook");
    const studio = joinMachine(ctx, "studio");
    await popupSession(ctx, mac.token, "key-mac-first", "api");
    await popupSession(ctx, studio.token, "key-studio-one", "notes");
    const two = await (await ctx.call("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "b" })).json();
    expect(two.approval).toEqual({
      url: url(two.task.id),
      popups: ["macbook", "studio"],
      note: `Waiting for the owner's approval. A pop-up is up on macbook and studio; the owner can also approve at ${url(two.task.id)}.`,
    });
    const queued = await (await ctx.call("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "c" })).json();
    expect(queued.approval).toBeNull();
  });

  test("the link needs hub sign-in", async () => {
    const ctx = makeApp();
    const sent = await (await ctx.call("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "a" })).json();
    const res = await ctx.app.request(new URL(sent.approval.url).pathname);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/hub/login?next=${encodeURIComponent(`/hub/tasks/${sent.task.id}`)}`);
  });
});
