import { afterEach, expect, test } from "bun:test";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { InboxSocket, SocketError, socketTarget } from "../src/socket";
import { fakeInboxSocket, type FakeInboxSocket, tempDir, waitFor } from "./helpers";

const open: FakeInboxSocket[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close();
});
const code = async (p: Promise<unknown>) => p.then(() => null, (err) => (err instanceof SocketError ? err.code : String(err)));

test("sends the auth line, then the user line", async () => {
  const fake = await fakeInboxSocket();
  open.push(fake);
  await fake.socket.post("hello there");
  expect(fake.posts).toEqual([{ auth: "inbox-token", content: "hello there" }]);
});

test("without a token, sends only the user line", async () => {
  const fake = await fakeInboxSocket({ token: null });
  open.push(fake);
  await fake.socket.post("x");
  expect(fake.posts).toEqual([{ auth: null, content: "x" }]);
});

test("rejects with no_socket, connect_failed or refused", async () => {
  expect(await code(new InboxSocket({ path: () => null, token: () => null }).post("x"))).toBe("no_socket");
  const missing = join(tempDir(), "none.sock");
  expect(await code(new InboxSocket({ path: () => missing, token: () => null }).post("x"))).toBe("connect_failed");
  const fake = await fakeInboxSocket();
  open.push(fake);
  fake.mode = "error";
  expect(await code(fake.socket.post("x"))).toBe("refused");
  expect(fake.posts).toEqual([]);
});

test("a peer that stays open and silent counts as accepted after settleMs", async () => {
  const path = join(tempDir(), "s.sock");
  const lines: string[] = [];
  const server: Server = createServer((conn) => conn.on("data", (d) => lines.push(d.toString())));
  await new Promise<void>((r) => server.listen(path, r));
  await new InboxSocket({ path: () => path, token: () => null, settleMs: 30 }).post("quiet");
  expect(lines.join("")).toBe(`${JSON.stringify({ type: "user", message: { role: "user", content: "quiet" } })}\n`);
  server.close();
});

test("a peer that accepts but never reads times out during the write, leaving nothing open", async () => {
  const path = join(tempDir(), "s.sock");
  const conns: Socket[] = [];
  let closed = 0;
  const server: Server = createServer({ pauseOnConnect: true }, (conn) => {
    conns.push(conn);
    conn.on("error", () => {});
    conn.on("close", () => closed++);
  });
  await new Promise<void>((r) => server.listen(path, r));
  const big = "x".repeat(8 * 1024 * 1024); // far more than the socket buffers hold, so the write can't finish
  const started = Date.now();
  expect(await code(new InboxSocket({ path: () => path, token: () => null, connectTimeoutMs: 100 }).post(big))).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(2000);
  // Reading again lets the peer see the client's end of the connection: it closes only if the client let go of it.
  for (const conn of conns) conn.resume();
  await waitFor(() => closed === 1);
  // server.close() finishes only once every connection is gone.
  await new Promise<void>((r) => server.close(() => r()));
});

test("socketTarget prefers CLAUDE_CODE_MESSAGING_SOCKET, then the registry's path", () => {
  const session = { pid: 1, sessionId: "s", cwd: "/w", status: "idle", name: null, messagingSocketPath: "/reg.sock" };
  expect(socketTarget({ CLAUDE_CODE_MESSAGING_SOCKET: "/env.sock", CLAUDE_CODE_MESSAGING_TOKEN: "t" }, () => session).path()).toBe("/env.sock");
  expect(socketTarget({}, () => session).path()).toBe("/reg.sock");
  expect(socketTarget({}, () => null).path()).toBeNull();
  expect(socketTarget({ CLAUDE_CODE_MESSAGING_TOKEN: "t" }, () => null).token()).toBe("t");
});
