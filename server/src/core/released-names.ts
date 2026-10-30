import type { Database } from "bun:sqlite";
import { DAY_MS, LIMITS } from "./limits";

/** An agent's bare name (an app's, a connector's or a session's short name), or a computer's name. */
export interface ReleasedName {
  scope: "agent" | "computer";
  name: string;
}

/**
 * Records names the person let go: an agent removed or renamed, a computer removed (with its sessions' names), or all
 * of them when the person is removed. For the history window, a released name stays with that person: another person's
 * agent or computer can't take it, so a name that reached one person's agent can't start reaching another person's.
 * Every release goes through here.
 */
export function releaseNames(db: Database, ownerId: string, names: readonly ReleasedName[], at: Date): void {
  const insert = db.query(
    `INSERT INTO released_names (scope, name, owner_id, released_at) VALUES ($scope, $name, $ownerId, $at)
     ON CONFLICT (scope, name, owner_id) DO UPDATE SET released_at = $at`,
  );
  for (const { scope, name } of names) insert.run({ scope, name, ownerId, at: at.toISOString() });
}

/** Whether a person other than this one let the name go within the history window. */
export function releasedByOther(db: Database, scope: ReleasedName["scope"], name: string, ownerId: string, now: Date): boolean {
  const since = new Date(now.getTime() - LIMITS.historyDays * DAY_MS).toISOString();
  return (
    db
      .query(
        `SELECT 1 FROM released_names
         WHERE scope = $scope AND name = $name AND owner_id != $ownerId AND released_at > $since LIMIT 1`,
      )
      .get({ scope, name, ownerId, since }) !== null
  );
}

/** Every agent and computer name the person has, released together when the person is removed. */
export function namesOwnedBy(db: Database, ownerId: string): ReleasedName[] {
  return db
    .query(
      `SELECT 'agent' AS scope, name FROM agents WHERE owner_id = $ownerId
       UNION SELECT 'computer' AS scope, name FROM computers WHERE owner_id = $ownerId`,
    )
    .all({ ownerId }) as ReleasedName[];
}
