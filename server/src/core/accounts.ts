import type { Database } from "bun:sqlite";
import { LIMITS } from "./limits";
import { DAY_MS } from "./limits";
import type { People } from "./people";
import { hashSecret, newToken } from "./tokens";
import type { Person } from "./types";

/** Passwords are stored only as argon2id hashes. */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash).catch(() => false);
}

/** The browser sign-in cookie. */
export const SESSION_COOKIE = "portico_session";

/** A web session's last_used_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

interface WebSessionRow {
  id: string;
  person_id: string;
  expires_at: string;
  last_used_at: string;
}

export interface AccountsDeps {
  db: Database;
  people: People;
  now?: () => Date;
  newId?: () => string;
}

/**
 * Sign-in for people: browser sessions stored by token hash, so signing out or removing a person ends them at once.
 * The Accounts track adds setup links, the sign-in limiter and passkeys here.
 */
export class Accounts {
  private readonly db: Database;
  private readonly people: People;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(deps: AccountsDeps) {
    this.db = deps.db;
    this.people = deps.people;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
  }

  /** A new browser session for the person. The token goes in the cookie and is stored only as a hash. */
  startSession(personId: string): { token: string; expiresAt: string } {
    const token = newToken("pw_");
    const at = this.now();
    const expiresAt = new Date(at.getTime() + LIMITS.webSessionDays * DAY_MS).toISOString();
    this.db
      .query(
        `INSERT INTO web_sessions (id, token_hash, person_id, created_at, expires_at, last_used_at)
         VALUES ($id, $hash, $personId, $at, $expiresAt, $at)`,
      )
      .run({ id: this.newId(), hash: hashSecret(token), personId, at: at.toISOString(), expiresAt });
    return { token, expiresAt };
  }

  /** The person signed in with this cookie token, or null when it's unknown or expired. */
  personForSession(token: string | undefined): Person | null {
    if (!token) return null;
    const row = this.db
      .query("SELECT id, person_id, expires_at, last_used_at FROM web_sessions WHERE token_hash = $hash")
      .get({ hash: hashSecret(token) }) as WebSessionRow | null;
    const now = this.now();
    if (!row || Date.parse(row.expires_at) <= now.getTime()) return null;
    if (now.getTime() - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) {
      this.db.query("UPDATE web_sessions SET last_used_at = $at WHERE id = $id").run({ id: row.id, at: now.toISOString() });
    }
    return this.people.get(row.person_id);
  }

  endSession(token: string | undefined): void {
    if (!token) return;
    this.db.query("DELETE FROM web_sessions WHERE token_hash = $hash").run({ hash: hashSecret(token) });
  }

  /** Signs the person out everywhere, except the session with `keepToken`. */
  endSessionsFor(personId: string, keepToken?: string): void {
    this.db
      .query("DELETE FROM web_sessions WHERE person_id = $personId AND token_hash != $keep")
      .run({ personId, keep: keepToken ? hashSecret(keepToken) : "" });
  }

  /** Deletes expired browser sessions. The Accounts track adds expired setup links here. */
  sweep(): number {
    return this.db.query("DELETE FROM web_sessions WHERE expires_at <= $now").run({ now: this.now().toISOString() }).changes;
  }
}
