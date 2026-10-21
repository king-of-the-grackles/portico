import { describe, expect, spyOn, test } from "bun:test";
import { captureLogs } from "../src/log";
import { callAs, joinMachine, makeApp, mintAssistant, openSessionStream, signIn, T0 } from "./helpers";

const TOKEN = /ba_[A-Za-z0-9_-]{43}/;

/** Undoes the escaping the page applies to text, so a block reads as it would when pasted. */
function unescape(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** The paste-ready text of each `<textarea readonly class="paste">` on a page, in order. */
function pasteBlocks(page: string): string[] {
  return [...page.matchAll(/<textarea\b[^>]*\bclass="paste"[^>]*>([\s\S]*?)<\/textarea>/g)].map((match) =>
    unescape(match[1]!),
  );
}

type Ctx = ReturnType<typeof makeApp>;

function post(ctx: Ctx, path: string, cookie: string, form: Record<string, string> = {}, headers: Record<string, string> = {}) {
  return ctx.app.request(path, { method: "POST", headers: { cookie, ...headers }, body: new URLSearchParams(form) });
}

async function getPage(ctx: Ctx, path: string, cookie: string): Promise<string> {
  const res = await ctx.app.request(path, { headers: { cookie } });
  expect(res.status).toBe(200);
  return await res.text();
}

describe("the live directory on the hub page", () => {
  test("the waiting page shows the live directory: sessions with status and doing, assistants with last check-in", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const { token } = joinMachine(ctx, "macbook");
    const { events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    ctx.presence.report("dialog-claude@macbook", { status: "busy", doing: "Fix login · Adding tests", repo: "dialog", branch: "main" }, T0.toISOString());
    mintAssistant(ctx, "helper", "muse");
    ctx.presence.checkedIn("helper", "2026-10-20T11:30:00.000Z");
    try {
      const page = await getPage(ctx, "/hub", cookie);
      expect(page).toContain("<h2>Directory</h2>");
      expect(page).toContain("dialog-claude");
      expect(page).toContain("macbook");
      expect(page).toContain("dialog@main");
      expect(page).toContain("busy");
      expect(page).toContain("Fix login · Adding tests");
      // A connected member's pill takes the accent; a pull member's says it checks in, with its last check-in.
      expect(page).toContain('<span class="status live">busy</span>');
      expect(page).toMatch(/helper<\/td>[\s\S]*?checks in[\s\S]*?2026-10-20 11:30 UTC/);
      // The short name is shown, with the full address beside it when they differ.
      expect(page).toContain("dialog-claude@macbook");
    } finally {
      await events.cancel();
    }
  });
});

describe("the network page", () => {
  test("the network page needs a session", async () => {
    const ctx = makeApp();
    const res = await ctx.app.request("/hub/network");
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/hub/login?next=${encodeURIComponent("/hub/network")}`);
    const signedOut = await ctx.app.request("/hub/network/join-codes", { method: "POST" });
    expect(signedOut.status).toBe(403);
    expect(await signedOut.text()).not.toContain("Join my agent bridge");
  });

  test("the network page lists machines with their sessions, assistants with when they were added, and the bridge.yaml agents", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const { token } = joinMachine(ctx, "macbook");
    const { events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    ctx.clock.advance(30 * 60_000);
    mintAssistant(ctx, "helper", "codex");
    try {
      const page = await getPage(ctx, "/hub/network", cookie);
      expect(page).toContain('<nav><a href="/hub">Waiting</a><a href="/hub/network">Network</a><a href="/hub/history">History</a>');
      expect(page).toContain("Add a machine");
      expect(page).toMatch(/<td>macbook<\/td><td><time[^>]*>2026-10-20 12:00 UTC<\/time><\/td><td><time[^>]*>2026-10-20 12:00 UTC<\/time><\/td><td>1<\/td>/);
      for (const heading of ["<th>Assistant</th>", "<th>Kind</th>", "<th>Added</th>", "<th>Last checked in</th>"]) {
        expect(page).toContain(heading);
      }
      expect(page).not.toContain("<th>Connected</th>");
      expect(page).toMatch(/<td>helper<\/td><td>codex<\/td><td><time[^>]*>2026-10-20 12:30 UTC<\/time><\/td><td>Not since the last restart<\/td>/);
      expect(page).toContain("Connect an assistant");
      for (const label of ["Muse", "Grok Bot", "ChatGPT", "Codex", "Other MCP client"]) expect(page).toContain(`>${label}</option>`);
      expect(page).toContain("From bridge.yaml");
      expect(page).toContain("Set in bridge.yaml. Changes need a hub restart.");
      expect(page).toMatch(/<td>claude-code<\/td><td>claude-code<\/td><td>push<\/td><td>Claude Code<\/td>/);
    } finally {
      await events.cancel();
    }
  });

  test("an empty network says so", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const page = await getPage(ctx, "/hub/network", cookie);
    expect(page).toContain("No machines yet.");
    expect(page).toContain("No assistants yet.");
  });

  test("Add a machine shows a join line once, and the line redeems at /api/join", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const res = await post(ctx, "/hub/network/join-codes", cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const page = await res.text();
    expect(page).toContain("<h1>Add a machine</h1>");
    expect(page).toContain("One use, expires <time");
    expect(page).toContain("2026-10-21 12:00 UTC");
    expect(page).toContain("The line is shown once.");
    expect(page).toContain('href="/hub/network"');
    const [line] = pasteBlocks(page);
    const match = line?.match(/^Join my agent bridge: https:\/\/bridge\.test\/join#([A-Za-z0-9_-]{22})$/);
    expect(match).not.toBeNull();
    const code = match![1]!;
    expect(await getPage(ctx, "/hub/network", cookie)).not.toContain(code);
    const joined = await ctx.app.request("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, machine: "studio" }),
    });
    expect(joined.status).toBe(201);
    expect(await getPage(ctx, "/hub/network", cookie)).toContain("<td>studio</td>");
  });

  test.each(["muse", "grok-bot", "chatgpt", "codex", "other"] as const)(
    "Connect an assistant (%s) shows the token once, with that kind's text, and the token works",
    async (kind) => {
      const ctx = makeApp();
      const cookie = await signIn(ctx.app);
      const name = `test-${kind}`;
      const res = await post(ctx, "/hub/network/assistants", cookie, { kind, name, description: "" });
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const page = await res.text();
      expect(page).toContain(`<h1>Assistant connected: ${name}</h1>`);
      expect(page).toContain("The token is shown once. Copy the blocks below now: leaving this page loses the token.");
      const token = page.match(TOKEN)?.[0];
      expect(token).toBeDefined();
      expect((await callAs(ctx, { token: token! }, "GET", "/api/agents")).status).toBe(200);

      const blocks = pasteBlocks(page);
      const header = `Authorization: Bearer ${token}`;
      switch (kind) {
        case "muse": {
          expect(blocks.some((block) => block.includes("https://bridge.test/api/openapi.json"))).toBe(true);
          expect(blocks.filter((block) => block.includes(token!))).toEqual([token!]);
          expect(page.split(token!)).toHaveLength(2);
          break;
        }
        case "grok-bot": {
          expect(blocks).toHaveLength(1);
          expect(blocks[0]).toContain("https://bridge.test/mcp");
          expect(blocks[0]).toContain(header);
          break;
        }
        case "codex": {
          expect(blocks.some((block) => block.includes('bearer_token_env_var = "BRIDGE_TOKEN_TEST_CODEX"'))).toBe(true);
          expect(blocks.some((block) => block.includes('url = "https://bridge.test/mcp"'))).toBe(true);
          expect(blocks).toContain(`export BRIDGE_TOKEN_TEST_CODEX='${token}'`);
          break;
        }
        case "chatgpt":
        case "other": {
          expect(blocks).toEqual(["https://bridge.test/mcp", header]);
          break;
        }
      }
      blocks.forEach((_, i) => expect(page).toContain(`<label for="block-${i}">`));

      const network = await getPage(ctx, "/hub/network", cookie);
      expect(network).toContain(`<td>${name}</td>`);
      expect(network).not.toContain(token!);
    },
  );

  test("a taken or invalid assistant name shows the form again with the problem, as a 400", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    expect((await post(ctx, "/hub/network/assistants", cookie, { kind: "muse", name: "helper" })).status).toBe(200);
    const cases: [Record<string, string>, string][] = [
      [{ kind: "muse", name: "helper" }, "An assistant named &quot;helper&quot; already exists. Choose another name."],
      [{ kind: "codex", name: "muse" }, "&quot;muse&quot; is already an agent in bridge.yaml. Choose another name."],
      [{ kind: "codex", name: "Bad Name" }, "name must be lowercase letters, digits and hyphens."],
      [{ kind: "robot", name: "fresh" }, "kind must be one of: muse, grok-bot, chatgpt, codex, other."],
    ];
    for (const [form, problem] of cases) {
      const res = await post(ctx, "/hub/network/assistants", cookie, form);
      expect(res.status).toBe(400);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const page = await res.text();
      expect(page).toContain('<div class="card error">');
      expect(page).toContain(problem);
      expect(page).toContain('action="/hub/network/assistants"');
      expect(page).not.toMatch(TOKEN);
    }
    expect(ctx.networkService.listAssistants().map((assistant) => assistant.name)).toEqual(["helper"]);
  });

  test("removing an assistant stops its token at once", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const { token } = mintAssistant(ctx, "helper", "grok-bot");
    expect((await callAs(ctx, { token }, "GET", "/api/agents")).status).toBe(200);
    const res = await post(ctx, "/hub/network/assistants/helper/remove", cookie);
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/hub/network");
    expect((await callAs(ctx, { token }, "GET", "/api/agents")).status).toBe(401);
    expect(await getPage(ctx, "/hub/network", cookie)).not.toContain("<td>helper</td>");
    expect(await getPage(ctx, "/hub", cookie)).not.toContain("helper");
  });

  test("removing a machine drops its sessions from the directory and closes their streams", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const { token } = joinMachine(ctx, "macbook");
    const one = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog", folderId: "1".repeat(64) });
    const two = await openSessionStream(ctx, token, { key: "key-bbbbbbbb", repo: "scenes", folderId: "2".repeat(64) });
    try {
      const before = await getPage(ctx, "/hub", cookie);
      expect(before).toContain("dialog-claude");
      expect(before).toContain("scenes-claude");
      const res = await post(ctx, "/hub/network/machines/macbook/remove", cookie);
      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/hub/network");
      await expect(one.events.next()).rejects.toThrow("stream ended");
      await expect(two.events.next()).rejects.toThrow("stream ended");
      expect(ctx.streams.isConnected("dialog-claude@macbook")).toBe(false);
      expect(ctx.streams.isConnected("scenes-claude@macbook")).toBe(false);
      const after = await getPage(ctx, "/hub", cookie);
      expect(after).not.toContain("dialog-claude");
      expect(after).not.toContain("scenes-claude");
      expect(await getPage(ctx, "/hub/network", cookie)).not.toContain("macbook");
      const reopen = await ctx.app.request("/api/stream?repo=dialog", {
        headers: { authorization: `Bearer ${token}`, "x-bridge-session": "key-aaaaaaaa", "x-bridge-folder": "1".repeat(64) },
      });
      expect(reopen.status).toBe(401);
    } finally {
      await one.events.cancel();
      await two.events.cancel();
    }
  });

  test("removing a machine closes its streams without errors", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    const { token } = joinMachine(ctx, "macbook");
    const { events } = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
    const lines: string[] = [];
    const consoleError = spyOn(console, "error").mockImplementation(() => {});
    captureLogs((line) => lines.push(line));
    try {
      expect((await post(ctx, "/hub/network/machines/macbook/remove", cookie)).status).toBe(303);
      // The stream ends only after its finalizer, which writes last_seen_at for the deleted row, has run.
      await expect(events.next()).rejects.toThrow("stream ended");
      const logged = lines.map((line) => JSON.parse(line) as { level: string; msg: string; agent?: string });
      expect(logged).toContainEqual(expect.objectContaining({ msg: "stream_closed", agent: "dialog-claude@macbook" }));
      expect(logged.filter((entry) => entry.level === "error")).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      captureLogs(null);
      consoleError.mockRestore();
      await events.cancel();
    }
  });

  test("the new forms refuse other origins", async () => {
    const ctx = makeApp();
    const cookie = await signIn(ctx.app);
    joinMachine(ctx, "macbook");
    const { token } = mintAssistant(ctx, "helper");
    const evil = { origin: "https://evil.test" };
    const forms: [string, Record<string, string>][] = [
      ["/hub/network/join-codes", {}],
      ["/hub/network/assistants", { kind: "muse", name: "sneaky" }],
      ["/hub/network/assistants/helper/remove", {}],
      ["/hub/network/machines/macbook/remove", {}],
    ];
    for (const [path, form] of forms) {
      const res = await post(ctx, path, cookie, form, evil);
      expect(res.status).toBe(403);
      const page = await res.text();
      expect(page).not.toContain("Join my agent bridge");
      expect(page).not.toMatch(TOKEN);
    }
    expect(ctx.networkService.listAssistants().map((assistant) => assistant.name)).toEqual(["helper"]);
    expect(ctx.networkService.listMachines().map((machine) => machine.name)).toEqual(["macbook"]);
    expect((await callAs(ctx, { token }, "GET", "/api/agents")).status).toBe(200);
  });
});
