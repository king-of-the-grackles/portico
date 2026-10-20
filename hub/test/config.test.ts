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
    });
    expect(config.port).toBe(8790);
    expect(config.signingSecret).toBe("s".repeat(32));
    expect(config.adminPassword).toBe("correct horse battery");
    expect(config.ntfy).toBeNull();
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

describe("parseConfig: secrets, ntfy and strictness", () => {
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

  test("BRIDGE_NTFY_URL must be https, except http for localhost", () => {
    const topic = "t".repeat(24);
    const withUrl = (url: string) => problems(YAML, { ...ENV, BRIDGE_NTFY_TOPIC: topic, BRIDGE_NTFY_URL: url });
    expect(withUrl("http://ntfy.example.com")).toContain(
      "BRIDGE_NTFY_URL must start with https:// (http:// is allowed only for localhost)",
    );
    expect(withUrl("http://127.0.0.1:9999")).toEqual([]);
    expect(withUrl("http://localhost:9999")).toEqual([]);
    expect(withUrl("not a url")).toEqual(['BRIDGE_NTFY_URL "not a url" is not a valid http(s) URL']);
  });

  test("the signing secret must differ from every agent token and the admin password", () => {
    const message = "BRIDGE_SIGNING_SECRET must differ from every agent token and from BRIDGE_ADMIN_PASSWORD";
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: ENV.BRIDGE_TOKEN_GROK_BOT })).toContain(message);
    expect(problems(YAML, { ...ENV, BRIDGE_SIGNING_SECRET: "p".repeat(32), BRIDGE_ADMIN_PASSWORD: "p".repeat(32) })).toContain(
      message,
    );
    expect(problems(YAML)).not.toContain(message);
  });

  test("ntfy is on only when a topic is set", () => {
    const topic = "t".repeat(24);
    expect(parseConfig(YAML, { ...ENV, BRIDGE_NTFY_TOPIC: topic }).ntfy).toEqual({
      url: "https://ntfy.sh",
      topic,
      token: null,
    });
    expect(
      parseConfig(YAML, {
        ...ENV,
        BRIDGE_NTFY_TOPIC: topic,
        BRIDGE_NTFY_URL: "https://ntfy.example.com/",
        BRIDGE_NTFY_TOKEN: "tk_abc",
      }).ntfy,
    ).toEqual({ url: "https://ntfy.example.com", topic, token: "tk_abc" });
  });

  test("rejects a short or oddly formed ntfy topic and a bad ntfy URL", () => {
    const message =
      "BRIDGE_NTFY_TOPIC must be 20–64 letters, digits, - or _, because anyone who knows a public topic can read it";
    expect(problems(YAML, { ...ENV, BRIDGE_NTFY_TOPIC: "mytopic" })).toContain(message);
    expect(problems(YAML, { ...ENV, BRIDGE_NTFY_TOPIC: `${"t".repeat(24)}/x` })).toContain(message);
    expect(problems(YAML, { ...ENV, BRIDGE_NTFY_TOPIC: "t".repeat(24), BRIDGE_NTFY_URL: "not a url" })).toContain(
      'BRIDGE_NTFY_URL "not a url" is not a valid http(s) URL',
    );
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
});
