import type { Hono } from "hono";
import type { PushMessage } from "../src/approvals/ntfy";
import { createHub } from "../src/hub";
import { parseConfig } from "../src/config";
import { BridgeError } from "../src/core/errors";
import { BridgeService } from "../src/core/service";
import type { BridgeConfig, Notice } from "../src/core/types";
import { openDb, Store } from "../src/db";

export const T0 = new Date("2026-10-20T12:00:00.000Z");
export const HOUR = 3_600_000;

export function testClock(start: Date = T0) {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    advance: (ms: number) => {
      current += ms;
    },
  };
}

// Rules cover every case: allow, ask, an explicit block, and pairs with no rule (blocked).
export const BASE_YAML = `
agents:
  - { name: grok-bot, description: Grok Bot, delivery: pull }
  - { name: claude-code, description: Claude Code, delivery: push }
  - { name: muse, description: Meta Muse, delivery: pull }
  - { name: codex, description: Codex, delivery: pull }
rules:
  - { from: grok-bot, to: claude-code, action: allow }
  - { from: claude-code, to: grok-bot, action: allow }
  - { from: muse, to: claude-code, action: allow }
  - { from: codex, to: grok-bot, action: allow }
  - { from: "*", to: muse, action: ask }
  - { from: codex, to: claude-code, action: block }
triggers:
  - name: bug-to-claude
    when: { agent: muse, event: bug_report_received }
    send: { to: claude-code, instructions: "Investigate: {{event.details}}" }
  - name: bug-to-grok
    when: { agent: muse, event: bug_report_received }
    send: { to: grok-bot, instructions: "Research: {{event.details}}" }
`;

export const TOKENS = {
  "grok-bot": "grok-token-0123456789abcdef",
  "claude-code": "claude-token-0123456789abcdef",
  muse: "muse-token-0123456789abcdef01",
  codex: "codex-token-0123456789abcdef",
} as const;

export type TestAgent = keyof typeof TOKENS;

export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    BRIDGE_PUBLIC_URL: "https://bridge.test",
    BRIDGE_TOKEN_GROK_BOT: TOKENS["grok-bot"],
    BRIDGE_TOKEN_CLAUDE_CODE: TOKENS["claude-code"],
    BRIDGE_TOKEN_MUSE: TOKENS.muse,
    BRIDGE_TOKEN_CODEX: TOKENS.codex,
    BRIDGE_SIGNING_SECRET: "test-signing-secret-0123456789abcdef",
    BRIDGE_ADMIN_PASSWORD: "test-admin-password",
    ...extra,
  };
}

export function testConfig(yaml: string = BASE_YAML, extraEnv: Record<string, string> = {}): BridgeConfig {
  return parseConfig(yaml, testEnv(extraEnv));
}

export function makeService(config: BridgeConfig = testConfig()) {
  const store = new Store(openDb(":memory:"));
  const clock = testClock();
  const notices: Notice[] = [];
  let counter = 0;
  const service = new BridgeService({
    store,
    config,
    now: clock.now,
    newId: () => `id-${++counter}`,
    notify: (notice) => notices.push(notice),
  });
  return { service, store, config, clock, notices };
}

/** Runs fn and returns the BridgeError code it threw, or null if it didn't throw. */
export function errorCode(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    if (err instanceof BridgeError) return err.code;
    throw err;
  }
  return null;
}

export function makeApp(config: BridgeConfig = testConfig()) {
  const clock = testClock();
  const notices: Notice[] = [];
  const pushes: PushMessage[] = [];
  let counter = 0;
  const hub = createHub(config, {
    db: openDb(":memory:"),
    now: clock.now,
    newId: () => `id-${++counter}`,
    push: async (message) => {
      pushes.push(message);
      return true;
    },
    heartbeatMs: 50,
    onNotice: (notice) => notices.push(notice),
  });
  const { app } = hub;
  async function call(agent: TestAgent | null, method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = {};
    if (agent) headers.authorization = `Bearer ${TOKENS[agent]}`;
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = typeof body === "string" ? body : JSON.stringify(body);
    }
    return await app.request(path, { method, headers, body: payload });
  }
  return { ...hub, config, clock, notices, pushes, call };
}

/** Lets queued microtasks and zero-delay timers run, e.g. the notifier's work after a transaction. */
export function flush(): Promise<void> {
  return Bun.sleep(1);
}

export interface SseEvent {
  event: string;
  data: unknown;
}

/** Reads server-sent events from a streaming response, skipping heartbeat comments. */
export function sseReader(res: Response) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Kept across calls: a read that loses a timeout race still owns the next chunk.
  let pending: ReturnType<typeof reader.read> | null = null;
  return {
    async next(timeoutMs = 2000): Promise<SseEvent> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const lines = block.split("\n").filter((line) => line !== "" && !line.startsWith(":"));
          if (lines.length === 0) continue; // a heartbeat comment
          const event = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
          const data = lines
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("\n");
          return { event, data: data ? JSON.parse(data) : null };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("timed out waiting for a stream event");
        pending ??= reader.read();
        const chunk = await Promise.race([pending, Bun.sleep(remaining).then(() => null)]);
        if (chunk === null) throw new Error("timed out waiting for a stream event");
        pending = null;
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {});
    },
  };
}

export const ADMIN_PASSWORD = "test-admin-password";

/** Signs in to the hub page and returns the Cookie header value to send. */
export async function signIn(app: Hono, password = ADMIN_PASSWORD): Promise<string> {
  const res = await app.request("/hub/login", { method: "POST", body: new URLSearchParams({ password }) });
  const setCookie = res.headers.get("set-cookie");
  if (res.status !== 303 || !setCookie) throw new Error(`sign-in failed with ${res.status}`);
  return setCookie.split(";")[0]!;
}
