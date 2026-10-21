import { expect, test } from "bun:test";
import { Directory, SESSION_LIST_HOURS } from "../src/core/directory";
import { hashSecret } from "../src/core/tokens";
import { addSession, errorCode, HOUR, makeApp, makeService, mintAssistant, T0 } from "./helpers";

test("members are the bridge.yaml agents, the assistants and the recent sessions, each with a kind", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  const byAddress = Object.fromEntries(ctx.directory.members().map((m) => [m.address, m.kind]));
  expect(byAddress).toMatchObject({
    "claude-code": "claude-code",
    "grok-bot": "grok-bot",
    muse: "muse",
    codex: "codex",
    chatgpt: "chatgpt",
    "dialog-claude@macbook": "claude-code",
  });
  expect(ctx.directory.members().map((m) => m.source)).toEqual(["config", "config", "config", "config", "assistant", "session"]);
  expect(ctx.directory.find("dialog-claude@macbook")).toMatchObject({
    name: "dialog-claude",
    delivery: "push",
    machine: "macbook",
    source: "session",
  });
  expect(ctx.directory.find("chatgpt")).toMatchObject({ delivery: "pull", machine: null, source: "assistant" });
});

test("resolve takes a full address, or a short session name when it's unique", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.resolve("dialog-claude@macbook", "muse").address).toBe("dialog-claude@macbook");
  expect(ctx.directory.resolve("dialog-claude", "muse").address).toBe("dialog-claude@macbook");
  expect(ctx.directory.resolve("muse", "grok-bot")).toMatchObject({ address: "muse", source: "config" });
  expect(ctx.directory.resolve("chatgpt", "muse")).toMatchObject({ address: "chatgpt", source: "assistant" });
  expect(errorCode(() => ctx.directory.resolve("dialog-claude@studio", "muse"))).toBe("unknown_agent");
  for (const bad of [undefined, 42, "", "   "]) expect(errorCode(() => ctx.directory.resolve(bad, "muse"))).toBe("bad_request");
});

test("an ambiguous short name lists its candidates", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "studio" });
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(errorCode(() => ctx.directory.resolve("dialog-claude", "muse"))).toBe("unknown_agent");
  expect(() => ctx.directory.resolve("dialog-claude", "muse")).toThrow(
    '"dialog-claude" is on 2 machines. Use one of: dialog-claude@macbook, dialog-claude@studio.',
  );
  expect(ctx.directory.resolve("dialog-claude@studio", "muse").address).toBe("dialog-claude@studio");
});

test("resolve refuses broadcasts", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  for (const to of ["*", "dialog-*", "kind:claude-code", "a?"]) expect(errorCode(() => ctx.directory.resolve(to, "muse"))).toBe("bad_request");
});

test("an unknown name lists the valid names, without the caller", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(() => ctx.directory.resolve("nobody", "dialog-claude@macbook")).toThrow(
    'No agent named "nobody". Valid agents: grok-bot, claude-code, muse, codex.',
  );
  expect(() => ctx.directory.resolve("nobody", "muse")).toThrow(
    'No agent named "nobody". Valid agents: grok-bot, claude-code, codex, dialog-claude.',
  );
});

test("sessions and push agents are push members; assistants and pull agents aren't", () => {
  const ctx = makeApp();
  mintAssistant(ctx, "chatgpt", "chatgpt");
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.isPush("dialog-claude@macbook")).toBe(true);
  expect(ctx.directory.isPush("claude-code")).toBe(true);
  expect(ctx.directory.isPush("chatgpt")).toBe(false);
  expect(ctx.directory.isPush("muse")).toBe(false);
  expect(ctx.directory.isPush("nobody")).toBe(false);
  expect(ctx.directory.isPush("dialog-claude")).toBe(false); // a short name isn't an address
});

test("a session not seen for 24 hours leaves members() but still resolves by full address", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(SESSION_LIST_HOURS).toBe(24);
  ctx.clock.advance(24 * HOUR);
  expect(ctx.directory.members().map((m) => m.address)).toContain("dialog-claude@macbook");
  ctx.clock.advance(1);
  expect(ctx.directory.members().map((m) => m.address)).not.toContain("dialog-claude@macbook");
  expect(ctx.directory.find("dialog-claude@macbook")).not.toBeNull();
  expect(ctx.directory.resolve("dialog-claude@macbook", "muse").address).toBe("dialog-claude@macbook");
  // A session with an open stream stays listed however long ago its row was written.
  const connected = new Directory({
    config: ctx.config,
    network: ctx.network,
    isConnected: (address) => address === "dialog-claude@macbook",
    presence: ctx.presence,
    now: ctx.clock.now,
  });
  expect(connected.members().map((m) => m.address)).toContain("dialog-claude@macbook");
});

test("displayName is the short form when unique, else the full address", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.displayName("dialog-claude@macbook")).toBe("dialog-claude");
  expect(ctx.directory.displayName("muse")).toBe("muse");
  addSession(ctx, { name: "dialog-claude", machine: "studio" });
  expect(ctx.directory.displayName("dialog-claude@macbook")).toBe("dialog-claude@macbook");
  expect(ctx.directory.displayName("nobody@nowhere")).toBe("nobody@nowhere");
});

test("ref gives the member's kind, or unknown", () => {
  const ctx = makeApp();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  expect(ctx.directory.ref("dialog-claude@macbook")).toEqual({ address: "dialog-claude@macbook", kind: "claude-code" });
  expect(ctx.directory.ref("muse")).toEqual({ address: "muse", kind: "muse" });
  expect(ctx.directory.ref("nobody")).toEqual({ address: "nobody", kind: "unknown" });
});

test("an assistant named like a bridge.yaml agent is shadowed by it", () => {
  const ctx = makeApp();
  ctx.network.insertAssistant(
    { id: "a-muse", owner: "owner", name: "muse", kind: "other", description: "Imposter", createdAt: T0.toISOString() },
    hashSecret("ba_imposter"),
  );
  expect(ctx.directory.members().filter((m) => m.address === "muse")).toEqual([
    expect.objectContaining({ source: "config", description: "Meta Muse" }),
  ]);
  expect(ctx.directory.find("muse")?.source).toBe("config");
  expect(ctx.directory.resolve("muse", "grok-bot").source).toBe("config");
});

const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

test("entries show status, doing, repo and branch for connected sessions; offline sessions show offline with no doing, their last repo and branch, and when last seen", () => {
  const ctx = makeService();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  addSession(ctx, { name: "wingman-claude", machine: "macbook" });
  // Reported busy at 12:00:30, then its stream closed at 12:01, which wrote last_seen_at.
  addSession(ctx, { name: "scenes-claude", machine: "studio", lastSeenAt: at(60_000) });
  ctx.presence.report("scenes-claude@studio", { status: "busy", doing: "Old plan · Old step", repo: "scenes", branch: "dev" }, at(30_000));
  ctx.connected.add("dialog-claude@macbook");
  ctx.connected.add("wingman-claude@macbook");
  ctx.clock.advance(120_000);
  ctx.presence.report("dialog-claude@macbook", { status: "busy", doing: "Fix login · Adding tests", repo: "dialog", branch: "main" }, at(120_000));
  const entry = (address: string) => ctx.directory.entries("muse").find((e) => e.address === address);

  expect(entry("dialog-claude@macbook")).toEqual({
    address: "dialog-claude@macbook",
    name: "dialog-claude",
    display: "dialog-claude",
    source: "session",
    kind: "claude-code",
    description: "Claude Code in dialog on macbook",
    delivery: "push",
    machine: "macbook",
    status: "busy",
    doing: "Fix login · Adding tests",
    repo: "dialog",
    branch: "main",
    lastSeen: at(120_000),
  });
  // Connected with no report yet: idle, with the folder it registered from as its repo.
  expect(entry("wingman-claude@macbook")).toMatchObject({ status: "idle", doing: null, repo: "wingman", branch: null, lastSeen: at(0) });
  // Offline: the last report's status and doing aren't shown, its repo and branch are the last known, and last seen is
  // when its stream closed.
  expect(entry("scenes-claude@studio")).toMatchObject({
    status: "offline",
    doing: null,
    repo: "scenes",
    branch: "dev",
    lastSeen: at(60_000),
  });
  // A bridge.yaml push agent with no stream and no report is offline, never seen.
  expect(entry("claude-code")).toMatchObject({ status: "offline", doing: null, repo: null, branch: null, lastSeen: null });
});

test("pull members show their last check-in and no status", () => {
  const ctx = makeService();
  ctx.network.insertAssistant(
    { id: "a-chatgpt", owner: "owner", name: "chatgpt", kind: "chatgpt", description: "ChatGPT", createdAt: at(0) },
    hashSecret("ba_chatgpt"),
  );
  ctx.clock.advance(60_000);
  ctx.service.checkInbox("grok-bot");
  ctx.service.checkInbox("chatgpt");
  const entries = ctx.directory.entries("muse");
  const pull = { status: null, doing: null, repo: null, branch: null, machine: null, delivery: "pull" };
  expect(entries.find((e) => e.address === "grok-bot")).toMatchObject({ ...pull, lastSeen: at(60_000) });
  expect(entries.find((e) => e.address === "chatgpt")).toMatchObject({ ...pull, kind: "chatgpt", lastSeen: at(60_000) });
  expect(entries.find((e) => e.address === "codex")).toMatchObject({ ...pull, lastSeen: null });
});

test("entries go busy, waiting, idle, then pull members, then offline, alphabetical within each", () => {
  const ctx = makeService();
  const live = (name: string, machine: string, status: "busy" | "waiting" | "idle" | null) => {
    const { address } = addSession(ctx, { name, machine });
    ctx.connected.add(address);
    if (status) ctx.presence.report(address, { status, doing: null, repo: null, branch: null }, at(0));
  };
  live("zeta-claude", "macbook", "busy");
  live("alpha-claude", "macbook", "busy");
  live("mid-claude", "studio", "waiting");
  live("beta-claude", "studio", null); // no report yet: idle
  live("aaa-claude", "macbook", "idle");
  addSession(ctx, { name: "old-claude", machine: "studio" });
  ctx.presence.report("old-claude@studio", { status: "busy", doing: null, repo: null, branch: null }, at(0)); // gone since
  expect(ctx.directory.entries().map((e) => e.display)).toEqual([
    "alpha-claude",
    "zeta-claude",
    "mid-claude",
    "aaa-claude",
    "beta-claude",
    "codex",
    "grok-bot",
    "muse",
    "claude-code",
    "old-claude",
  ]);
});

test("entries leave out the caller, and name each by its short form when unique", () => {
  const ctx = makeService();
  addSession(ctx, { name: "dialog-claude", machine: "macbook" });
  addSession(ctx, { name: "dialog-claude", machine: "studio" });
  addSession(ctx, { name: "wingman-claude", machine: "macbook" });
  const fromWingman = ctx.directory.entries("wingman-claude@macbook");
  expect(fromWingman.map((e) => e.address)).not.toContain("wingman-claude@macbook");
  expect(fromWingman.filter((e) => e.source === "session").map((e) => e.display)).toEqual([
    "dialog-claude@macbook",
    "dialog-claude@studio",
  ]);
  const fromMuse = ctx.directory.entries("muse");
  expect(fromMuse.map((e) => e.address)).not.toContain("muse");
  expect(fromMuse.find((e) => e.address === "wingman-claude@macbook")?.display).toBe("wingman-claude");
  expect(fromMuse.find((e) => e.address === "grok-bot")?.display).toBe("grok-bot");
  expect(ctx.service.listAgents("muse")).toEqual(fromMuse);
});
