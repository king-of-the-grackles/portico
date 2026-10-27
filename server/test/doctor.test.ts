import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/commands/doctor";
import type { CliIo } from "../src/commands/io";
import { openDb } from "../src/db";
import { copyProblems, makePortico, PUBLIC_URL } from "./helpers";

function testIo(env: Record<string, string | undefined>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, cwd: "/", out: (line) => out.push(line), err: (line) => err.push(line) };
  return { io, out, err };
}

/** A fetch that answers from a running test Portico, recording the URLs asked for. */
function fetchFrom(p: ReturnType<typeof makePortico>, asked: string[] = []) {
  return async (url: string, init?: RequestInit) => {
    asked.push(url);
    return await p.app.request(url, init);
  };
}

const env = { PORTICO_PUBLIC_URL: PUBLIC_URL, PORTICO_DB_PATH: "/nowhere/portico.db" };

describe("portico doctor", () => {
  test("all good: Portico answers at the public URL and setup is done", async () => {
    const p = makePortico();
    const asked: string[] = [];
    const { io, out } = testIo(env);
    expect(await doctorCommand([], io, { fetch: fetchFrom(p, asked) })).toBe(0);
    expect(asked).toEqual([`${PUBLIC_URL}/healthz`, `${PUBLIC_URL}/api/me`]);
    expect(out).toEqual([`Checking Portico at ${PUBLIC_URL}.`, `✓ Portico answers at ${PUBLIC_URL}.`, "✓ Setup is done."]);
  });

  test("before setup: the next step is portico setup", async () => {
    const { io, out } = testIo(env);
    expect(await doctorCommand([], io, { fetch: fetchFrom(makePortico({ setup: false })) })).toBe(1);
    expect(out.slice(2)).toEqual(["✗ Setup isn't done.", "  Next: run portico setup on the host and open the printed link."]);
  });

  test("no answer: the next step is to start Portico or fix the address, and setup isn't checked", async () => {
    const { io, out } = testIo(env);
    const refused = async () => {
      throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    };
    expect(await doctorCommand([], io, { fetch: refused })).toBe(1);
    expect(out.slice(1)).toEqual([
      `✗ Portico didn't answer at ${PUBLIC_URL}/healthz (ConnectionRefused).`,
      `  Next: check that portico serve is running and that ${PUBLIC_URL} leads to Portico. If Portico runs at another address, set PORTICO_PUBLIC_URL.`,
    ]);
  });

  test("another server at the address: both checks say so", async () => {
    const { io, out } = testIo(env);
    const other = async () => new Response("<html>hello</html>", { status: 404 });
    expect(await doctorCommand([], io, { fetch: other })).toBe(1);
    expect(out[1]).toBe(`✗ Portico didn't answer at ${PUBLIC_URL}/healthz (HTTP 404).`);
    const healthyButOdd = async (url: string) => (url.endsWith("/healthz") ? Response.json({ ok: true }) : new Response("", { status: 200 }));
    const second = testIo(env);
    expect(await doctorCommand([], second.io, { fetch: healthyButOdd })).toBe(1);
    expect(second.out.slice(2)).toEqual([
      `✗ ${PUBLIC_URL}/api/me gave an unexpected answer (HTTP 200).`,
      `  Next: check that ${PUBLIC_URL} leads to Portico and not to another server.`,
    ]);
  });

  test("without PORTICO_PUBLIC_URL, the URL saved at setup is checked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "portico-doctor-"));
    const dbPath = join(dir, "portico.db");
    const db = openDb(dbPath);
    db.query("INSERT INTO settings (key, value) VALUES ('public_url', 'https://portico.example.org')").run();
    db.close();
    const asked: string[] = [];
    const { io } = testIo({ PORTICO_DB_PATH: dbPath });
    await doctorCommand([], io, { fetch: fetchFrom(makePortico(), asked) });
    expect(asked[0]).toBe("https://portico.example.org/healthz");
    const local: string[] = [];
    await doctorCommand([], testIo({ PORTICO_DB_PATH: join(dir, "missing.db"), PORT: "8802" }).io, { fetch: fetchFrom(makePortico(), local) });
    expect(local[0]).toBe("http://localhost:8802/healthz");
  });

  test("output follows the copy rules; a bad option or setting fails plainly", async () => {
    const lines: string[] = [];
    for (const fetch of [fetchFrom(makePortico()), fetchFrom(makePortico({ setup: false })), async () => new Response("", { status: 502 })]) {
      const { io, out } = testIo(env);
      await doctorCommand([], io, { fetch });
      lines.push(...out);
    }
    const bad = testIo({ PORTICO_PUBLIC_URL: "http://portico.example.com" });
    expect(await doctorCommand([], bad.io)).toBe(1);
    lines.push(...bad.out, ...bad.err);
    const option = testIo(env);
    expect(await doctorCommand(["--fix"], option.io)).toBe(1);
    expect(option.err).toEqual(["Unknown option: --fix. Usage: portico doctor"]);
    expect(copyProblems(lines.join("\n").replaceAll(PUBLIC_URL, ""))).toEqual([]);
  });
});
