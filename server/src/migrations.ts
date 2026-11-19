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
export const DIRECTORY_MIGRATIONS: readonly Migration[] = [];

/**
 * Every change to a workspace's content database since its baseline (version 1): the first is version 2. Each content
 * database is upgraded when it is next opened, so a feature that lives in a workspace arrives as one migration here.
 */
export const CONTENT_MIGRATIONS: readonly Migration[] = [];
