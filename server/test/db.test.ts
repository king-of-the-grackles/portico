import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupProblem } from "../src/commands/serve";
import { BASE_VERSION, openDb, prepare, SCHEMA_VERSION, SchemaMismatchError } from "../src/db";
import type { Migration } from "../src/migrations";

const versionOf = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "portico-db-")), name);
}

/** A database file at the first schema (version 100), with a person in it. */
function baseFile(): string {
  const path = tempPath("portico.db");
  const db = new Database(path, { create: true, strict: true });
  prepare(db, { migrations: [] });
  db.run(
    `INSERT INTO people (id, name, role, status, password_hash, created_at)
     VALUES ('p1', 'Maya', 'owner', 'active', 'h', '2026-10-01T00:00:00.000Z')`,
  );
  db.close();
  return path;
}

const addNotes: Migration = (db) => db.run("CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
const addColour: Migration = (db) => db.run("ALTER TABLE people ADD COLUMN colour TEXT");

describe("database", () => {
  test("a new database gets the whole schema at the current version", () => {
    const db = openDb(":memory:");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables).toContain("messages");
    expect(tables).toContain("always_allow");
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
  });

  test("a new database runs every migration after the first schema", () => {
    const db = new Database(":memory:", { strict: true });
    prepare(db, { migrations: [addNotes, addColour] });
    expect(versionOf(db)).toBe(BASE_VERSION + 2);
    db.run("INSERT INTO notes (id, text) VALUES ('n1', 'hi')");
    db.run(
      `INSERT INTO people (id, name, role, status, password_hash, created_at, colour)
       VALUES ('p1', 'Maya', 'owner', 'active', 'h', 't', 'teal')`,
    );
  });

  test("an older database is copied, then upgraded in place, keeping its rows", () => {
    const path = baseFile();
    const logged: string[] = [];
    const db = new Database(path, { strict: true });
    prepare(db, {
      path,
      migrations: [addNotes, addColour],
      now: () => new Date("2026-10-28T12:00:00.000Z"),
      log: (msg) => logged.push(msg),
    });
    expect(versionOf(db)).toBe(BASE_VERSION + 2);
    expect((db.query("SELECT name FROM people").get() as { name: string }).name).toBe("Maya");
    db.close();
    expect(logged).toEqual(["db_backed_up", "db_migrated", "db_migrated"]);

    const backups = readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"));
    expect(backups).toEqual(["portico.db.v100-2026-10-28T12-00-00-000Z.bak"]);
    const backup = new Database(join(path, "..", backups[0]!), { readonly: true });
    expect(versionOf(backup)).toBe(BASE_VERSION);
    expect((backup.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(1);
    backup.close();
  });

  test("a failed migration rolls back and leaves the last version that worked", () => {
    const path = baseFile();
    const failing: Migration = (db) => {
      db.run("CREATE TABLE half_done (id TEXT)");
      throw new Error("boom");
    };
    const db = new Database(path, { strict: true });
    expect(() => prepare(db, { path, migrations: [addNotes, failing] })).toThrow("boom");
    expect(versionOf(db)).toBe(BASE_VERSION + 1);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables).toContain("notes");
    expect(tables).not.toContain("half_done");
    db.close();
  });

  test("a migration that breaks a foreign key is rolled back", () => {
    const db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON");
    prepare(db, { migrations: [] });
    const orphan: Migration = (d) => {
      d.run("PRAGMA defer_foreign_keys = ON");
      d.run(
        `INSERT INTO web_sessions (id, token_hash, person_id, created_at, expires_at, last_used_at)
         VALUES ('w1', 'h', 'nobody', 't', 't', 't')`,
      );
    };
    expect(() => prepare(db, { migrations: [orphan] })).toThrow();
    expect(versionOf(db)).toBe(BASE_VERSION);
    expect((db.query("SELECT COUNT(*) AS n FROM web_sessions").get() as { n: number }).n).toBe(0);
  });

  test("a foreign key already broken before the upgrade doesn't block it", () => {
    const db = new Database(":memory:", { strict: true });
    prepare(db, { migrations: [] });
    db.run(
      `INSERT INTO web_sessions (id, token_hash, person_id, created_at, expires_at, last_used_at)
       VALUES ('w1', 'h', 'nobody', 't', 't', 't')`,
    );
    prepare(db, { migrations: [addNotes] });
    expect(versionOf(db)).toBe(BASE_VERSION + 1);
  });

  test("a database from a Portico before the open network is refused, not changed", () => {
    const path = tempPath("old.db");
    const old = new Database(path);
    old.run("CREATE TABLE tasks (id TEXT)");
    old.run("PRAGMA user_version = 2");
    old.close();
    expect(() => openDb(path)).toThrow(SchemaMismatchError);
    const again = new Database(path);
    expect(versionOf(again)).toBe(2);
    again.close();
  });

  test("a database from a newer Portico is refused, not changed, with its own explanation", () => {
    const path = baseFile();
    const newer = new Database(path);
    newer.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    newer.close();
    let error: unknown;
    try {
      openDb(path);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SchemaMismatchError);
    expect(startupProblem(error, { port: 3000, dbPath: path })).toContain("newer Portico version");
    const again = new Database(path);
    expect(versionOf(again)).toBe(SCHEMA_VERSION + 1);
    again.close();
    expect(readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"))).toEqual([]);
  });

  test("removing a person removes what depends on them", () => {
    const db = openDb(":memory:");
    db.run(
      `INSERT INTO people (id, name, role, status, password_hash, created_at)
       VALUES ('p1', 'Maya', 'member', 'active', 'h', 't')`,
    );
    db.run("INSERT INTO computers (id, owner_id, name, token_hash, created_at) VALUES ('c1', 'p1', 'linux', 'th', 't')");
    db.run(
      `INSERT INTO agents (id, owner_id, name, kind, type, description, computer_id, created_at)
       VALUES ('a1', 'p1', 'x', 'codex', 'session', '', 'c1', 't')`,
    );
    db.run("DELETE FROM people WHERE id = 'p1'");
    expect((db.query("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
  });
});
