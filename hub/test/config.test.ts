import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, parseConfig, tokenEnvName } from "../src/config";

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
  BRIDGE_SIGNING_SECRET: "s".repeat(32),
  BRIDGE_ADMIN_PASSWORD: "correct horse battery",
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
      maxMessageKb: 64,
      messageExpiryHours: 24,
      messagesPerHourPerAgent: 120,
    });
    expect(config.port).toBe(8790);
    expect(config.signingSecret).toBe("s".repeat(32));
    expect(config.adminPassword).toBe("correct horse battery");
    expect(config.ntfyIgnored).toEqual([]);
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

  test("reads the message limits, which must be positive integers", () => {
    const limits = `\nlimits:\n  max_message_kb: 32\n  message_expiry_hours: 6\n  messages_per_hour_per_agent: 40\n`;
    expect(parseConfig(`${YAML}${limits}`, ENV).limits).toMatchObject({
      maxMessageKb: 32,
      messageExpiryHours: 6,
      messagesPerHourPerAgent: 40,
    });
    for (const key of ["max_message_kb", "message_expiry_hours", "messages_per_hour_per_agent"]) {
      for (const bad of ["0", "-1", "1.5"]) {
        const found = problems(`${YAML}\nlimits:\n  ${key}: ${bad}\n`);
        expect(found.length).toBe(1);
        expect(found[0]).toStartWith(`limits.${key}: `);
      }
    }
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

  test("rejects triggers that name unknown agents, but rules may name agents that join later", () => {
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
    expect(p.filter((problem) => problem.startsWith("rule "))).toEqual([]);
    expect(p).toContain('trigger "t": when.agent "codex" is not a configured agent');
    expect(p).toContain('trigger "t": send.to "muse" is not a configured agent');
  });

  test("an agent's kind defaults from its delivery and name", () => {
    const yaml = `
agents:
  - { name: claude-code-wingman, description: x, delivery: push }
  - { name: muse, description: x, delivery: pull }
  - { name: grok-bot, description: x, delivery: pull }
  - { name: chatgpt, description: x, delivery: pull }
  - { name: codex, description: x, delivery: pull }
  - { name: helper, description: x, delivery: pull }
`;
    const env = {
      ...ENV,
      BRIDGE_TOKEN_MUSE: "m".repeat(32),
      BRIDGE_TOKEN_CHATGPT: "h".repeat(32),
      BRIDGE_TOKEN_CODEX: "x".repeat(32),
      BRIDGE_TOKEN_HELPER: "e".repeat(32),
    };
    const kinds = Object.fromEntries(parseConfig(yaml, env).agents.map((agent) => [agent.name, agent.kind]));
    expect(kinds).toEqual({
      "claude-code-wingman": "claude-code",
      muse: "muse",
      "grok-bot": "grok-bot",
      chatgpt: "chatgpt",
      codex: "codex",
      helper: "assistant",
    });
  });

  test("an explicit kind is used as given, and must be a slug", () => {
    const yaml = (kind: string) => `
agents:
  - { name: grok-bot, description: x, delivery: pull, kind: "${kind}" }
  - { name: claude-code-wingman, description: x, delivery: push }
`;
    expect(parseConfig(yaml("gemini"), ENV).agents[0]?.kind).toBe("gemini");
    expect(problems(yaml("Kind X"))).toContain('agent "grok-bot": kind "Kind X" must be lowercase letters, digits and hyphens');
  });

  test("rules accept names, addresses, globs, kind: patterns and *", () => {
    const yaml = `
agents:
  - { name: grok-bot, description: x, delivery: pull }
  - { name: claude-code-wingman, description: x, delivery: push }
rules:
  - { from: grok-bot, to: muse, action: allow }
  - { from: "kind:claude-code", to: "dialog-*", action: ask }
  - { from: "*@macbook", to: "dialog-claude@macbook", action: allow }
  - { from: "*", to: "*", action: block }
`;
    expect(parseConfig(yaml, ENV).rules.map((rule) => `${rule.from} -> ${rule.to}`)).toEqual([
      "grok-bot -> muse",
      "kind:claude-code -> dialog-*",
      "*@macbook -> dialog-claude@macbook",
      "* -> *",
    ]);
  });

  test("rejects a rule side that isn't a valid pattern", () => {
    const yaml = YAML.replace("{ from: grok-bot, to: claude-code-wingman", '{ from: Grok, to: "kind:"');
    const p = problems(yaml);
    expect(p).toContain('rule from "Grok" is not a valid name, address, glob, kind:<kind> or "*"');
    expect(p).toContain('rule to "kind:" is not a valid name, address, glob, kind:<kind> or "*"');
  });

  test("rejects a glob made only of * and @", () => {
    const p = problems(YAML.replace('{ from: "*", to: grok-bot', '{ from: "*@*", to: grok-bot'));
    expect(p).toEqual([
      'rule from "*@*" is a glob without any name; use "*" for everyone, or a glob like "dialog-*" or "*@macbook"',
    ]);
    expect(p[0]).not.toMatch(/\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i);
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
      "BRIDGE_PUBLIC_URL must start with https:// (http:// is allowed only for localhost and 127.0.0.1)",
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

describe("parseConfig: secrets and strictness", () => {
  test("requires a signing secret and an admin password of a minimum length", () => {
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: undefined })).toContain("missing BRIDGE_SIGNING_SECRET");
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: "short" })).toContain(
      "BRIDGE_SIGNING_SECRET must be at least 32 characters",
    );
    expect(problems(YAML, { ...ENV, BRIDGE_ADMIN_PASSWORD: undefined })).toContain("missing BRIDGE_ADMIN_PASSWORD");
    expect(problems(YAML, { ...ENV, BRIDGE_ADMIN_PASSWORD: "short" })).toContain(
      "BRIDGE_ADMIN_PASSWORD must be at least 12 characters",
    );
  });

  test("the signing secret must differ from every agent token and the admin password", () => {
    const message = "BRIDGE_SIGNING_SECRET must differ from every agent token and from BRIDGE_ADMIN_PASSWORD";
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: ENV.BRIDGE_TOKEN_GROK_BOT })).toContain(message);
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: "p".repeat(32), BRIDGE_ADMIN_PASSWORD: "p".repeat(32) })).toContain(
      message,
    );
    expect(problems(YAML)).not.toContain(message);
  });

  test("BRIDGE_NTFY_* variables are ignored, never refused, and listed by name", () => {
    const config = parseConfig(YAML, {
      ...ENV,
      BRIDGE_NTFY_TOPIC: "mytopic", // refused before v1.2: too short
      BRIDGE_NTFY_URL: "http://ntfy.example.com", // refused before v1.2: not https
      BRIDGE_NTFY_TOKEN: "  ",
    });
    expect(config.ntfyIgnored).toEqual(["BRIDGE_NTFY_TOPIC", "BRIDGE_NTFY_URL"]);
    expect(config).not.toHaveProperty("ntfy");
    expect(parseConfig(YAML, ENV).ntfyIgnored).toEqual([]);
  });

  test("rejects unknown keys, so typos aren't silently ignored", () => {
    expect(problems(`${YAML}\nlimits:\n  max_chain_lenght: 2\n`)).toContain('limits: Unrecognized key: "max_chain_lenght"');
    expect(problems(`${YAML}\nrulez: []\n`)).toContain('(root): Unrecognized key: "rulez"');
  });

  test("defaults PORT to 8790 and rejects a bad PORT", () => {
    expect(parseConfig(YAML, ENV).port).toBe(8790);
    expect(problems(YAML, { ...ENV, PORT: "99999" })).toContain('PORT "99999" is not a valid port');
  });

  test("rejects triggers that send to their own agent or share a name", () => {
    const yaml = `
agents:
  - { name: grok-bot, description: x, delivery: pull }
  - { name: muse, description: y, delivery: pull }
triggers:
  - { name: t, when: { agent: muse, event: e }, send: { to: muse, instructions: hi } }
  - { name: t, when: { agent: muse, event: f }, send: { to: grok-bot, instructions: hi } }
`;
    const p = problems(yaml, { ...ENV, BRIDGE_TOKEN_MUSE: "m".repeat(32) });
    expect(p).toContain(`trigger "t": an agent can't send a task to itself`);
    expect(p).toContain(`trigger "t" is defined more than once`);
  });

  test("flags placeholders it can't render, including filters", () => {
    const p = problems(YAML.replace("{{ event.details }}", "{{ event.details | upper }}"));
    expect(p).toContain('trigger "bug-to-claude": unknown placeholder {{event.details | upper}}');
  });

  test("an empty file names the missing agents list", () => {
    expect(problems("").join("\n")).toContain("agents");
  });
});

describe("loadConfig", () => {
  test("names a missing config file", async () => {
    await expect(loadConfig({ ...ENV, BRIDGE_CONFIG: "/nonexistent/bridge.yaml" })).rejects.toThrow(
      "config file not found: /nonexistent/bridge.yaml",
    );
  });

  // Root can read any file, so the check only means something for an unprivileged test process.
  test.skipIf(process.getuid?.() === 0)("explains a config file that cannot be read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bridge-cfg-"));
    const path = join(dir, "bridge.yaml");
    try {
      writeFileSync(path, YAML);
      chmodSync(path, 0o000);
      const err = await loadConfig({ ...ENV, BRIDGE_CONFIG: path }).catch((e) => e);
      expect(err).toBeInstanceOf(ConfigError);
      const text = err.problems.join("\n");
      expect(text).toContain(path);
      expect(text).toContain("can't be read");
      // The path is removed first: a temp path could contain a pronoun-like segment.
      expect(text.split(path).join("")).not.toMatch(/\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i);
    } finally {
      chmodSync(path, 0o600);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
