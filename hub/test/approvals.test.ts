import { describe, expect, test } from "bun:test";
import { signLink } from "../src/approvals/links";
import { HOUR, flush, makeApp } from "./helpers";

type Ctx = ReturnType<typeof makeApp>;

async function askTask(ctx: Ctx, instructions = "Summarize the inbox") {
  const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions });
  await flush();
  const push = ctx.pushes.at(-1)!;
  const path = (label: string) => new URL(push.actions.find((action) => action.label === label)!.url).pathname;
  return { task, approvePath: path("Approve"), denyPath: path("Deny") };
}

describe("approval links", () => {
  test("opening a link shows the task and a confirm form, and changes nothing", async () => {
    const ctx = makeApp();
    const { task, approvePath } = await askTask(ctx, "Summarize <script>alert(1)</script>");
    const res = await ctx.app.request(approvePath);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Approve this task?");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toContain("<script>");
    expect(page).toContain('<form method="post">');
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
  });

  test("pages carry the security headers", async () => {
    const ctx = makeApp();
    const { approvePath } = await askTask(ctx);
    const res = await ctx.app.request(approvePath);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
  });

  test("a POST approves once; a second POST changes nothing", async () => {
    const ctx = makeApp();
    const { task, approvePath } = await askTask(ctx);
    const res = await ctx.app.request(approvePath, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Approved.");
    expect(ctx.service.findTask(task.id)?.status).toBe("queued");
    expect(ctx.notices.at(-1)).toMatchObject({ kind: "queued" });
    const again = await ctx.app.request(approvePath, { method: "POST" });
    expect(again.status).toBe(200);
    expect(await again.text()).toContain("no longer waiting for approval");
    expect(ctx.service.findTask(task.id)?.status).toBe("queued");
  });

  test("an old link never shows a failed task's reason", async () => {
    const ctx = makeApp();
    const { task, approvePath } = await askTask(ctx);
    await ctx.app.request(approvePath, { method: "POST" });
    expect(ctx.service.checkInbox("muse").tasks.map((t) => t.id)).toContain(task.id);
    ctx.service.finishTask("muse", { taskId: task.id, failedReason: "SECRET-FAILURE" });
    expect(ctx.service.findTask(task.id)?.status).toBe("failed");
    for (const res of [await ctx.app.request(approvePath), await ctx.app.request(approvePath, { method: "POST" })]) {
      const page = await res.text();
      expect(page).toContain("no longer waiting for approval");
      expect(page).not.toContain("SECRET-FAILURE");
    }
  });

  test("deny takes an optional note from the confirm form", async () => {
    const ctx = makeApp();
    const { task, denyPath } = await askTask(ctx);
    expect(await (await ctx.app.request(denyPath)).text()).toContain('name="note"');
    const res = await ctx.app.request(denyPath, { method: "POST", body: new URLSearchParams({ note: "Not now" }) });
    expect(res.status).toBe(200);
    expect(ctx.service.findTask(task.id)).toMatchObject({ status: "denied", reason: "Not now" });
  });

  test("ntfy's bodiless POST denies with the default reason", async () => {
    const ctx = makeApp();
    const { task, denyPath } = await askTask(ctx);
    expect((await ctx.app.request(denyPath, { method: "POST" })).status).toBe(200);
    expect(ctx.service.findTask(task.id)).toMatchObject({ status: "denied", reason: "denied by the user" });
  });

  test("a link for one action doesn't work for the other, and tampered or expired links do nothing", async () => {
    const ctx = makeApp();
    const { task, approvePath, denyPath } = await askTask(ctx);
    const approveToken = approvePath.slice("/approve/".length);
    expect((await ctx.app.request(`/deny/${approveToken}`, { method: "POST" })).status).toBe(404);
    expect((await ctx.app.request(`${approvePath}x`, { method: "POST" })).status).toBe(404);
    expect((await ctx.app.request("/approve/not-a-token")).status).toBe(404);
    ctx.clock.advance(25 * HOUR);
    expect((await ctx.app.request(denyPath, { method: "POST" })).status).toBe(404);
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
  });
});

describe("permission links", () => {
  test("Allow sends the answer; repeats change nothing; expired links do nothing", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", {
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run the tests",
      input_preview: "bun test",
    });
    await flush();
    const allowPath = new URL(ctx.pushes.at(-1)!.actions[0]!.url).pathname;
    const confirm = await (await ctx.app.request(allowPath)).text();
    expect(confirm).toContain("claude-code wants to use Bash");
    expect(confirm).toContain("bun test");
    expect(ctx.relay.get("claude-code", "abcde")?.answer).toBeNull();

    const res = await ctx.app.request(allowPath, { method: "POST" });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("Allowed.");
    expect(page).toContain("isn't connected right now");
    expect(ctx.relay.get("claude-code", "abcde")?.answer).toBe("allow");
    expect(await (await ctx.app.request(allowPath, { method: "POST" })).text()).toContain("Already answered");

    ctx.clock.advance(HOUR);
    expect((await ctx.app.request(allowPath, { method: "POST" })).status).toBe(404);
  });

  test("a permission link for another agent's prompt, or after a restart, changes nothing", async () => {
    const ctx = makeApp();
    await ctx.call("claude-code", "POST", "/api/permission-requests", { request_id: "abcde", tool_name: "Bash" });
    // Correctly signed, but for an agent whose prompt this isn't.
    const otherAgent = signLink(ctx.config.signingSecret, {
      subject: "permission",
      id: "abcde",
      agent: "claude-code-other",
      action: "approve",
      expiresAt: "2026-10-20T13:00:00.000Z",
    });
    expect((await ctx.app.request(`/approve/${otherAgent}`, { method: "POST" })).status).toBe(404);
    await flush();
    const allowPath = new URL(ctx.pushes.at(-1)!.actions[0]!.url).pathname;
    const restarted = makeApp(ctx.config); // same secret, empty in-memory relay
    expect((await restarted.app.request(allowPath, { method: "POST" })).status).toBe(404);
    expect(ctx.relay.get("claude-code", "abcde")?.answer).toBeNull();
  });
});

describe("expired and oversized approval links", () => {
  test("an expired permission link says the prompt is no longer pending; a tampered one is still invalid", async () => {
    const { app, relay, config, clock } = makeApp();
    relay.add("claude-code", { requestId: "abcde", toolName: "Bash" });
    const token = signLink(config.signingSecret, {
      subject: "permission",
      id: "abcde",
      agent: "claude-code",
      action: "approve",
      expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(),
    });
    clock.advance(3_600_001);
    for (const method of ["GET", "POST"]) {
      const res = await app.request(`/approve/${token}`, { method });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("This permission prompt is no longer pending.");
    }
    const tampered = (token[0] === "A" ? "B" : "A") + token.slice(1);
    expect(await (await app.request(`/approve/${tampered}`)).text()).toContain("This link is invalid or has expired.");
  });

  test("an expired task link shows what happened to the task", async () => {
    const { app, service, config, clock } = makeApp();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const token = signLink(config.signingSecret, { subject: "task", id: task.id, action: "approve", expiresAt: task.expiresAt });
    clock.advance(25 * 3_600_000);
    service.expireDue();
    const res = await app.request(`/approve/${token}`);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("This task is no longer waiting for approval.");
    expect(page).toContain("Nothing was changed.");
  });

  test("an oversized deny note on a link gets an HTML 413 page", async () => {
    const { app, service, config } = makeApp();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "x" });
    const token = signLink(config.signingSecret, { subject: "task", id: task.id, action: "deny", expiresAt: task.expiresAt });
    const res = await app.request(`/deny/${token}`, { method: "POST", body: new URLSearchParams({ note: "x".repeat(70 * 1024) }) });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(service.findTask(task.id)?.status).toBe("waiting_approval");
  });
});
