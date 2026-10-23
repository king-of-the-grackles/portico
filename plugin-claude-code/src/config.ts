import type { MachineFile } from "./machine";

export interface PluginConfig {
  /** The hub's base URL, without a trailing slash. */
  url: string;
  token: string;
  /** "env": PORTICO_URL and PORTICO_TOKEN, for one session. "machine": machine.json, written when this machine joined. */
  source: "env" | "machine";
  /** This machine's name in machine mode, otherwise null. */
  machine: string | null;
}

export class PluginConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Portico plugin settings are incomplete:\n- ${problems.join("\n- ")}`);
    this.name = "PluginConfigError";
  }
}

type Env = Record<string, string | undefined>;

/** `.mcp.json` passes `${VAR}` through as literal text when VAR isn't set in Claude Code's environment. */
function read(env: Env, name: string): string {
  const value = env[name]?.trim() ?? "";
  return /^\$\{[^}]*\}$/.test(value) ? "" : value;
}

/**
 * The hub address without a trailing slash, or a problem. `label` names where it came from. https is required except
 * for localhost, because the token travels with every request.
 */
function parseHubUrl(raw: string, label: string): { url: string } | { problem: string } {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { problem: `${label} is not a valid URL.` };
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.username || parsed.password) return { problem: `${label} must not contain a user name or password.` };
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return {
      problem: `${label} must start with https:// (http:// is allowed only for localhost and 127.0.0.1), because the token travels with every request.`,
    };
  }
  return { url: `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "") };
}

/**
 * Reads the plugin's settings (spec §5.1). PORTICO_URL and PORTICO_TOKEN win, for one session; otherwise the machine
 * file gives machine mode. Returns null when there are neither: the plugin is enabled in every session, and sessions
 * not on a hub should see nothing. Throws when the settings are half there or wrong.
 */
export function parsePluginConfig(env: Env, machineFile: MachineFile | null = null): PluginConfig | null {
  const rawUrl = read(env, "PORTICO_URL");
  const token = read(env, "PORTICO_TOKEN");
  if (!rawUrl && !token && !machineFile) return null;

  const problems: string[] = [];
  let url = "";
  if (rawUrl || token) {
    if (!rawUrl) {
      problems.push(
        "PORTICO_URL is not set. Set it to the hub's public address, e.g. https://portico.example.com, in the environment Claude Code starts from.",
      );
    } else {
      const hub = parseHubUrl(rawUrl, "PORTICO_URL");
      if ("problem" in hub) problems.push(hub.problem);
      else url = hub.url;
    }
    if (!token) {
      problems.push("PORTICO_TOKEN is not set. Use the token of this session's agent (PORTICO_TOKEN_<NAME> in the hub's environment).");
    }
  } else if (machineFile) {
    const hub = parseHubUrl(machineFile.hub, "the hub address in machine.json");
    if ("problem" in hub) problems.push(hub.problem);
    else url = hub.url;
  }
  if (problems.length > 0) throw new PluginConfigError(problems);

  if (rawUrl || token) return { url, token, source: "env", machine: null };
  const file = machineFile!;
  return { url, token: file.token, source: "machine", machine: file.machine };
}
