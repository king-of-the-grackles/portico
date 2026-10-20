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
  const rawUrl = read(env, "BRIDGE_URL");
  let url = rawUrl;
  const token = read(env, "BRIDGE_TOKEN");
  const relay = (read(env, "BRIDGE_PERMISSION_RELAY") || "on").toLowerCase();
  if (!rawUrl && !token) return null;

  const problems: string[] = [];
  if (!rawUrl) {
    problems.push(
      "BRIDGE_URL is not set. Set it to the hub's public address, e.g. https://bridge.example.com, in the environment Claude Code starts from.",
    );
  } else {
    let parsed: URL | null = null;
    try {
      parsed = new URL(rawUrl);
    } catch {
      problems.push("BRIDGE_URL is not a valid URL.");
    }
    if (parsed) {
      const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (parsed.username || parsed.password) {
        problems.push("BRIDGE_URL must not contain a user name or password.");
      } else if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
        problems.push(
          "BRIDGE_URL must start with https:// (http:// is allowed only for localhost and 127.0.0.1), because the token travels with every request.",
        );
      } else {
        url = `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
      }
    }
  }
  if (!token) {
    problems.push("BRIDGE_TOKEN is not set. Use the token of this session's agent (BRIDGE_TOKEN_<NAME> in the hub's environment).");
  }
  if (relay !== "on" && relay !== "off") problems.push(`BRIDGE_PERMISSION_RELAY must be "on" or "off", not "${relay}".`);
  if (problems.length > 0) throw new PluginConfigError(problems);
  return { url, token, permissionRelay: relay === "on" };
}
