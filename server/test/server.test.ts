import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/config";
import { hashSecret } from "../src/core/tokens";
import { openDb } from "../src/db";
import { captureLogs } from "../src/log";
import { NetworkStore } from "../src/network-store";
import { type RunningServer, startServer } from "../src/server";
import { addSession, BASE_YAML, T0, TOKENS, testConfig, testEnv } from "./helpers";

const dirs: string[] = [];
let running: RunningServer | null = null;

afterEach(() => {
  running?.stop();
  running = null;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "portico-"));
  dirs.push(dir);
  return dir;
}

describe("startServer", () => {
  test("serves the API and keeps data in the database file across restarts", async () => {
    const config = { ...testConfig(), dbPath: join(tempDir(), "portico.db") };
    running = startServer(config, { port: 0 });
    const base = `http://127.0.0.1:${running.port}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);

    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKENS["grok-bot"]}`, "content-type": "application/json" },
      body: JSON.stringify({ to: "claude-code", instructions: "hi" }),
    });
    expect(res.status).toBe(201);
    const { task } = await res.json();

    running.stop();
    running = startServer(config, { port: 0 });
    expect(running.service.getTask("grok-bot", task.id).instructions).toBe("hi");
  });
});

describe("startup warnings", () => {
  test("logs rule names nothing knows and assistants shadowed by portico.yaml agents, by name only", () => {
    const dbPath = join(tempDir(), "portico.db");
    const db = openDb(dbPath);
    const network = new NetworkStore(db);
    network.insertAssistant(
      { id: "a-muse", owner: "owner", name: "muse", kind: "muse", description: "Muse", createdAt: T0.toISOString() },
      hashSecret("ba_shadowed-token-0123456789"),
    );
    addSession({ network }, { name: "api-claude", machine: "macbook" });
    db.close();
    const yaml = BASE_YAML.replace(
      "rules:\n",
      `rules:
  - { from: ghost-agent, to: "dialog-claude@macbook", action: allow }
  - { from: muse, to: "api-claude@macbook", action: allow }
  - { from: "kind:claude-code", to: "dialog-*", action: ask }
`,
    );
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      running = startServer({ ...testConfig(yaml), dbPath }, { port: 0 });
    } finally {
      captureLogs(null);
    }
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual({
      time: expect.any(String),
      level: "warn",
      msg: "rule_names_unknown",
      names: ["ghost-agent", "dialog-claude@macbook"],
    });
    expect(entries).toContainEqual({ time: expect.any(String), level: "warn", msg: "assistant_name_conflict", names: ["muse"] });
    expect(lines.join("\n")).not.toContain("ba_shadowed-token");
  });

  test("logs neither warning when every rule name is known and no assistant is shadowed", () => {
    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      running = startServer({ ...testConfig(), dbPath: join(tempDir(), "portico.db") }, { port: 0 });
    } finally {
      captureLogs(null);
    }
    const names = lines.map((line) => (JSON.parse(line) as { msg: string }).msg);
    expect(names).toContain("portico_started");
    expect(names).not.toContain("rule_names_unknown");
    expect(names).not.toContain("assistant_name_conflict");
  });
});

describe("network sweep", () => {
  test("deletes sessions unseen for 7 days and join codes past a day, at startup, logging the counts", () => {
    const dbPath = join(tempDir(), "portico.db");
    const db = openDb(dbPath);
    const network = new NetworkStore(db);
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
    addSession({ network }, { name: "old-claude", machine: "macbook", key: "key-old", lastSeenAt: daysAgo(8) });
    addSession({ network }, { name: "recent-claude", machine: "macbook", key: "key-recent", lastSeenAt: daysAgo(6) });
    const code = (id: string, expiresAt: string, usedAt: string | null) =>
      network.insertJoinCode({ id, owner: "owner", createdAt: daysAgo(3), expiresAt, usedAt }, hashSecret(id));
    code("expired-long-ago", daysAgo(2), null);
    code("used-long-ago", daysAgo(-1), daysAgo(2));
    code("still-valid", daysAgo(-1), null);
    db.close();

    const lines: string[] = [];
    captureLogs((line) => lines.push(line));
    try {
      running = startServer({ ...testConfig(), dbPath }, { port: 0 });
    } finally {
      captureLogs(null);
    }
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(entries).toContainEqual({ time: expect.any(String), level: "info", msg: "network_pruned", sessions: 1, join_codes: 2 });
    running.stop();
    running = null;
    const after = new NetworkStore(openDb(dbPath));
    expect(after.listSessions().map((s) => s.name)).toEqual(["recent-claude"]);
    expect(after.joinCodeByHash(hashSecret("still-valid"))).not.toBeNull();
    expect(after.joinCodeByHash(hashSecret("used-long-ago"))).toBeNull();
  });
});

describe("example config", () => {
  test("portico.example.yaml is valid", () => {
    const yaml = readFileSync(join(import.meta.dir, "../../portico.example.yaml"), "utf8");
    const env = {
      PORTICO_PUBLIC_URL: "https://portico.test",
      PORTICO_TOKEN_CLAUDE_CODE: "c".repeat(48),
      PORTICO_TOKEN_GROK_BOT: "g".repeat(48),
      PORTICO_TOKEN_MUSE: "m".repeat(48),
      PORTICO_TOKEN_CODEX: "x".repeat(48),
      PORTICO_SIGNING_SECRET: "s".repeat(48),
      PORTICO_ADMIN_PASSWORD: "a".repeat(16),
    };
    expect(parseConfig(yaml, env).agents).toHaveLength(4);
  });
});

describe("portico CLI", () => {
  const cli = join(import.meta.dir, "../src/cli.ts");

  test("prints usage", async () => {
    const proc = Bun.spawn(["bun", cli, "--help"], { stdout: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toContain("portico <command>");
  });

  test("serve exits with the config problems when the config is bad", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "portico.yaml"), BASE_YAML);
    const proc = Bun.spawn(["bun", cli, "serve"], {
      cwd: dir,
      env: { ...process.env, ...testEnv(), PORTICO_TOKEN_MUSE: "", PORTICO_CONFIG: join(dir, "portico.yaml") },
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain('missing PORTICO_TOKEN_MUSE for agent "muse"');
  });

  test("serve starts and answers /healthz", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "portico.yaml"), BASE_YAML);
    const port = 18787 + Math.floor(Math.random() * 1000);
    const proc = Bun.spawn(["bun", cli, "serve"], {
      cwd: dir,
      env: {
        ...process.env,
        ...testEnv(),
        PORT: String(port),
        PORTICO_CONFIG: join(dir, "portico.yaml"),
        PORTICO_DB_PATH: join(dir, "portico.db"),
      },
      stdout: "pipe",
    });
    try {
      let healthy = false;
      for (let attempt = 0; attempt < 50 && !healthy; attempt++) {
        await Bun.sleep(100);
        healthy = await fetch(`http://127.0.0.1:${port}/healthz`).then(
          (res) => res.ok,
          () => false,
        );
      }
      expect(healthy).toBe(true);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
