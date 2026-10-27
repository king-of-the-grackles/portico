import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliIo } from "../src/commands/io";
import { joinCommand } from "../src/commands/join";
import { leaveCommand } from "../src/commands/leave";
import { copyProblems } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const TOKEN = "T4mWq8Zr2LpX6Kd1";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempHome(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "po-cli-")));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A stand-in for the computer API (built by the Onboarding track), following the shared contract. */
function fakeComputerApi() {
  const requests: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const text = await req.text();
      const path = new URL(req.url).pathname;
      requests.push({ method: req.method, path, auth: req.headers.get("authorization"), body: text ? JSON.parse(text) : null });
      if (req.method === "POST" && path === "/api/computer/join") {
        const body = JSON.parse(text) as { token: string; computer: string };
        if (body.token !== TOKEN) return Response.json({ error: "not_found", message: "The join line isn't valid any more." }, { status: 404 });
        return Response.json({ computer: { id: "c1", name: body.computer }, token: "pc_computer-token" }, { status: 201 });
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
    env: { PORTICO_COMPUTER_CONFIG: join(home, ".portico", "computer.json"), PORTICO_CLAUDE_HOME: join(home, ".claude"), PATH: "" },
    cwd: home,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
  return { io: value, lines };
}

describe("portico join and portico leave", () => {
  test("join redeems the line on Portico and writes the computer file; leave undoes it", async () => {
    const api = fakeComputerApi();
    const home = tempHome();
    const { io: joinIo, lines: joined } = io(home);
    expect(await joinCommand([`Join Portico: ${api.url}/join#${TOKEN}`, "--name", "studio"], joinIo)).toBe(0);
    expect(joined[0]).toBe(`Joined Portico at ${api.url} as computer "studio".`);
    expect(api.requests[0]).toEqual({ method: "POST", path: "/api/computer/join", auth: null, body: { token: TOKEN, computer: "studio" } });
    const path = join(home, ".portico", "computer.json");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ url: api.url, computer: "studio", token: "pc_computer-token", off: [] });
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
  });

  test("a refused join exits 1 with Portico's message", async () => {
    const api = fakeComputerApi();
    const { io: value, lines } = io(tempHome());
    expect(await joinCommand([`${api.url}/join#AAAAAAAAAAAAAAAAAAAAAA`], value)).toBe(1);
    expect(lines).toEqual(["The join line isn't valid any more."]);
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
