import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import { dirname, join } from "node:path";
import { copyProblems } from "../../server/test/helpers";
import { type CliDeps, type CliIo, runCli } from "../src/cli-run";
import { folderId, readComputerFile, writeComputerFile } from "../src/computer";
import { contractPortico, tempDir } from "./helpers";

const CLI = join(import.meta.dir, "../src/cli.ts");

const servers: { stop: () => void }[] = [];
// Every run sets PORTICO_COMPUTER_CONFIG and PORTICO_CLAUDE_HOME. The home folder is stubbed too, so an override name the
// CLI doesn't read falls back into a temp folder, never into the real ~/.portico or ~/.claude.
let home: Mock<typeof os.homedir>;
beforeEach(() => {
  home = spyOn(os, "homedir").mockReturnValue(tempDir());
});
afterEach(() => {
  home.mockRestore();
  for (const server of servers.splice(0)) server.stop();
});

/** The Portico the test's person looks at: the code on its page is what that person types at the prompt. */
let current: ReturnType<typeof contractPortico> | null = null;

function portico(person: Parameters<typeof contractPortico>[0] = "allow") {
  const server = contractPortico(person);
  servers.push(server);
  current = server;
  return server;
}

/** A temp folder with the computer file's path inside it. Tests never touch the real ~/.portico. */
function computerDir(): { dir: string; path: string } {
  const dir = realpathSync(tempDir());
  return { dir, path: join(dir, ".portico", "computer.json") };
}

/** No `claude` on the PATH unless a test says otherwise. */
const NO_CLAUDE: CliDeps = { findClaude: () => null };

/** Runs one command, recording stdout and stderr lines (and both, in order). */
async function cli(argv: string[], opts: { path: string; cwd: string; deps?: CliDeps }) {
  const out: string[] = [];
  const err: string[] = [];
  const lines: string[] = [];
  const io: CliIo = {
    env: {
      PORTICO_COMPUTER_CONFIG: opts.path,
      PORTICO_CLAUDE_HOME: join(dirname(dirname(opts.path)), ".claude"),
      CODEX_HOME: join(dirname(dirname(opts.path)), ".codex"),
      PATH: "",
    },
    cwd: opts.cwd,
    out: (line) => {
      out.push(line);
      lines.push(line);
    },
    err: (line) => {
      err.push(line);
      lines.push(line);
    },
  };
  // As in a terminal, once the person has pressed Allow: the code the page shows is typed at the prompt. Until then, and
  // with `noPrompt`, the command runs as in an agent's shell.
  const server = current;
  const readCode = server?.state.person === "allow" ? () => server.typeCode() : undefined;
  const code = await runCli(argv, io, { ...NO_CLAUDE, pollMs: 1, readCode, ...opts.deps });
  return { code, out, err, lines };
}

const settingsOf = (path: string) => join(dirname(dirname(path)), ".claude", "settings.json");

describe("join", () => {
  test("prints the link for a person, takes the code, then says what was written and what happens next", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    const run = await cli(["join", server.url], { path, cwd: dir, deps: { hostname: () => "macbook.local" } });
    expect(run.code).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out.slice(0, 8)).toEqual([
      "A person allows this computer on one Portico page:",
      `  1. Open ${server.url}/c/r1 in a browser, sign in and press Allow.`,
      "  2. The page then shows a 4-digit code. Type that code here, and nowhere else.",
      expect.stringMatching(/^The request runs out at .*\.$/),
      `Joined Portico at ${server.url} as computer "macbook".`,
      `Wrote ${path} (mode 600).`,
      "New Claude Code sessions on this computer join Portico automatically. Sessions already open join within a few seconds, or after a restart when the plugin was installed after the session started.",
      "To keep a folder off Portico, run /portico:off in a Claude Code session in that folder.",
    ]);
    const file = readComputerFile(path)!;
    expect(file.computer).toBe("macbook");
    expect(run.lines.join("\n")).not.toContain(file.token);
    expect(run.lines.join("\n")).not.toContain("ps_");
    expect(run.lines.join("\n")).not.toContain("4821");
  });

  test("the address may come as the sentence a person says, with --name", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    const run = await cli(["join", "Join", "Portico", "at", `${server.url}/join`, "--name", "studio"], { path, cwd: dir });
    expect(run.code).toBe(0);
    expect(run.out[4]).toBe(`Joined Portico at ${server.url} as computer "studio".`);
    expect(server.requests[0]!.body).toEqual({ kind: "computer", name: "studio", client: "claude-code" });
    const missing = await cli(["join", server.url, "--name", "--replace"], { path, cwd: dir });
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual(["--name needs a value. Usage: join <address> [--name <computer>] [--replace] [--no-allow] [--wait <seconds>] | join --code <4 digits> [--no-allow]"]);
    const wait = await cli(["join", server.url, "--wait", "soon"], { path, cwd: dir });
    expect(wait.err).toEqual(["--wait takes a number of seconds. Usage: join <address> [--name <computer>] [--replace] [--no-allow] [--wait <seconds>] | join --code <4 digits> [--no-allow]"]);
  });

  test("--wait 0 only asks and prints the link; join --code hands in the code the person read on the page", async () => {
    const server = portico("wait");
    const { dir, path } = computerDir();
    const noPrompt = { hostname: () => "macbook", readCode: undefined, command: 'bun "/plugin/src/cli.ts"' };
    const asked = await cli(["join", server.url, "--wait", "0"], { path, cwd: dir, deps: noPrompt });
    expect(asked.code).toBe(0);
    expect(asked.out).toHaveLength(5);
    expect(asked.out[1]).toBe(`  1. Open ${server.url}/c/r1 in a browser, sign in and press Allow.`);
    expect(asked.out[4]).toMatch(
      /^Waiting for a person to press Allow on Portico's page, which then shows a 4-digit code\. To finish the join, run: bun "\/plugin\/src\/cli\.ts" join --code <the 4 digits>\. The request runs out at .*\.$/,
    );
    expect(existsSync(path)).toBe(false);
    // Nothing is allowed in Claude Code's settings before the computer has joined.
    expect(existsSync(settingsOf(path))).toBe(false);
    // A code handed in before Allow, a code that isn't 4 digits, and a wrong code: each says so and exits 1.
    const early = await cli(["join", "--code", "4821"], { path, cwd: dir, deps: noPrompt });
    expect([early.code, early.err[0]]).toEqual([1, `Nobody has pressed Allow yet. Open ${server.url}/c/r1 in a browser, sign in and press Allow: the page then shows the code.`]);
    server.state.person = "allow";
    const odd = await cli(["join", "--code", "48211"], { path, cwd: dir, deps: noPrompt });
    expect([odd.code, odd.err[0]]).toEqual([1, `--code takes the 4 digits Portico's page shows. Usage: ${"join <address> [--name <computer>] [--replace] [--no-allow] [--wait <seconds>] | join --code <4 digits> [--no-allow]"}`]);
    const wrong = await cli(["join", "--code", "0000"], { path, cwd: dir, deps: noPrompt });
    expect([wrong.code, wrong.err[0]]).toEqual([1, "That code doesn't match the one Portico's page shows. 4 tries are left."]);
    // The same first call again, once Allow was pressed, says the code is showing and makes no new request.
    const again = await cli(["join", server.url, "--wait", "100"], { path, cwd: dir, deps: noPrompt });
    expect(again.out.slice(0, 4)).toEqual(asked.out.slice(0, 4));
    expect(again.out[4]).toStartWith("Allow was pressed on Portico's page, which shows the 4-digit code now. To finish the join, run: ");
    const done = await cli(["join", "--code", "4821"], { path, cwd: dir, deps: noPrompt });
    expect(done.code).toBe(0);
    expect(done.out[0]).toBe(`Joined Portico at ${server.url} as computer "macbook".`);
    expect(server.requests.filter((r) => r.method === "POST" && r.path === "/api/join")).toHaveLength(1);
    expect(existsSync(settingsOf(path))).toBe(true);
    for (const run of [asked, early, odd, wrong, again, done]) expect(run.lines.join("\n")).not.toMatch(/ps_|pc_/);
  });

  test("allows the Portico tools in Claude Code's settings once, and --no-allow skips it", async () => {
    const server = portico();
    const deps = { hostname: () => "macbook" };
    const { dir, path } = computerDir();
    const settings = settingsOf(path);
    const first = await cli(["join", server.url], { path, cwd: dir, deps });
    expect(first.code).toBe(0);
    expect(first.out).toContain(
      `Added mcp__plugin_portico_portico to permissions.allow in ${settings}, so Claude Code runs the Portico tools without asking. To skip this step, join with --no-allow.`,
    );
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ permissions: { allow: ["mcp__plugin_portico_portico"] } });
    const again = await cli(["join", server.url, "--replace"], { path, cwd: dir, deps });
    expect(again.code).toBe(0);
    expect(again.out.some((text) => text.includes("permissions.allow"))).toBe(false);

    const other = computerDir();
    const skipped = await cli(["join", server.url, "--no-allow"], { path: other.path, cwd: other.dir, deps });
    expect(skipped.code).toBe(0);
    expect(existsSync(settingsOf(other.path))).toBe(false);
    expect(skipped.out.some((text) => text.includes("permissions.allow"))).toBe(false);
  });

  test("a computer that joined already is told so, with nothing to allow", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    await cli(["join", server.url], { path, cwd: dir, deps: { hostname: () => "macbook" } });
    const again = await cli(["join", server.url], { path, cwd: dir });
    expect(again.code).toBe(0);
    expect(again.out[0]).toBe(`This computer is already on Portico at ${server.url} as computer "macbook". Nothing to allow.`);
    expect(server.requests.filter((r) => r.method === "POST" && r.path === "/api/join")).toHaveLength(1);
  });

  test("a settings file with invalid JSON is left alone, the rule to add by hand is printed, and the join still succeeds", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    const settings = settingsOf(path);
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, "{ broken");
    const run = await cli(["join", server.url], { path, cwd: dir, deps: { hostname: () => "macbook" } });
    expect(run.code).toBe(0);
    expect(readFileSync(settings, "utf8")).toBe("{ broken");
    expect(run.out).toContain(
      `${settings} was left unchanged (not valid JSON). To let Claude Code run the Portico tools without asking, add "mcp__plugin_portico_portico" to permissions.allow in that file.`,
    );
  });

  test("a join that isn't allowed never touches the settings", async () => {
    const server = portico("deny");
    const { dir, path } = computerDir();
    const run = await cli(["join", server.url], { path, cwd: dir });
    expect(run.code).toBe(1);
    expect(run.err).toEqual(["The join wasn't allowed on Portico. Nothing was written."]);
    expect(existsSync(dirname(settingsOf(path)))).toBe(false);
  });

  test("prints no control characters from Portico", async () => {
    const { dir, path } = computerDir();
    const fetch = (async (input: string | URL | Request) =>
      String(input).endsWith("/api/join")
        ? Response.json({ id: "r1", link: "https://portico.example.com/c/r1", poll_secret: "ps_x", expires_at: new Date(Date.now() + 60_000).toISOString() }, { status: 201 })
        : Response.json({ status: "approved", computer: { id: "c1", name: `studio${String.fromCharCode(27)}[2J` }, token: "pc_x" })) as unknown as typeof globalThis.fetch;
    const run = await cli(["join", "https://portico.example.com"], { path, cwd: dir, deps: { fetch, readCode: async () => "1234" } });
    expect(run.code).toBe(0);
    expect(run.out[4]).toBe('Joined Portico at https://portico.example.com as computer "studio[2J".');
    for (const line of run.lines) expect(line).not.toMatch(/\p{Cc}/u);
  });
});

describe("off and on", () => {
  async function joined() {
    const server = portico();
    const { dir, path } = computerDir();
    await cli(["join", server.url], { path, cwd: dir, deps: { hostname: () => "macbook" } });
    const work = join(dir, "work");
    mkdirSync(work);
    return { server, dir, path, work, token: readComputerFile(path)!.token };
  }

  test("set the current folder's switch on Portico by folder ID, and keep the local copy in step", async () => {
    const { server, path, work, token } = await joined();
    const id = folderId(token, work);
    let result = await cli(["off"], { path, cwd: work });
    expect([result.code, result.out, result.err]).toEqual([
      0,
      [`${work} is off Portico now: new sessions there stay off, and sessions already open there stay until closed.`],
      [],
    ]);
    expect(server.requests.at(-1)).toEqual({
      method: "PUT",
      path: `/api/computer/folders/${id}`,
      token,
      body: { joins: false, name: "work" },
    });
    expect(readComputerFile(path)?.off).toEqual([work]);

    result = await cli(["on"], { path, cwd: work });
    expect([result.code, result.out]).toEqual([
      0,
      [`${work} is on Portico again: new sessions there join, and sessions already open there join after a restart.`],
    ]);
    expect(server.requests.at(-1)).toMatchObject({ method: "PUT", body: { joins: true, name: "work" } });
    expect(readComputerFile(path)?.off).toEqual([]);
  });

  test("a folder given on the command line resolves against the current folder", async () => {
    const { server, dir, path, work, token } = await joined();
    const result = await cli(["off", "work"], { path, cwd: dir });
    expect(result.code).toBe(0);
    expect(server.requests.at(-1)?.path).toBe(`/api/computer/folders/${folderId(token, work)}`);
    expect(readComputerFile(path)?.off).toEqual([work]);
  });

  test("when Portico can't be reached or refuses, nothing changes on either side", async () => {
    const { server, path, work } = await joined();
    server.stop();
    const unreachable = await cli(["off"], { path, cwd: work });
    expect(unreachable.code).toBe(1);
    expect(unreachable.err).toEqual([`Portico at ${server.url} could not be reached. Nothing changed.`]);
    expect(readComputerFile(path)?.off).toEqual([]);

    // A computer removed on Portico: its token fails.
    const { dir: otherDir, path: otherPath } = computerDir();
    const live = portico();
    writeComputerFile(otherPath, { url: live.url, computer: "macbook", token: "pc_removed", off: [] });
    const refused = await cli(["off"], { path: otherPath, cwd: otherDir });
    expect(refused.code).toBe(1);
    expect(refused.err).toEqual([
      "Portico no longer accepts this computer's token (the computer may have been removed in Settings). Join again with the join command and the server's address.",
    ]);
  });

  test("before joining, off, on and status say the computer hasn't joined, and exit 1", async () => {
    const { dir, path } = computerDir();
    for (const command of ["off", "on", "status"]) {
      const result = await cli([command], { path, cwd: dir });
      expect(result.code).toBe(1);
      expect(result.out).toEqual([]);
      expect(result.err).toEqual([`This computer hasn't joined Portico: ${path} doesn't exist. Run join with the Portico server's address first.`]);
    }
    expect(existsSync(path)).toBe(false);
  });
});

describe("status", () => {
  test("shows the computer, the Portico address and the folders that are off", async () => {
    const { dir, path } = computerDir();
    const file = { url: "https://portico.example.com", computer: "macbook", token: "pc_secret-token", off: [] as string[] };
    writeComputerFile(path, file);
    let result = await cli(["status"], { path, cwd: dir });
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['Computer "macbook" on https://portico.example.com.', `Computer file: ${path}`, "Folders off Portico: none."]);

    writeComputerFile(path, { ...file, off: ["/work/a", "/work/b"] });
    result = await cli(["status"], { path, cwd: dir });
    expect(result.out).toEqual([
      'Computer "macbook" on https://portico.example.com.',
      `Computer file: ${path}`,
      "Folders off Portico:",
      "  /work/a",
      "  /work/b",
    ]);
    expect(result.lines.join("\n")).not.toContain(file.token);
  });
});

describe("leave", () => {
  test("removes the computer on Portico, then the computer file, the settings rule and the plugin", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    await cli(["join", server.url], { path, cwd: dir, deps: { hostname: () => "macbook" } });
    const token = readComputerFile(path)!.token;
    const ran: string[] = [];
    const run = await cli(["leave"], {
      path,
      cwd: dir,
      deps: { findClaude: () => "/usr/local/bin/claude", uninstall: (claude) => (ran.push(claude), 0) },
    });
    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      'Portico removed computer "macbook" along with every session there.',
      `Removed ${path}.`,
      `Removed mcp__plugin_portico_portico from permissions.allow in ${settingsOf(path)}.`,
      "Uninstalled the Portico plugin (portico@portico).",
      "This computer has left Portico.",
    ]);
    expect(server.requests.at(-1)).toEqual({ method: "DELETE", path: "/api/computer", token, body: null });
    expect(server.computers.size).toBe(0);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(dirname(path))).toBe(false); // the emptied .portico folder goes too
    expect(JSON.parse(readFileSync(settingsOf(path), "utf8"))).toEqual({ permissions: { allow: [] } });
    expect(ran).toEqual(["/usr/local/bin/claude"]);
  });

  test("succeeds with a note when Portico can't be reached, and prints the uninstall command without claude", async () => {
    const { dir, path } = computerDir();
    writeComputerFile(path, { url: "http://127.0.0.1:1", computer: "macbook", token: "pc_secret-token", off: [] });
    const run = await cli(["leave"], { path, cwd: dir });
    expect(run.code).toBe(0);
    expect(run.out).toEqual([
      'Portico at http://127.0.0.1:1 could not be reached, so computer "macbook" stays listed there. Remove computer "macbook" in Settings › Computers.',
      `Removed ${path}.`,
      "To remove the plugin too, run: claude plugin uninstall portico@portico",
      "This computer has left Portico.",
    ]);
    expect(existsSync(path)).toBe(false);
    expect(run.lines.join("\n")).not.toContain("pc_secret-token");
  });

  test("a computer Portico already removed, a failed uninstall, and no computer file at all", async () => {
    const server = portico();
    const { dir, path } = computerDir();
    writeComputerFile(path, { url: server.url, computer: "macbook", token: "pc_gone", off: [] });
    const gone = await cli(["leave"], { path, cwd: dir, deps: { findClaude: () => "/bin/claude", uninstall: () => 1 } });
    expect(gone.code).toBe(0);
    expect(gone.out).toContain('Computer "macbook" was already gone from Portico.');
    expect(gone.out).toContain(
      "The plugin uninstall didn't finish (claude exited with 1). To remove the plugin, run: claude plugin uninstall portico@portico",
    );

    const again = await cli(["leave"], { path, cwd: dir });
    expect(again.code).toBe(0);
    expect(again.out[0]).toBe(`No computer file at ${path}, so there was nothing to tell Portico.`);
    expect(again.out).not.toContain(`Removed ${path}.`);
  });

  test("a broken computer file is removed, with a note that Portico wasn't told", async () => {
    const { dir, path } = computerDir();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{ not json");
    const run = await cli(["leave"], { path, cwd: dir });
    expect(run.code).toBe(0);
    expect(run.out[0]).toBe(`${path} is not valid JSON. Portico wasn't told; remove the computer in Settings › Computers.`);
    expect(existsSync(path)).toBe(false);
  });

  test("finds claude on the PATH when no finder is given", async () => {
    const { dir, path } = computerDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "claude"), 0o755);
    const out: string[] = [];
    const io: CliIo = {
      env: { PORTICO_COMPUTER_CONFIG: path, PORTICO_CLAUDE_HOME: join(dir, ".claude"), CODEX_HOME: join(dir, ".codex"), PATH: `/nowhere:${bin}` },
      cwd: dir,
      out: (line) => out.push(line),
      err: (line) => out.push(line),
    };
    expect(await runCli(["leave"], io)).toBe(0);
    expect(out).toContain("Uninstalled the Portico plugin (portico@portico).");
  });
});

describe("copy", () => {
  test("output has no pronouns and never says hub", async () => {
    // Every command's lines: happy paths, refusals, CommandError messages, computer file errors and the usage.
    const server = portico();
    const { dir, path } = computerDir();
    const work = join(dir, "work");
    mkdirSync(work);
    const runs = [
      await cli(["off"], { path, cwd: work }),
      await cli(["status"], { path, cwd: work }),
      await cli(["join", `Join Portico at ${server.url}`], { path, cwd: work, deps: { hostname: () => "macbook" } }),
      await cli(["join", server.url], { path, cwd: work }),
      await cli(["join", "https://other.example.com"], { path, cwd: work }),
      await cli(["off"], { path, cwd: work }),
      await cli(["status"], { path, cwd: work }),
      await cli(["on"], { path, cwd: work }),
      await cli(["launch"], { path, cwd: work }),
      await cli(["help"], { path, cwd: work }),
      await cli(["join"], { path, cwd: work }),
      await cli(["join", "--bogus"], { path, cwd: work }),
      await cli(["join", "x", "--name"], { path, cwd: work }),
      await cli(["off", "a", "b"], { path, cwd: work }),
      await cli(["on", "--all"], { path, cwd: work }),
      await cli(["status", "extra"], { path, cwd: work }),
      await cli(["leave", "extra"], { path, cwd: work }),
      await cli(["leave"], { path, cwd: work, deps: { findClaude: () => "/bin/claude", uninstall: () => 0 } }),
      await cli(["leave"], { path, cwd: work, deps: { findClaude: () => "/bin/claude", uninstall: () => null } }),
    ];
    const other = computerDir();
    for (const line of [
      "no address here",
      "https://[bad",
      "http://portico.example.com",
      "https://u:p@portico.example.com",
      "https://portico.example.com/join#T4mWq8Zr2LpX6Kd1",
      "http://127.0.0.1:1",
    ]) {
      runs.push(await cli(["join", line], { path: other.path, cwd: other.dir }));
    }
    // The person turns the join down, lets the request run out, or hasn't answered when the wait ends; then a code
    // too early, a wrong one, Allow seen by the waiting command, and too many wrong codes.
    for (const person of ["deny", "late", "wait"] as const) {
      server.state.person = person;
      runs.push(await cli(["join", server.url, "--wait", "0"], { path: other.path, cwd: other.dir }));
    }
    const noPrompt = { readCode: undefined };
    runs.push(await cli(["join", "--code", "0000"], { path: other.path, cwd: other.dir, deps: noPrompt }));
    server.state.person = "allow";
    runs.push(await cli(["join", server.url, "--wait", "0"], { path: other.path, cwd: other.dir, deps: noPrompt }));
    for (let i = 0; i < 6; i++) runs.push(await cli(["join", "--code", "0000"], { path: other.path, cwd: other.dir, deps: noPrompt }));
    runs.push(await cli(["join", "--code", "12"], { path: other.path, cwd: other.dir, deps: noPrompt }));
    const bare = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    const odd = (async () => Response.json({}, { status: 201 })) as unknown as typeof fetch;
    for (const fetch of [bare, odd]) {
      runs.push(await cli(["join", "https://portico.example.com"], { path: other.path, cwd: other.dir, deps: { fetch } }));
    }
    writeComputerFile(other.path, { url: "http://127.0.0.1:1", computer: "macbook", token: "pc_x", off: [] });
    runs.push(await cli(["off"], { path: other.path, cwd: other.dir }));
    runs.push(await cli(["leave"], { path: other.path, cwd: other.dir }));
    mkdirSync(dirname(other.path), { recursive: true });
    writeFileSync(other.path, "{ not json");
    runs.push(await cli(["status"], { path: other.path, cwd: other.dir }));
    writeFileSync(other.path, '{ "url": 1 }');
    runs.push(await cli(["off"], { path: other.path, cwd: other.dir }));
    runs.push(await cli(["leave"], { path: other.path, cwd: other.dir }));

    expect(runs.filter((run) => run.code !== 0).length).toBeGreaterThanOrEqual(20);
    const lines = runs.flatMap((run) => run.lines.flatMap((line) => line.split("\n")));
    expect(lines.length).toBeGreaterThanOrEqual(60);
    for (const line of lines) {
      // Paths and addresses are data, not copy: a temp folder's random name could hold a pronoun.
      const copy = line.replaceAll(other.dir, "<dir>").replaceAll(dir, "<dir>").replaceAll(server.url, "<portico>");
      expect(copyProblems(copy)).toEqual([]);
    }
  });

  test("an unknown command prints the usage and exits 1", async () => {
    const { dir, path } = computerDir();
    const result = await cli(["launch"], { path, cwd: dir });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err[0]).toBe("Unknown command: launch");
    const usage = result.err.slice(1).join("\n");
    for (const command of ["join <address> [--name <computer>] [--replace] [--no-allow] [--wait <seconds>]", "off [folder]", "on [folder]", "leave", "status"]) {
      expect(usage).toContain(command);
    }
    const help = await cli(["help"], { path, cwd: dir });
    expect(help.code).toBe(0);
    expect(help.out.join("\n")).toBe(usage);
  });

  test("cli.ts runs the CLI with the real process", async () => {
    const { dir, path } = computerDir();
    writeComputerFile(path, { url: "https://portico.example.com", computer: "macbook", token: "pc_x", off: [] });
    // The env is built from scratch, so the child never inherits this session's settings.
    const proc = Bun.spawn(["bun", CLI, "status"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, PORTICO_COMPUTER_CONFIG: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      `Computer "macbook" on https://portico.example.com.\nComputer file: ${path}\nFolders off Portico: none.\n`,
    );

    const missing = Bun.spawn(["bun", CLI, "off"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, PORTICO_COMPUTER_CONFIG: join(dir, "none.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain("hasn't joined Portico");
  });
});
