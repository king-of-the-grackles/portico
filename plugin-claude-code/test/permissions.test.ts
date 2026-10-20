import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { HubClient, HubError, type PermissionPrompt } from "../src/hub-client";
import { PERMISSION_TTL_MS, PermissionRelayClient } from "../src/permissions";
import { createBridgePlugin } from "../src/plugin";
import { captureLog, fakeHost, startHub, type TestHub, TOKENS, waitFor } from "./helpers";

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

const prompt = (request_id: string) => ({
  request_id,
  tool_name: "Bash",
  description: "SECRET-DESCRIPTION",
  input_preview: '{"command":"SECRET-COMMAND"}',
});

async function connect(opts: { relay?: boolean; client?: HubClient } = {}) {
  const plugin = createBridgePlugin({
    config: { url: hub.url, token: TOKENS["claude-code"], permissionRelay: opts.relay ?? true },
    client: opts.client ?? new HubClient({ url: hub.url, token: TOKENS["claude-code"] }),
    log: logs.log,
    stream: { initialBackoffMs: 10 },
    relayRetryMs: [5, 5],
  });
  const host = await fakeHost(plugin);
  cleanup.push(async () => {
    await plugin.stop();
    await host.close();
  });
  await waitFor(() => hub.streams.isConnected("claude-code"));
  return host;
}

describe("permission relay", () => {
  test("declares the permission capability only when relay is on", async () => {
    const on = await connect();
    expect(on.host.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {}, "claude/channel/permission": {} });
  });

  test("relays a prompt to the hub, which pushes it to the phone", async () => {
    const host = await connect();
    await host.askPermission(prompt("abcde"));
    await waitFor(() => hub.relay.pending().length === 1);
    expect(hub.relay.pending()[0]).toMatchObject({ agent: "claude-code", requestId: "abcde", toolName: "Bash" });
    await waitFor(() => hub.pushes.length === 1);
    expect(hub.pushes[0]!.title).toBe("claude-code wants to use Bash");
  });

  test("forwards an answer once, and drops repeats and answers for prompts it didn't relay", async () => {
    const host = await connect();
    await host.askPermission(prompt("abcde"));
    await host.askPermission(prompt("fghij"));
    await waitFor(() => hub.relay.pending().length === 2);

    hub.relay.answer("claude-code", "abcde", "allow");
    hub.relay.answer("claude-code", "fghij", "deny");
    await waitFor(() => host.verdicts.length === 2);
    expect(host.verdicts).toEqual([
      { request_id: "abcde", behavior: "allow" },
      { request_id: "fghij", behavior: "deny" },
    ]);

    // The hub re-sends answers on every reconnect; one for an unknown prompt must not reach Claude Code either.
    hub.streams.sendPermissionAnswer("claude-code", "abcde", "allow");
    hub.streams.sendPermissionAnswer("claude-code", "qwert", "allow");
    await Bun.sleep(100);
    expect(host.verdicts.length).toBe(2);
  });

  test("with relay off, prompts stay in the terminal and answers are ignored", async () => {
    const host = await connect({ relay: false });
    expect(host.host.getServerCapabilities()?.experimental).toEqual({ "claude/channel": {} });
    await host.askPermission(prompt("abcde"));
    hub.streams.sendPermissionAnswer("claude-code", "abcde", "allow");
    await Bun.sleep(100);
    expect(hub.relay.pending()).toEqual([]);
    expect(host.verdicts).toEqual([]);
  });

  test("retries a relay when the hub can't be reached", async () => {
    class Flaky extends HubClient {
      failures = 2;
      override async relayPermission(p: PermissionPrompt): Promise<unknown> {
        if (this.failures-- > 0) throw new HubError(0, "unreachable", "down");
        return super.relayPermission(p);
      }
    }
    const host = await connect({ client: new Flaky({ url: hub.url, token: TOKENS["claude-code"] }) });
    await host.askPermission(prompt("abcde"));
    await waitFor(() => hub.relay.pending().length === 1);
  });

  test("gives up at once on a refusal, and then ignores answers for that prompt", async () => {
    let calls = 0;
    class Refused extends HubClient {
      override async relayPermission(): Promise<unknown> {
        calls++;
        throw new HubError(429, "rate_limited", "too many");
      }
    }
    const host = await connect({ client: new Refused({ url: hub.url, token: TOKENS["claude-code"] }) });
    await host.askPermission(prompt("abcde"));
    await waitFor(() => logs.lines.some((line) => line.msg === "permission_relay_failed"));
    expect(calls).toBe(1);
    hub.streams.sendPermissionAnswer("claude-code", "abcde", "allow");
    await Bun.sleep(100);
    expect(host.verdicts).toEqual([]);
  });

  test("logs never carry the description or the input preview", async () => {
    const host = await connect();
    await host.askPermission(prompt("abcde"));
    await waitFor(() => hub.relay.pending().length === 1);
    hub.relay.answer("claude-code", "abcde", "allow");
    await waitFor(() => host.verdicts.length === 1);
    const logged = JSON.stringify(logs.lines);
    expect(logged).not.toContain("SECRET-DESCRIPTION");
    expect(logged).not.toContain("SECRET-COMMAND");
    expect(logs.lines.map((line) => line.msg)).toContain("permission_answered");
  });
});

describe("reused request IDs", () => {
  const ask = (host: Awaited<ReturnType<typeof connect>>, id: string, description: string) =>
    host.askPermission({ ...prompt(id), description });

  test("an old answer replayed while a reused ID is being relayed is not forwarded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    class Gated extends HubClient {
      calls = 0;
      override async relayPermission(p: PermissionPrompt): Promise<unknown> {
        if (this.calls++ === 1) await gate;
        return super.relayPermission(p);
      }
    }
    const host = await connect({ client: new Gated({ url: hub.url, token: TOKENS["claude-code"] }) });
    await ask(host, "abcde", "first");
    await waitFor(() => hub.relay.pending().length === 1);
    hub.relay.answer("claude-code", "abcde", "allow");
    await waitFor(() => host.verdicts.length === 1);

    await ask(host, "abcde", "second");
    hub.streams.sendPermissionAnswer("claude-code", "abcde", "allow");
    await Bun.sleep(100);
    expect(host.verdicts.length).toBe(1);
    release();
    await waitFor(() => hub.relay.pending().length === 1);
  });

  test("a reused ID that is still waiting is not relayed again, and its answers are dropped", async () => {
    const host = await connect();
    await ask(host, "abcde", "ls");
    await waitFor(() => hub.relay.pending().length === 1);
    await waitFor(() => hub.pushes.length === 1);
    await ask(host, "abcde", "rm");
    await waitFor(() => logs.lines.some((line) => line.msg === "permission_id_reused"));
    expect(hub.relay.pending().length).toBe(1);
    expect(hub.pushes.length).toBe(1);
    hub.relay.answer("claude-code", "abcde", "allow");
    await Bun.sleep(100);
    expect(host.verdicts).toEqual([]);
  });

  test("an ID can be reused once its answer was forwarded", async () => {
    const host = await connect();
    await ask(host, "abcde", "first");
    await waitFor(() => hub.relay.pending().length === 1);
    hub.relay.answer("claude-code", "abcde", "allow");
    await waitFor(() => host.verdicts.length === 1);
    await ask(host, "abcde", "second");
    await waitFor(() => hub.relay.pending().length === 1);
    hub.relay.answer("claude-code", "abcde", "deny");
    await waitFor(() => host.verdicts.length === 2);
    expect(host.verdicts[1]).toEqual({ request_id: "abcde", behavior: "deny" });
  });
});

describe("PermissionRelayClient", () => {
  test("forgets a prompt after an hour, as the hub does", async () => {
    let now = 1_000_000;
    const verdicts: string[] = [];
    const relay = new PermissionRelayClient({
      client: { relayPermission: async () => ({}) } as unknown as HubClient,
      sendVerdict: async (requestId) => {
        verdicts.push(requestId);
      },
      log: captureLog().log,
      now: () => now,
    });
    await relay.relay(prompt("abcde"));
    expect(relay.pending).toBe(1);
    now += PERMISSION_TTL_MS + 1;
    relay.answer({ request_id: "abcde", behavior: "allow" });
    expect(verdicts).toEqual([]);
    expect(relay.pending).toBe(0);
  });

  test("ignores malformed answers", async () => {
    const verdicts: string[] = [];
    const relay = new PermissionRelayClient({
      client: { relayPermission: async () => ({}) } as unknown as HubClient,
      sendVerdict: async (requestId) => {
        verdicts.push(requestId);
      },
      log: captureLog().log,
    });
    await relay.relay(prompt("abcde"));
    relay.answer(null);
    relay.answer({ request_id: "abcde", behavior: "maybe" });
    relay.answer({ request_id: 5, behavior: "allow" });
    expect(verdicts).toEqual([]);
    expect(relay.pending).toBe(1);
  });
});
