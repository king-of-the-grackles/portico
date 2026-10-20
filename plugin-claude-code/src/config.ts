export interface PluginConfig {
  /** The hub's base URL, without a trailing slash. */
  url: string;
  token: string;
  permissionRelay: boolean;
}

export class PluginConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`agent-bridge plugin settings are incomplete:\n- ${problems.join("\n- ")}`);
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
 * Reads the plugin's settings. Returns null when neither BRIDGE_URL nor BRIDGE_TOKEN is set: the plugin is enabled
 * in every session, and sessions not on the bridge should see nothing. Throws when the settings are half there or wrong.
 */
export function parsePluginConfig(env: Env): PluginConfig | null {
  const url = read(env, "BRIDGE_URL").replace(/\/+$/, "");
  const token = read(env, "BRIDGE_TOKEN");
  const relay = (read(env, "BRIDGE_PERMISSION_RELAY") || "on").toLowerCase();
  if (!url && !token) return null;

  const problems: string[] = [];
  if (!url) {
    problems.push(
      "BRIDGE_URL is not set. Set it to the hub's public address, e.g. https://bridge.example.com, in the environment Claude Code starts from.",
    );
  } else {
    try {
      const parsed = new URL(url);
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
        problems.push(
          "BRIDGE_URL must start with https:// (http:// is allowed only for localhost), because the token travels with every request.",
        );
      }
    } catch {
      problems.push(`BRIDGE_URL "${url}" is not a valid URL.`);
    }
  }
  if (!token) {
    problems.push("BRIDGE_TOKEN is not set. Use the token of this session's agent (BRIDGE_TOKEN_<NAME> in the hub's environment).");
  }
  if (relay !== "on" && relay !== "off") problems.push(`BRIDGE_PERMISSION_RELAY must be "on" or "off", not "${relay}".`);
  if (problems.length > 0) throw new PluginConfigError(problems);
  return { url, token, permissionRelay: relay === "on" };
}
