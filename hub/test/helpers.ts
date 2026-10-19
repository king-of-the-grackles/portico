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
