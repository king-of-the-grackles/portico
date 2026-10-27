import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PorticoClient } from "../src/portico-client";
import { StreamClient, type StreamClientOptions, type StreamStop } from "../src/stream";
import { appAgent, captureLog, connected, joinTestComputer, startPortico, type TestPortico, waitFor } from "./helpers";

const running: StreamClient[] = [];
afterEach(async () => {
  for (const client of running.splice(0)) await client.stop();
});

function watch(open: StreamClientOptions["open"], extra: Partial<StreamClientOptions> = {}) {
  const events: { event: string; data: unknown }[] = [];
  const stops: StreamStop[] = [];
  const logs = captureLog();
  let opens = 0;
  const client = new StreamClient({
    open: (signal) => {
      opens++;
      return open(signal);
    },
    onEvent: (event, data) => events.push({ event, data }),
    onStop: (stop) => stops.push(stop),
    log: logs.log,
    initialBackoffMs: 10,
    ...extra,
  });
  running.push(client);
  client.start();
  return { client, events, stops, logs, opens: () => opens };
}

const FOLDER = "a".repeat(64);

describe("StreamClient against Portico", () => {
  let p: TestPortico;
  let token: string;
  beforeEach(async () => {
    p = await startPortico();
    token = joinTestComputer(p).token;
  });
  afterEach(async () => {
    for (const client of running.splice(0)) await client.stop();
    p.stop();
  });

  /** Opens the stream as a session on the computer, registering it. */
  const openAs = (key = "key-stream-001", folderId = FOLDER, withToken = () => token) => (signal: AbortSignal) =>
    new PorticoClient({ url: p.url, token: withToken(), sessionKey: key }).openStream(signal, { repo: "api", folderId });

  test("passes the hello and nudges through", async () => {
    const watched = watch(openAs());
    await waitFor(() => connected(p, "api-claude@macbook"));
    const { agent } = appAgent(p, "grok", { kind: "grok-bot" });
    p.messages.send(agent, { to: "api-claude", subject: "Hello", text: "hello" });
    await waitFor(() => watched.events.length > 1);
    expect(watched.events).toEqual([
      { event: "hello", data: { address: "api-claude@macbook", name: "api-claude", computer: "macbook" } },
      { event: "nudge", data: {} },
    ]);
  });

  test("passes a rename through", async () => {
    const watched = watch(openAs());
    await waitFor(() => connected(p, "api-claude@macbook"));
    p.agents.update(p.owner.id, p.agents.byAddress("api-claude@macbook")!.id, { name: "billing-claude" });
    await waitFor(() => watched.events.length > 1);
    expect(watched.events[1]).toEqual({
      event: "renamed",
      data: { address: "billing-claude@macbook", name: "billing-claude", computer: "macbook" },
    });
  });

  test("stops for good when Portico refuses the stream", async () => {
    const app = appAgent(p, "grok", { kind: "grok-bot" });
    const notSession = watch(openAs("key-stream-001", FOLDER, () => app.token));
    await waitFor(() => notSession.stops.length === 1);
    expect(notSession.stops[0]).toEqual({
      reason: "rejected",
      status: 403,
      code: "not_allowed",
      message: "Only sessions on a computer open the live stream.",
    });

    const unknown = watch(openAs("key-stream-001", FOLDER, () => "pc_wrong-token-0123456789abcdef"));
    await waitFor(() => unknown.stops.length === 1);
    expect(unknown.stops[0]).toMatchObject({ reason: "rejected", status: 401, code: "unauthorized" });
    expect(unknown.logs.lines).toContainEqual({ level: "error", msg: "stream_refused", fields: { status: 401, code: "unauthorized" } });

    await Bun.sleep(100);
    expect(notSession.opens()).toBe(1);
    expect(unknown.opens()).toBe(1);
  });

  test("a folder that is off stops the stream for good with folder_off, logged once as info", async () => {
    p.computers.setFolder(p.computers.byName("macbook")!.id, "f".repeat(64), "api", false);
    const watched = watch(openAs("key-stream-001", "f".repeat(64)));
    await waitFor(() => watched.stops.length === 1);
    expect(watched.stops[0]).toMatchObject({ reason: "rejected", status: 403, code: "folder_off" });
    await Bun.sleep(100);
    expect(watched.opens()).toBe(1);
    expect(watched.logs.lines).toEqual([{ level: "info", msg: "stream_refused", fields: { status: 403, code: "folder_off" } }]);
  });

  test("stops for good on a 404 that Portico itself sent (not_found): the address points at the wrong path", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: "not_found", message: "No such endpoint." }, { status: 404 }) });
    try {
      const watched = watch((signal) => fetch(`http://127.0.0.1:${server.port}/api/agent/stream`, { signal }));
      await waitFor(() => watched.stops.length === 1);
      expect(watched.stops[0]).toMatchObject({ reason: "rejected", status: 404, code: "not_found" });
      await Bun.sleep(100);
      expect(watched.opens()).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("retries a 404 that did not come from Portico, such as a proxy page during a redeploy", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      idleTimeout: 0,
      fetch: () => {
        calls++;
        if (calls === 1) {
          return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
        }
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    try {
      const watched = watch((signal) => fetch(`http://127.0.0.1:${server.port}/api/agent/stream`, { signal }));
      await waitFor(() => watched.opens() >= 2);
      await waitFor(() => watched.logs.lines.some((line) => line.msg === "stream_connected"));
      expect(watched.stops).toEqual([]);
      expect(watched.logs.lines).toContainEqual({ level: "warn", msg: "stream_failed", fields: { status: 404 } });
    } finally {
      server.stop(true);
    }
  });

  test("heartbeats keep a quiet stream open", async () => {
    const quiet = watch(openAs(), { silenceMs: 300 });
    await Bun.sleep(800);
    expect(quiet.opens()).toBe(1);
  });

  test("reports each dropped connection through onDisconnect, but not a refused open", async () => {
    let drops = 0;
    const watched = watch(openAs(), { onDisconnect: () => drops++ });
    const hellos = () => watched.events.filter((item) => item.event === "hello").length;
    await waitFor(() => hellos() === 1);
    watched.client.reconnect();
    await waitFor(() => drops === 1);
    await waitFor(() => hellos() === 2); // the second connection reached Portico before the stop
    await watched.client.stop();
    expect(drops).toBe(2);
    let refused = 0;
    const wrong = watch(openAs("key-stream-002", FOLDER, () => "pc_wrong-token-0123456789abcdef"), { onDisconnect: () => refused++ });
    await waitFor(() => wrong.stops.length === 1);
    expect(refused).toBe(0);
  });

  test("starts the backoff over after a healthy connection", async () => {
    const times: number[] = [];
    const open = openAs();
    const watched = watch(
      (signal) => {
        times.push(Date.now());
        return open(signal);
      },
      { healthyMs: 100, initialBackoffMs: 40, random: () => 0.5 },
    );
    await waitFor(() => times.length === 1);
    await Bun.sleep(20);
    watched.client.reconnect(); // pause 40
    await waitFor(() => times.length === 2);
    await Bun.sleep(20);
    watched.client.reconnect(); // pause 80
    await waitFor(() => times.length === 3);
    await Bun.sleep(300); // healthy: backoff resets
    watched.client.reconnect(); // pause 40, not 160
    await waitFor(() => times.length === 4);
    await watched.client.stop();
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const pauseBefore = gaps[1]! - 20;
    const lastPause = gaps[2]! - 300;
    expect(lastPause).toBeLessThan(pauseBefore);
  });
});

/** A server that sends ": connected" and then ends the stream, goes silent, or says `replaced`. */
function fakeSse(mode: "end" | "silent" | "replaced") {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            if (mode === "replaced") controller.enqueue(new TextEncoder().encode("event: replaced\ndata: {}\n\n"));
            if (mode === "end") controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  return {
    open: (signal: AbortSignal) => fetch(`http://127.0.0.1:${server.port}/api/agent/stream`, { signal }),
    stop: () => server.stop(true),
  };
}

describe("StreamClient stops", () => {
  test("for good when the stream says another connection replaced it", async () => {
    const fake = fakeSse("replaced");
    try {
      const watched = watch(fake.open);
      await waitFor(() => watched.stops.length === 1);
      expect(watched.stops[0]).toEqual({ reason: "replaced" });
      await Bun.sleep(100);
      expect(watched.opens()).toBe(1);
    } finally {
      fake.stop();
    }
  });
});

describe("StreamClient reconnects", () => {
  test("after the server ends the stream", async () => {
    const fake = fakeSse("end");
    try {
      const watched = watch(fake.open);
      await waitFor(() => watched.opens() >= 3);
    } finally {
      fake.stop();
    }
  });

  test("after a silence longer than silenceMs", async () => {
    const fake = fakeSse("silent");
    try {
      const watched = watch(fake.open, { silenceMs: 100 });
      await waitFor(() => watched.opens() >= 2);
      expect(watched.logs.lines.some((line) => line.msg === "stream_silent")).toBe(true);
    } finally {
      fake.stop();
    }
  });

  test("waiting twice as long after each failed attempt, up to the cap", async () => {
    const times: number[] = [];
    const watched = watch(
      async () => {
        times.push(Date.now());
        throw new TypeError("fetch failed");
      },
      { initialBackoffMs: 40, maxBackoffMs: 120, random: () => 0.5 },
    );
    await waitFor(() => times.length >= 5, 3000);
    await watched.client.stop();
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    expect(gaps[0]!).toBeGreaterThanOrEqual(35); // 40
    expect(gaps[1]!).toBeGreaterThanOrEqual(75); // 80
    expect(gaps[2]!).toBeGreaterThanOrEqual(115); // capped at 120
    expect(gaps[3]!).toBeLessThan(200); // still capped
  });

  test("keeps backing off when connections end right after opening", async () => {
    const fake = fakeSse("end");
    try {
      const times: number[] = [];
      const watched = watch(
        (signal) => {
          times.push(Date.now());
          return fake.open(signal);
        },
        { initialBackoffMs: 40, random: () => 0.5 },
      );
      await waitFor(() => times.length >= 4, 3000);
      await watched.client.stop();
      const gaps = times.slice(1).map((t, i) => t - times[i]!);
      expect(gaps[0]!).toBeGreaterThanOrEqual(35); // 40
      expect(gaps[1]!).toBeGreaterThanOrEqual(75); // 80
      expect(gaps[2]!).toBeGreaterThanOrEqual(155); // 160
    } finally {
      fake.stop();
    }
  });

  test("stop() ends the loop, even during a long pause", async () => {
    const watched = watch(
      async () => {
        throw new TypeError("fetch failed");
      },
      { initialBackoffMs: 10_000 },
    );
    await waitFor(() => watched.opens() === 1);
    const started = Date.now();
    await watched.client.stop();
    expect(Date.now() - started).toBeLessThan(200);
  });

  test("reconnect() drops the connection and opens a new one", async () => {
    const fake = fakeSse("silent");
    try {
      const watched = watch(fake.open);
      await waitFor(() => watched.opens() === 1);
      await Bun.sleep(20);
      watched.client.reconnect();
      await waitFor(() => watched.opens() === 2);
    } finally {
      fake.stop();
    }
  });
});
