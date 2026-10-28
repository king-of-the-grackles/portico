import type { Database } from "bun:sqlite";

/** One step from a schema version to the next. It runs inside a transaction; db.ts sets the version. */
export type Migration = (db: Database) => void;

/** Every change since the first schema (version 100), oldest first: the first is version 101. Never edit a shipped one. */
export const MIGRATIONS: readonly Migration[] = [];
