import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, SCHEMA_VERSION, SchemaMismatchError } from "../src/db";

describe("database", () => {
  test("a new database gets the whole schema", () => {
    const db = openDb(":memory:");
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
      (row) => row.name,
    );
    expect(tables).toContain("messages");
    expect(tables).toContain("always_allow");
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  });

  test("a database from an earlier Portico is refused, not changed", () => {
    const path = join(mkdtempSync(join(tmpdir(), "portico-db-")), "old.db");
    const old = new Database(path);
    old.run("CREATE TABLE tasks (id TEXT)");
    old.run("PRAGMA user_version = 2");
    old.close();
    expect(() => openDb(path)).toThrow(SchemaMismatchError);
    const again = new Database(path);
    expect((again.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(2);
    again.close();
  });

  test("removing a person removes what depends on them", () => {
    const db = openDb(":memory:");
    db.run("INSERT INTO people VALUES ('p1', 'Maya', 'member', 'active', 'h', NULL, 't', 't')");
    db.run("INSERT INTO computers VALUES ('c1', 'p1', 'linux', 'th', 't', NULL)");
    db.run("INSERT INTO agents (id, owner_id, name, kind, type, description, computer_id, created_at) VALUES ('a1', 'p1', 'x', 'codex', 'session', '', 'c1', 't')");
    db.run("DELETE FROM people WHERE id = 'p1'");
    expect((db.query("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n).toBe(0);
  });
});
