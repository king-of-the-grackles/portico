import { describe, expect, test } from "bun:test";
import { ConfigError, parseConfig, tokenEnvName } from "../src/config";

const YAML = `
agents:
  - name: grok-bot
    description: Grok Bot
    delivery: pull
  - name: claude-code-wingman
    description: Claude Code in the wingman repo
    delivery: push
rules:
  - { from: grok-bot, to: claude-code-wingman, action: allow }
  - { from: "*", to: grok-bot, action: ask }
triggers:
  - name: bug-to-claude
    when: { agent: grok-bot, event: found_bug }
    send: { to: claude-code-wingman, instructions: "Fix this: {{ event.details }}" }
`;

const ENV: Record<string, string | undefined> = {
  BRIDGE_PUBLIC_URL: "https://bridge.example.com/",
  BRIDGE_TOKEN_GROK_BOT: "g".repeat(32),
  BRIDGE_TOKEN_CLAUDE_CODE_WINGMAN: "c".repeat(32),
};

function problems(yaml: string, env: Record<string, string | undefined> = ENV): string[] {
  try {
    parseConfig(yaml, env);
    return [];
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
}

describe("tokenEnvName", () => {
  test("upper-cases and turns hyphens into underscores", () => {
    expect(tokenEnvName("claude-code-wingman")).toBe("BRIDGE_TOKEN_CLAUDE_CODE_WINGMAN");
  });
});

describe("parseConfig", () => {
  test("parses a valid file and fills in defaults", () => {
    const config = parseConfig(YAML, ENV);
    expect(config.agents.map((a) => a.name)).toEqual(["grok-bot", "claude-code-wingman"]);
    expect(config.rules).toHaveLength(2);
    expect(config.triggers[0]?.send.to).toBe("claude-code-wingman");
    expect(config.publicUrl).toBe("https://bridge.example.com");
    expect(config.tokens).toEqual({ "grok-bot": "g".repeat(32), "claude-code-wingman": "c".repeat(32) });
    expect(config.limits).toEqual({
      taskExpiryHours: 24,
      tasksPerHourPerAgent: 30,
      eventsPerHourPerAgent: 60,
      maxTextKb: 20,
      maxChainLength: 1,
      historyDays: 30,
    });
    expect(config.port).toBe(8787);
    expect(config.dbPath).toBe("./bridge.db");
  });

  test("reads limits, PORT and BRIDGE_DB_PATH", () => {
    const config = parseConfig(`${YAML}\nlimits:\n  max_chain_length: 3\n  task_expiry_hours: 2\n`, {
      ...ENV,
      PORT: "9000",
      BRIDGE_DB_PATH: "/data/bridge.db",
    });
    expect(config.limits.maxChainLength).toBe(3);
    expect(config.limits.taskExpiryHours).toBe(2);
    expect(config.port).toBe(9000);
    expect(config.dbPath).toBe("/data/bridge.db");
  });

  test("rejects bad and duplicate agent names", () => {
    const yaml = `
agents:
  - { name: Grok_Bot, description: x, delivery: pull }
  - { name: muse, description: x, delivery: pull }
  - { name: muse, description: y, delivery: pull }
`;
    const p = problems(yaml, {
      BRIDGE_PUBLIC_URL: "https://b.test",
      BRIDGE_TOKEN_GROK_BOT: "g".repeat(32),
      BRIDGE_TOKEN_MUSE: "m".repeat(32),
    });
    expect(p).toContain('agent name "Grok_Bot" must be lowercase letters, digits and hyphens');
    expect(p).toContain('agent name "muse" is used more than once');
  });

  test("rejects rules and triggers that name unknown agents", () => {
    const yaml = `
agents:
  - { name: grok-bot, description: x, delivery: pull }
rules:
  - { from: grok-bot, to: muse, action: allow }
triggers:
  - name: t
    when: { agent: codex, event: e }
    send: { to: muse, instructions: hi }
`;
    const p = problems(yaml, { BRIDGE_PUBLIC_URL: "https://b.test", BRIDGE_TOKEN_GROK_BOT: "g".repeat(32) });
    expect(p).toContain('rule to "muse" is not a configured agent or "*"');
    expect(p).toContain('trigger "t": when.agent "codex" is not a configured agent');
    expect(p).toContain('trigger "t": send.to "muse" is not a configured agent');
  });

  test("rejects unknown template placeholders", () => {
    const p = problems(YAML.replace("{{ event.details }}", "{{ event.secret }}"));
    expect(p).toContain('trigger "bug-to-claude": unknown placeholder {{event.secret}}');
  });

  test("rejects missing, short and shared tokens", () => {
    expect(problems(YAML, { ...ENV, BRIDGE_TOKEN_GROK_BOT: undefined })).toContain(
      'missing BRIDGE_TOKEN_GROK_BOT for agent "grok-bot"',
    );
    expect(problems(YAML, { ...ENV, BRIDGE_TOKEN_GROK_BOT: "short" })).toContain(
      "BRIDGE_TOKEN_GROK_BOT must be at least 24 characters",
    );
    expect(problems(YAML, { ...ENV, BRIDGE_TOKEN_GROK_BOT: "c".repeat(32) })).toContain(
      'agents "grok-bot" and "claude-code-wingman" share the same token',
    );
  });

  test("requires https except for localhost", () => {
    expect(problems(YAML, { ...ENV, BRIDGE_PUBLIC_URL: "http://bridge.example.com" })).toContain(
      "BRIDGE_PUBLIC_URL must start with https:// (http:// is allowed only for localhost)",
    );
    expect(problems(YAML, { ...ENV, BRIDGE_PUBLIC_URL: "http://localhost:8787" })).toEqual([]);
    expect(problems(YAML, { ...ENV, BRIDGE_PUBLIC_URL: undefined })).toContain("missing BRIDGE_PUBLIC_URL");
  });

  test("rejects a bad rule action and a bad delivery mode", () => {
    const p = problems(YAML.replace("action: allow", "action: maybe").replace("delivery: push", "delivery: pigeon"));
    expect(p.some((x) => x.startsWith("rules.0.action:"))).toBe(true);
    expect(p.some((x) => x.startsWith("agents.1.delivery:"))).toBe(true);
  });

  test("rejects a file that isn't YAML", () => {
    expect(problems("agents: [unclosed")[0]).toStartWith("bridge.yaml is not valid YAML");
  });
});
