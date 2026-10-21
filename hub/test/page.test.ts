import { describe, expect, test } from "bun:test";
import { safeNext } from "../src/page/session";
import { ADMIN_PASSWORD, BASE_YAML, HOUR, PRONOUNS, flush, makeApp, signIn, testConfig, visibleCopy } from "./helpers";

const login = (password: string) => ({ method: "POST", body: new URLSearchParams({ password }) });

describe("hub page sign-in", () => {
  test("pages redirect to sign-in without a session", async () => {
    const { app } = makeApp();
    for (const path of ["/hub", "/hub/history", "/hub/tasks/x"]) {
      const res = await app.request(path);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe(
        path === "/hub" ? "/hub/login" : `/hub/login?next=${encodeURIComponent(path)}`,
      );
    }
  });

  test("a trailing slash on /hub redirects to /hub", async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await app.request("/hub/", { headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hub");
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

  test("parallel wrong attempts cannot get past the limiter", async () => {
    const { app } = makeApp();
    const statuses = (await Promise.all(Array.from({ length: 15 }, () => app.request("/hub/login", login("nope"))))).map(
      (r) => r.status,
    );
    expect(statuses.filter((s) => s === 401)).toHaveLength(10);
    expect(statuses.filter((s) => s === 429)).toHaveLength(5);
    expect((await app.request("/hub/login", login(ADMIN_PASSWORD))).status).toBe(429);
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

  test("waiting cards show the chain", async () => {
    const ctx = makeApp(testConfig(`${BASE_YAML}\nlimits:\n  max_chain_length: 2\n`));
    const cookie = await signIn(ctx.app);
    ctx.service.sendTask("grok-bot", { to: "claude-code", instructions: "parent-task" });
    ctx.service.checkInbox("claude-code");
    ctx.service.sendTask("claude-code", { to: "muse", instructions: "child-task" });
    const page = await (await ctx.app.request("/hub", { headers: { cookie } })).text();
    for (const text of ["child-task", "Chain", "parent-task"]) expect(page).toContain(text);
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
      const text = visibleCopy(page);
      expect(text).not.toMatch(PRONOUNS);
      expect(text.toLowerCase()).not.toContain("agent-bridge");
    }
  });

  test("the copy sweep skips paste text and reads attribute text", () => {
    const page = `<style>p{}</style><p>Shown &amp; read</p><pre>Join my agent bridge</pre><code>your-token</code>
<textarea readonly class="paste" aria-label="Connect prompt">Use your token</textarea>
<input placeholder="Name it" title='Their title'><img alt="Our logo" src="x.png">`;
    const text = visibleCopy(page);
    expect(text).toContain("Shown");
    expect(text).toContain("read");
    for (const hidden of ["p{}", "agent bridge", "your-token", "Use your token", "&amp;"]) expect(text).not.toContain(hidden);
    for (const shown of ["Connect prompt", "Name it", "Their title", "Our logo"]) expect(text).toContain(shown);
  });
});

describe("hub page: carried-over fixes", () => {
  test("a signed-out visit to a task page returns there after sign-in", async () => {
    const { app, service } = makeApp();
    const task = service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the inbox" });
    const page = `/hub/tasks/${task.id}`;

    const res = await app.request(page);
    expect(res.status).toBe(303);
    const login = res.headers.get("location")!;
    expect(login).toBe(`/hub/login?next=${encodeURIComponent(page)}`);
    expect(await (await app.request(login)).text()).toContain(`<input type="hidden" name="next" value="${page}">`);

    const signedIn = await app.request("/hub/login", {
      method: "POST",
      body: new URLSearchParams({ password: ADMIN_PASSWORD, next: page }),
    });
    expect(signedIn.status).toBe(303);
    expect(signedIn.headers.get("location")).toBe(page);
  });

  test("sign-in only returns to pages under /hub", () => {
    expect(safeNext("/hub/tasks/abc")).toBe("/hub/tasks/abc");
    expect(safeNext("/hub/history?agent=muse&status=done")).toBe("/hub/history?agent=muse&status=done");
    for (const bad of [
      "//evil.example",
      "https://evil.example/hub",
      "/hub//evil.example",
      "/hubx",
      "/hub/../x",
      "/hub/%2e%2e/x",
      "/hub\\evil",
      "/hub/login?next=/hub",
      undefined,
      5,
    ]) {
      expect(safeNext(bad)).toBe("/hub");
    }
  });

  test("a signed-in visit to the sign-in page goes straight to next", async () => {
    const { app } = makeApp();
    const cookie = await signIn(app);
    const res = await app.request("/hub/login?next=%2Fhub%2Fhistory", { headers: { cookie } });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hub/history");
  });

  test("HEAD without a session redirects like GET", async () => {
    const { app } = makeApp();
    const res = await app.request("/hub", { method: "HEAD" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hub/login");
  });

  test("the waiting list shows the oldest first, and says when more are waiting", async () => {
    const { app, service, clock } = makeApp(testConfig(`${BASE_YAML}\nlimits:\n  tasks_per_hour_per_agent: 500\n`));
    for (let i = 0; i < 101; i++) {
      service.sendTask("grok-bot", { to: "muse", instructions: `job-${String(i).padStart(3, "0")}` });
      clock.advance(1000);
    }
    const cookie = await signIn(app);
    const page = await (await app.request("/hub", { headers: { cookie } })).text();
    expect(page).toContain("job-000");
    expect(page).toContain("job-099");
    expect(page).not.toContain("job-100");
    expect(page.indexOf("job-000")).toBeLessThan(page.indexOf("job-099"));
    expect(page).toContain("Showing the oldest 100 tasks. More are waiting.");
  });

  test("an oversized form gets an HTML 413 page", async () => {
    const { app } = makeApp();
    const res = await app.request("/hub/login", {
      method: "POST",
      body: new URLSearchParams({ password: "x".repeat(70 * 1024) }),
    });
    expect(res.status).toBe(413);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("The form is too large.");
  });
});
