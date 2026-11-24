import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupProblem } from "../src/commands/serve";
import { CONTENT, CONTENT_VERSION, DIRECTORY, FRESH_FOLDER, openContentDb, openDb, prepare, SCHEMA_VERSION, SchemaMismatchError } from "../src/db";
import { CONTENT_MIGRATIONS, DIRECTORY_MIGRATIONS, type Migration } from "../src/migrations";

const BASE_VERSION = DIRECTORY.baseVersion;
const versionOf = (db: Database) => (db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
const kindOf = (db: Database) => (db.query("PRAGMA application_id").get() as { application_id: number }).application_id;
const tablesOf = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((row) => row.name);

function tempPath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "portico-db-")), name);
}

/** A directory file at the baseline, with a person in it. */
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

/** What an earlier Portico left: tables, a schema version, and no application ID. */
function oldFile(version: number): string {
  const path = tempPath("portico.db");
  const old = new Database(path);
  old.run("CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT)");
  old.run("CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT, text TEXT)");
  old.run("INSERT INTO messages (id, subject, text) VALUES ('m1', 'Hello', 'An old message')");
  old.run(`PRAGMA user_version = ${version}`);
  old.close();
  return path;
}

const addNotes: Migration = (db) => db.run("CREATE TABLE notes (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
const addColour: Migration = (db) => db.run("ALTER TABLE people ADD COLUMN colour TEXT");

describe("the two kinds of database", () => {
  test("a new directory holds who is on Portico, at the current version, and no table for message content", () => {
    const db = openDb(":memory:");
    const tables = tablesOf(db);
    for (const table of ["people", "agents", "workspaces", "workspace_agents", "always_allow", "activity", "uploads", "consent_requests", "mails"]) {
      expect(tables).toContain(table);
    }
    for (const table of ["threads", "messages", "message_files", "files", "released_names"]) expect(tables).not.toContain(table);
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
    expect(kindOf(db)).toBe(DIRECTORY.applicationId);
    // Five migrations since the baseline: the shared Portico every person starts with, a share link's allow choice,
    // the minutes between an app agent's scheduled inbox checks, feedback, and the questions agents ask their people.
    expect(DIRECTORY_MIGRATIONS).toHaveLength(5);
    expect(SCHEMA_VERSION).toBe(205);
    expect(tables).toContain("questions");
  });

  test("a new content database holds threads, messages and files, at its own version, and nothing of the directory", () => {
    const db = openContentDb(":memory:");
    expect(tablesOf(db)).toEqual(["files", "message_files", "messages", "threads"]);
    expect(versionOf(db)).toBe(CONTENT_VERSION);
    expect(kindOf(db)).toBe(CONTENT.applicationId);
    expect(CONTENT_MIGRATIONS).toEqual([]);
    // No foreign key leaves the database: agent IDs are plain text.
    const foreign = tablesOf(db).flatMap((table) => db.query(`PRAGMA foreign_key_list(${table})`).all() as { table: string }[]);
    expect([...new Set(foreign.map((key) => key.table))].sort()).toEqual(["files", "messages", "threads"]);
  });

  test("a workspace and its membership carry where the content is, when it was deleted, and who left", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ('p1', 'Maya', 'member', 'active', 'h', 't')");
    db.run("INSERT INTO agents (id, owner_id, name, kind, type, description, created_at) VALUES ('a1', 'p1', 'x', 'muse', 'app', '', 't')");
    db.run("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ('w1', 'Launch', 'shared', 'p1', 't')");
    db.run("INSERT INTO workspace_agents (workspace_id, agent_id, added_at) VALUES ('w1', 'a1', 't')");
    expect(db.query("SELECT location, archived_at FROM workspaces").get()).toEqual({ location: "local", archived_at: null });
    expect(db.query("SELECT left_at FROM workspace_agents").get()).toEqual({ left_at: null });
  });

  test("one kind is never opened as the other", () => {
    const directory = tempPath("portico.db");
    openDb(directory).close();
    const content = tempPath("content.db");
    openContentDb(content).close();
    for (const open of [() => openContentDb(directory), () => openDb(content)]) {
      let error: unknown;
      try {
        open();
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SchemaMismatchError);
      expect((error as SchemaMismatchError).reason).toBe("wrong_kind");
    }
    expect(startupProblem(new SchemaMismatchError(1, "wrong_kind"), { port: 3000, dbPath: content })).toContain("another kind");
    // Neither file was changed by the refusal.
    const again = new Database(content);
    expect([versionOf(again), kindOf(again)]).toEqual([CONTENT_VERSION, CONTENT.applicationId]);
    again.close();
  });
});

describe("a database from an earlier Portico", () => {
  test("every old version is refused with the fresh-folder message, and the file is left as it was", () => {
    // 2: before the open network. 100 to 110: the one database that held everything. 150: a version nothing ever made.
    for (const version of [1, 2, 100, 105, 110, 150]) {
      const path = oldFile(version);
      let error: unknown;
      try {
        openDb(path);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(SchemaMismatchError);
      expect((error as SchemaMismatchError).reason).toBe("older");
      expect((error as Error).message).toBe(FRESH_FOLDER);
      const problem = startupProblem(error, { port: 3000, dbPath: path })!;
      expect(problem).toContain("made by an earlier Portico that this version can't open");
      expect(problem).toContain("Start with a fresh data folder");
      expect(problem).toContain("PORTICO_DATA_DIR");
      expect(problem).toContain(path);
      const again = new Database(path);
      expect(versionOf(again)).toBe(version);
      expect(tablesOf(again)).toEqual(["messages", "people"]);
      expect(again.query("SELECT text FROM messages").get()).toEqual({ text: "An old message" });
      again.close();
      expect(readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"))).toEqual([]);
    }
  });

  test("a file with tables and no version at all is refused too", () => {
    const path = tempPath("portico.db");
    const other = new Database(path);
    other.run("CREATE TABLE tasks (id TEXT)");
    other.close();
    expect(() => openDb(path)).toThrow(FRESH_FOLDER);
  });

  test("an old database carrying the current version number is still refused: it has no application ID", () => {
    const path = oldFile(SCHEMA_VERSION);
    expect(() => openDb(path)).toThrow(FRESH_FOLDER);
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
    // Restoring the copy brings back removed access, so the message says to remove it again.
    expect(startupProblem(error, { port: 3000, dbPath: path })).toContain("brings back everything removed since the upgrade");
    const again = new Database(path);
    expect(versionOf(again)).toBe(SCHEMA_VERSION + 1);
    again.close();
    expect(readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"))).toEqual([]);
  });
});

describe("migrations, for both kinds", () => {
  test("a new database runs every migration after the baseline", () => {
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
    expect(backups).toEqual([`portico.db.v${BASE_VERSION}-2026-10-28T12-00-00-000Z.bak`]);
    const backup = new Database(join(path, "..", backups[0]!), { readonly: true });
    expect(versionOf(backup)).toBe(BASE_VERSION);
    expect((backup.query("SELECT COUNT(*) AS n FROM people").get() as { n: number }).n).toBe(1);
    backup.close();
  });

  test("a content database has its own list: a feature in a workspace arrives as one migration, per database", () => {
    const path = tempPath("content.db");
    const first = openContentDb(path);
    first.run("INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at) VALUES ('t1', 'a', 'b', 'a', 't', 't')");
    first.close();
    const addBoard: Migration = (db) => db.run("CREATE TABLE board_posts (id TEXT PRIMARY KEY, text TEXT NOT NULL)");
    const db = new Database(path, { strict: true });
    prepare(db, { kind: CONTENT, path, migrations: [addBoard] });
    expect(versionOf(db)).toBe(CONTENT.baseVersion + 1);
    expect(tablesOf(db)).toContain("board_posts");
    expect(db.query("SELECT id FROM threads").get()).toEqual({ id: "t1" });
    db.close();
    // The copy made before the upgrade sits beside the content database, in the workspace's own folder.
    expect(readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"))).toHaveLength(1);
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
    expect(tablesOf(db)).toContain("notes");
    expect(tablesOf(db)).not.toContain("half_done");
    db.close();
  });

  test("people who came before the shared Portico every person starts with get theirs, once", () => {
    const db = new Database(":memory:", { strict: true });
    db.run("PRAGMA foreign_keys = ON");
    prepare(db, { migrations: [] });
    const at = "2026-10-27T12:00:00.000Z";
    for (const id of ["p1", "p2"]) {
      db.query("INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ($id, $id, 'member', 'active', '', $at)").run({ id, at });
      db.query("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ($w, 'Personal', 'personal', $id, $at)").run({ w: `own-${id}`, id, at });
    }
    db.query("INSERT INTO workspaces (id, name, kind, owner_id, created_at) VALUES ('s2', 'Shared', 'shared', 'p2', $at)").run({ at });
    prepare(db);
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
    const starters = db.query("SELECT w.owner_id AS owner, (SELECT count(*) FROM workspace_people p WHERE p.workspace_id = w.id) AS people FROM workspaces w WHERE w.name = 'Shared' ORDER BY owner").all();
    expect(starters).toEqual([{ owner: "p1", people: 1 }, { owner: "p2", people: 0 }]);
  });

  test("a directory at version 204 opens at 205 with its data intact, and gains the questions table and nothing else", () => {
    const path = tempPath("portico.db");
    const before = new Database(path, { strict: true });
    before.run("PRAGMA foreign_keys = ON");
    prepare(before, { migrations: DIRECTORY_MIGRATIONS.slice(0, 4) });
    expect(versionOf(before)).toBe(204);
    const at = "2026-10-27T12:00:00.000Z";
    before.query("INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ('p1', 'Maya', 'owner', 'active', 'h', $at)").run({ at });
    before.query("INSERT INTO agents (id, owner_id, name, kind, type, description, created_at) VALUES ('a1', 'p1', 'muse', 'muse', 'app', '', $at)").run({ at });
    before.query("INSERT INTO agent_notices (id, agent_id, at, text) VALUES ('n1', 'a1', $at, 'hello')").run({ at });
    before
      .query("INSERT INTO feedback (id, kind, title, details, agent_id, agent_name, person_id, created_at) VALUES ('f1', 'idea', 't', 'd', 'a1', 'muse', 'p1', $at)")
      .run({ at });
    const schemaBefore = before.query("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    const rowsBefore = Object.fromEntries(["people", "agents", "agent_notices", "feedback", "workspaces"].map((table) => [table, before.query(`SELECT * FROM ${table} ORDER BY 1`).all()]));
    before.close();

    const db = openDb(path);
    expect(versionOf(db)).toBe(205);
    expect(SCHEMA_VERSION).toBe(205);
    // Every row that was there is still there, unchanged.
    for (const [table, rows] of Object.entries(rowsBefore)) expect(db.query(`SELECT * FROM ${table} ORDER BY 1`).all()).toEqual(rows);
    // Every table and index that was there has the same definition: the migration only adds.
    const schemaAfter = db.query("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string; sql: string }[];
    expect(schemaAfter.filter((item) => !item.name.startsWith("questions"))).toEqual(schemaBefore);
    expect(schemaAfter.filter((item) => item.name.startsWith("questions")).map((item) => item.name)).toEqual([
      "questions",
      "questions_agent",
      "questions_person",
      "questions_status_expires",
      "questions_task",
    ]);
    // The new table takes a question, both answer paths, and no other; no foreign key leaves it.
    const insert = (id: string, via: string | null) =>
      db
        .query("INSERT INTO questions (id, agent_id, person_id, question, status, answered_via, created_at, expires_at) VALUES ($id, 'gone-agent', 'gone-person', 'q', 'answered', $via, $at, $at)")
        .run({ id, via, at });
    insert("q1", "web");
    insert("q2", "popup");
    insert("q3", null);
    expect(() => insert("q4", "email")).toThrow();
    expect(() => db.run("INSERT INTO questions (id, agent_id, person_id, question, status, created_at, expires_at) VALUES ('q5', 'a', 'p', 'q', 'open', 't', 't')")).toThrow();
    expect(db.query("PRAGMA foreign_key_list(questions)").all()).toEqual([]);
    expect((db.query("SELECT stakes, answer_level FROM questions WHERE id = 'q1'").get() as Record<string, unknown>)).toEqual({ stakes: null, answer_level: null });
    db.close();
    // The copy made before the upgrade is the database as it was.
    const backups = readdirSync(join(path, "..")).filter((file) => file.endsWith(".bak"));
    expect(backups).toHaveLength(1);
    const backup = new Database(join(path, "..", backups[0]!), { readonly: true });
    expect(versionOf(backup)).toBe(204);
    expect(tablesOf(backup)).not.toContain("questions");
    backup.close();
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
});

describe("what the directory removes by itself", () => {
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

describe("what a delete reports", () => {
  // The sweeps report `changes` as how many threads or messages went, and purging a workspace checks `changes === 1`.
  // Both rely on Bun counting only the rows a statement deletes itself. Bun 1.4.3 and earlier also counted the rows an
  // ON DELETE CASCADE took (oven-sh/bun#43306, fixed in 1.4.4), so on those the history sweep reported a thread with its
  // messages as several threads, and a purged workspace with people in it as not purged.
  test("a delete counts the rows it deletes, not the rows its cascade takes with them", () => {
    const content = openContentDb(":memory:");
    content.run("INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at) VALUES ('t1', 'a1', 'a2', 'a1', 't', 't')");
    const message = content.query(
      `INSERT INTO messages (id, thread_id, from_id, to_id, subject, text, root_id, status, created_at, expires_at)
       VALUES ($id, 't1', 'a1', 'a2', 's', 'x', 'm1', 'delivered', 't', 't')`,
    );
    for (const id of ["m1", "m2", "m3"]) message.run({ id });
    expect(content.query("DELETE FROM threads WHERE id = 't1'").run().changes).toBe(1);
    expect((content.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number }).n).toBe(0);

    const directory = openDb(":memory:");
    directory.run("INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ('p1', 'Maya', 'owner', 'active', 'h', 't'), ('p2', 'Sam', 'member', 'active', 'h', 't')");
    directory.run("INSERT INTO workspaces (id, name, kind, owner_id, created_at, archived_at) VALUES ('w1', 'Old', 'shared', 'p1', 't', 't')");
    directory.run("INSERT INTO workspace_people (workspace_id, person_id, added_at) VALUES ('w1', 'p1', 't'), ('w1', 'p2', 't')");
    expect(directory.query("DELETE FROM workspaces WHERE id = 'w1' AND archived_at IS NOT NULL").run().changes).toBe(1);
    expect((directory.query("SELECT COUNT(*) AS n FROM workspace_people").get() as { n: number }).n).toBe(0);
  });
});
