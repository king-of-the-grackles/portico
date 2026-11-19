import type { Database } from "bun:sqlite";
import { EventSubscriptions } from "./events";
import type { AgentNotices } from "./notices";
import { INVITE_SEAL, People } from "./people";
import { Secrets, type SecretPlace } from "./secrets";
import { SHARE_SEAL, Shares } from "./shares";
import { sessionKeyHash, unseal } from "./tokens";
import { WakeUrls } from "./wake-urls";

type Log = (msg: string, fields: Record<string, unknown>) => void;

const SCRUB_PENDING = "scrub_pending";
/** Set once a database has been rewritten. */
const SCRUBBED = "scrubbed_at";

/**
 * A start's pass replaced values an earlier Portico stored readable (plain, or sealed with the data folder's own key).
 * Replacing a value leaves its old bytes in the file: in the free space of its page, and in the write-ahead log. So
 * the pass leaves a note in the database first, and the file is rewritten once the passes are done. The note outlives
 * a stop in between, and a rewrite that failed: the next start tries again.
 */
export function scrubNeeded(db: Database): void {
  db.query("INSERT INTO settings (key, value) VALUES ($key, '1') ON CONFLICT (key) DO NOTHING").run({ key: SCRUB_PENDING });
}

/**
 * Rewrites every page of the database when a pass asked for that: VACUUM builds the file again from its rows alone, and
 * the checkpoint moves the result into the main file and empties the write-ahead log, so nothing of the old pages is
 * left in either. Also once for any database with no mark that it was ever rewritten: a pass of a Portico before this
 * one may have replaced values there and left their bytes behind. Returns whether the file was rewritten. Never throws.
 */
export function scrubIfNeeded(db: Database, log: Log): boolean {
  try {
    const has = (key: string) => db.query("SELECT 1 FROM settings WHERE key = $key").get({ key }) !== null;
    const pending = has(SCRUB_PENDING);
    const first = !pending && !has(SCRUBBED);
    if (!pending && !first) return false;
    const done = () =>
      db.query("INSERT INTO settings (key, value) VALUES ($key, $at) ON CONFLICT (key) DO UPDATE SET value = $at").run({ key: SCRUBBED, at: new Date().toISOString() });
    // Zeroing freed bytes is per connection: make sure of it here, whoever opened the database.
    db.run("PRAGMA secure_delete = ON");
    db.query("DELETE FROM settings WHERE key = $key").run({ key: SCRUB_PENDING });
    // The mark first, so the rewritten file holds it and the write-ahead log ends empty.
    done();
    db.run("VACUUM");
    db.run("PRAGMA wal_checkpoint(TRUNCATE)");
    log("database_scrubbed", { reason: pending ? "stored_secrets_replaced" : "first_start_with_scrubbing" });
    return true;
  } catch (err) {
    try {
      scrubNeeded(db);
      db.query("DELETE FROM settings WHERE key = $key").run({ key: SCRUBBED });
    } catch {
      // The database can't be written at all: the next start's pass finds nothing to do, and this is in the log.
    }
    log("database_scrub_failed", { error: err instanceof Error ? err.name : typeof err });
    return false;
  }
}

/** At start: session keys an earlier Portico stored as they were become hashes. A raw key never holds a colon. */
export function hashStoredSessionKeys(db: Database): number {
  const rows = db.query("SELECT id, session_key FROM agent_runs WHERE session_key NOT LIKE 'h:%'").all() as { id: string; session_key: string }[];
  if (rows.length === 0) return 0;
  const update = db.query("UPDATE agent_runs SET session_key = $hash WHERE id = $id AND session_key = $was");
  db.transaction(() => {
    scrubNeeded(db);
    for (const row of rows) update.run({ id: row.id, was: row.session_key, hash: sessionKeyHash(row.session_key) });
  })();
  return rows.length;
}

/**
 * At start, before anything reads one: every invite's and share link's stored secret is brought under the current
 * secrets key. One an earlier Portico sealed with the data folder's signing key, and one under the previous secrets
 * key, is encrypted again under the current one. One that can't be read stays as it is, in case the key for it comes
 * back: until then the link still works for whoever holds it, and Portico's pages say that the link can't be shown
 * again. Never throws.
 */
export function encryptStoredLinkSecrets(deps: { db: Database; secrets: Secrets; signingKey: string; log: (msg: string, fields: Record<string, unknown>) => void }): {
  encrypted: number;
  rekeyed: number;
  unreadable: number;
} {
  const { db, secrets } = deps;
  const counts = { encrypted: 0, rekeyed: 0, unreadable: 0 };
  const pass = (table: "invites" | "shares", purpose: string, place: (id: string) => SecretPlace) => {
    const rows = db.query(`SELECT id, secret_box FROM ${table} WHERE secret_box IS NOT NULL`).all() as { id: string; secret_box: string }[];
    const update = db.query(`UPDATE ${table} SET secret_box = $next WHERE id = $id`);
    for (const row of rows) {
      let value: string | null;
      if (Secrets.sealed(row.secret_box)) {
        const opened = secrets.openSync(place(row.id), row.secret_box);
        if (opened.ok && opened.current) continue;
        value = opened.ok ? opened.value : null;
        if (value !== null) counts.rekeyed++;
      } else {
        value = unseal(deps.signingKey, purpose, row.secret_box);
        if (value !== null) counts.encrypted++;
      }
      if (value === null) {
        counts.unreadable++;
        deps.log("link_secret_unreadable", { table, id: row.id });
        continue;
      }
      scrubNeeded(db);
      update.run({ id: row.id, next: secrets.sealSync(place(row.id), value) });
    }
  };
  try {
    db.transaction(() => {
      pass("invites", INVITE_SEAL, People.invitePlace);
      pass("shares", SHARE_SEAL, Shares.place);
    })();
    if (counts.encrypted + counts.rekeyed + counts.unreadable > 0) deps.log("stored_link_secrets_checked", { key_id: secrets.keyId, ...counts });
  } catch (err) {
    deps.log("stored_link_secrets_failed", { error: err instanceof Error ? err.name : typeof err });
  }
  return counts;
}

/** What the agent is told, once, when Portico can't read what the agent gave it any more. Portico's own words. */
export const WAKE_KEY_LOST =
  "Portico can no longer read the key of this agent's wake URL, so no wake goes out. Register the wake URL again with set_wake_url (or PUT /api/agent/wake), with the trigger's address and key.";
export const EVENT_SECRET_LOST =
  "Portico can no longer read the secret of one of this agent's event subscriptions, so no events go out for that subscription. Subscribe to message.received again with events/subscribe, with the callback address and a secret.";

export interface StoredSecretsDeps {
  db: Database;
  secrets: Secrets;
  wakeUrls: WakeUrls;
  events: EventSubscriptions;
  notices: AgentNotices;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

/**
 * At start, every wake URL key and event secret is brought under the current secrets key: one still in plain text (an
 * earlier Portico's) is encrypted where it is, and one under the previous key (PORTICO_SECRETS_KEY_OLD) is encrypted
 * again under the new one. One that can't be read (a key Portico wasn't given, or a value that isn't what Portico
 * stored there) stays, marked: nothing is sent with it, the log says so, and the agent is told once to register
 * again. Each row is rewritten only if it still holds what was read, so a wake URL set meanwhile is never undone.
 * Never throws: a start goes on whatever a row holds.
 */
export async function encryptStoredSecrets(deps: StoredSecretsDeps): Promise<{ encrypted: number; rekeyed: number; unreadable: number }> {
  const { db, secrets } = deps;
  const counts = { encrypted: 0, rekeyed: 0, unreadable: 0 };
  /** Null: already under the current key. A string: what to store instead. False: can't be read. */
  const renew = async (place: SecretPlace, stored: string): Promise<string | null | false> => {
    const opened = await secrets.open(place, stored);
    if (!opened.ok) return false;
    if (opened.current) return null;
    if (Secrets.sealed(stored)) counts.rekeyed++;
    else counts.encrypted++;
    const next = await secrets.seal(place, opened.value);
    // Before the row changes, so a stop right after still ends in a rewritten file.
    scrubNeeded(db);
    return next;
  };
  try {
    const wakes = db.query("SELECT agent_id, key FROM wake_urls").all() as { agent_id: string; key: string }[];
    for (const row of wakes) {
      const next = await renew(WakeUrls.place(row.agent_id), row.key);
      if (next === false) {
        counts.unreadable++;
        if (deps.wakeUrls.unreadable(row.agent_id, "at_start")) deps.notices.add(row.agent_id, WAKE_KEY_LOST);
      } else if (next !== null) {
        db.query("UPDATE wake_urls SET key = $next WHERE agent_id = $agentId AND key = $was").run({ agentId: row.agent_id, was: row.key, next });
      }
    }
    const subs = db.query("SELECT id, agent_id, secret, previous_secret FROM event_subscriptions").all() as {
      id: string;
      agent_id: string;
      secret: string;
      previous_secret: string | null;
    }[];
    for (const row of subs) {
      const next = await renew(EventSubscriptions.place(row.id), row.secret);
      if (next === false) {
        counts.unreadable++;
        if (deps.events.unreadable(row.id, "at_start")) deps.notices.add(row.agent_id, EVENT_SECRET_LOST);
      } else if (next !== null) {
        db.query("UPDATE event_subscriptions SET secret = $next WHERE id = $id AND secret = $was").run({ id: row.id, was: row.secret, next });
      }
      if (row.previous_secret === null) continue;
      // The secret before a rotation signs alongside for ten minutes: one that can't be read is dropped.
      const before = await renew(EventSubscriptions.place(row.id, "previous_secret"), row.previous_secret);
      if (before !== null) {
        db.query("UPDATE event_subscriptions SET previous_secret = $next, previous_until = CASE WHEN $next IS NULL THEN NULL ELSE previous_until END WHERE id = $id AND previous_secret = $was")
          .run({ id: row.id, was: row.previous_secret, next: before === false ? null : before });
      }
    }
    if (counts.encrypted + counts.rekeyed + counts.unreadable > 0) deps.log("stored_secrets_checked", { key_id: secrets.keyId, ...counts });
  } catch (err) {
    deps.log("stored_secrets_failed", { error: err instanceof Error ? err.name : typeof err });
  } finally {
    // From here on a value that isn't encrypted is no value: nothing new is ever written that way.
    secrets.plainEnded();
    // Last, once every pass of this start is done: what the passes replaced must not stay readable in the file.
    scrubIfNeeded(db, deps.log);
  }
  return counts;
}
