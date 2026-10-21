import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { HubError, type StatusReport } from "../src/hub-client";
import type { OwnSession } from "../src/registry";
import { composeDoing, folderId, gitInfo, mapStatus, SessionWatcher, type SessionWatcherDeps } from "../src/status";
import { captureLog, tempDir, waitFor } from "./helpers";

describe("status values", () => {
  test("mapStatus: busy and shell are busy; idle and waiting stay; anything else is idle", () => {
    expect(mapStatus("busy")).toBe("busy");
    expect(mapStatus("shell")).toBe("busy");
    expect(mapStatus("idle")).toBe("idle");
    expect(mapStatus("waiting")).toBe("waiting");
    expect(mapStatus("unknown")).toBe("idle");
    expect(mapStatus("")).toBe("idle");
    expect(mapStatus(null)).toBe("idle");
    expect(mapStatus(undefined)).toBe("idle");
  });

  test("composeDoing joins with ' · ' and clips to 120 code points", () => {
    expect(composeDoing("Fix login", "Adding tests")).toBe("Fix login · Adding tests");
    expect(composeDoing(null, "Adding tests")).toBe("Adding tests");
    expect(composeDoing("Fix login", null)).toBe("Fix login");
    expect(composeDoing(null, null)).toBeNull();
    expect(composeDoing("  ", "")).toBeNull();
    expect(Array.from(composeDoing("é".repeat(200), null)!)).toHaveLength(120);
  });

  test("folderId is an HMAC keyed with the token: same folder, same ID; another token, another ID", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "app"));
    symlinkSync(join(dir, "app"), join(dir, "link"));
    const id = folderId("bm_one", join(dir, "app"));
    expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect(folderId("bm_one", join(dir, "app"))).toBe(id);
    expect(folderId("bm_one", join(dir, "link"))).toBe(id); // the real path is what's hashed
    expect(folderId("bm_two", join(dir, "app"))).not.toBe(id);
    expect(folderId("bm_one", dir)).not.toBe(id);
    expect(id).not.toContain(Buffer.from(join(dir, "app")).toString("hex"));
  });

  test("gitInfo: inside a repo, the top-level folder's basename and the branch; outside, the folder's basename and no branch", async () => {
    const calls: string[][] = [];
    const inside = async (args: string[]) => {
      calls.push(args);
      return args.includes("--show-toplevel") ? "/w/dialog\nmain\n" : null;
    };
    expect(await gitInfo("/w/dialog/src", inside)).toEqual({ repo: "dialog", branch: "main" });
    expect(calls[0]).toEqual(["-C", "/w/dialog/src", "rev-parse", "--show-toplevel", "--abbrev-ref", "HEAD"]);
    expect(await gitInfo("/w/scratch", async () => null)).toEqual({ repo: "scratch", branch: null });
    // A detached HEAD has no branch.
    expect(await gitInfo("/w/dialog", async () => "/w/dialog\nHEAD\n")).toEqual({ repo: "dialog", branch: null });
    // The real git, outside any repo.
    const dir = tempDir();
    expect(await gitInfo(dir)).toEqual({ repo: basename(dir), branch: null });
  });
});

function fakeSession(status = "idle"): OwnSession {
  return { pid: 4242, sessionId: "s-1", cwd: "/w/dialog", status, name: null, messagingSocketPath: null };
}

function watcherDeps(overrides: Partial<SessionWatcherDeps> = {}) {
  const reports: StatusReport[] = [];
  const logs = captureLog();
  const deps: SessionWatcherDeps = {
    locate: () => fakeSession(),
    cwd: "/w/dialog",
    transcriptOf: () => null,
    git: async () => ({ repo: "dialog", branch: "main" }),
    report: async (r) => {
      reports.push(r);
    },
    log: logs.log,
    ...overrides,
  };
  return { deps, reports, logs };
}

describe("SessionWatcher", () => {
  test("the watcher reports on start, on a change, and on the heartbeat, but not when nothing changed", async () => {
    const session = fakeSession("idle");
    const { deps, reports } = watcherDeps({ locate: () => session, pollMs: 10, heartbeatMs: 300 });
    const watcher = new SessionWatcher(deps);
    watcher.start();
    try {
      await waitFor(() => reports.length === 1);
      expect(reports[0]).toEqual({ status: "idle", doing: null, repo: "dialog", branch: "main" });
      await Bun.sleep(100);
      expect(reports).toHaveLength(1); // ten polls, nothing changed

      session.status = "busy";
      await waitFor(() => reports.length === 2);
      expect(reports[1]).toEqual({ status: "busy", doing: null, repo: "dialog", branch: "main" });
      const changedAt = Date.now();

      await waitFor(() => reports.length === 3, 2000);
      expect(Date.now() - changedAt).toBeGreaterThanOrEqual(250);
      expect(reports[2]).toEqual(reports[1]!);
      expect(watcher.current()).toEqual(reports[1]!);
    } finally {
      watcher.stop();
    }
    const count = reports.length;
    await Bun.sleep(50);
    expect(reports).toHaveLength(count); // stopped
  });

  test("resend reports the current values at once", async () => {
    const { deps, reports } = watcherDeps({ pollMs: 10_000, heartbeatMs: 60_000 });
    const watcher = new SessionWatcher(deps);
    watcher.start();
    try {
      await waitFor(() => reports.length === 1);
      watcher.resend();
      await waitFor(() => reports.length === 2, 200);
      expect(reports[1]).toEqual(reports[0]!);
    } finally {
      watcher.stop();
    }
  });

  test("doing comes from the session's transcript: its title and current to-do", async () => {
    const dir = tempDir();
    const transcript = join(dir, "s-1.jsonl");
    const entry = (o: unknown) => `${JSON.stringify(o)}\n`;
    writeFileSync(
      transcript,
      entry({ type: "ai-title", aiTitle: "Fix login" }) +
        entry({
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "TodoWrite", input: { todos: [{ content: "Add tests", activeForm: "Adding tests", status: "in_progress" }] } },
            ],
          },
        }),
    );
    const lookups: string[] = [];
    const { deps, reports } = watcherDeps({
      locate: () => fakeSession("busy"),
      transcriptOf: (id) => {
        lookups.push(id);
        return transcript;
      },
      pollMs: 10,
    });
    const watcher = new SessionWatcher(deps);
    watcher.start();
    try {
      await waitFor(() => reports.length === 1);
      expect(reports[0]).toEqual({ status: "busy", doing: "Fix login · Adding tests", repo: "dialog", branch: "main" });
      await Bun.sleep(50);
      expect(lookups).toEqual(["s-1"]); // a found path is cached
    } finally {
      watcher.stop();
    }
  });

  test("a missing transcript is looked for again at most every 30 seconds", async () => {
    const lookups: string[] = [];
    const { deps, reports } = watcherDeps({
      transcriptOf: (id) => {
        lookups.push(id);
        return null;
      },
      pollMs: 10,
    });
    const watcher = new SessionWatcher(deps);
    watcher.start();
    try {
      await waitFor(() => reports.length === 1);
      await Bun.sleep(60);
      expect(lookups).toEqual(["s-1"]);
    } finally {
      watcher.stop();
    }
  });

  test("a failed report is logged by error name only and retried on the next poll, and nothing private is logged", async () => {
    const doingText = "Secret plan · Moving the launch";
    let fail = true;
    const sent: StatusReport[] = [];
    const { deps, logs } = watcherDeps({
      transcriptOf: () => null,
      git: async () => ({ repo: "dialog", branch: "secret-branch" }),
      report: async (r) => {
        if (fail) throw new HubError(500, "internal", `boom ${doingText}`);
        sent.push(r);
      },
      pollMs: 10,
    });
    const watcher = new SessionWatcher({ ...deps, locate: () => ({ ...fakeSession("busy"), sessionId: "s-private-id" }) });
    watcher.start();
    try {
      await waitFor(() => logs.lines.some((l) => l.msg === "status_report_failed"));
      await Bun.sleep(50);
      // Logged once per failure streak, not on every poll.
      expect(logs.lines.filter((l) => l.msg === "status_report_failed")).toEqual([
        { level: "warn", msg: "status_report_failed", fields: { error: "HubError" } },
      ]);
      fail = false;
      await waitFor(() => sent.length === 1);
      expect(sent[0]).toMatchObject({ status: "busy", branch: "secret-branch" });
    } finally {
      watcher.stop();
    }
    const logged = JSON.stringify(logs.lines);
    for (const secret of ["Secret plan", "secret-branch", "s-private-id", "/w/dialog"]) expect(logged).not.toContain(secret);
  });
});
