import type { Database } from "bun:sqlite";
import type { PorticoConfig } from "./types";

type Key = "public_url" | "setup_done_at" | "analytics_opt_out" | "first_message_sent_backfilled" | ReturnType<typeof firstMessageKey>;

/**
 * The key under which it is kept that a person has sent a message before: the time it was noted. Analytics counts a
 * person's first message once, and messages are pruned after a while, so what is stored of them can't say this for
 * good.
 */
export function firstMessageKey(personId: string): `first_message_sent:${string}` {
  return `first_message_sent:${personId}`;
}

/**
 * Portico-wide values kept in the database: the public URL confirmed at setup, when setup was done, the people whose
 * browser said to leave them out of analytics (a JSON list of person IDs), and for analytics, per person, that a first
 * message was sent.
 */
export class Settings {
  constructor(
    private readonly db: Database,
    private readonly config: Pick<PorticoConfig, "publicUrl" | "port">,
  ) {}

  get(key: Key): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = $key").get({ key }) as { value: string } | null;
    return row?.value ?? null;
  }

  set(key: Key, value: string): void {
    this.db
      .query("INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = $value")
      .run({ key, value });
  }

  /** Sets a value only where there is none yet. */
  setOnce(key: Key, value: string): void {
    this.db.query("INSERT INTO settings (key, value) VALUES ($key, $value) ON CONFLICT (key) DO NOTHING").run({ key, value });
  }

  /** The one address Portico answers at: PORTICO_PUBLIC_URL when set, else the address confirmed at setup, else this computer's own. */
  publicUrl(): string {
    return this.config.publicUrl ?? this.get("public_url") ?? `http://localhost:${this.config.port}`;
  }

  /** The public URL someone set or confirmed: PORTICO_PUBLIC_URL, else the address confirmed at setup. Null before either. */
  knownPublicUrl(): string | null {
    return this.config.publicUrl ?? this.get("public_url");
  }

  /** Until setup is done, Portico and joining stay closed. */
  setupDone(): boolean {
    return this.get("setup_done_at") !== null;
  }
}

/** Whether a host name is this computer: localhost, a name under it (acme.localhost), or 127.0.0.1. */
function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1";
}

/** Whether a URL points at this computer. */
export function isLocalUrl(url: string): boolean {
  try {
    return isLocalHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** A public URL as given, checked: https, or http only for localhost and 127.0.0.1. Null when unusable. */
export function cleanPublicUrl(raw: string): string | null {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const local = isLocalHost(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}
