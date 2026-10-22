import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inviteCommand } from "../src/commands/invite";
import type { CliIo } from "../src/commands/io";
import { NetworkService } from "../src/core/network";
import { openDb } from "../src/db";
import { NetworkStore } from "../src/network-store";
import { BASE_YAML, PRONOUNS, T0, testConfig, testEnv } from "./helpers";

const JOIN_LINE = /^Join my agent bridge: https:\/\/bridge\.test\/join#[A-Za-z0-9_-]{22}$/;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A folder with bridge.yaml, and env pointing the config and database there. */
function setup(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bridge-invite-"));
  dirs.push(dir);
  writeFileSync(join(dir, "bridge.yaml"), BASE_YAML);
  const dbPath = join(dir, "bridge.db");
  const env = testEnv({ BRIDGE_DB_PATH: dbPath, BRIDGE_CONFIG: join(dir, "bridge.yaml"), ...extraEnv });
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { env, cwd: dir, out: (line) => out.push(line), err: (line) => err.push(line) };
  return { dir, dbPath, io, out, err };
}

describe("bridge invite", () => {
  test("prints a join line that redeems on the hub, valid for 24 hours", async () => {
    const run = setup();
    expect(await inviteCommand([], run.io, { now: () => T0 })).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out).toHaveLength(3);
    expect(run.out[0]).toBe("Join line for a new machine (one use, expires 2026-10-21 12:00 UTC):");
    expect(run.out[1]).toMatch(JOIN_LINE);
    expect(run.out[2]).toBe("Paste the line into Claude Code on the new machine, or open the link there for the steps.");

    const code = run.out[1]!.split("#")[1]!;
    const db = openDb(run.dbPath);
    try {
      const network = new NetworkService({ store: new NetworkStore(db), config: testConfig(), now: () => T0 });
      expect(network.redeemJoinCode(code, "macbook").machine.name).toBe("macbook");
    } finally {
      db.close();
    }
  });

  test("every line except the join line is free of pronouns, and no other line carries the code", async () => {
    const ok = setup();
    expect(await inviteCommand([], ok.io, { now: () => T0 })).toBe(0);
    const code = ok.out[1]!.split("#")[1]!;
    const broken = setup({ BRIDGE_PUBLIC_URL: "" });
    expect(await inviteCommand([], broken.io)).toBe(1);
    const leftover = setup({ BRIDGE_NTFY_TOPIC: "mytopic" }); // ignored since v1.2, never a config error
    expect(await inviteCommand([], leftover.io, { now: () => T0 })).toBe(0);
    const unknown = setup();
    expect(await inviteCommand(["--force"], unknown.io)).toBe(1);

    const lines = [ok, broken, leftover, unknown].flatMap((run) => [...run.out, ...run.err]).filter((line) => !JOIN_LINE.test(line));
    expect(lines.length).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(line).not.toMatch(PRONOUNS);
      expect(line).not.toContain(code);
    }
  });

  test("a config problem is reported, and nothing is created", async () => {
    const run = setup({ BRIDGE_PUBLIC_URL: "" });
    expect(await inviteCommand([], run.io)).toBe(1);
    expect(run.err.join("\n")).toContain("missing BRIDGE_PUBLIC_URL");
    expect(run.out).toEqual([]);
    expect(existsSync(run.dbPath)).toBe(false);

    const missing = setup({ BRIDGE_CONFIG: "nowhere.yaml" });
    expect(await inviteCommand([], missing.io)).toBe(1);
    expect(missing.err.join("\n")).toContain("config file not found");
    expect(existsSync(missing.dbPath)).toBe(false);
  });

  test("an unknown option prints the usage and exits 1", async () => {
    const run = setup();
    expect(await inviteCommand(["--force"], run.io)).toBe(1);
    expect(run.err).toEqual(["Unknown option: --force. Usage: bridge invite"]);
    expect(run.out).toEqual([]);
    expect(existsSync(run.dbPath)).toBe(false);
  });
});
