import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { findOwnSession, SessionLocator } from "../src/registry";
import { tempDir, writeSessionFile } from "./helpers";

const chain = (pairs: [number, number][]) => {
  const parents = new Map(pairs);
  return (pid: number) => parents.get(pid) ?? null;
};

test("finds the nearest ancestor that has a session file", () => {
  const dir = tempDir();
  writeSessionFile(dir, 300, { sessionId: "s-1", cwd: "/work/dialog", status: "busy", messagingSocketPath: "/tmp/x.sock" });
  const found = findOwnSession({ sessionsDir: dir, startPid: 100, parentOf: chain([[100, 200], [200, 300], [300, 1]]) });
  expect(found).toMatchObject({ pid: 300, sessionId: "s-1", cwd: "/work/dialog", status: "busy", messagingSocketPath: "/tmp/x.sock" });
});

test("stops at pid 1, at a missing parent, or after maxDepth", () => {
  const dir = tempDir();
  writeSessionFile(dir, 900, { sessionId: "far", cwd: "/w" });
  const parentOf = chain([[1, 0], [100, 200], [200, 300], [300, 400], [400, 900]]);
  expect(findOwnSession({ sessionsDir: dir, startPid: 100, parentOf, maxDepth: 3 })).toBeNull();
  expect(findOwnSession({ sessionsDir: dir, startPid: 100, parentOf, maxDepth: 6 })?.sessionId).toBe("far");
  expect(findOwnSession({ sessionsDir: dir, startPid: 1, parentOf })).toBeNull();
});

test("ignores files that aren't valid session records", () => {
  const dir = tempDir();
  writeFileSync(join(dir, "100.json"), "{not json");
  writeFileSync(join(dir, "200.json"), JSON.stringify({ pid: 200 }));
  expect(findOwnSession({ sessionsDir: dir, startPid: 100, parentOf: chain([[100, 200], [200, 1]]) })).toBeNull();
});

test("SessionLocator finds the pid once and re-reads that file on every call", () => {
  const dir = tempDir();
  writeSessionFile(dir, 300, { sessionId: "s-1", cwd: "/w", status: "idle" });
  let walks = 0;
  const locator = new SessionLocator({ sessionsDir: dir, startPid: 300, parentOf: () => (walks++, null) });
  expect(locator.current()?.status).toBe("idle");
  writeSessionFile(dir, 300, { sessionId: "s-1", cwd: "/w", status: "busy" });
  expect(locator.current()?.status).toBe("busy");
  expect(walks).toBe(0);
});

test("SessionLocator walks every 5 s while nothing is found for the first minute, then every 30 s, and stops once found", () => {
  const dir = tempDir();
  let now = 1_000_000;
  let walks = 0;
  const locator = new SessionLocator({ sessionsDir: dir, startPid: 300, parentOf: () => (walks++, null), now: () => now });
  const callAt = (ms: number) => {
    now = 1_000_000 + ms;
    return locator.current();
  };
  expect(callAt(0)).toBeNull();
  expect(walks).toBe(1);
  callAt(4_999);
  expect(walks).toBe(1);
  // Every 5 s through the first minute: walks at 0, 5, 10, ... 55 s.
  for (let s = 5; s <= 55; s += 5) callAt(s * 1000);
  expect(walks).toBe(12);
  // Then every 30 s after the last walk.
  callAt(60_000);
  callAt(84_999);
  expect(walks).toBe(12);
  callAt(85_000);
  expect(walks).toBe(13);
  callAt(114_999);
  expect(walks).toBe(13);
  callAt(115_000);
  expect(walks).toBe(14);
  // Found at the next walk, then read directly with no more walks.
  writeSessionFile(dir, 300, { sessionId: "s-1", cwd: "/w", status: "idle" });
  expect(callAt(130_000)).toBeNull();
  expect(callAt(145_000)?.sessionId).toBe("s-1");
  expect(callAt(145_001)?.sessionId).toBe("s-1");
  expect(walks).toBe(14);
});
