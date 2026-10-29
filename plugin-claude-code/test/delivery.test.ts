import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyProblems } from "../../server/test/helpers";
import { deliveryItems, InboxDelivery, stopNotice } from "../src/delivery";
import { INSTRUCTIONS } from "../src/instructions";
import { ApiError, type DeliveryAck, type Inbox, type MessageDelivery, PorticoClient, type UpdateDelivery } from "../src/portico-client";
import { InboxSocket, SocketError } from "../src/socket";
import { appAgent, connected, joinTestComputer, startPortico, startSession, type TestPortico, waitFor } from "./helpers";

let p: TestPortico;
let token: string;
const cleanup: (() => Promise<void>)[] = [];
const ADDRESS = "api-claude@macbook";
const KEY = "key-delivery-01";

beforeEach(async () => {
  p = await startPortico();
  token = joinTestComputer(p).token;
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  p.stop();
});

async function connect(opts: { client?: PorticoClient; retryMs?: number[]; socket?: InboxSocket } = {}) {
  const s = await startSession(p, { token, key: KEY, client: opts.client, socket: opts.socket, deliveryRetryMs: opts.retryMs });
  cleanup.push(s.stop);
  return s;
}

/** Sends from a new app agent to the session, as Portico's core does for any sender. */
function sender(name = "grok") {
  const { agent } = appAgent(p, name, { kind: "grok-bot" });
  return (subject: string, text: string) => p.messages.send(agent, { to: "api-claude", subject, text }).message;
}

const status = (id: string) => p.messages.get(id)?.status;

describe("inbox socket delivery", () => {
  test("gives Claude standing instructions, without pronouns", async () => {
    const { host } = await connect();
    const instructions = host.getInstructions() ?? "";
    for (const part of [
      "not from the user",
      "list_agents",
      "send_message",
      "list_tasks",
      "get_task",
      "update_profile",
      "done: false",
      "<portico-message",
      "<portico-update",
      "<portico-notice>",
      "Act once per ID",
    ]) {
      expect(instructions).toContain(part);
    }
    // Tasks came back as list_tasks and get_task; the old task tools stay gone.
    for (const retired of ["finish_task", "create_task", "hub"]) expect(instructions).not.toContain(retired);
    expect(copyProblems(INSTRUCTIONS)).toEqual([]);
  });

  test("posts messages through the socket, framed by Portico, and acks them", async () => {
    const { sock, channel, logs } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    const send = sender();
    const message = send("Release", "Which branch is the release on?");
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<portico-message id="${message.id}" from="grok">`);
    expect(sock.posts[0]!.content).toContain("via Portico: Release**");
    expect(sock.posts[0]!.content).toEndWith("Which branch is the release on?\n</portico-message>");
    expect(sock.posts[0]!.auth).toBe("inbox-token");
    await waitFor(() => status(message.id) === "delivered");
    expect(logs.lines.find((line) => line.msg === "message_delivered")?.fields).toEqual({ message_id: message.id });
    expect(JSON.stringify(logs.lines)).not.toContain("Which branch");
    expect(channel).toEqual([]);
  });

  test("delivers messages that arrived while disconnected", async () => {
    // The session registered earlier and is offline now, as after a dropped connection.
    p.agents.registerSession(p.computers.byName("macbook")!, { key: KEY, repo: "api", folderId: "a".repeat(64), client: "claude-code" });
    const message = sender()("Waiting", "Waiting already");
    expect(status(message.id)).toBe("pending");
    const { sock } = await connect();
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<portico-message id="${message.id}"`);
    await waitFor(() => status(message.id) === "delivered");
  });

  test("posts the outcome of a held message this session sent, and marks the outcome reported", async () => {
    appAgent(p, "muse", { approvalRequired: true });
    const { host, sock } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    const sent = await host.callTool({ name: "send_message", arguments: { to: "muse", subject: "Read the inbox", text: "x" } });
    const { message } = JSON.parse((sent.content as { text: string }[])[0]!.text) as { message: { id: string } };
    expect(status(message.id)).toBe("held");
    p.approvals.decide(p.owner.id, message.id, "deny");
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<portico-update message_id="${message.id}" to="muse" status="declined">`);
    expect(sock.posts[0]!.content).toContain("declined");
    await waitFor(() => p.messages.get(message.id)?.senderNotifiedAt != null);
  });

  test("delivers each message once when nudges overlap", async () => {
    const { sock } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    const send = sender();
    const ids = Array.from({ length: 5 }, (_, i) => send(`job ${i}`, `job ${i}`).id);
    await waitFor(() => sock.posts.length === 5);
    await Bun.sleep(100);
    expect(sock.posts).toHaveLength(5);
    const posted = sock.posts.map((post) => /^<portico-message id="([^"]+)"/.exec(post.content)?.[1]);
    expect(posted.sort()).toEqual([...ids].sort());
    for (const id of ids) expect(status(id)).toBe("delivered");
  });

  test("leaves messages waiting when the socket refuses, and delivers them on the retry", async () => {
    const { sock, logs } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    sock.mode = "error";
    const message = sender()("Refused", "Refused at first");
    await Bun.sleep(50);
    expect(status(message.id)).toBe("pending");
    expect(sock.posts).toEqual([]);
    expect(logs.lines.some((line) => line.msg === "inbox_post_failed" && line.fields.code === "refused")).toBe(true);
    sock.mode = "accept";
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<portico-message id="${message.id}"`);
    await waitFor(() => status(message.id) === "delivered");
  });

  test("with no socket, marks nothing delivered and logs inbox_socket_missing once", async () => {
    const { logs } = await connect({ socket: new InboxSocket({ path: () => null, token: () => null }) });
    await waitFor(() => connected(p, ADDRESS));
    const send = sender();
    const first = send("First", "First");
    await waitFor(() => logs.lines.some((line) => line.msg === "inbox_socket_missing"));
    const second = send("Second", "Second");
    await Bun.sleep(100);
    expect(status(first.id)).toBe("pending");
    expect(status(second.id)).toBe("pending");
    expect(logs.lines.filter((line) => line.msg === "inbox_socket_missing")).toHaveLength(1);
    expect(logs.lines.some((line) => line.msg === "message_delivered")).toBe(false);
  });

  test("an item posted but not acked is acked next time without a second post", async () => {
    class AckFailsOnce extends PorticoClient {
      failures = 1;
      override async ackDeliveries(ack: DeliveryAck) {
        if (this.failures-- > 0) throw new ApiError(0, "unreachable", "down");
        return super.ackDeliveries(ack);
      }
    }
    const client = new AckFailsOnce({ url: p.url, token, sessionKey: KEY });
    const { sock, logs } = await connect({ client });
    await waitFor(() => connected(p, ADDRESS));
    const message = sender()("Once", "Post once");
    await waitFor(() => client.failures < 0);
    await waitFor(() => status(message.id) === "delivered");
    await Bun.sleep(50);
    expect(sock.posts).toHaveLength(1);
    expect(logs.lines.some((line) => line.msg === "inbox_check_failed")).toBe(true);
  });

  test("after a failed deliveries check, reconnects and delivers on Portico's next nudge", async () => {
    class FlakyClient extends PorticoClient {
      failures = 1;
      override async pendingDeliveries(): Promise<Inbox> {
        if (this.failures-- > 0) throw new ApiError(0, "unreachable", "down");
        return super.pendingDeliveries();
      }
    }
    const flaky = new FlakyClient({ url: p.url, token, sessionKey: KEY });
    const { sock, logs } = await connect({ client: flaky });
    await waitFor(() => connected(p, ADDRESS));
    const message = sender()("Again", "Try again");
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith(`<portico-message id="${message.id}"`);
    expect(logs.lines.some((line) => line.msg === "inbox_check_failed")).toBe(true);
  });

  test("checks again after each delivered batch, so a capped delivery list doesn't strand messages", async () => {
    class OneAtATime extends PorticoClient {
      override async pendingDeliveries(): Promise<Inbox> {
        const d = await super.pendingDeliveries();
        return { ...d, messages: d.messages.slice(0, 1) };
      }
    }
    const { sock } = await connect({ client: new OneAtATime({ url: p.url, token, sessionKey: KEY }) });
    await waitFor(() => connected(p, ADDRESS));
    const send = sender();
    // Sent within one tick, so the first nudge finds all three waiting.
    const ids = [1, 2, 3].map((i) => send(`queued ${i}`, `queued ${i}`).id);
    await waitFor(() => sock.posts.length === 3);
    for (const id of ids) await waitFor(() => status(id) === "delivered");
  });

  test("a permanent stop stops delivery, so an armed retry can't peek, post or ack afterwards", async () => {
    class Counting extends PorticoClient {
      peeks = 0;
      acks = 0;
      override async pendingDeliveries(): Promise<Inbox> {
        this.peeks++;
        return super.pendingDeliveries();
      }
      override async ackDeliveries(ack: DeliveryAck) {
        this.acks++;
        return super.ackDeliveries(ack);
      }
    }
    const client = new Counting({ url: p.url, token, sessionKey: KEY });
    const { sock, logs } = await connect({ client, retryMs: [300] });
    await waitFor(() => connected(p, ADDRESS));
    sock.mode = "error";
    const message = sender()("Refused", "Refused, then removed");
    await waitFor(() => logs.lines.some((line) => line.msg === "inbox_post_failed"));
    // The retry is now armed. Let the socket accept again, so only a stopped delivery keeps the message from going out.
    sock.mode = "accept";
    const peeks = client.peeks;
    // The computer is removed: the stream closes, the reconnect gets 401, and the stream stops for good.
    p.agents.forget(p.computers.remove(p.computers.byName("macbook")!.id));
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toContain("no longer accepts this computer's token");
    await Bun.sleep(400);
    expect(client.peeks).toBe(peeks);
    expect(client.acks).toBe(0);
    expect(sock.posts).toHaveLength(1);
    expect(p.messages.get(message.id)).toBeNull();
  });

  test("stop() clears a pending retry", async () => {
    let peeks = 0;
    const client = {
      pendingDeliveries: async (): Promise<Inbox> => {
        peeks++;
        return { messages: [{ id: "m1", created_at: "2026-10-27T10:00:00.000Z", framed_message: "M" } as MessageDelivery], updates: [] };
      },
      ackDeliveries: async () => ({ acked: { messages: 0, updates: 0 } }),
    };
    const socket = {
      post: async () => {
        throw new SocketError("refused", "The inbox socket refused the post.");
      },
    };
    const logs: string[] = [];
    const delivery = new InboxDelivery({ client, socket, log: (_l, msg) => logs.push(msg), onFailure: () => {}, retryMs: [20] });
    await delivery.run();
    await waitFor(() => peeks === 2); // the retry fired and armed the next one
    delivery.stop();
    await Bun.sleep(80);
    expect(peeks).toBe(2);
  });

  test("never declares a Claude Code channel", async () => {
    const { host } = await connect();
    expect(host.getServerCapabilities()?.experimental).toBeUndefined();
  });

  test("tells the session when Portico no longer accepts the computer's token", async () => {
    const { sock } = await connect({ client: new PorticoClient({ url: p.url, token: "pc_not-a-real-token-123456789", sessionKey: KEY }) });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toStartWith("<portico-notice>\nPortico delivery is off: Portico no longer accepts this computer's token");
  });

  test("a rename reaches the session as a notice with the new name", async () => {
    const { sock, logs } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    p.agents.update(p.owner.id, p.agents.byAddress(ADDRESS)!.id, { name: "billing-claude" });
    await waitFor(() => sock.posts.length === 1);
    expect(sock.posts[0]!.content).toBe(
      "<portico-notice>\nThis session is now `billing-claude` on Portico (address `billing-claude@macbook`). Other agents send messages to that name.\n</portico-notice>",
    );
    expect(logs.lines).toContainEqual({ level: "info", msg: "session_renamed", fields: { address: "billing-claude@macbook" } });
  });

  test("logs carry IDs, never message text", async () => {
    const { sock, logs } = await connect();
    await waitFor(() => connected(p, ADDRESS));
    const message = sender()("SECRET-SUBJECT", "SECRET-TEXT");
    await waitFor(() => sock.posts.length === 1);
    await waitFor(() => status(message.id) === "delivered");
    const logged = JSON.stringify(logs.lines);
    for (const secret of ["SECRET-SUBJECT", "SECRET-TEXT", "inbox-token", token, KEY]) expect(logged).not.toContain(secret);
  });
});

describe("deliveryItems", () => {
  test("orders messages by created_at, then updates by when they happened", () => {
    const message = (id: string, created_at: string) => ({ id, created_at, framed_message: `M ${id}` }) as MessageDelivery;
    const update = (message_id: string, at: string) => ({ message_id, at, framed_message: `U ${message_id}` }) as UpdateDelivery;
    const items = deliveryItems({
      messages: [message("m-late", "2026-10-27T10:00:03.000Z"), message("m-early", "2026-10-27T10:00:00.000Z")],
      updates: [update("u-late", "2026-10-27T09:00:02.000Z"), update("u-early", "2026-10-27T09:00:00.000Z")],
    });
    expect(items.map((item) => `${item.kind}:${item.id}`)).toEqual(["message:m-early", "message:m-late", "update:u-early", "update:u-late"]);
    expect(items.map((item) => item.text)).toEqual(["M m-early", "M m-late", "U u-early", "U u-late"]);
  });
});

describe("notice text", () => {
  test("stopNotice explains each permanent stop, without pronouns or the retired word", () => {
    const notices = [
      stopNotice({ reason: "replaced" }),
      stopNotice({ reason: "rejected", status: 401, code: "unauthorized", message: "Missing or invalid bearer token." }),
      stopNotice({ reason: "rejected", status: 404, code: "not_found", message: "No such endpoint." }),
      stopNotice({ reason: "rejected", status: 403, code: "not_allowed", message: "Only sessions on a computer open the live stream." }),
    ];
    expect(notices[0]).toContain("another connection took over");
    expect(notices[1]).toContain("Join again with a new join line");
    expect(notices[2]).toContain("(404)");
    expect(notices[3]).toContain("Only sessions on a computer open the live stream.");
    for (const notice of notices) expect(copyProblems(notice)).toEqual([]);
  });
});
