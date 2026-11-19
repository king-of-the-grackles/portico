import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/commands/io";
import { joinCommand } from "../src/commands/join";
import { leaveCommand } from "../src/commands/leave";
import { copyProblems } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "po-cli-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A stand-in for the join and computer APIs, following the shared contract: POST /api/join answers a link and a code,
 * GET /api/join/:id is polled with the poll secret, and `decision` is what the person does on the page.
 */
function fakeComputerApi(decision: "approved" | "denied" = "approved") {
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      requests.push({ method: req.method, path, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : null });
      const base = new URL(req.url).origin;
      if (req.method === "POST" && path === "/api/join") {
        return Response.json({ id: "r1", link: `${base}/c/r1`, code: "4821", poll_secret: "ps_poll", expires_at: new Date(Date.now() + 600_000).toISOString(), show: "x" }, { status: 201 });
      }
      if (req.method === "GET" && path === "/api/join/r1") {
        if (req.headers.get("authorization") !== "Bearer ps_poll") return Response.json({ error: "unauthorized", message: "Missing or wrong poll secret for this request." }, { status: 401 });
        // The first poll finds the person still reading the page.
        if (requests.filter((r) => r.path === path).length === 1) return Response.json({ status: "pending" });
        return Response.json(decision === "approved" ? { status: "approved", computer: { id: "c1", name: "studio" }, token: "pc_computer-token" } : { status: "denied" });
      }
      if (req.method === "DELETE" && path === "/api/computer") return new Response(null, { status: 204 });
      return Response.json({ error: "not_found", message: "No such endpoint." }, { status: 404 });
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, requests };
}

function io(home: string) {
  const lines: string[] = [];
  const value: CliIo = {
    env: {
      PORTICO_COMPUTER_CONFIG: join(home, ".portico", "computer.json"),
      PORTICO_CLAUDE_HOME: join(home, ".claude"),
      CODEX_HOME: join(home, ".codex"),
      PATH: "",
    },
    cwd: home,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
  return { io: value, lines };
}

describe("portico join and portico leave", () => {
  test("join asks Portico, prints the link and the code, waits for Allow and writes the computer file; leave undoes it", async () => {
    const api = fakeComputerApi();
    const home = tempHome();
    const { io: joinIo, lines: joined } = io(home);
    expect(await joinCommand([api.url, "--name", "studio"], joinIo, { pollMs: 1 })).toBe(0);
    expect(api.requests[0]).toEqual({ method: "POST", path: "/api/join", auth: null, body: { kind: "computer", name: "studio", client: "claude-code" } });
    expect(joined.slice(0, 4)).toEqual([
      "A person allows this computer on one Portico page:",
      `  1. Open ${api.url}/c/r1 in a browser and sign in.`,
      "  2. Type the code 4821 there and press Allow.",
      expect.stringMatching(/^The code runs out at .*\. Type the code only on that page\.$/),
    ]);
    expect(joined[4]).toBe(`Joined Portico at ${api.url} as computer "studio".`);
    const path = join(home, ".portico", "computer.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ url: api.url, computer: "studio", token: "pc_computer-token", off: [] });
    // The waiting request's poll secret is gone once the join ends.
    expect(existsSync(join(home, ".portico", "join.json"))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"))).toEqual({
      permissions: { allow: ["mcp__plugin_portico_portico"] },
    });

    const { io: leaveIo, lines: left } = io(home);
    const uninstalled: string[] = [];
    const code = await leaveCommand([], leaveIo, { findClaude: () => "/bin/claude", uninstall: (claude) => (uninstalled.push(claude), 0) });
    expect(code).toBe(0);
    expect(api.requests.at(-1)).toEqual({ method: "DELETE", path: "/api/computer", auth: "Bearer pc_computer-token", body: null });
    expect(existsSync(path)).toBe(false);
    expect(uninstalled).toEqual(["/bin/claude"]);
    expect(left.at(-1)).toBe("This computer has left Portico.");
    for (const line of [...joined, ...left]) expect(copyProblems(line.replaceAll(home, "<home>"))).toEqual([]);
    expect([...joined, ...left].join("\n")).not.toContain("pc_computer-token");
    expect([...joined, ...left].join("\n")).not.toContain("ps_poll");
  });

  test("a join the person turns down exits 1 and writes nothing", async () => {
    const api = fakeComputerApi("denied");
    const home = tempHome();
    const { io: value, lines } = io(home);
    expect(await joinCommand([`${api.url}/join`], value, { pollMs: 1 })).toBe(1);
    expect(lines.at(-1)).toBe("The join wasn't allowed on Portico. Nothing was written.");
    expect(existsSync(join(home, ".portico", "computer.json"))).toBe(false);
    expect(existsSync(join(home, ".portico", "join.json"))).toBe(false);
  });

  test("the portico binary runs leave, and succeeds on a computer that never joined", async () => {
    const home = tempHome();
    const proc = Bun.spawn([process.execPath, CLI, "leave"], {
      env: { HOME: home, PATH: "", PORTICO_COMPUTER_CONFIG: join(home, ".portico", "computer.json"), PORTICO_CLAUDE_HOME: join(home, ".claude") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    expect(code).toBe(0);
    expect(out).toContain("so there was nothing to tell Portico.");
    expect(out).toContain("To remove the plugin too, run: claude plugin uninstall portico@portico");
  });
});
