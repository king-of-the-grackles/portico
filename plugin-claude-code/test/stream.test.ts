import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HubClient } from "../src/hub-client";
import { StreamClient, type StreamClientOptions, type StreamStop } from "../src/stream";
import { captureLog, hubClient, startHub, type TestHub, TOKENS, waitFor } from "./helpers";

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

describe("StreamClient against the hub", () => {
  let hub: TestHub;
  beforeEach(() => {
    hub = startHub();
  });
  afterEach(async () => {
    for (const client of running.splice(0)) await client.stop();
    hub.stop();
  });

  const openAs = (agent: keyof typeof TOKENS) => (signal: AbortSignal) => hubClient(hub, agent).openStream(signal);

  test("passes nudges through", async () => {
    const watched = watch(openAs("claude-code"));
    await waitFor(() => hub.streams.isConnected("claude-code"));
    hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "hello" });
    await waitFor(() => watched.events.length > 0);
    expect(watched.events[0]).toEqual({ event: "nudge", data: {} });
  });

  test("stops for good when another stream replaces it", async () => {
    const first = watch(openAs("claude-code"));
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const second = watch(openAs("claude-code"));
    await waitFor(() => first.stops.length === 1);
    expect(first.stops[0]).toEqual({ reason: "replaced" });
    await Bun.sleep(100);
    expect(first.opens()).toBe(1);
    expect(second.stops).toEqual([]);
  });

  test("stops for good when the hub refuses the stream", async () => {
    const pull = watch(openAs("grok-bot"));
    await waitFor(() => pull.stops.length === 1);
    expect(pull.stops[0]).toEqual({ reason: "rejected", status: 403, message: "Only push agents can open the live stream." });

    const wrong = new HubClient({ url: hub.url, token: "wrong-token-0123456789abcdef" });
    const unknown = watch((signal) => wrong.openStream(signal));
    await waitFor(() => unknown.stops.length === 1);
    expect(unknown.stops[0]).toMatchObject({ reason: "rejected", status: 401 });

    await Bun.sleep(100);
    expect(pull.opens()).toBe(1);
    expect(unknown.opens()).toBe(1);
  });

  test("stops for good on a 404, which means BRIDGE_URL points at the wrong path (the hub answered not_found)", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: "not_found", message: "No such endpoint." }, { status: 404 }) });
    try {
      const watched = watch((signal) => fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal }));
      await waitFor(() => watched.stops.length === 1);
      expect(watched.stops[0]).toMatchObject({ reason: "rejected", status: 404 });
      await Bun.sleep(100);
      expect(watched.opens()).toBe(1);
    } finally {
      server.stop(true);
    }
  });

  test("retries a 404 that did not come from the hub, such as a proxy page during a redeploy", async () => {
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
      const watched = watch((signal) => fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal }));
      await waitFor(() => watched.opens() >= 2);
      await waitFor(() => watched.logs.lines.some((line) => line.msg === "stream_connected"));
      expect(watched.stops).toEqual([]);
      expect(watched.logs.lines).toContainEqual({ level: "warn", msg: "stream_failed", fields: { status: 404 } });
    } finally {
      server.stop(true);
    }
  });

  test("heartbeats keep a quiet stream open", async () => {
    const quiet = watch(openAs("claude-code"), { silenceMs: 300 });
    await Bun.sleep(800);
    expect(quiet.opens()).toBe(1);
  });
});

/** A server that sends ": connected" and then either ends the stream or goes silent. */
function fakeSse(mode: "end" | "silent") {
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": connected\n\n"));
            if (mode === "end") controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  return {
    open: (signal: AbortSignal) => fetch(`http://127.0.0.1:${server.port}/api/stream`, { signal }),
    stop: () => server.stop(true),
  };
}

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

  test("starts the backoff over after a healthy connection", async () => {
    const hub = startHub();
    try {
      const times: number[] = [];
      const watched = watch(
        (signal) => {
          times.push(Date.now());
          return hubClient(hub, "claude-code").openStream(signal);
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
    } finally {
      hub.stop();
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
