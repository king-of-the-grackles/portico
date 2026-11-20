import type { Database } from "bun:sqlite";

/** One step from a schema version to the next. It runs inside a transaction; db.ts sets the version. */
export type Migration = ((db: Database) => void) & {
  /**
   * The migration rebuilds a table other tables refer to. It runs with foreign keys off, so dropping the old table
   * deletes nothing by cascade; db.ts still checks every foreign key before the migration commits.
   */
  rebuilds?: true;
};

// Both baselines are new, and nothing has shipped on them: until this version ships, a schema change edits the baseline
// in db.ts. After that, each change is a migration here, oldest first, and a shipped one is never edited.

/** Every change to the directory since its baseline (version 200): the first is version 201. */
export const DIRECTORY_MIGRATIONS: readonly Migration[] = [
  // 201: every person starts with a shared Portico (stored name "Shared", see STARTER_NAME in core/workspaces.ts).
  // People who came before that get theirs here: empty but for its owner, with no agents.
  (db) => {
    const people = db
      .query(
        `SELECT w.owner_id AS id FROM workspaces w WHERE w.kind = 'personal' AND w.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM workspaces s WHERE s.owner_id = w.owner_id AND s.kind = 'shared' AND s.name = 'Shared')`,
      )
      .all() as { id: string }[];
    const at = new Date().toISOString();
    for (const person of people) {
      const id = crypto.randomUUID();
      db.query("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ($id, 'Shared', 'shared', $ownerId, $at)").run({ id, ownerId: person.id, at });
      db.query("INSERT INTO workspace_people (workspace_id, person_id, added_at) VALUES ($id, $ownerId, $at)").run({ id, ownerId: person.id, at });
    }
  },
  // 202: a share link remembers whether its maker chose, when making it, to allow messages from the agents of the
  // person the link lets in. Links made before never did.
  (db) => {
    db.run("ALTER TABLE shares ADD COLUMN allow_back INTEGER NOT NULL DEFAULT 0");
  },
];

/**
 * Every change to a workspace's content database since its baseline (version 1): the first is version 2. Each content
 * database is upgraded when it is next opened, so a feature that lives in a workspace arrives as one migration here.
 */
export const CONTENT_MIGRATIONS: readonly Migration[] = [];
