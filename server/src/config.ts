import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanPublicUrl } from "./core/settings";
import type { BucketConfig, MailConfig, PorticoConfig } from "./core/types";

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join("\n- ")}`);
    this.name = "ConfigError";
  }
}

/** Not 8787 (Claude Code's fakechat channel demo) or 8788 (the Channels webhook example). */
export const DEFAULT_PORT = 8790;
export const DEFAULT_DATA_DIR = "./data";
const DB_FILE = "portico.db";
const SIGNING_KEY_FILE = "signing.key";

type Env = Record<string, string | undefined>;

/** Settings from before Portico had one data folder, and what replaces each. */
const RETIRED: Record<string, string> = {
  PORTICO_DB_PATH: "PORTICO_DB_PATH is no longer read. Set PORTICO_DATA_DIR to the data folder: the database is portico.db inside it.",
  PORTICO_HOSTED_DOMAIN:
    "PORTICO_HOSTED_DOMAIN is no longer read. Set PORTICO_PUBLIC_URL to the address people open, and PORTICO_DATA_DIR to the data folder.",
  PORTICO_HOSTED_DATA: "PORTICO_HOSTED_DATA is no longer read. Set PORTICO_DATA_DIR to the data folder.",
};

/**
 * Everything is optional: PORT, PORTICO_DATA_DIR (default ./data), PORTICO_PUBLIC_URL, PORTICO_PLUGIN_SOURCE,
 * PORTICO_WEBHOOKS_ALLOW_PRIVATE, the bucket for files, email through Resend, and PORTICO_DESCOPE_PROJECT_ID, which
 * switches sign-in from this server's own passwords to Descope. The signing key is passed in, so this stays free of
 * file access (see loadConfig).
 */
export function parseEnv(env: Env, signingKey: string): PorticoConfig {
  const problems: string[] = [];
  for (const [name, problem] of Object.entries(RETIRED)) if (env[name]?.trim()) problems.push(problem);
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
  const descopeProjectId = env.PORTICO_DESCOPE_PROJECT_ID?.trim() || null;
  if (descopeProjectId !== null && !/^[A-Za-z0-9]{8,64}$/.test(descopeProjectId)) {
    problems.push("PORTICO_DESCOPE_PROJECT_ID must be a Descope project ID: letters and digits only");
  }
  const files = bucketConfig(env, problems);
  const mail = mailConfig(env, problems, publicUrl ? `Portico <invites@mail.${new URL(publicUrl).hostname}>` : null);
  if (problems.length > 0) throw new ConfigError(problems);
  const dataDir = env.PORTICO_DATA_DIR?.trim() || DEFAULT_DATA_DIR;
  return {
    port,
    dbPath: join(dataDir, DB_FILE),
    dataDir,
    pluginSource: env.PORTICO_PLUGIN_SOURCE?.trim() || null,
    publicUrl,
    signingKey,
    webhooksAllowPrivate: env.PORTICO_WEBHOOKS_ALLOW_PRIVATE?.trim() === "1",
    files,
    mail,
    descopeProjectId,
  };
}

/**
 * Email through Resend, only when PORTICO_RESEND_API_KEY is set. PORTICO_MAIL_FROM names the sender, on a domain
 * verified with Resend; with a public URL it defaults to invites@mail.<the URL's host>. PORTICO_RESEND_WEBHOOK_SECRET is the signing
 * secret of the Resend webhook that reports bounces and complaints to /api/mail/resend.
 */
function mailConfig(env: Env, problems: string[], defaultFrom: string | null): MailConfig | null {
  const apiKey = env.PORTICO_RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  const from = env.PORTICO_MAIL_FROM?.trim() || defaultFrom;
  if (!from || !/^[^<>\r\n]*<?[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>?$/.test(from)) {
    problems.push("PORTICO_MAIL_FROM must name the sender, such as Portico <invites@mail.portico.example>");
    return null;
  }
  return { apiKey, from, webhookSecret: env.PORTICO_RESEND_WEBHOOK_SECRET?.trim() || null };
}

/**
 * The bucket for files, only when PORTICO_FILES_BUCKET names one. The endpoint, region and key fall back to the names
 * `fly storage create` and AWS set: AWS_ENDPOINT_URL_S3, AWS_REGION, AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.
 * Without a bucket, files live in the data folder.
 */
function bucketConfig(env: Env, problems: string[]): BucketConfig | null {
  const pick = (...names: string[]) => names.map((name) => env[name]?.trim()).find((value) => value) ?? null;
  const bucket = pick("PORTICO_FILES_BUCKET");
  if (!bucket) return null;
  const accessKeyId = pick("PORTICO_FILES_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID");
  const secretAccessKey = pick("PORTICO_FILES_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY");
  if (!accessKeyId || !secretAccessKey) {
    problems.push(
      `The bucket "${bucket}" needs a key: PORTICO_FILES_ACCESS_KEY_ID and PORTICO_FILES_SECRET_ACCESS_KEY (or the AWS_ names)`,
    );
    return null;
  }
  return {
    bucket,
    endpoint: pick("PORTICO_FILES_ENDPOINT", "AWS_ENDPOINT_URL_S3"),
    region: pick("PORTICO_FILES_REGION", "AWS_REGION"),
    accessKeyId,
    secretAccessKey,
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

/** The config from the environment, with the data folder and its signing key, both made if missing. */
export function loadConfig(env: Env = process.env): PorticoConfig {
  const config = parseEnv(env, "");
  return { ...config, signingKey: ensureSigningKey(config.dataDir) };
}
