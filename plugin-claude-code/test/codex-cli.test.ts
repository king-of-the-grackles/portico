import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyProblems } from "../../server/test/helpers";
import { readComputerFile, writeComputerFile } from "../src/computer";
import { type CodexCliIo, runCodexCli } from "../src/codex/cli";
import { STOP_HOOK } from "../src/codex-config";
import { joinTestComputer, startPortico, type TestPortico, tempDir } from "./helpers";

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
  const code = await runCodexCli(argv, io, { bridgePath: h.bridge, hostname: () => "Chris-MacBook.local", findBun: () => "/opt/bun/bin/bun" });
  return { code, out, err };
}

/** A Codex join line made by the owner, as Add agent › Codex makes one. */
function codexLine(portico: TestPortico): { line: string; id: string } {
  const { joinLine, secret } = portico.computers.createJoinLine(portico.owner.id, "codex");
  return { line: `Join Portico: ${portico.url}/join#${secret}`, id: joinLine.id };
}

describe("the Codex bridge's join", () => {
  test("joins the computer, then adds Portico to Codex: the server and the Stop hook", async () => {
    p = await startPortico();
    const h = home();
    const { line, id } = codexLine(p);
    const { code, out, err } = await cli(["join", line], h);
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(readComputerFile(h.configPath)).toMatchObject({ url: p.url, computer: "chris-macbook" });
    expect(p.computers.joinLine(id)?.computerId).toBe(p.computers.byName("chris-macbook")!.id);
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

  test("on a computer that already joined (for Claude Code, say), the line is used there and no second computer is made", async () => {
    p = await startPortico();
    const h = home();
    const { token, computer } = joinTestComputer(p, "macbook");
    writeComputerFile(h.configPath, { url: p.url, computer, token, off: [] });
    const { line, id } = codexLine(p);
    const { code, out } = await cli(["join", line], h);
    expect(code).toBe(0);
    expect(out[0]).toBe(`This computer is already on Portico at ${p.url} as computer "macbook". Used the line here.`);
    expect(p.computers.joinLine(id)?.computerId).toBe(p.computers.byName("macbook")!.id);
    expect(readComputerFile(h.configPath)?.token).toBe(token);
    expect(existsSync(join(h.codex, "config.toml"))).toBe(true);
  });

  test("--no-allow leaves Codex asking before Portico's tools run; a used line is refused with Portico's reason", async () => {
    p = await startPortico();
    const h = home();
    const { line } = codexLine(p);
    expect((await cli(["join", line, "--no-allow"], h)).code).toBe(0);
    const config = Bun.TOML.parse(readFileSync(join(h.codex, "config.toml"), "utf8")) as { mcp_servers: { portico: Record<string, unknown> } };
    expect(config.mcp_servers.portico.default_tools_approval_mode).toBeUndefined();
    const again = await cli(["join", line], h);
    expect(again.code).toBe(1);
    expect(again.err[0]).toContain("already used");
  });
});

describe("Claude Code after Codex", () => {
  test("Claude Code's join on a computer Codex joined first uses the line there; its leave takes Portico out of Codex", async () => {
    const { runCli } = await import("../src/cli-run");
    p = await startPortico();
    const h = home();
    expect((await cli(["join", codexLine(p).line], h)).code).toBe(0);
    const { joinLine, secret } = p.computers.createJoinLine(p.owner.id, "claude-code");
    const out: string[] = [];
    const io = {
      env: { PORTICO_COMPUTER_CONFIG: h.configPath, PORTICO_CLAUDE_HOME: join(h.dir, ".claude"), CODEX_HOME: h.codex, PATH: "" },
      cwd: h.dir,
      out: (line: string) => out.push(line),
      err: (line: string) => out.push(line),
    };
    expect(await runCli(["join", `Join Portico: ${p.url}/join#${secret}`], io, { findClaude: () => null })).toBe(0);
    expect(p.computers.joinLine(joinLine.id)?.computerId).toBe(p.computers.byName("chris-macbook")!.id);
    expect(await runCli(["leave"], io, { findClaude: () => null })).toBe(0);
    expect(readFileSync(join(h.codex, "config.toml"), "utf8")).not.toContain("portico");
    expect(out).toContain(`Removed Portico's MCP server in ${join(h.codex, "config.toml")}.`);
  });
});

describe("update and leave", () => {
  test("update downloads the bridge Portico serves over this file", async () => {
    p = await startPortico();
    const h = home();
    expect((await cli(["join", codexLine(p).line], h)).code).toBe(0);
    writeFileSync(h.bridge, "// old bridge\n");
    const { code, out } = await cli(["update"], h);
    expect(code).toBe(0);
    expect(out[0]).toStartWith(`Updated ${h.bridge} from ${p.url}.`);
    expect(readFileSync(h.bridge, "utf8")).toContain("portico-codex.js");
  });

  test("leave takes the computer off Portico and Portico out of Codex's files, keeping the rest", async () => {
    p = await startPortico();
    const h = home();
    expect((await cli(["join", codexLine(p).line], h)).code).toBe(0);
    const { code, out } = await cli(["leave"], h);
    expect(code).toBe(0);
    expect(out[0]).toBe('Portico removed computer "chris-macbook" along with every session there.');
    expect(existsSync(h.configPath)).toBe(false);
    expect(p.computers.byName("chris-macbook")).toBeNull();
    expect(readFileSync(join(h.codex, "config.toml"), "utf8")).not.toContain("portico");
    expect(JSON.parse(readFileSync(join(h.codex, "hooks.json"), "utf8"))).toEqual({ hooks: {} });
  });
});
