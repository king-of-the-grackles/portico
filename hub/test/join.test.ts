import { describe, expect, test } from "bun:test";
import { captureLogs } from "../src/log";
import { CSP } from "../src/page/layout";
import { BASE_YAML, HOUR, makeApp, openSessionStream, PRONOUNS, testConfig, visibleCopy } from "./helpers";

const INVALID = { error: "not_found", message: "The join code is invalid, expired or already used. Ask for a new join line." };

function postJoin(ctx: ReturnType<typeof makeApp>, body: unknown): Promise<Response> {
  return Promise.resolve(
    ctx.app.request("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("POST /api/join", () => {
  test("a valid code returns the machine and a token once, and the token opens a session stream", async () => {
    const ctx = makeApp();
    const { code } = ctx.networkService.createJoinCode();
    const res = await ctx.app.request("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machine: "macbook" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { machine: { name: string }; token: string };
    expect(body.machine.name).toBe("macbook");
    expect(body.token).toMatch(/^bm_/);
    const { hello, events } = await openSessionStream(ctx, body.token, { key: "key-aaaaaaaa", repo: "dialog" });
    expect(hello.address).toBe("dialog-claude@macbook");
    await events.cancel();
  });

  test("a used, expired or unknown code gets one plain 404", async () => {
    const ctx = makeApp();
    const { code } = ctx.networkService.createJoinCode();
    expect((await postJoin(ctx, { code, machine: "macbook" })).status).toBe(201);
    const used = await postJoin(ctx, { code, machine: "macbook" });
    const unknown = await postJoin(ctx, { code: "B".repeat(22), machine: "studio" });
    const { code: old } = ctx.networkService.createJoinCode();
    ctx.clock.advance(24 * HOUR);
    const expired = await postJoin(ctx, { code: old });
    for (const res of [used, unknown, expired]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(INVALID);
    }
    expect(ctx.networkService.listMachines().map((machine) => machine.name)).toEqual(["macbook"]);
  });

  test("ten failures lock the route for 15 minutes", async () => {
    const ctx = makeApp();
    const { code } = ctx.networkService.createJoinCode();
    // Unknown codes (404) and malformed ones (400 from the service) both count.
    for (let i = 0; i < 10; i++) {
      const res = await postJoin(ctx, { code: i % 2 ? "short" : `${"B".repeat(21)}${i}` });
      expect(res.status).toBe(i % 2 ? 400 : 404);
    }
    const locked = await postJoin(ctx, { code, machine: "macbook" });
    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({
      error: "rate_limited",
      message: "Too many failed join attempts. Try again in 15 minutes.",
    });
    ctx.clock.advance(15 * 60_000 + 1);
    expect((await postJoin(ctx, { code, machine: "macbook" })).status).toBe(201);
  });

  test("the body is validated", async () => {
    const ctx = makeApp();
    for (const body of [{ code: 5 }, { machine: "macbook" }, { code: "A".repeat(22), machine: 5 }, "not json"]) {
      const res = await postJoin(ctx, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    }
    const tooLarge = await postJoin(ctx, { code: "A".repeat(22), machine: "x".repeat(300 * 1024) });
    expect(tooLarge.status).toBe(413);
  });

  test("logs name the machine, never the code or the token", async () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      const ctx = makeApp();
      const { code } = ctx.networkService.createJoinCode();
      const res = await postJoin(ctx, { code, machine: "macbook" });
      const { token } = (await res.json()) as { token: string };
      expect((await postJoin(ctx, { code, machine: "macbook" })).status).toBe(404);
      const text = lines.join("\n");
      expect(lines.map((line) => JSON.parse(line).msg)).toContain("machine_joined");
      expect(text).toContain('"machine":"macbook"');
      expect(text).not.toContain(code);
      expect(text).not.toContain(token);
    } finally {
      captureLogs(null);
    }
  });
});

describe("GET /join", () => {
  test("GET /join is public and carries the page headers", async () => {
    const res = await makeApp().app.request("/join");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-security-policy")).toBe(CSP);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    const page = await res.text();
    expect(page).toContain("<h1>Join a machine</h1>");
    expect(page).not.toContain("<nav>");
    expect(page).not.toContain("Sign out");
  });

  test("the join page gives the three ways to run join, and the plugin source when set", async () => {
    const withSource = makeApp(testConfig(BASE_YAML, { BRIDGE_PLUGIN_SOURCE: "owner/agent-bridge" }));
    const set = await (await withSource.app.request("/join")).text();
    expect(set).toContain("claude plugin marketplace add owner/agent-bridge");
    expect(set).not.toContain("Ask the hub owner for the source.");

    const without = await (await makeApp().app.request("/join")).text();
    expect(without).toContain("Ask the hub owner for the source.");
    expect(without).toContain("claude plugin marketplace add &lt;marketplace source from the hub owner&gt;");
    expect(without).toContain("https://bridge.test/join#&lt;code&gt;");
    for (const text of ["bridge join '", "src/cli.ts\" join '", "/agent-bridge:join", "/agent-bridge:off"]) {
      expect(without).toContain(text);
    }

    // BRIDGE_PLUGIN_SOURCE is trimmed, and blank means unset.
    expect(testConfig(BASE_YAML, { BRIDGE_PLUGIN_SOURCE: "  owner/agent-bridge \n" }).pluginSource).toBe("owner/agent-bridge");
    expect(testConfig(BASE_YAML, { BRIDGE_PLUGIN_SOURCE: "  " }).pluginSource).toBeNull();
    expect(testConfig().pluginSource).toBeNull();
  });

  test("the join page's prose has no pronouns and never names the app", async () => {
    for (const ctx of [makeApp(), makeApp(testConfig(BASE_YAML, { BRIDGE_PLUGIN_SOURCE: "owner/agent-bridge" }))]) {
      const text = visibleCopy(await (await ctx.app.request("/join")).text());
      expect(text).toContain("Join a machine");
      expect(text).not.toMatch(PRONOUNS);
      expect(text.toLowerCase()).not.toContain("agent-bridge");
    }
  });
});
