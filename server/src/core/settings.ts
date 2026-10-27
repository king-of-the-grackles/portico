import type { Database } from "bun:sqlite";
import type { PorticoConfig } from "./types";

type Key = "public_url" | "setup_done_at";

/** Portico-wide values kept in the database: the public URL confirmed at setup, and when setup was done. */
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

  /** PORTICO_PUBLIC_URL when set, else the address confirmed at setup, else this computer's own address. */
  publicUrl(): string {
    return this.config.publicUrl ?? this.get("public_url") ?? `http://localhost:${this.config.port}`;
  }

  /** Until setup is done, Portico and joining stay closed. */
  setupDone(): boolean {
    return this.get("setup_done_at") !== null;
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
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}
