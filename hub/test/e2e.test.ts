import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "../src/server";
import { ADMIN_PASSWORD, TOKENS, type TestAgent, sseReader, testConfig } from "./helpers";

let running: RunningServer | null = null;
let dir: string | null = null;

afterEach(() => {
  running?.stop();
  if (dir) rmSync(dir, { recursive: true, force: true });
  running = null;
  dir = null;
});

function startHub() {
  dir = mkdtempSync(join(tmpdir(), "bridge-e2e-"));
  running = startServer({ ...testConfig(), dbPath: join(dir, "bridge.db") }, { port: 0 });
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
  /** Signs in to the hub page over HTTP and returns the Cookie header value to send. */
  const signIn = async (): Promise<string> => {
    const login = await fetch(`${base}/hub/login`, {
      method: "POST",
      body: new URLSearchParams({ password: ADMIN_PASSWORD }),
      redirect: "manual",
    });
    expect(login.status).toBe(303);
    return login.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { base, api, signIn };
}

describe("end to end over HTTP", () => {
  test("an ask task: Approve on the hub page, the receiver works it, and the sender gets the result", async () => {
    const { base, api, signIn } = startHub();
    const sent = await (await api("grok-bot", "POST", "/api/tasks", { to: "muse", instructions: "Summarize the inbox" })).json();
    expect(sent.task.status).toBe("waiting_approval");

    const cookie = await signIn();
    expect((await fetch(`${base}/hub/tasks/${sent.task.id}/approve`, { method: "POST", headers: { cookie } })).status).toBe(200);

    const inbox = await (await api("muse", "GET", "/api/inbox")).json();
    expect(inbox.tasks.map((t: { id: string }) => t.id)).toEqual([sent.task.id]);
    await api("muse", "POST", `/api/tasks/${sent.task.id}/finish`, { result: "Three emails." });
    const back = await (await api("grok-bot", "GET", "/api/inbox")).json();
    expect(back.results[0]).toMatchObject({ id: sent.task.id, status: "done", result: "Three emails." });
  });

  test("a push agent hears about new work at once", async () => {
    const { base, api } = startHub();
    const stream = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${TOKENS["claude-code"]}` } });
    const events = sseReader(stream);
    try {
      expect(await events.next()).toEqual({ event: "hello", data: { address: "claude-code", name: "claude-code", machine: null } });
      await api("grok-bot", "POST", "/api/tasks", { to: "claude-code", instructions: "Add rate limiting" });
      expect(await events.next()).toEqual({ event: "nudge", data: {} });
    } finally {
      await events.cancel();
    }
  });

  test("the hub page signs in over HTTP and lists the waiting task", async () => {
    const { base, api, signIn } = startHub();
    await api("codex", "POST", "/api/tasks", { to: "muse", instructions: "Draft a reply" });
    const cookie = await signIn();
    const page = await fetch(`${base}/hub`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Draft a reply");
  });
});
