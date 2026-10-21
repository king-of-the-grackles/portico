import { expect, test } from "bun:test";
import { captureLogs } from "../src/log";
import { callAs, joinMachine, makeApp, openSessionStream } from "./helpers";

const ADDRESS = "dialog-claude@macbook";

async function connectedSession() {
  const ctx = makeApp();
  const { token } = joinMachine(ctx, "macbook");
  const stream = await openSessionStream(ctx, token, { key: "key-aaaaaaaa", repo: "dialog" });
  const report = (body: unknown) => callAs(ctx, { token, key: "key-aaaaaaaa" }, "POST", "/api/status", body);
  return { ctx, token, stream, report };
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(5);
  }
}

test("a session's report shows in presence while connected, and offline in the directory once the stream closes", async () => {
  const { ctx, stream, report } = await connectedSession();
  const res = await report({ status: "busy", doing: "Fix login · Adding tests", repo: "dialog", branch: "main" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
  expect(ctx.presence.get(ADDRESS)).toEqual({
    status: "busy",
    doing: "Fix login · Adding tests",
    repo: "dialog",
    branch: "main",
    at: ctx.clock.now().toISOString(),
  });
  expect(ctx.streams.isConnected(ADDRESS)).toBe(true);

  ctx.clock.advance(120_000);
  await stream.events.cancel();
  // The directory's isConnected is the stream hub's: once the stream is gone, the session is offline.
  await waitUntil(() => !ctx.streams.isConnected(ADDRESS));
  expect(ctx.directory.find(ADDRESS)).not.toBeNull();
  expect(ctx.network.sessionByAddress("dialog-claude", "macbook")?.lastSeenAt).toBe(ctx.clock.now().toISOString());
});

test("doing is defanged, made one line and clipped to 120 code points; repo keeps only its last segment", async () => {
  const { ctx, stream, report } = await connectedSession();
  try {
    const res = await report({
      status: "busy",
      doing: "Fix\u001b[31m login\n" + "x".repeat(200),
      repo: "/Users/x/dialog",
      branch: "main",
    });
    expect(res.status).toBe(200);
    expect(ctx.presence.get(ADDRESS)).toMatchObject({
      status: "busy",
      doing: "Fix login " + "x".repeat(110),
      repo: "dialog",
      branch: "main",
    });
    // Missing and empty fields become null; frame tags lose their "<".
    await report({ status: "idle", doing: "  ", branch: "<bridge-task>" });
    expect(ctx.presence.get(ADDRESS)).toMatchObject({ status: "idle", doing: null, repo: null, branch: "‹bridge-task>" });
  } finally {
    await stream.events.cancel();
  }
});

test("pull agents can't report status", async () => {
  const ctx = makeApp();
  const res = await ctx.call("grok-bot", "POST", "/api/status", { status: "busy" });
  expect(res.status).toBe(403);
  expect(await res.json()).toMatchObject({ error: "not_allowed" });
  expect(ctx.presence.get("grok-bot")).toBeNull();
});

test("a bad status is a 400", async () => {
  const { ctx, stream, report } = await connectedSession();
  try {
    const res = await report({ status: "asleep" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "bad_request", message: "status must be busy, idle or waiting." });
    expect((await report("not json")).status).toBe(400);
    expect(ctx.presence.get(ADDRESS)).toBeNull();
  } finally {
    await stream.events.cancel();
  }
});

test("a session's reports write last_seen_at at most once a minute, and nothing is logged about them", async () => {
  const { ctx, stream, report } = await connectedSession();
  const lines: string[] = [];
  captureLogs((line) => lines.push(line));
  try {
    const seen = () => ctx.network.sessionByAddress("dialog-claude", "macbook")?.lastSeenAt;
    const registeredAt = seen();
    ctx.clock.advance(30_000);
    await report({ status: "busy", doing: "Secret plan", repo: "dialog", branch: "main" });
    expect(seen()).toBe(registeredAt);
    ctx.clock.advance(31_000);
    await report({ status: "idle", doing: "Secret plan", repo: "dialog", branch: "main" });
    expect(seen()).toBe(ctx.clock.now().toISOString());
  } finally {
    captureLogs(null);
    await stream.events.cancel();
  }
  expect(lines.join("\n")).not.toContain("Secret plan");
});

test("a bridge.yaml push agent reports too", async () => {
  const ctx = makeApp();
  const res = await ctx.call("claude-code", "POST", "/api/status", { status: "waiting", doing: "Asking a question" });
  expect(res.status).toBe(200);
  expect(ctx.presence.get("claude-code")).toMatchObject({ status: "waiting", doing: "Asking a question" });
});
