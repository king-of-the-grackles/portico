import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("a burst of concurrent failures still locks after ten", async () => {
    const ctx = makeApp();
    const answers = await Promise.all(
      Array.from({ length: 20 }, (_, i) => postJoin(ctx, { code: `${"B".repeat(20)}${String(i).padStart(2, "0")}` })),
    );
    const statuses = answers.map((res) => res.status);
    expect(statuses.filter((status) => status === 404)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
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
    const withSource = makeApp(testConfig(BASE_YAML, { PORTICO_PLUGIN_SOURCE: "owner/portico" }));
    const set = await (await withSource.app.request("/join")).text();
    expect(set).toContain("claude plugin marketplace add owner/portico");
    expect(set).not.toContain("Ask the hub owner for the source.");

    const without = await (await makeApp().app.request("/join")).text();
    expect(without).toContain("Ask the hub owner for the source.");
    expect(without).toContain("claude plugin marketplace add &lt;marketplace source from the hub owner&gt;");
    expect(without).toContain("https://portico.test/join#&lt;code&gt;");
    for (const text of ["portico join '", "src/cli.ts\" join '", "/portico:join", "/portico:off"]) {
      expect(without).toContain(text);
    }

    // PORTICO_PLUGIN_SOURCE is trimmed, and blank means unset.
    expect(testConfig(BASE_YAML, { PORTICO_PLUGIN_SOURCE: "  owner/portico \n" }).pluginSource).toBe("owner/portico");
    expect(testConfig(BASE_YAML, { PORTICO_PLUGIN_SOURCE: "  " }).pluginSource).toBeNull();
    expect(testConfig().pluginSource).toBeNull();
  });

  test("the bun one-liner picks the plugin folder by version order, so 0.10.0 beats 0.9.0", async () => {
    const page = await (await makeApp().app.request("/join")).text();
    // Run the folder pick from the page as a shell would, against a temporary home, never the real ~/.claude.
    const pick = /<pre>bun "\$\((.+?)\)src\/cli\.ts" join/.exec(page)![1]!;
    const home = mkdtempSync(join(tmpdir(), "po-"));
    try {
      const cache = join(home, ".claude/plugins/cache/portico/portico");
      for (const version of ["0.2.0", "0.9.0", "0.10.0"]) mkdirSync(join(cache, version), { recursive: true });
      const run = Bun.spawnSync(["sh", "-c", pick], { env: { PATH: process.env.PATH ?? "", HOME: home } });
      expect(run.exitCode).toBe(0);
      expect(run.stdout.toString().trim()).toBe(`${cache}/0.10.0/`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
    expect(page).toContain(
      `<pre>bun "$(ls -d ~/.claude/plugins/cache/portico/portico/*/ | sort -V | tail -n 1)src/cli.ts" join '&lt;join line&gt;'</pre>`,
    );
  });

  test("the join page's prose has no pronouns and never names the app", async () => {
    for (const ctx of [makeApp(), makeApp(testConfig(BASE_YAML, { PORTICO_PLUGIN_SOURCE: "owner/portico" }))]) {
      const text = visibleCopy(await (await ctx.app.request("/join")).text());
      expect(text).toContain("Join a machine");
      expect(text).not.toMatch(PRONOUNS);
      expect(text.toLowerCase()).not.toContain("portico");
    }
  });
});
