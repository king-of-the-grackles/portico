import type { Database } from "bun:sqlite";
import { EventSubscriptions } from "./events";
import type { AgentNotices } from "./notices";
import { INVITE_SEAL, People } from "./people";
import { Secrets, type SecretPlace } from "./secrets";
import { SHARE_SEAL, Shares } from "./shares";
import { sessionKeyHash, unseal } from "./tokens";
import { WakeUrls } from "./wake-urls";

/** At start: session keys an earlier Portico stored as they were become hashes. A raw key never holds a colon. */
export function hashStoredSessionKeys(db: Database): number {
  const rows = db.query("SELECT id, session_key FROM agent_runs WHERE session_key NOT LIKE 'h:%'").all() as { id: string; session_key: string }[];
  const update = db.query("UPDATE agent_runs SET session_key = $hash WHERE id = $id AND session_key = $was");
  db.transaction(() => {
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
    return await secrets.seal(place, opened.value);
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
  }
  return counts;
}
