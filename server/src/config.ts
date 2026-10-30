import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cleanPublicUrl } from "./core/settings";
import type { PorticoConfig } from "./core/types";

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

/** Not 8787 (Claude Code's fakechat channel demo) or 8788 (the Channels webhook example). */
export const DEFAULT_PORT = 8790;
export const DEFAULT_DB_PATH = "./portico.db";
const SIGNING_KEY_FILE = "signing.key";

type Env = Record<string, string | undefined>;

/**
 * Everything is optional: PORT, PORTICO_DB_PATH, PORTICO_PLUGIN_SOURCE, PORTICO_PUBLIC_URL and
 * PORTICO_WEBHOOKS_ALLOW_PRIVATE. The signing key is passed in, so this stays free of file access (see loadConfig).
 */
export function parseEnv(env: Env, signingKey: string): PorticoConfig {
  const problems: string[] = [];
  const port = env.PORT?.trim() ? Number(env.PORT) : DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`PORT "${env.PORT}" is not a valid port`);
  let publicUrl: string | null = null;
  const rawUrl = env.PORTICO_PUBLIC_URL?.trim();
  if (rawUrl) {
    publicUrl = cleanPublicUrl(rawUrl);
    if (!publicUrl) {
      problems.push(
        `PORTICO_PUBLIC_URL "${rawUrl}" must be an https:// address (http:// is allowed only for localhost and 127.0.0.1)`,
      );
    }
  }
  if (problems.length > 0) throw new ConfigError(problems);
  const dbPath = env.PORTICO_DB_PATH?.trim() || DEFAULT_DB_PATH;
  return {
    port,
    dbPath,
    dataDir: dbPath === ":memory:" ? "." : dirname(resolve(dbPath)),
    pluginSource: env.PORTICO_PLUGIN_SOURCE?.trim() || null,
    publicUrl,
    signingKey,
    webhooksAllowPrivate: env.PORTICO_WEBHOOKS_ALLOW_PRIVATE?.trim() === "1",
  };
}

/** The data folder's signing key, made on first start: 32 random bytes as hex, readable only by this account. */
export function ensureSigningKey(dataDir: string): string {
  const path = join(dataDir, SIGNING_KEY_FILE);
  if (existsSync(path)) {
    const key = readFileSync(path, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(key)) return key;
    throw new ConfigError([`${path} isn't a Portico signing key. Move it aside and start again to make a new one.`]);
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString("hex");
  writeFileSync(path, `${key}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  return key;
}

/**
 * The address a cloud platform gives Portico, when Portico runs on one: Render's RENDER_EXTERNAL_URL, or
 * https://<app>.fly.dev from Fly's FLY_APP_NAME. Null elsewhere.
 */
export function platformUrl(env: Env): string | null {
  const render = env.RENDER_EXTERNAL_URL?.trim();
  if (render) return cleanPublicUrl(render);
  const fly = env.FLY_APP_NAME?.trim();
  if (fly && /^[a-z0-9]+(-[a-z0-9]+)*$/i.test(fly)) return `https://${fly.toLowerCase()}.fly.dev`;
  return null;
}

/**
 * The address host-side commands (setup, doctor) put in links: PORTICO_PUBLIC_URL, else the URL confirmed at setup,
 * else the platform's address, else this computer's own.
 */
export function hostUrl(config: Pick<PorticoConfig, "publicUrl" | "port">, env: Env, saved: string | null): string {
  return config.publicUrl ?? saved ?? platformUrl(env) ?? `http://localhost:${config.port}`;
}

/** The config from the environment, with the data folder's signing key, made if missing. */
export function loadConfig(env: Env = process.env): PorticoConfig {
  const config = parseEnv(env, "");
  return { ...config, signingKey: ensureSigningKey(config.dataDir) };
}
