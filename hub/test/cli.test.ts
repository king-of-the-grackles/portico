import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand, generateSecrets, agentNames, InitError } from "../src/commands/init";
import type { CliIo } from "../src/commands/io";
import { joinCommand } from "../src/commands/join";
import { startupProblem } from "../src/commands/serve";
import { STARTER_YAML } from "../src/commands/starter";
import { parseConfig } from "../src/config";
import { SchemaTooNewError } from "../src/db";
import { startServer } from "../src/server";
import { BASE_YAML, makeApp, PRONOUNS, testConfig, testEnv } from "./helpers";

const CLI = join(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "portico-cli-"));
  dirs.push(dir);
  return dir;
}

function io(dir: string, env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const value: CliIo = { env, cwd: dir, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io: value, out, err };
}

/** Reads KEY=VALUE lines (.env) or export KEY='VALUE' lines (--shell), skipping comments. */
function readSecrets(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^(?:export )?([A-Z0-9_]+)='?([^']*)'?$/);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

const SECRET_KEY = /^PORTICO_(SIGNING_SECRET|ADMIN_PASSWORD|TOKEN_.+)$/;

describe("portico init", () => {
  test("writes the starter config and a private .env that the hub accepts", async () => {
    const dir = tempDir();
    const run = io(dir);
    expect(await initCommand([], run.io)).toBe(0);

    const yaml = readFileSync(join(dir, "portico.yaml"), "utf8");
    expect(yaml).toBe(STARTER_YAML);
    const envPath = join(dir, ".env");
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
    const env = readSecrets(readFileSync(envPath, "utf8"));
    const config = parseConfig(yaml, env);
    expect(Object.keys(config.tokens).sort()).toEqual(["claude-code", "codex", "grok-bot", "muse"]);
    expect(new Set(Object.values(config.tokens)).size).toBe(4);
    expect(config.publicUrl).toBe("http://localhost:8790");

    const printed = run.out.join("\n");
    expect(printed).not.toMatch(/ntfy|phone|push/i);
    for (const [key, value] of Object.entries(env)) if (SECRET_KEY.test(key)) expect(printed).not.toContain(value);
    expect(printed).toContain("Wrote portico.yaml");
    expect(printed).toContain("Wrote .env");
    for (const line of run.out) expect(line).not.toMatch(PRONOUNS);
  });

  test("--shell writes export lines to portico-secrets.sh instead", async () => {
    const dir = tempDir();
    const run = io(dir);
    expect(await initCommand(["--shell"], run.io)).toBe(0);
    const text = readFileSync(join(dir, "portico-secrets.sh"), "utf8");
    expect(text).toMatch(/^export PORTICO_SIGNING_SECRET='[0-9a-f]{64}'$/m);
    expect(statSync(join(dir, "portico-secrets.sh")).mode & 0o777).toBe(0o600);
    expect(() => statSync(join(dir, ".env"))).toThrow();
    expect(parseConfig(STARTER_YAML, readSecrets(text)).agents).toHaveLength(4);
    expect(run.out.join("\n")).toContain("source portico-secrets.sh");
  });

  test("uses an existing portico.yaml (from PORTICO_CONFIG) and makes a token for each agent in it", async () => {
    const dir = tempDir();
    const yaml = "agents:\n  - { name: alpha, description: A, delivery: push }\n  - { name: beta-2, description: B, delivery: pull }\n";
    writeFileSync(join(dir, "custom.yaml"), yaml);
    const run = io(dir, { PORTICO_CONFIG: "custom.yaml" });
    expect(await initCommand([], run.io)).toBe(0);
    expect(readFileSync(join(dir, "custom.yaml"), "utf8")).toBe(yaml);
    const env = readSecrets(readFileSync(join(dir, ".env"), "utf8"));
    expect(Object.keys(env).filter((key) => key.startsWith("PORTICO_TOKEN_")).sort()).toEqual([
      "PORTICO_TOKEN_ALPHA",
      "PORTICO_TOKEN_BETA_2",
    ]);
    expect(run.out.join("\n")).toContain("Using custom.yaml");
  });

  test("never overwrites a secrets file, and writes nothing else either", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, ".env"), "KEEP=1\n");
    const run = io(dir);
    expect(await initCommand([], run.io)).toBe(1);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("KEEP=1\n");
    expect(() => statSync(join(dir, "portico.yaml"))).toThrow();
    expect(run.err.join("\n")).toContain(".env already exists");
  });

  test("stops before writing when portico.yaml lists no usable agents", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "portico.yaml"), "agents: []\n");
    const run = io(dir);
    expect(await initCommand([], run.io)).toBe(1);
    expect(() => statSync(join(dir, ".env"))).toThrow();
    expect(run.err.join("\n")).toContain("lists no agents");
  });

  test("rejects unknown options", async () => {
    const run = io(tempDir());
    expect(await initCommand(["--force"], run.io)).toBe(1);
    expect(run.err[0]).toBe("Unknown option: --force. Usage: portico init [--shell]");
  });

  test("agentNames and generateSecrets", () => {
    expect(agentNames(BASE_YAML)).toEqual(["grok-bot", "claude-code", "muse", "codex"]);
    expect(() => agentNames("agents:\n  - { name: Bad_Name }\n")).toThrow(InitError);
    expect(() => agentNames(": not yaml : [")).toThrow(InitError);
    const secrets = generateSecrets(["a", "b"]);
    expect(secrets.signingSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(secrets.adminPassword).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(secrets.tokens.a).toMatch(/^[0-9a-f]{48}$/);
    expect(secrets.tokens.a).not.toBe(secrets.tokens.b);
  });

  test("the starter config is portico.example.yaml", () => {
    expect(STARTER_YAML).toBe(readFileSync(join(import.meta.dir, "../../portico.example.yaml"), "utf8"));
  });
});

describe("startup errors", () => {
  test("startupProblem explains a busy port and a database that can't be opened", () => {
    const config = { port: 8790, dbPath: "/data/portico.db" };
    expect(startupProblem(Object.assign(new Error("x"), { code: "EADDRINUSE" }), config)).toBe(
      "Port 8790 is already in use. Stop the other process, or set PORT to a free port.",
    );
    expect(startupProblem(Object.assign(new Error("x"), { code: "SQLITE_CANTOPEN" }), config)).toBe(
      "The database at /data/portico.db can't be opened. Check that its folder exists and is writable, or set PORTICO_DB_PATH.",
    );
    expect(startupProblem(new Error("other"), config)).toBeNull();
  });

  test("startupProblem explains a database written by a newer hub", () => {
    const config = { port: 8790, dbPath: "/data/portico.db" };
    expect(startupProblem(new SchemaTooNewError(3), config)).toBe(
      "The database at /data/portico.db was written by a newer hub version. Run that version, or restore a backup.",
    );
  });

  test("startServer closes the database when the server can't start", () => {
    const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const close = spyOn(Database.prototype, "close");
    try {
      const config = { ...testConfig(), dbPath: join(tempDir(), "portico.db") };
      expect(() => startServer(config, { port: busy.port as number })).toThrow();
      expect(close).toHaveBeenCalled();
    } finally {
      close.mockRestore();
      busy.stop(true);
    }
  });

  async function serve(dir: string, env: Record<string, string>) {
    writeFileSync(join(dir, "portico.yaml"), BASE_YAML);
    const proc = Bun.spawn(["bun", CLI, "serve"], {
      cwd: dir,
      env: { ...process.env, ...testEnv(), PORTICO_CONFIG: join(dir, "portico.yaml"), ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    return { code, stderr: await new Response(proc.stderr).text() };
  }

  test("serve exits with a plain message when the port is in use", async () => {
    const busy = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    try {
      const dir = tempDir();
      const { code, stderr } = await serve(dir, { PORT: String(busy.port), PORTICO_DB_PATH: join(dir, "portico.db") });
      expect(code).toBe(1);
      expect(stderr).toContain(`Port ${busy.port} is already in use.`);
      expect(stderr).not.toContain("    at ");
    } finally {
      busy.stop(true);
    }
  });

  test("serve exits with a plain message when the database can't be opened", async () => {
    const dir = tempDir();
    const { code, stderr } = await serve(dir, { PORTICO_DB_PATH: join(dir, "missing", "portico.db") });
    expect(code).toBe(1);
    expect(stderr).toContain("can't be opened");
    expect(stderr).not.toContain("    at ");
  });
});

describe("portico CLI dispatch", () => {
  test("init runs from the command line", async () => {
    const dir = tempDir();
    const proc = Bun.spawn(["bun", CLI, "init"], { cwd: dir, env: { ...process.env, PORTICO_CONFIG: "" }, stdout: "pipe" });
    expect(await proc.exited).toBe(0);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  test("the usage lists invite and join, with every option join takes", async () => {
    // Built from scratch, so the child never inherits this session's settings.
    const env = { PATH: process.env.PATH ?? "", HOME: tempDir() };
    const proc = Bun.spawn(["bun", CLI, "help"], { env, stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(0);
    const usage = await new Response(proc.stdout).text();
    expect(usage).toContain("\n  invite            Make a one-time join line for a new machine");
    expect(usage).toContain("\n  join <line> [--code <code>] [--name <machine>] [--replace] [--no-allow]\n");
    expect(usage).toContain("Join this machine to a hub with a join line, and allow the network tools in Claude Code.");
  });

  test("an unknown command prints the usage to stderr and exits 1", async () => {
    const proc = Bun.spawn(["bun", CLI, "launch"], { stdout: "pipe", stderr: "pipe" });
    expect(await proc.exited).toBe(1);
    expect(await new Response(proc.stderr).text()).toContain("Unknown command: launch");
  });
});

describe("portico join", () => {
  test("joins through the plugin's join and writes the machine file", async () => {
    const ctx = makeApp();
    const { code } = ctx.networkService.createJoinCode();
    const dir = tempDir();
    const path = join(dir, "portico", "machine.json");
    const run = io(dir, { PORTICO_MACHINE_CONFIG: path, PORTICO_CLAUDE_HOME: join(dir, ".claude") });
    const fetch = ((url: string | URL | Request, init?: RequestInit) => ctx.app.request(url, init)) as typeof globalThis.fetch;
    const line = `Join my Portico hub: https://portico.test/join#${code}`;
    expect(await joinCommand([line], run.io, { fetch, hostname: () => "studio.local" })).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out[0]).toBe('Joined https://portico.test as machine "studio".');
    expect(run.out).toContain(`Wrote ${path} (mode 600).`);
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file).toEqual({ hub: "https://portico.test", machine: "studio", token: expect.stringMatching(/^bm_/), off: [] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(run.out.join("\n")).not.toContain(file.token);
    expect(ctx.networkService.listMachines().map((machine) => machine.name)).toEqual(["studio"]);
    const settings = join(dir, ".claude", "settings.json");
    expect(run.out).toContain(
      `Added mcp__plugin_portico_portico to permissions.allow in ${settings}, so Claude Code runs the network tools without asking. To skip this step, join with --no-allow.`,
    );
    expect(JSON.parse(readFileSync(settings, "utf8")).permissions.allow).toEqual(["mcp__plugin_portico_portico"]);

    // A second join refuses to overwrite the file, and the hub sees no request.
    const again = io(dir, { PORTICO_MACHINE_CONFIG: path, PORTICO_CLAUDE_HOME: join(dir, ".claude") });
    expect(await joinCommand([line, "--name", "macbook"], again.io, { fetch })).toBe(1);
    expect(again.err.join("\n")).toContain("Run again with --replace");
    expect(ctx.networkService.listMachines()).toHaveLength(1);
  });
});
