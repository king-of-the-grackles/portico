import type { ComputerFile } from "./computer";

export interface PluginConfig {
  /** Portico's base URL, without a trailing slash. */
  url: string;
  /** The computer token. */
  token: string;
  /** This computer's name on Portico. */
  computer: string;
}

export class PluginConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Portico plugin settings are incomplete:\n- ${problems.join("\n- ")}`);
    this.name = "PluginConfigError";
  }
}

/**
 * Portico's address without a trailing slash, or a problem. `label` names where it came from. https is required except
 * for localhost, because the token travels with every request.
 */
export function parsePorticoUrl(raw: string, label: string): { url: string } | { problem: string } {
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
 * The plugin's settings, from computer.json, written when this computer joined. Null when there is none: the plugin
 * is enabled in every session, and sessions on a computer that hasn't joined should see nothing. Throws when the
 * address in the file is wrong.
 */
export function parsePluginConfig(file: ComputerFile | null): PluginConfig | null {
  if (!file) return null;
  const parsed = parsePorticoUrl(file.url, "the Portico address in computer.json");
  if ("problem" in parsed) throw new PluginConfigError([parsed.problem]);
  return { url: parsed.url, token: file.token, computer: file.computer };
}
