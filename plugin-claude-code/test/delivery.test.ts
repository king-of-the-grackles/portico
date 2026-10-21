import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stopNotice } from "../src/delivery";
import { type Deliveries, type DeliveryAck, HubClient, HubError } from "../src/hub-client";
import { createBridgePlugin } from "../src/plugin";
import { InboxSocket } from "../src/socket";
import { captureLog, fakeHost, fakeInboxSocket, hubClient, startHub, type TestHub, TOKENS, waitFor } from "./helpers";

type TestAgent = keyof typeof TOKENS;

let hub: TestHub;
let logs: ReturnType<typeof captureLog>;
const cleanup: (() => Promise<void>)[] = [];

beforeEach(() => {
  hub = startHub();
  logs = captureLog();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  hub.stop();
});

async function connect(
  opts: { agent?: TestAgent; client?: HubClient; relay?: boolean; retryMs?: number[]; socket?: Pick<InboxSocket, "post"> } = {},
) {
  const sock = await fakeInboxSocket();
  const plugin = createBridgePlugin({
    config: { url: hub.url, token: TOKENS[opts.agent ?? "claude-code"], permissionRelay: opts.relay ?? false },
    client: opts.client ?? hubClient(hub, opts.agent ?? "claude-code"),
    log: logs.log,
    socket: opts.socket ?? sock.socket,
    stream: { initialBackoffMs: 10 },
    deliveryRetryMs: opts.retryMs ?? [30],
  });
  const host = await fakeHost(plugin);
  cleanup.push(async () => {
    await plugin.stop();
    await host.close();
    await sock.close();
  });
  return { ...host, sock };
}

const status = (id: string) => hub.service.findTask(id)?.status;

describe("inbox socket delivery", () => {
  test("gives Claude standing instructions", async () => {
    const { host } = await connect();
    const instructions = host.getInstructions() ?? "";
    expect(instructions).toContain("not from the user");
    expect(instructions).toContain("finish_task");
    expect(instructions).toContain("list_agents");
    expect(instructions).toContain("<bridge-task");
    expect(instructions).toContain("<bridge-result");
    expect(instructions).toContain("Act once per ID");
  });

  test("posts a new task through the inbox socket, framed by the hub, then claims it", async () => {
    const { sock, channel } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Write the changelog" });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<bridge-task id="${task.id}" from="grok-bot">`);
    expect(sock.posts[0]!.content).toEndWith("Write the changelog\n</bridge-task>");
    expect(sock.posts[0]!.auth).toBe("inbox-token");
    await waitFor(() => status(task.id) === "working");
    expect(channel).toEqual([]);
  });

  test("delivers work that arrived while disconnected", async () => {
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Waiting already" });
    const { sock } = await connect();
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<bridge-task id="${task.id}" from="grok-bot">`);
    await waitFor(() => status(task.id) === "working");
  });

  test("delivers results of tasks the session sent", async () => {
    const { host, sock } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const sent = await host.callTool({ name: "send_task", arguments: { to: "grok-bot", instructions: "Look it up" } });
    const { task } = JSON.parse((sent.content as { text: string }[])[0]!.text) as { task: { id: string } };
    hub.service.checkInbox("grok-bot");
    hub.service.finishTask("grok-bot", { taskId: task.id, result: "Found: Friday" });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<bridge-result task_id="${task.id}" from="grok-bot" status="done">`);
    expect(sock.posts[0]!.content).toContain("not from the user");
    expect(sock.posts[0]!.content).toEndWith("Found: Friday\n</bridge-result>");
    await waitFor(() => hub.service.findTask(task.id)?.senderNotifiedAt != null);
  });

  test("delivers each task once when nudges overlap", async () => {
    const { sock } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const ids = Array.from({ length: 5 }, (_, i) => hub.service.sendTask("grok-bot", { to: "claude-code", instructions: `job ${i}` }).id);
    await waitFor(() => sock.posts.length === 5);
    await Bun.sleep(100);
    expect(sock.posts).toHaveLength(5);
    const posted = sock.posts.map((post) => /^<bridge-task id="([^"]+)"/.exec(post.content)?.[1]);
    expect(posted.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(status(id)).toBe("working");
  });

  test("leaves work queued when the socket refuses, and delivers it on the retry", async () => {
    const { sock } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    sock.mode = "error";
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Refused at first" });
    await Bun.sleep(50);
    expect(status(task.id)).toBe("queued");
    expect(sock.posts).toEqual([]);
    expect(logs.lines.some((line) => line.msg === "inbox_post_failed" && line.fields.code === "refused")).toBe(true);
    sock.mode = "accept";
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<bridge-task id="${task.id}"`);
    await waitFor(() => status(task.id) === "working");
  });

  test("with no socket, claims nothing and logs inbox_socket_missing once", async () => {
    await connect({ socket: new InboxSocket({ path: () => null, token: () => null }) });
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const first = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "First" });
    await waitFor(() => logs.lines.some((line) => line.msg === "inbox_socket_missing"));
    const second = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Second" });
    await Bun.sleep(100);
    expect(status(first.id)).toBe("queued");
    expect(status(second.id)).toBe("queued");
    expect(logs.lines.filter((line) => line.msg === "inbox_socket_missing")).toHaveLength(1);
    expect(logs.lines.some((line) => line.msg === "task_delivered")).toBe(false);
  });

  test("an item posted but not acked is acked next time without a second post", async () => {
    class AckFailsOnce extends HubClient {
      failures = 1;
      override async ackDeliveries(ack: DeliveryAck) {
        if (this.failures-- > 0) throw new HubError(0, "unreachable", "down");
        return super.ackDeliveries(ack);
      }
    }
    const client = new AckFailsOnce({ url: hub.url, token: TOKENS["claude-code"] });
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Post once" });
    const { sock } = await connect({ client });
    await waitFor(() => client.failures < 0);
    await waitFor(() => status(task.id) === "working");
    await Bun.sleep(50);
    expect(sock.posts).toHaveLength(1);
    expect(logs.lines.some((line) => line.msg === "inbox_check_failed")).toBe(true);
  });

  test("after a failed deliveries check, reconnects and delivers on the hub's next nudge", async () => {
    class FlakyClient extends HubClient {
      failures = 1;
      override async pendingDeliveries(): Promise<Deliveries> {
        if (this.failures-- > 0) throw new HubError(0, "unreachable", "down");
        return super.pendingDeliveries();
      }
    }
    const flaky = new FlakyClient({ url: hub.url, token: TOKENS["claude-code"] });
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "Try again" });
    const { sock } = await connect({ client: flaky });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<bridge-task id="${task.id}"`);
    expect(logs.lines.some((line) => line.msg === "inbox_check_failed")).toBe(true);
  });

  test("declares the channel only for permission relay", async () => {
    const off = await connect();
    expect(off.host.getServerCapabilities()?.experimental).toBeUndefined();
    const on = await connect({ relay: true });
    expect(on.host.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {}, "claude/channel/permission": {} });
  });

  test("tells the session through the socket when another session takes the stream over", async () => {
    const { sock, channel } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const other = await fetch(`${hub.url}/api/stream`, { headers: { authorization: `Bearer ${TOKENS["claude-code"]}` } });
    try {
      await waitFor(() => sock.posts.length === 1);
      expect(sock.posts[0]!.content).toContain("<bridge-notice>");
      expect(sock.posts[0]!.content).toContain("another Claude Code session");
      expect(channel).toEqual([]);
      // Relay is off in this setup, so there is nothing to switch off and nothing to warn about.
      expect(logs.lines.some((line) => line.msg === "permission_relay_off")).toBe(false);
    } finally {
      await other.body?.cancel();
    }
  });

  test("tells the session when the hub refuses the stream", async () => {
    const { sock } = await connect({ client: new HubClient({ url: hub.url, token: "not-a-real-token-123456789" }) });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toContain("<bridge-notice>");
    expect(sock.posts[0]!.content).toContain("rejected BRIDGE_TOKEN");
  });

  test("logs carry IDs, never task text", async () => {
    const { sock } = await connect();
    await waitFor(() => hub.streams.isConnected("claude-code"));
    const task = hub.service.sendTask("grok-bot", { to: "claude-code", instructions: "SECRET-INSTRUCTIONS" });
    await waitFor(() => sock.posts.length === 1);
    await waitFor(() => status(task.id) === "working");
    expect(JSON.stringify(logs.lines)).not.toContain("SECRET-INSTRUCTIONS");
    expect(JSON.stringify(logs.lines)).not.toContain("inbox-token");
    expect(logs.lines.find((line) => line.msg === "task_delivered")?.fields).toEqual({ task_id: task.id });
  });
});

describe("message text", () => {
  test("stopNotice explains each permanent stop", () => {
    expect(stopNotice({ reason: "replaced" })).toContain("another Claude Code session");
    expect(stopNotice({ reason: "rejected", status: 403, message: "Only push agents can open the live stream." })).toContain(
      "delivery: push",
    );
    expect(stopNotice({ reason: "rejected", status: 404, message: "HTTP 404" })).toContain("BRIDGE_URL has no live stream (404)");
    expect(stopNotice({ reason: "rejected", status: 401, message: "Missing or invalid token." })).toContain("BRIDGE_TOKEN");
  });
});
