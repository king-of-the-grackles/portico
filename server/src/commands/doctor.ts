import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ConfigError, hostUrl, parseEnv } from "../config";
import type { PorticoConfig } from "../core/types";
import { errorName } from "../log";
import type { CliIo } from "./io";

export interface DoctorDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/** The public URL confirmed at setup, when this computer has Portico's database. Null when it can't be read. */
function savedPublicUrl(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const db = new Database(path, { readonly: true });
    try {
      const row = db.query("SELECT value FROM settings WHERE key = 'public_url'").get() as { value: string } | null;
      return row?.value ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Why a request got no answer: the HTTP status, or the error's code or class name (never its message). */
function reason(err: unknown): string {
  if (err instanceof Response) return `HTTP ${err.status}`;
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z_]+$/.test(code) ? code : errorName(err);
}

/**
 * `portico doctor`: checks that Portico answers at its public URL (/healthz) and that setup is done (before setup, a
 * signed-out GET /api/me answers 503 setup_required; after, 401). Each failure ends with the next step.
 */
export async function doctorCommand(args: string[], io: CliIo, deps: DoctorDeps = {}): Promise<number> {
  if (args.length > 0) {
    io.err(`Unknown option: ${args[0]}. Usage: portico doctor`);
    return 1;
  }
  let config: PorticoConfig;
  try {
    config = parseEnv(io.env, "");
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) io.out(`✗ ${problem}`);
    return 1;
  }
  const base = hostUrl(config, io.env, savedPublicUrl(resolve(io.cwd, config.dbPath)));
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  const get = (path: string) =>
    doFetch(`${base}${path}`, {
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    });
  io.out(`Checking Portico at ${base}.`);

  try {
    const res = await get("/healthz");
    if (res.status !== 200) throw res;
    io.out(`✓ Portico answers at ${base}.`);
  } catch (err) {
    io.out(`✗ Portico didn't answer at ${base}/healthz (${reason(err)}).`);
    io.out(
      `  Next: check that portico serve is running and that ${base} leads to Portico. If Portico runs at another address, set PORTICO_PUBLIC_URL.`,
    );
    return 1;
  }

  let status = 0;
  let code: unknown = null;
  try {
    const res = await get("/api/me");
    status = res.status;
    code = ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error;
  } catch (err) {
    io.out(`✗ ${base}/api/me didn't answer (${reason(err)}).`);
    io.out(`  Next: check that portico serve is running, then run portico doctor again.`);
    return 1;
  }
  if (status === 401 && code === "unauthorized") {
    io.out("✓ Setup is done.");
    return 0;
  }
  if (status === 503 && code === "setup_required") {
    io.out("✗ Setup isn't done.");
    io.out("  Next: run portico setup on the host and open the printed link.");
    return 1;
  }
  io.out(`✗ ${base}/api/me gave an unexpected answer (HTTP ${status}).`);
  io.out(`  Next: check that ${base} leads to Portico and not to another server.`);
  return 1;
}
