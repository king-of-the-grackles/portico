import { describe, expect, test } from "bun:test";
import { ADMIN_PASSWORD, BASE_YAML, HOUR, flush, makeApp, signIn, testConfig } from "./helpers";

const login = (password: string) => ({ method: "POST", body: new URLSearchParams({ password }) });

describe("hub page sign-in", () => {
  test("pages redirect to sign-in without a session", async () => {
    const { app } = makeApp();
    for (const path of ["/hub", "/hub/history", "/hub/tasks/x"]) {
      const res = await app.request(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/hub/login");
    }
  });

  test("a wrong password is refused; the right one sets a strict session cookie", async () => {
    const { app } = makeApp();
    const wrong = await app.request("/hub/login", login("nope"));
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("set-cookie")).toBeNull();
    expect(await wrong.text()).toContain("Wrong password.");
    const right = await app.request("/hub/login", login(ADMIN_PASSWORD));
    expect(right.status).toBe(303);
    expect(right.headers.get("location")).toBe("/hub");
    const cookie = right.headers.get("set-cookie")!;
    expect(cookie).toStartWith("bridge_session=");
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Path=/hub", "Max-Age=604800"]) {
      expect(cookie).toContain(part);
    }
  });

  test("ten failed attempts lock sign-in for fifteen minutes", async () => {
    const { app, clock } = makeApp();
    for (let i = 0; i < 10; i++) expect((await app.request("/hub/login", login("nope"))).status).toBe(401);
    expect((await app.request("/hub/login", login(ADMIN_PASSWORD))).status).toBe(429);
    clock.advance(15 * 60_000 + 1);
    expect((await app.request("/hub/login", login(ADMIN_PASSWORD))).status).toBe(303);
  });

  test("a tampered or expired session is refused", async () => {
    const { app, clock } = makeApp();
    const cookie = await signIn(app);
    expect((await app.request("/hub", { headers: { cookie } })).status).toBe(200);
    expect((await app.request("/hub", { headers: { cookie: `${cookie}x` } })).status).toBe(303);
    clock.advance(7 * 24 * HOUR + 1);
    expect((await app.request("/hub", { headers: { cookie } })).status).toBe(303);
  });

  test("signing out clears the cookie", async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await app.request("/hub/logout", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hub/login");
    expect(res.headers.get("set-cookie")).toContain("bridge_session=;");
  });
});

describe("hub page", () => {
  test("lists waiting tasks, permission prompts, and agents with their last check-in", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    ctx.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the <b>inbox</b>" });
    await ctx.call("claude-code", "POST", "/api/permission-requests", {
      request_id: "abcde",
      tool_name: "Bash",
      input_preview: "bun test",
    });
    ctx.service.checkInbox("codex");
    const res = await ctx.app.request("/hub", { headers: { cookie } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain("Summarize the &lt;b&gt;inbox&lt;/b&gt;");
    expect(page).toContain("claude-code wants to use <strong>Bash</strong>");
    expect(page).toContain("bun test");
    expect(page).toContain("2026-10-20 12:00 UTC"); // codex's check-in
    expect(page).toContain("Not since the last restart");
    expect(page).toContain("not connected"); // claude-code is a push agent with no stream open
  });

  test("approve and deny from the page", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const a = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    const b = ctx.service.sendTask("codex", { to: "muse", instructions: "two" });
    expect((await ctx.app.request(`/hub/tasks/${a.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(200);
    expect(ctx.service.findTask(a.id)?.status).toBe("queued");
    const deny = await ctx.app.request(`/hub/tasks/${b.id}/deny`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ note: "Not this week" }),
    });
    expect(deny.status).toBe(200);
    expect(ctx.service.findTask(b.id)).toMatchObject({ status: "denied", reason: "Not this week" });
  });

  test("a deny note over the size limit changes nothing", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    const res = await ctx.app.request(`/hub/tasks/${task.id}/deny`, {
      method: "POST",
      headers: { cookie },
      body: new URLSearchParams({ note: "x".repeat(20 * 1024 + 1) }),
    });
    expect(res.status).toBe(413);
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
  });

  test("form posts need a session and the hub's own origin", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    const approve = (headers: Record<string, string>) =>
      ctx.app.request(`/hub/tasks/${task.id}/approve`, { method: "POST", headers });
    expect((await approve({})).status).toBe(403);
    expect((await approve({ cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(ctx.service.findTask(task.id)?.status).toBe("waiting_approval");
    expect((await approve({ cookie, origin: "https://bridge.test" })).status).toBe(200);
  });

  test("allow a permission prompt from the page", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    await ctx.call("claude-code", "POST", "/api/permission-requests", { request_id: "abcde", tool_name: "Bash" });
    const res = await ctx.app.request("/hub/permissions/claude-code/abcde/allow", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(200);
    expect(ctx.relay.get("claude-code", "abcde")?.answer).toBe("allow");
  });

  test("history filters by agent and status, and ignores unknown filter values", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "alpha-task" });
    ctx.service.sendTask("codex", { to: "grok-bot", instructions: "beta-task" });
    // Triggers: muse → claude-code is allowed; muse → grok-bot has no rule, so that task is denied.
    ctx.service.reportEvent("muse", { name: "bug_report_received", details: "gamma-details" });
    const get = async (query: string) => (await ctx.app.request(`/hub/history${query}`, { headers: { cookie } })).text();

    const all = await get("");
    for (const text of ["alpha-task", "beta-task", "gamma-details"]) expect(all).toContain(text);
    const codexOnly = await get("?agent=codex");
    expect(codexOnly).toContain("beta-task");
    expect(codexOnly).not.toContain("alpha-task");
    expect(codexOnly).not.toContain("gamma-details");
    const denied = await get("?status=denied");
    expect(denied).toContain("Research: gamma-details");
    expect(denied).not.toContain("alpha-task");
    expect(await get("?status=bogus&agent=nobody")).toContain("alpha-task");
  });

  test("task detail shows the chain that led to the task", async () => {
    const ctx = makeApp(testConfig(`${BASE_YAML}\nlimits:\n  max_chain_length: 2\n`));
    const cookie = await signIn(ctx.app);
    const parent = ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "parent-task" });
    ctx.service.checkInbox("claude-code");
    const child = ctx.service.sendTask("claude-code", { to: "muse", instructions: "child-task" });
    const page = await (await ctx.app.request(`/hub/tasks/${child.id}`, { headers: { cookie } })).text();
    expect(page).toContain("child-task");
    expect(page).toContain("Chain");
    expect(page).toContain("parent-task");
    expect(page).toContain(`/hub/tasks/${parent.id}`);
    expect((await ctx.app.request("/hub/tasks/missing", { headers: { cookie } })).status).toBe(404);
  });

  test("page copy has no pronouns and never names the app", async () => {
    const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;
    const visibleText = (page: string) =>
      page
        .replace(/<style>[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&[a-z0-9#]+;/gi, " ");
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
    await ctx.call("claude-code", "POST", "/api/permission-requests", {
      request_id: "abcde",
      tool_name: "Bash",
      description: "Run the tests",
    });
    await flush();
    const approvePath = new URL(ctx.pushes[0]!.actions[0]!.url).pathname;
    const pages = [
      await (await ctx.app.request("/hub/login")).text(),
      await (await ctx.app.request("/hub", { headers: { cookie } })).text(),
      await (await ctx.app.request("/hub/history", { headers: { cookie } })).text(),
      await (await ctx.app.request(`/hub/tasks/${task.id}`, { headers: { cookie } })).text(),
      await (await ctx.app.request(approvePath)).text(),
      await (await ctx.app.request(approvePath, { method: "POST" })).text(),
      await (await ctx.app.request(approvePath, { method: "POST" })).text(),
      await (await ctx.app.request("/approve/not-a-token")).text(),
      await (await ctx.app.request("/hub/permissions/claude-code/abcde/deny", { method: "POST", headers: { cookie } })).text(),
      await (await ctx.app.request("/hub/login", login("nope"))).text(),
    ];
    for (const page of pages) {
      const text = visibleText(page);
      expect(text).not.toMatch(PRONOUNS);
      expect(text.toLowerCase()).not.toContain("agent-bridge");
    }
  });
});
