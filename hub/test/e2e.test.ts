import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "../src/server";
import { ADMIN_PASSWORD, TOKENS, type TestAgent, sseReader, testConfig } from "./helpers";

interface RecordedPush {
  topic: string;
  title: string;
  message: string;
  actions: { label: string; url: string; method?: string }[];
}

/** A stand-in ntfy server that records every push it receives. */
function fakeNtfy() {
  const pushes: RecordedPush[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      pushes.push((await req.json()) as RecordedPush);
      return Response.json({ id: "fake" });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    async nth(n: number): Promise<RecordedPush> {
      const deadline = Date.now() + 2000;
      while (pushes.length < n) {
        if (Date.now() > deadline) throw new Error(`push ${n} never arrived`);
        await Bun.sleep(10);
      }
      return pushes[n - 1]!;
    },
  };
}

let running: RunningServer | null = null;
let ntfy: ReturnType<typeof fakeNtfy> | null = null;
let dir: string | null = null;

afterEach(() => {
  running?.stop();
  ntfy?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  running = null;
  ntfy = null;
  dir = null;
});

function startHub() {
  ntfy = fakeNtfy();
  dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
  const config = {
    ...testConfig(undefined, { BRIDGE_NTFY_TOPIC: "e2e-topic-0123456789abcdef", BRIDGE_NTFY_URL: ntfy.url }),
    dbPath: join(dir, "bridge.db"),
  };
  running = startServer(config, { port: 0 });
  const base = `http://127.0.0.1:${running.port}`;
  const api = (agent: TestAgent, method: string, path: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${TOKENS[agent]}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  // Fires a push button the way the ntfy app does: a POST to its URL. The URL names the public
  // address (https://bridge.test), so send the same path to the local server instead.
  const tap = (url: string) => fetch(`${base}${new URL(url).pathname}`, { method: "POST" });
  return { base, api, tap, ntfy };
}

describe("end to end over HTTP", () => {
  test("an ask task: the push arrives, Approve is tapped, the receiver works it, and the sender gets the result", async () => {
    const { api, tap, ntfy } = startHub();
    const sent = await (await api("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "Summarize the inbox" })).json();
    expect(sent.task.status).toBe("waiting_approval");

    const push = await ntfy.nth(1);
    expect(push).toMatchObject({ topic: "e2e-topic-0123456789abcdef", title: "grok-bot → muse", message: "Summarize the inbox" });
    expect((await tap(push.actions.find((a) => a.label === "Approve")!.url)).status).toBe(200);

    const inbox = await (await api("muse", "GET", "/api/inbox")).json();
    expect(inbox.tasks.map((t: { id: string }) => t.id)).toEqual([sent.task.id]);
    await api("muse", "POST", `/api/tasks/${sent.task.id}/finish`, { result: "Three emails." });
    const back = await (await api("grok-bot", "GET", "/api/inbox")).json();
    expect(back.results[0]).toMatchObject({ id: sent.task.id, status: "done", result: "Three emails." });
  });

  test("a push agent hears about new work at once, and a permission prompt is answered from the phone", async () => {
    const { base, api, tap, ntfy } = startHub();
    const stream = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${TOKENS["claude-code"]}` } });
    const events = sseReader(stream);
    try {
      expect(await events.next()).toEqual({ event: "hello", data: { address: "claude-code", name: "claude-code", machine: null } });
      await api("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "Add rate limiting" });
      expect(await events.next()).toEqual({ event: "nudge", data: {} });

      await api("claude-code", "POST", "/api/permission-requests", {
        request_id: "abcde",
        tool_name: "Bash",
        input_preview: "bun test",
      });
      const push = await ntfy.nth(1);
      expect(push.title).toBe("claude-code wants to use Bash");
      expect((await tap(push.actions.find((a) => a.label === "Allow")!.url)).status).toBe(200);
      expect(await events.next()).toEqual({ event: "permission", data: { request_id: "abcde", behavior: "allow" } });
    } finally {
      await events.cancel();
    }
  });

  test("the hub page signs in over HTTP and lists the waiting task", async () => {
    const { base, api } = startHub();
    await api("codex", "POST", "/api/tasks", { to: "muse", instructions: "Draft a reply" });
    const login = await fetch(`${base}/hub/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const page = await fetch(`${base}/hub`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Draft a reply");
  });
});
