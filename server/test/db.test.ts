import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startupProblem } from "../src/commands/serve";
import { BASE_VERSION, openDb, prepare, SCHEMA_VERSION, SchemaMismatchError } from "../src/db";
import { MIGRATIONS, type Migration } from "../src/migrations";

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

  test("101: sessions that split one folder merge into one agent, keeping their messages, threads and allow entries", () => {
    const path = tempPath("portico.db");
    const old = new Database(path, { create: true, strict: true });
    old.run("PRAGMA foreign_keys = ON");
    prepare(old, { migrations: [] });
    const F = "f".repeat(64);
    const t = (minute: number) => `2026-10-20T10:${String(minute).padStart(2, "0")}:00.000Z`;
    old.run(
      `INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ('p1', 'Chris', 'owner', 'active', 'h', 't')`,
    );
    old.run("INSERT INTO computers (id, owner_id, name, token_hash, created_at) VALUES ('c1', 'p1', 'macbook', 'th', 't')");
    const agent = old.query(
      `INSERT INTO agents (id, owner_id, name, kind, type, description, computer_id, session_key, folder, folder_id, created_at, last_seen_at)
       VALUES ($id, 'p1', $name, $kind, $type, '', $computer, $key, $folder, $folderId, $at, $at)`,
    );
    agent.run({ id: "a-grok", name: "grok", kind: "grok-bot", type: "app", computer: null, key: null, folder: null, folderId: null, at: t(0) });
    agent.run({ id: "m-muse", name: "muse", kind: "muse", type: "app", computer: null, key: null, folder: null, folderId: null, at: t(0) });
    agent.run({ id: "s1", name: "api-claude", kind: "claude-code", type: "session", computer: "c1", key: "k1", folder: "api", folderId: F, at: t(1) });
    agent.run({ id: "s2", name: "api-claude-2", kind: "claude-code", type: "session", computer: "c1", key: "k2", folder: "api", folderId: F, at: t(5) });
    old.run("UPDATE agents SET approval_required = 1 WHERE id = 's2'");
    agent.run({ id: "s3", name: "api-claude-3", kind: "claude-code", type: "session", computer: "c1", key: "k3", folder: "api", folderId: F, at: t(6) });
    agent.run({ id: "s4", name: "api-codex", kind: "codex", type: "session", computer: "c1", key: "k4", folder: "api", folderId: F, at: t(7) });
    const thread = old.query(
      "INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at) VALUES ($id, $a, $b, $by, $created, $last)",
    );
    thread.run({ id: "t1", a: "a-grok", b: "s1", by: "a-grok", created: t(2), last: t(2) });
    thread.run({ id: "t2", a: "a-grok", b: "s2", by: "s2", created: t(1), last: t(8) });
    thread.run({ id: "t3", a: "m-muse", b: "s2", by: "s2", created: t(3), last: t(3) });
    thread.run({ id: "t4", a: "s1", b: "s3", by: "s1", created: t(4), last: t(4) });
    const message = old.query(
      `INSERT INTO messages (id, thread_id, from_id, to_id, subject, text, status, created_at, expires_at)
       VALUES ($id, $thread, $from, $to, 's', 't', 'delivered', $at, $at)`,
    );
    message.run({ id: "m1", thread: "t1", from: "a-grok", to: "s1", at: t(2) });
    message.run({ id: "m2", thread: "t2", from: "s2", to: "a-grok", at: t(8) });
    message.run({ id: "m3", thread: "t3", from: "s2", to: "m-muse", at: t(3) });
    message.run({ id: "m4", thread: "t4", from: "s1", to: "s3", at: t(4) });
    const allow = old.query("INSERT INTO always_allow (agent_id, sender_id, added_by, created_at) VALUES ($agent, $sender, 'p1', 't')");
    allow.run({ agent: "s1", sender: "a-grok" });
    allow.run({ agent: "s2", sender: "a-grok" });
    allow.run({ agent: "m-muse", sender: "s2" });
    old.close();

    const db = openDb(path);
    expect(versionOf(db)).toBe(SCHEMA_VERSION);
    const rows = <T>(sql: string) => db.query(sql).all() as T[];
    expect(rows<{ id: string; folder_id: string | null }>("SELECT id, folder_id FROM agents WHERE type = 'session' ORDER BY id")).toEqual([
      { id: "s1", folder_id: F },
      // s3 talked with s1, so it keeps its history but leaves the folder.
      { id: "s3", folder_id: null },
      { id: "s4", folder_id: F },
    ]);
    expect(rows<{ agent_id: string; session_key: string }>("SELECT agent_id, session_key FROM agent_runs ORDER BY session_key")).toEqual([
      { agent_id: "s1", session_key: "k1" },
      { agent_id: "s1", session_key: "k2" },
      { agent_id: "s3", session_key: "k3" },
      { agent_id: "s4", session_key: "k4" },
    ]);
    expect(rows("SELECT id, a_id, b_id, started_by, created_at, last_message_at FROM threads ORDER BY id")).toEqual([
      { id: "t1", a_id: "a-grok", b_id: "s1", started_by: "s1", created_at: t(1), last_message_at: t(8) },
      { id: "t3", a_id: "m-muse", b_id: "s1", started_by: "s1", created_at: t(3), last_message_at: t(3) },
      { id: "t4", a_id: "s1", b_id: "s3", started_by: "s1", created_at: t(4), last_message_at: t(4) },
    ]);
    expect(rows("SELECT id, thread_id, from_id, to_id FROM messages ORDER BY id")).toEqual([
      { id: "m1", thread_id: "t1", from_id: "a-grok", to_id: "s1" },
      { id: "m2", thread_id: "t1", from_id: "s1", to_id: "a-grok" },
      { id: "m3", thread_id: "t3", from_id: "s1", to_id: "m-muse" },
      { id: "m4", thread_id: "t4", from_id: "s1", to_id: "s3" },
    ]);
    expect(rows("SELECT agent_id, sender_id FROM always_allow ORDER BY agent_id")).toEqual([
      { agent_id: "m-muse", sender_id: "s1" },
      { agent_id: "s1", sender_id: "a-grok" },
    ]);
    expect(rows("SELECT COUNT(*) AS n FROM agents WHERE session_key IS NOT NULL")).toEqual([{ n: 0 }]);
    // s2 required approval, so the merged agent does too.
    expect(rows("SELECT approval_required FROM agents WHERE id = 's1'")).toEqual([{ approval_required: 1 }]);
    // One agent per folder and coding agent from now on.
    expect(() =>
      db.run(
        `INSERT INTO agents (id, owner_id, name, kind, type, description, computer_id, folder, folder_id, created_at)
         VALUES ('s5', 'p1', 'api-claude-5', 'claude-code', 'session', '', 'c1', 'api', '${F}', 't')`,
      ),
    ).toThrow();
    db.close();
  });

  test("102: each message gets its conversation's first message as its task, and a reply whose original is gone starts one", () => {
    const path = tempPath("portico.db");
    const old = new Database(path, { create: true, strict: true });
    prepare(old, { migrations: MIGRATIONS.slice(0, 1) });
    old.run(`INSERT INTO people (id, name, role, status, password_hash, created_at) VALUES ('p1', 'Chris', 'owner', 'active', 'h', 't')`);
    for (const [id, name] of [["a1", "grok"], ["a2", "muse"]]) {
      old.run(
        `INSERT INTO agents (id, owner_id, name, kind, type, description, created_at) VALUES ('${id}', 'p1', '${name}', 'muse', 'app', '', 't')`,
      );
    }
    old.run("INSERT INTO threads (id, a_id, b_id, started_by, created_at, last_message_at) VALUES ('t1', 'a1', 'a2', 'a1', 't', 't')");
    const message = old.query(
      `INSERT INTO messages (id, thread_id, from_id, to_id, subject, text, reply_to, status, created_at, expires_at)
       VALUES ($id, 't1', $from, $to, 's', 't', $replyTo, 'delivered', $at, $at)`,
    );
    message.run({ id: "m1", from: "a1", to: "a2", replyTo: null, at: "2026-10-20T10:00:00.000Z" });
    message.run({ id: "m2", from: "a2", to: "a1", replyTo: "m1", at: "2026-10-20T10:01:00.000Z" });
    message.run({ id: "m3", from: "a1", to: "a2", replyTo: "m2", at: "2026-10-20T10:02:00.000Z" });
    message.run({ id: "m4", from: "a2", to: "a1", replyTo: "pruned", at: "2026-10-20T10:03:00.000Z" });
    message.run({ id: "m5", from: "a1", to: "a2", replyTo: "m4", at: "2026-10-20T10:04:00.000Z" });
    old.close();
    const db = openDb(path);
    expect(db.query("SELECT id, root_id, summary FROM messages ORDER BY id").all()).toEqual([
      { id: "m1", root_id: "m1", summary: null },
      { id: "m2", root_id: "m1", summary: null },
      { id: "m3", root_id: "m1", summary: null },
      { id: "m4", root_id: "m4", summary: null },
      { id: "m5", root_id: "m4", summary: null },
    ]);
    expect((db.query("SELECT COUNT(*) AS n FROM activity").get() as { n: number }).n).toBe(0);
    db.close();
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
