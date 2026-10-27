import { describe, expect, test } from "bun:test";
import { safeNext } from "../src/page/session";
import { ASSISTANT_KINDS } from "../src/core/types";
import { ADMIN_PASSWORD, BASE_YAML, HOUR, PRONOUNS, TOKENS, addSession, makeApp, mintAssistant, signIn, testConfig, visibleCopy } from "./helpers";

const login = (password: string) => ({ method: "POST", body: new URLSearchParams({ password }) });

describe("hub page sign-in", () => {
  test("pages redirect to sign-in without a session", async () => {
    const { app } = makeApp();
    for (const path of ["/hub", "/hub/history", "/hub/messages", "/hub/tasks/x"]) {
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
    expect(cookie).toStartWith("portico_session=");
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
    expect(res.headers.get("set-cookie")).toContain("portico_session=;");
  });
});

describe("hub page", () => {
  test("lists waiting tasks and the directory with last check-ins", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    ctx.service.sendTask("grok-bot", { to: "muse", instructions: "Summarize the <b>inbox</b>" });
    ctx.service.checkInbox("codex");
    const res = await ctx.app.request("/hub", { headers: { cookie } });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain("Summarize the &lt;b&gt;inbox&lt;/b&gt;");
    expect(page).not.toContain("Permission prompts");
    expect(page).toContain("2026-10-20 12:00 UTC"); // codex's check-in
    expect(page).toContain("Not since the last restart");
    // claude-code is a push agent with no stream open; the others are pull agents.
    expect(page).toContain('<td>claude-code</td><td class="narrow-hide">Claude Code</td><td></td><td><span class="status">offline</span>');
    expect(page).toContain('<td>codex</td><td class="narrow-hide">Codex</td><td></td><td><span class="status">checks in</span>');
  });

  test("on a phone, table cells wrap long names, the directory drops Kind and Doing, and the Network forms line up", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    addSession(ctx, { name: "personal-finance-dashboard-claude", machine: "macbook" });
    const home = await (await ctx.app.request("/hub", { headers: { cookie } })).text();
    const style = home.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    // Without this, a session row with long repo and branch names pushes the table past a 375 px screen.
    expect(style).toContain("td{overflow-wrap:anywhere}");
    // A Remove step stays readable in a narrow column: the summary never splits, and the button is compact.
    expect(style).toContain("td summary{overflow-wrap:normal}");
    expect(style).toContain("details.confirm button{padding:6px 8px;font-size:13px}");
    expect(style).toContain("@media (max-width:600px){.narrow-hide{display:none}}");
    expect(home).toContain('<th class="narrow-hide">Kind</th>');
    expect(home).toContain('<th class="narrow-hide">Doing</th>');
    // The Add a machine button keeps a gap above the table, and the Kind and Name fields share a height.
    expect(style).toContain(".spaced{margin-bottom:12px}");
    expect(style).toContain(".fields{align-items:flex-start}");
    expect(style).toContain(".fields select{height:calc(1.5em + 18px)}");
    const network = await (await ctx.app.request("/hub/network", { headers: { cookie } })).text();
    expect(network).toContain('<form method="post" action="/hub/network/join-codes" class="spaced">');
    expect(network).toContain('<div class="actions fields">');
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
    expect((await approve({ cookie, origin: "https://portico.test" })).status).toBe(200);
  });

  test("a second approve post shows the no-longer-waiting page and changes nothing; an unknown task gets a 404 page", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const post = (path: string, fields: Record<string, string> = {}) =>
      ctx.app.request(path, { method: "POST", headers: { cookie }, body: new URLSearchParams(fields) });
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    const first = await post(`/hub/tasks/${task.id}/approve`);
    expect(first.status).toBe(200);
    expect(await first.text()).toContain("Approved.");
    expect(ctx.service.findTask(task.id)?.status).toBe("queued");
    for (const again of [await post(`/hub/tasks/${task.id}/approve`), await post(`/hub/tasks/${task.id}/deny`, { note: "Too late" })]) {
      expect(again.status).toBe(200);
      const page = await again.text();
      expect(page).toContain("This task is no longer waiting for approval.");
      expect(page).toContain("Nothing was changed.");
    }
    expect(ctx.service.findTask(task.id)).toMatchObject({ status: "queued", reason: null });
    // A task that failed later never shows its failure reason on that page.
    ctx.service.checkInbox("muse");
    ctx.service.finishTask("muse", { taskId: task.id, failedReason: "SECRET-FAILURE" });
    const failed = await (await post(`/hub/tasks/${task.id}/approve`)).text();
    expect(failed).toContain("This task is no longer waiting for approval.");
    expect(failed).not.toContain("SECRET-FAILURE");
    const unknown = await post("/hub/tasks/no-such-task/approve");
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain("No such task.");
  });

  test("hub pages carry the security headers", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const task = ctx.service.sendTask("grok-bot", { to: "muse", instructions: "one" });
    for (const res of [
      await ctx.app.request("/hub", { headers: { cookie } }),
      await ctx.app.request(`/hub/tasks/${task.id}/approve`, { method: "POST", headers: { cookie } }),
    ]) {
      expect(res.headers.get("cache-control")).toBe("no-store");
      // Not "no-referrer": under it, browsers send `Origin: null` on the page's own form posts, which the hub page refuses.
      expect(res.headers.get("referrer-policy")).toBe("same-origin");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    }
  });

  test("the approval link and permission routes are gone", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    for (const [method, path] of [
      ["GET", "/approve/some-token"],
      ["POST", "/deny/some-token"],
      ["POST", "/hub/permissions/claude-code/abcde/allow"],
      ["POST", "/api/permission-requests"],
    ] as const) {
      const res = await ctx.app.request(path, { method, headers: { cookie, authorization: `Bearer ${TOKENS["claude-code"]}` } });
      expect(`${method} ${path} -> ${res.status}`).toBe(`${method} ${path} -> 404`);
      // The hub's own JSON 404 for an unknown endpoint, not a page that still handles the route.
      expect(await res.json()).toEqual({ error: "not_found", message: "No such endpoint." });
    }
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
    addSession(ctx, { name: "dialog-claude", machine: "macbook" });
    mintAssistant(ctx, "helper", "muse");
    const form = (path: string, fields: Record<string, string> = {}) =>
      ctx.app.request(path, { method: "POST", headers: { cookie }, body: new URLSearchParams(fields) });
    const assistantPages = await Promise.all(
      ASSISTANT_KINDS.map(async (kind) => (await form("/hub/network/assistants", { kind, name: `copy-${kind}` })).text()),
    );
    for (let i = 0; i < 101; i++) {
      const at = `2026-10-20T10:${String(i % 60).padStart(2, "0")}:00.000Z`;
      ctx.store.insertMessage({
        id: `sweep-${String(i).padStart(4, "0")}`,
        fromAgent: "grok-bot",
        toAgent: "muse",
        text: "sweep body",
        replyTo: i === 100 ? "sweep-0000" : null,
        createdAt: at,
        expiresAt: i === 1 ? "2026-10-20T00:00:00.000Z" : "2026-10-22T00:00:00.000Z",
        deliveredAt: i === 2 ? "2026-10-20T11:00:00.000Z" : null,
      });
    }
    const newest = ctx.store.listMessages({ limit: 100 });
    const pages = [
      await (await ctx.app.request("/hub/messages", { headers: { cookie } })).text(),
      await (await ctx.app.request(`/hub/messages?before=${newest[99]!.id}`, { headers: { cookie } })).text(),
      await (await ctx.app.request("/hub/network", { headers: { cookie } })).text(),
      await (await form("/hub/network/join-codes")).text(),
      ...assistantPages,
      await (await form("/hub/network/assistants", { kind: "muse", name: "Bad Name" })).text(),
      await (await ctx.app.request("/join")).text(),
      await (await ctx.app.request("/hub/login")).text(),
      await (await ctx.app.request("/hub", { headers: { cookie } })).text(),
      await (await ctx.app.request("/hub/history", { headers: { cookie } })).text(),
      await (await ctx.app.request(`/hub/tasks/${task.id}`, { headers: { cookie } })).text(),
      await (await form(`/hub/tasks/${task.id}/deny`, { note: "Not now" })).text(),
      await (await form(`/hub/tasks/${task.id}/approve`)).text(), // the "no longer waiting" page
      await (await ctx.app.request("/hub/login", login("nope"))).text(),
    ];
    for (const page of pages) {
      // Every entry is a rendered page, so a missing route can't pass the sweep as a JSON 404.
      expect(page).toStartWith("<!doctype html>");
      const text = visibleCopy(page);
      expect(text).not.toMatch(PRONOUNS);
      // portico.yaml is a file name; apart from it, the copy never names the app.
      expect(text.toLowerCase().replaceAll("portico.yaml", "")).not.toContain("portico");
    }
  });

  test("the copy sweep skips paste text and reads attribute text", () => {
    const page = `<style>p{}</style><p>Shown &amp; read</p><pre>Join my Portico hub</pre><code>your-token</code>
<textarea readonly class="paste" aria-label="Connect prompt">Use your token</textarea>
<input placeholder="Name it" title='Their title'><img alt="Our logo" src="x.png">`;
    const text = visibleCopy(page);
    expect(text).toContain("Shown");
    expect(text).toContain("read");
    for (const hidden of ["p{}", "Portico hub", "your-token", "Use your token", "&amp;"]) expect(text).not.toContain(hidden);
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
