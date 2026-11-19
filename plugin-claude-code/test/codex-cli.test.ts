import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyProblems } from "../../server/test/helpers";
import { readComputerFile, writeComputerFile } from "../src/computer";
import { type CodexCliIo, runCodexCli } from "../src/codex/cli";
import { STOP_HOOK } from "../src/codex-config";
import { allowJoins, joinTestComputer, startPortico, type TestPortico, tempDir, computerNamed } from "./helpers";

let p: TestPortico | null = null;
afterEach(() => {
  p?.stop();
  p = null;
});

/** A fresh home: the computer file and Codex's folder inside it, and the bridge file Codex's config will run. */
function home() {
  const dir = realpathSync(tempDir("cxh-"));
  const bridge = join(dir, ".portico", "portico-codex.js");
  return {
    dir,
    bridge,
    configPath: join(dir, ".portico", "computer.json"),
    codex: join(dir, ".codex"),
  };
}

async function cli(argv: string[], h: ReturnType<typeof home>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CodexCliIo = {
    env: { PORTICO_COMPUTER_CONFIG: h.configPath, CODEX_HOME: h.codex },
    cwd: h.dir,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  // The person allows the join between two polls, as on the consent page.
  const code = await runCodexCli(argv, io, {
    bridgePath: h.bridge,
    hostname: () => "Chris-MacBook.local",
    findBun: () => "/opt/bun/bin/bun",
    pollMs: 1,
    // The test Portico runs on its own clock, which the code's time to run out is measured by.
    now: () => (p ? p.clock.now().getTime() : Date.now()),
    sleep: async () => void (p && allowJoins(p)),
  });
  return { code, out, err };
}

describe("the Codex bridge's join", () => {
  test("joins the computer, then adds Portico to Codex: the server and the Stop hook", async () => {
    p = await startPortico();
    const h = home();
    const { code, out, err } = await cli(["join", p.url], h);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    // The link and the code for the person come first, from the real server.
    expect(out[1]).toMatch(/^  1\. Open https:\/\/portico\.example\.com\/c\/[A-Za-z0-9-]+ in a browser and sign in\.$/);
    expect(out[2]).toMatch(/^  2\. Type the code \d{4} there and press Allow\.$/);
    expect(readComputerFile(h.configPath)).toMatchObject({ url: p.url, computer: "chris-macbook", token: expect.stringMatching(/^pc_/) });
    expect(computerNamed(p, "chris-macbook")!.ownerId).toBe(p.owner.id);
    // The request says which coding agent asked, for the page the person reads.
    expect(p.db.query("SELECT agent_kind, status FROM consent_requests").all()).toEqual([{ agent_kind: "codex", status: "approved" }]);
    const config = Bun.TOML.parse(readFileSync(join(h.codex, "config.toml"), "utf8")) as { mcp_servers: Record<string, unknown> };
    // Bun by full path, and the computer file the join used: Codex passes the bridge only a few variables.
    expect(config.mcp_servers.portico).toMatchObject({
      command: "/opt/bun/bin/bun",
      args: [h.bridge],
      default_tools_approval_mode: "approve",
      env: { PORTICO_COMPUTER_CONFIG: h.configPath },
    });
    expect(JSON.parse(readFileSync(join(h.codex, "hooks.json"), "utf8"))).toEqual({ hooks: { Stop: [{ hooks: [STOP_HOOK] }] } });
    expect(out).toContain("Next: in Codex, open /hooks and approve the Portico Stop hook. Codex skips a new hook until a person approves the hook.");
    for (const line of out) expect(copyProblems(line)).toEqual([]);
  });

  test("on a computer that already joined (for Claude Code, say), nothing is asked and no second computer is made", async () => {
    p = await startPortico();
    const h = home();
    const { token, computer } = joinTestComputer(p, "macbook");
    writeComputerFile(h.configPath, { url: p.url, computer, token, off: [] });
    const { code, out } = await cli(["join", p.url], h);
    expect(code).toBe(0);
    expect(out[0]).toBe(`This computer is already on Portico at ${p.url} as computer "macbook". Nothing to allow.`);
    expect(p.computers.list(p.owner.id).map((c) => c.name)).toEqual(["macbook"]);
    expect(p.db.query("SELECT id FROM consent_requests").all()).toEqual([]);
    expect(readComputerFile(h.configPath)?.token).toBe(token);
    expect(existsSync(join(h.codex, "config.toml"))).toBe(true);
  });

  test("--no-allow leaves Codex asking before Portico's tools run; a computer Portico no longer knows is told to replace", async () => {
    p = await startPortico();
    const h = home();
    expect((await cli(["join", p.url, "--no-allow"], h)).code).toBe(0);
    const config = Bun.TOML.parse(readFileSync(join(h.codex, "config.toml"), "utf8")) as { mcp_servers: { portico: Record<string, unknown> } };
    expect(config.mcp_servers.portico.default_tools_approval_mode).toBeUndefined();
    p.computers.remove(computerNamed(p, "chris-macbook")!.id);
    const again = await cli(["join", p.url], h);
    expect(again.code).toBe(1);
    expect(again.err[0]).toContain("Run again with --replace to join as a new computer.");
  });
});

describe("Claude Code after Codex", () => {
  test("Claude Code's join on a computer Codex joined first needs nothing allowed; its leave takes Portico out of Codex", async () => {
    const { runCli } = await import("../src/cli-run");
    p = await startPortico();
    const h = home();
    expect((await cli(["join", p.url], h)).code).toBe(0);
    const out: string[] = [];
    const io = {
      env: { PORTICO_COMPUTER_CONFIG: h.configPath, PORTICO_CLAUDE_HOME: join(h.dir, ".claude"), CODEX_HOME: h.codex, PATH: "" },
      cwd: h.dir,
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(line),
    };
    expect(await runCli(["join", p.url], io, { findClaude: () => null, now: () => p!.clock.now().getTime() })).toBe(0);
    expect(out[0]).toBe(`This computer is already on Portico at ${p.url} as computer "chris-macbook". Nothing to allow.`);
    expect(p.computers.list(p.owner.id)).toHaveLength(1);
    expect(await runCli(["leave"], io, { findClaude: () => null })).toBe(0);
    expect(readFileSync(join(h.codex, "config.toml"), "utf8")).not.toContain("portico");
    expect(out).toContain(`Removed Portico's MCP server in ${join(h.codex, "config.toml")}.`);
  });
});

describe("update and leave", () => {
  test("update downloads the bridge Portico serves over this file", async () => {
    p = await startPortico();
    const h = home();
    expect((await cli(["join", p.url], h)).code).toBe(0);
    writeFileSync(h.bridge, "// old bridge\n");
    const { code, out } = await cli(["update"], h);
    expect(code).toBe(0);
    expect(out[0]).toStartWith(`Updated ${h.bridge} from ${p.url}.`);
    expect(readFileSync(h.bridge, "utf8")).toContain("portico-codex.js");
  });

  test("leave takes the computer off Portico and Portico out of Codex's files, keeping the rest", async () => {
    p = await startPortico();
    const h = home();
    expect((await cli(["join", p.url], h)).code).toBe(0);
    const { code, out } = await cli(["leave"], h);
    expect(code).toBe(0);
    expect(out[0]).toBe('Portico removed computer "chris-macbook" along with every session there.');
    expect(existsSync(h.configPath)).toBe(false);
    expect(computerNamed(p, "chris-macbook")).toBeNull();
    expect(readFileSync(join(h.codex, "config.toml"), "utf8")).not.toContain("portico");
    expect(JSON.parse(readFileSync(join(h.codex, "hooks.json"), "utf8"))).toEqual({ hooks: {} });
  });
});
