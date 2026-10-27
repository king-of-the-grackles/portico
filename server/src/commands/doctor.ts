import { ConfigError, parseEnv } from "../config";
import { errorName } from "../log";
import type { CliIo } from "./io";

export interface DoctorDeps {
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
}

/** Checks that Portico answers at its public URL. The Accounts track adds the setup check. */
export async function doctorCommand(args: string[], io: CliIo, deps: DoctorDeps = {}): Promise<number> {
  if (args.length > 0) {
    io.err(`Unknown option: ${args[0]}. Usage: portico doctor`);
    return 1;
  }
  let base: string;
  try {
    const config = parseEnv(io.env, "");
    base = config.publicUrl ?? `http://localhost:${config.port}`;
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    for (const problem of err.problems) io.out(`✗ ${problem}`);
    return 1;
  }
  const doFetch = deps.fetch ?? ((url: string, init?: RequestInit) => fetch(url, init));
  try {
    const res = await doFetch(`${base}/healthz`, { signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    io.out(`✓ ${base}/healthz answered.`);
    return 0;
  } catch (err) {
    io.out(`✗ ${base}/healthz didn't answer (${err instanceof Error && err.message.startsWith("HTTP") ? err.message : errorName(err)}).`);
    return 1;
  }
}
