import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRONOUNS } from "../../hub/test/helpers";
import { type CliIo, runCli } from "../src/cli-run";
import { readMachineFile, writeMachineFile } from "../src/machine";
import { startHub, tempDir, type TestHub } from "./helpers";

const CLI = join(import.meta.dir, "../src/cli.ts");
const FILE = { hub: "https://bridge.example.com", machine: "macbook", token: "bm_secret-token", off: [] as string[] };

const hubs: TestHub[] = [];
afterEach(() => {
  for (const hub of hubs.splice(0)) hub.stop();
});

function hub(): TestHub {
  const started = startHub();
  hubs.push(started);
  return started;
}

/** A temp folder with the machine file's path inside it. Tests never touch the real ~/.agent-bridge. */
function machineDir(): { dir: string; path: string } {
  const dir = realpathSync(tempDir());
  return { dir, path: join(dir, "machine.json") };
}

/** Runs one command, recording stdout and stderr lines (and both, in order). */
async function cli(argv: string[], opts: { path: string; cwd: string; deps?: Parameters<typeof runCli>[2] }) {
  const out: string[] = [];
  const err: string[] = [];
  const lines: string[] = [];
  const io: CliIo = {
    env: { BRIDGE_MACHINE_CONFIG: opts.path },
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
  const code = await runCli(argv, io, opts.deps);
  return { code, out, err, lines };
}

const offLines = (folder: string) => ({
  off: `${folder} is now off the network. New sessions there don't register; open sessions there leave after a restart.`,
  alreadyOff: `${folder} was already off the network.`,
  on: `${folder} is back on the network for new sessions.`,
  notOff: `${folder} wasn't off the network.`,
});

describe("plugin CLI", () => {
  test("join prints what was written and what happens next", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const { dir, path } = machineDir();
    const run = await cli(["join", `Join my agent bridge: ${h.url}/join#${code}`], {
      path,
      cwd: dir,
      deps: { hostname: () => "macbook.local" },
    });
    expect(run.code).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out[0]).toBe(`Joined ${h.url} as machine "macbook".`);
    expect(run.out).toContain(`Wrote ${path} (mode 600).`);
    expect(run.out.some((line) => line.startsWith("New Claude Code sessions on this machine now appear on the network."))).toBe(true);
    expect(run.out.some((line) => line.includes("/agent-bridge:off"))).toBe(true);
    const file = readMachineFile(path)!;
    expect(file.machine).toBe("macbook");
    expect(run.lines.join("\n")).not.toContain(file.token);
  });

  test("the join line may come as several words, with --code and --name", async () => {
    const h = hub();
    const { code } = h.networkService.createJoinCode();
    const { dir, path } = machineDir();
    const run = await cli(["join", "Join", "my", "agent", "bridge:", h.url, "--code", code, "--name", "Studio"], { path, cwd: dir });
    expect(run.code).toBe(0);
    expect(run.out[0]).toBe(`Joined ${h.url} as machine "studio".`);
    expect(readMachineFile(path)?.machine).toBe("studio");

    // A code may start with "-"; only another option counts as a missing value.
    const posted: unknown[] = [];
    const fetch = (async (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)));
      return Response.json({ machine: { name: "studio" }, token: "bm_x" }, { status: 201 });
    }) as unknown as typeof globalThis.fetch;
    const other = machineDir();
    const dashed = await cli(["join", "https://bridge.example.com", "--code", `--${"A".repeat(20)}`, "--name", "studio"], {
      path: other.path,
      cwd: other.dir,
      deps: { fetch },
    });
    expect(dashed.code).toBe(0);
    expect(posted).toEqual([{ code: `--${"A".repeat(20)}`, machine: "studio" }]);
    const missing = await cli(["join", "https://bridge.example.com", "--name", "--replace"], { path: other.path, cwd: other.dir });
    expect(missing.code).toBe(1);
    expect(missing.err).toEqual(["--name needs a value. Usage: join <line> [--code <code>] [--name <machine>] [--replace]"]);
  });

  test("join prints no control characters from the hub", async () => {
    const { dir, path } = machineDir();
    const fetch = (async () =>
      Response.json({ machine: { name: "studio\u001b[2J" }, token: "bm_x" }, { status: 201 })) as unknown as typeof globalThis.fetch;
    const run = await cli(["join", `https://bridge.example.com/join#${"B".repeat(22)}`], { path, cwd: dir, deps: { fetch } });
    expect(run.code).toBe(0);
    expect(run.out[0]).toBe('Joined https://bridge.example.com as machine "studio[2J".');
    for (const line of run.lines) expect(line).not.toMatch(/\p{Cc}/u);
  });

  test("off and on edit the list for the current folder by default", async () => {
    const { dir, path } = machineDir();
    writeMachineFile(path, FILE);
    const work = join(dir, "work");
    mkdirSync(work);
    const lines = offLines(work);
    const run = (argv: string[], cwd = work) => cli(argv, { path, cwd });

    let result = await run(["off"]);
    expect([result.code, result.out, result.err]).toEqual([0, [lines.off], []]);
    expect(readMachineFile(path)?.off).toEqual([work]);
    result = await run(["off"]);
    expect([result.code, result.out]).toEqual([0, [lines.alreadyOff]]);
    result = await run(["on"]);
    expect([result.code, result.out]).toEqual([0, [lines.on]]);
    expect(readMachineFile(path)?.off).toEqual([]);
    result = await run(["on"]);
    expect([result.code, result.out]).toEqual([0, [lines.notOff]]);

    // A folder given on the command line resolves against the current folder.
    result = await run(["off", "work"], dir);
    expect(result.out).toEqual([lines.off]);
    expect(readMachineFile(path)).toEqual({ ...FILE, off: [work] });
  });

  test("on inside a folder that is off names the folder to switch back on", async () => {
    const { dir, path } = machineDir();
    writeMachineFile(path, { ...FILE, off: [dir] });
    const inner = join(dir, "inner");
    mkdirSync(inner);
    const result = await cli(["on"], { path, cwd: inner });
    expect(result.code).toBe(0);
    expect(result.out).toEqual([`${inner} is inside ${dir}, which is off the network. Run on in ${dir} instead.`]);
    expect(readMachineFile(path)?.off).toEqual([dir]);
  });

  test("off before joining says the machine hasn't joined, and exits 1", async () => {
    const { dir, path } = machineDir();
    for (const command of ["off", "on", "status"]) {
      const result = await cli([command], { path, cwd: dir });
      expect(result.code).toBe(1);
      expect(result.out).toEqual([]);
      expect(result.err).toEqual([`This machine hasn't joined a hub: ${path} doesn't exist. Run join with a join line first.`]);
    }
    expect(existsSync(path)).toBe(false);
  });

  test("status shows the machine, the hub and the off folders", async () => {
    const { dir, path } = machineDir();
    writeMachineFile(path, FILE);
    let result = await cli(["status"], { path, cwd: dir });
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      'Machine "macbook" on https://bridge.example.com.',
      `Machine file: ${path}`,
      "Folders off the network: none.",
    ]);

    writeMachineFile(path, { ...FILE, off: ["/work/a", "/work/b"] });
    result = await cli(["status"], { path, cwd: dir });
    expect(result.out).toEqual([
      'Machine "macbook" on https://bridge.example.com.',
      `Machine file: ${path}`,
      "Folders off the network:",
      "  /work/a",
      "  /work/b",
    ]);
    expect(result.lines.join("\n")).not.toContain(FILE.token);
  });

  test("output has no pronouns", async () => {
    // Every command's lines: happy paths, refusals, JoinError messages, machine file errors and the usage.
    const h = hub();
    const { dir, path } = machineDir();
    const work = join(dir, "work");
    mkdirSync(work);
    const code = () => h.networkService.createJoinCode().code;
    const runs = [
      await cli(["off"], { path, cwd: work }),
      await cli(["status"], { path, cwd: work }),
      await cli(["join", `Join my agent bridge: ${h.url}/join#${code()}`], { path, cwd: work, deps: { hostname: () => "macbook" } }),
      await cli(["join", `${h.url}/join#${code()}`], { path, cwd: work }),
      await cli(["off"], { path, cwd: work }),
      await cli(["off"], { path, cwd: work }),
      await cli(["status"], { path, cwd: work }),
      await cli(["on"], { path, cwd: work }),
      await cli(["on"], { path, cwd: work }),
      await cli(["off", dir], { path, cwd: work }),
      await cli(["on"], { path, cwd: work }),
      await cli(["launch"], { path, cwd: work }),
      await cli(["help"], { path, cwd: work }),
      await cli(["join"], { path, cwd: work }),
      await cli(["join", "--bogus"], { path, cwd: work }),
      await cli(["join", "x", "--name"], { path, cwd: work }),
      await cli(["off", "a", "b"], { path, cwd: work }),
      await cli(["on", "--all"], { path, cwd: work }),
      await cli(["status", "extra"], { path, cwd: work }),
    ];
    const other = machineDir();
    for (const line of [
      "no address here",
      "https://[bad/join#AAAAAAAAAAAAAAAAAAAAAA",
      "http://bridge.example.com/join#AAAAAAAAAAAAAAAAAAAAAA",
      "https://u:p@bridge.example.com/join#AAAAAAAAAAAAAAAAAAAAAA",
      "https://bridge.example.com/join#short",
      `${h.url}/join#${"B".repeat(22)}`,
      `http://127.0.0.1:1/join#${"B".repeat(22)}`,
    ]) {
      runs.push(await cli(["join", line], { path: other.path, cwd: other.dir }));
    }
    const bare = (async () => new Response("", { status: 502 })) as unknown as typeof fetch;
    const odd = (async () => Response.json({}, { status: 201 })) as unknown as typeof fetch;
    for (const fetch of [bare, odd]) {
      runs.push(await cli(["join", `https://bridge.example.com/join#${"B".repeat(22)}`], { path: other.path, cwd: other.dir, deps: { fetch } }));
    }
    writeFileSync(other.path, "{ not json");
    runs.push(await cli(["status"], { path: other.path, cwd: other.dir }));
    writeFileSync(other.path, '{ "hub": 1 }');
    runs.push(await cli(["off"], { path: other.path, cwd: other.dir }));

    expect(runs.filter((run) => run.code !== 0).length).toBeGreaterThanOrEqual(20);
    const lines = runs.flatMap((run) => run.lines.flatMap((line) => line.split("\n")));
    expect(lines.length).toBeGreaterThanOrEqual(40);
    for (const line of lines) {
      // Paths and addresses are data, not copy: a temp folder's random name could hold a pronoun.
      const copy = line.replaceAll(other.dir, "<dir>").replaceAll(dir, "<dir>").replaceAll(h.url, "<hub>");
      expect(copy).not.toMatch(PRONOUNS);
    }
  });

  test("an unknown command prints the usage and exits 1", async () => {
    const { dir, path } = machineDir();
    const result = await cli(["launch"], { path, cwd: dir });
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err[0]).toBe("Unknown command: launch");
    const usage = result.err.slice(1).join("\n");
    for (const command of ["join <line> [--code <code>] [--name <machine>] [--replace]", "off [folder]", "on [folder]", "status"]) {
      expect(usage).toContain(command);
    }
    const help = await cli(["help"], { path, cwd: dir });
    expect(help.code).toBe(0);
    expect(help.out.join("\n")).toBe(usage);
  });

  test("cli.ts runs the CLI with the real process", async () => {
    const { dir, path } = machineDir();
    writeMachineFile(path, FILE);
    // The env is built from scratch, so the child never inherits this session's settings.
    const proc = Bun.spawn(["bun", CLI, "status"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, BRIDGE_MACHINE_CONFIG: path },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await proc.exited).toBe(0);
    expect(await new Response(proc.stdout).text()).toBe(
      `Machine "macbook" on https://bridge.example.com.\nMachine file: ${path}\nFolders off the network: none.\n`,
    );

    const missing = Bun.spawn(["bun", CLI, "off"], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? "", HOME: dir, BRIDGE_MACHINE_CONFIG: join(dir, "none.json") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await missing.exited).toBe(1);
    expect(await new Response(missing.stderr).text()).toContain("hasn't joined a hub");
  });
});
