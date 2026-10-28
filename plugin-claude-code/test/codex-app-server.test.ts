import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerWebSocket } from "bun";
import { AppServerError, connectAppServer, controlSocketPath } from "../src/codex/app-server";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

type Message = { id?: number; method?: string; params?: unknown };

/** An app-server on a Unix socket: answers with `answer`, and records what clients sent. */
function appServer(answer: (message: Message, ws: ServerWebSocket<unknown>) => unknown) {
  const dir = mkdtempSync(join(tmpdir(), "portico-app-server-"));
  const path = join(dir, "app-server-control.sock");
  const received: Message[] = [];
  const sockets: ServerWebSocket<unknown>[] = [];
  const server = Bun.serve({
    unix: path,
    fetch: (req, srv) => (srv.upgrade(req) ? undefined : new Response("upgrade", { status: 400 })),
    websocket: {
      open: (ws) => void sockets.push(ws),
      message: (ws, data) => {
        const message = JSON.parse(String(data)) as Message;
        received.push(message);
        if (message.id === undefined) return;
        const result = answer(message, ws);
        if (result === undefined) return;
        ws.send(JSON.stringify(result instanceof Error ? { id: message.id, error: { code: -32600, message: result.message } } : { id: message.id, result }));
      },
    },
  });
  cleanups.push(() => {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  });
  return { path, received, sockets, server };
}

describe("the Codex app-server client", () => {
  test("lives under CODEX_HOME, or ~/.codex", () => {
    expect(controlSocketPath({ CODEX_HOME: "/x/codex" })).toBe("/x/codex/app-server-control/app-server-control.sock");
    expect(controlSocketPath({})).toEndWith("/.codex/app-server-control/app-server-control.sock");
  });

  test("introduces itself, answers requests in order, and hears notifications", async () => {
    const fake = appServer((m) => (m.method === "initialize" ? { userAgent: "codex" } : m.method === "bad" ? new Error("no such method") : { echo: m.params }));
    const server = await connectAppServer({ path: fake.path, version: "9.9.9" });
    cleanups.push(() => server.close());
    expect(fake.received[0]).toMatchObject({ method: "initialize", params: { clientInfo: { name: "portico-bridge", version: "9.9.9" } } });
    await Bun.sleep(10);
    expect(fake.received[1]).toEqual({ jsonrpc: "2.0", method: "initialized" } as Message);
    expect(await server.request("thread/read", { threadId: "t" })).toEqual({ echo: { threadId: "t" } });
    const failure = await server.request("bad", {}).catch((err) => err);
    expect(failure).toBeInstanceOf(AppServerError);
    expect((failure as AppServerError).code).toBe(-32600);
    const heard: [string, unknown][] = [];
    server.onNotification((method, params) => void heard.push([method, params]));
    fake.sockets[0]!.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "t", status: { type: "idle" } } }));
    await Bun.sleep(20);
    expect(heard).toEqual([["thread/status/changed", { threadId: "t", status: { type: "idle" } }]]);
  });

  test("never answers a request the app-server sends it", async () => {
    const fake = appServer((m) => (m.method === "initialize" ? {} : undefined));
    const server = await connectAppServer({ path: fake.path, version: "1" });
    cleanups.push(() => server.close());
    fake.sockets[0]!.send(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} }));
    await Bun.sleep(30);
    expect(fake.received.filter((m) => m.id === 99)).toEqual([]);
  });

  test("a request that gets no answer times out, and a closed connection fails what's pending", async () => {
    const fake = appServer((m) => (m.method === "initialize" ? {} : undefined));
    const server = await connectAppServer({ path: fake.path, version: "1", timeoutMs: 50 });
    expect(((await server.request("slow", {}).catch((err) => err)) as AppServerError).code).toBe("timeout");
    let closed = 0;
    server.onClose(() => void closed++);
    const pending = server.request("slow", {}, 5_000).catch((err) => err);
    fake.sockets[0]!.close();
    expect(((await pending) as AppServerError).code).toBe("closed");
    expect(closed).toBe(1);
  });

  test("with no app-server on the socket, connecting fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portico-app-server-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const failure = await connectAppServer({ path: join(dir, "missing.sock"), version: "1", timeoutMs: 1000 }).catch((err) => err);
    expect(failure).toBeInstanceOf(AppServerError);
  });
});
