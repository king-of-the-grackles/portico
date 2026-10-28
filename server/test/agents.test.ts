import { describe, expect, test } from "bun:test";
import { parseRegistration, sessionBaseName } from "../src/core/agents";
import { addAppAgent, addComputer, addMember, addOwner, addSession, DAY, errorCode, HOUR, makePortico } from "./helpers";

describe("addresses and the agent list", () => {
  test("a session is name@computer, shown by its short name while that name is unique", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer: macbook } = addComputer(p, chris, "MacBook.local");
    const { computer: studio } = addComputer(p, chris, "studio");
    expect(macbook.name).toBe("macbook");
    const first = addSession(p, macbook, { repo: "dialog" }).agent;
    expect(first.name).toBe("dialog-claude");
    expect(p.agents.address(first)).toBe("dialog-claude@macbook");
    expect(p.agents.display(first)).toBe("dialog-claude");
    const second = addSession(p, studio, { repo: "dialog" }).agent;
    expect(p.agents.display(first)).toBe("dialog-claude@macbook");
    expect(p.agents.display(second)).toBe("dialog-claude@studio");
  });

  test("an app that had the name first keeps the short name; a later session goes by its full address", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    addAppAgent(p, chris, "api-claude");
    const session = addSession(p, addComputer(p, chris).computer, { repo: "api" }).agent;
    expect(p.agents.display(session)).toBe("api-claude@macbook");
    expect(p.agents.resolve("api-claude", "x").type).toBe("app");
  });

  test("resolve refuses patterns, names a duplicate short name's computers, and lists valid names", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    addSession(p, addComputer(p, chris, "macbook").computer, { repo: "dialog" });
    addSession(p, addComputer(p, chris, "studio").computer, { repo: "dialog" });
    const { agent: muse } = addAppAgent(p, chris, "muse");
    expect(errorCode(() => p.agents.resolve("*", muse.id))).toBe("bad_request");
    expect(() => p.agents.resolve("dialog-claude", muse.id)).toThrow(
      '"dialog-claude" is on 2 computers. Use one of: dialog-claude@macbook, dialog-claude@studio.',
    );
    expect(() => p.agents.resolve("nobody", muse.id)).toThrow(
      'No agent named "nobody". Valid agents: dialog-claude@macbook, dialog-claude@studio.',
    );
    expect(p.agents.resolve("dialog-claude@studio", muse.id).computer).toBe("studio");
  });

  test("sessions offline for a day leave the list; connected ones stay however old", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const { agent: old } = addSession(p, computer, { repo: "old" });
    const { agent: live } = addSession(p, computer, { repo: "live" });
    p.agentStreams.connect(live.id, live.id, { send() {}, close() {} });
    p.clock.advance(25 * HOUR);
    const names = p.agents.entries().map((e) => e.display);
    expect(names).toEqual(["live-claude"]);
    expect(p.agents.byAddress(`${old.name}@macbook`)).not.toBeNull();
  });

  test("entries order connected sessions by status, then apps, then offline sessions", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const busy = addSession(p, computer, { repo: "busy" }).agent;
    const idle = addSession(p, computer, { repo: "idle" }).agent;
    addSession(p, computer, { repo: "gone" });
    addAppAgent(p, chris, "muse");
    for (const a of [busy, idle]) p.agentStreams.connect(a.id, a.id, { send() {}, close() {} });
    p.presence.report(busy.id, busy.id, { status: "busy", doing: "Fixing", repo: "busy", branch: "main" }, p.now().toISOString());
    const entries = p.agents.entries();
    expect(entries.map((e) => [e.display, e.status])).toEqual([
      ["busy-claude", "busy"],
      ["idle-claude", "idle"],
      ["muse", null],
      ["gone-claude", "offline"],
    ]);
    expect(entries[0]!.doing).toBe("Fixing");
  });

  test("apps show the usual minutes between check-ins", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { agent } = addAppAgent(p, chris, "muse");
    for (const gap of [0, 10, 10, 12]) {
      p.clock.advance(gap * 60_000);
      p.agents.checkedIn(agent);
    }
    expect(p.agents.entry(agent).checkInMinutes).toBe(10);
  });
});

describe("session registration", () => {
  test("every session of a coding agent in one folder is one agent; each start is a run", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "b".repeat(64);
    const reg = (key: string) => p.agents.registerSession(computer, { key, repo: "api", folderId, client: "claude-code" });
    const first = reg("key-00001");
    expect(first).toMatchObject({ created: true });
    expect(first.agent.name).toBe("api-claude");
    expect(first.agent.ownerId).toBe(chris.id);
    // The same key reconnecting keeps its run.
    expect(reg("key-00001")).toMatchObject({ runId: first.runId, created: false });
    p.agentStreams.connect(first.agent.id, first.runId, { send() {}, close() {} });
    // A second terminal in the folder, while the first is open, is a second run of the same agent.
    const second = reg("key-00002");
    expect(second).toMatchObject({ created: false });
    expect(second.agent.id).toBe(first.agent.id);
    expect(second.runId).not.toBe(first.runId);
    // A restart right after the first closed is the same agent too: no waiting period, no -2.
    p.agentStreams.closeAll([first.agent.id]);
    const third = reg("key-00003");
    expect(third.agent.id).toBe(first.agent.id);
    expect(p.agents.all().map((a) => a.name)).toEqual(["api-claude"]);
    expect(p.agents.runCount(first.agent.id)).toBe(3);
    expect(p.agents.runs(first.agent.id).map((r) => r.id)).toContain(third.runId);
    expect(p.agents.sessionByKey(computer.id, "key-00002")).toMatchObject({ runId: second.runId, agent: { id: first.agent.id } });
    expect(sessionBaseName("My Repo!")).toBe("my-repo-claude");
    const long = sessionBaseName("a-very-long-repository-name-that-goes-on-and-on");
    expect(`${long}-99`.length).toBeLessThanOrEqual(40);
    expect(long).toBe("a-very-long-repository-name-th-claude");
  });

  test("another folder with the same name on the computer gets the next free name", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const one = p.agents.registerSession(computer, { key: "key-00001", repo: "api", folderId: "1".repeat(64) });
    const two = p.agents.registerSession(computer, { key: "key-00002", repo: "api", folderId: "2".repeat(64) });
    expect([one.agent.name, two.agent.name]).toEqual(["api-claude", "api-claude-2"]);
    expect(p.agents.registerSession(computer, { key: "key-00003", repo: "api", folderId: "2".repeat(64) }).agent.id).toBe(two.agent.id);
  });

  test("a run that ends leaves the agent; the agent is offline only once every run has ended", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "9".repeat(64);
    const a = p.agents.registerSession(computer, { key: "key-00001", repo: "api", folderId });
    const b = p.agents.registerSession(computer, { key: "key-00002", repo: "api", folderId });
    const closeA = p.agentStreams.connect(a.agent.id, a.runId, { send() {}, close() {} });
    p.agentStreams.connect(b.agent.id, b.runId, { send() {}, close() {} });
    p.presence.report(a.agent.id, a.runId, { status: "busy", doing: "Tests", repo: "api", branch: "main" }, p.now().toISOString());
    p.presence.report(b.agent.id, b.runId, { status: "idle", doing: null, repo: "api", branch: "main" }, p.now().toISOString());
    expect(p.agents.entry(a.agent).status).toBe("busy");
    closeA();
    p.agents.seen(a.agent.id, a.runId);
    expect(p.agents.entry(a.agent).status).toBe("idle");
    expect(p.agents.runs(a.agent.id).find((r) => r.id === a.runId)?.endedAt).not.toBeNull();
    p.agentStreams.closeAll([a.agent.id]);
    expect(p.agents.entry(a.agent).status).toBe("offline");
  });

  test("a new session in a folder switched off is refused with folder_off; the running one keeps its row", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "c".repeat(64);
    const { agent } = p.agents.registerSession(computer, { key: "key-running", repo: "api", folderId, client: "claude-code" });
    p.agents.update(chris.id, agent.id, { joinFromFolder: false });
    expect(p.agents.joinsFromFolder(p.agents.require(agent.id))).toBe(false);
    expect(errorCode(() => p.agents.registerSession(computer, { key: "key-new-one", repo: "api", folderId, client: "claude-code" }))).toBe("folder_off");
    expect(p.agents.registerSession(computer, { key: "key-running", repo: "api", folderId, client: "claude-code" }).agent.id).toBe(agent.id);
    p.agents.update(chris.id, agent.id, { joinFromFolder: true });
    expect(errorCode(() => p.agents.registerSession(computer, { key: "key-new-one", repo: "api", folderId, client: "claude-code" }))).toBeNull();
  });

  test("Codex in a folder is its own agent, apart from Claude Code there; its conversations share it", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "d".repeat(64);
    const claude = p.agents.registerSession(computer, { key: "key-claude1", repo: "api", folderId, client: "claude-code" });
    const codex = p.agents.registerSession(computer, { key: "key-codex01", repo: "api", folderId, client: "codex" });
    expect(codex).toMatchObject({ created: true });
    expect(codex.agent).toMatchObject({ name: "api-codex", kind: "codex", type: "session", description: "Codex in api on macbook" });
    expect(codex.agent.id).not.toBe(claude.agent.id);
    const next = p.agents.registerSession(computer, { key: "key-codex02", repo: "api", folderId, client: "codex" });
    expect(next).toMatchObject({ created: false });
    expect(next.agent.id).toBe(codex.agent.id);
    expect(sessionBaseName("My Repo!", "codex")).toBe("my-repo-codex");
    expect(`${sessionBaseName("a-very-long-repository-name-that-goes-on-and-on", "codex")}-99`.length).toBeLessThanOrEqual(40);
  });

  test("Codex sessions aren't pushed to: connected they're queued, gone they're offline", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const { agent: codex } = p.agents.registerSession(computer, { key: "key-codex01", repo: "api", folderId: "e".repeat(64), client: "codex" });
    const { agent: claude } = p.agents.registerSession(computer, { key: "key-claude1", repo: "api", folderId: "e".repeat(64), client: "claude-code" });
    expect(p.agents.isPush(codex)).toBe(false);
    expect(p.agents.isPush(claude)).toBe(true);
    expect(p.agents.tier(codex)).toBe("offline");
    p.agentStreams.connect(codex.id, codex.id, { send() {}, close() {} });
    p.agentStreams.connect(claude.id, claude.id, { send() {}, close() {} });
    expect(p.agents.tier(codex)).toBe("queued");
    expect(p.agents.tier(claude)).toBe("pushed");
  });

  test("registration names the client: Claude Code by default, Codex by header, anything else refused", () => {
    const key = "key-00001";
    const folderId = "f".repeat(64);
    expect(parseRegistration(key, folderId, "api").client).toBe("claude-code");
    expect(parseRegistration(key, folderId, "api", "codex").client).toBe("codex");
    expect(errorCode(() => parseRegistration(key, folderId, "api", "cursor"))).toBe("bad_request");
  });

  test("agents are kept however long they're away; only runs older than the history window are pruned", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const { agent: old } = addSession(p, computer, { repo: "old" });
    const { agent: live } = addSession(p, computer, { repo: "live" });
    p.clock.advance(31 * DAY);
    const { runId } = p.agents.registerSession(computer, { key: "key-live-again", repo: "live", folderId: live.folderId! });
    expect(p.agents.pruneRuns()).toBe(2);
    expect(p.agents.all().map((a) => a.name)).toEqual(["live-claude", "old-claude"]);
    expect(p.agents.runs(live.id).map((r) => r.id)).toEqual([runId]);
    expect(p.agents.runs(old.id)).toEqual([]);
  });
});

describe("labels", () => {
  test("a session is its coding agent and folder; the computer or the name tells same-named folders apart", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer: mac } = addComputer(p, chris, "macbook");
    const { computer: studio } = addComputer(p, chris, "studio");
    const a = p.agents.registerSession(mac, { key: "key-00001", repo: "portico", folderId: "1".repeat(64) }).agent;
    expect(p.agents.label(a)).toBe("Claude Code (portico)");
    const b = p.agents.registerSession(studio, { key: "key-00002", repo: "portico", folderId: "2".repeat(64) }).agent;
    expect(p.agents.label(b)).toBe("Claude Code (portico on studio)");
    const c = p.agents.registerSession(mac, { key: "key-00003", repo: "portico", folderId: "3".repeat(64) }).agent;
    expect([p.agents.label(p.agents.require(a.id)), p.agents.label(c)]).toEqual(["Claude Code (portico-claude)", "Claude Code (portico-claude-2)"]);
    const grok = addAppAgent(p, chris, "chris-grokbot", { kind: "grok-bot" }).agent;
    expect(p.agents.label(grok)).toBe("Grok Bot");
    expect(p.agents.label(addAppAgent(p, chris, "other-bot", { kind: "other" }).agent)).toBe("other-bot");
  });
});

describe("what an agent's manager can change", () => {
  test("rename and describe go live; a name in use is a conflict", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { agent: muse } = addAppAgent(p, chris, "muse");
    addAppAgent(p, chris, "grok");
    const renamed = p.agents.update(chris.id, muse.id, { name: "muse-work", description: "  Calendar and email  " });
    expect(renamed).toMatchObject({ name: "muse-work", description: "Calendar and email" });
    expect(() => p.agents.update(chris.id, muse.id, { name: "grok" })).toThrow("The name grok is already in use.");
    expect(errorCode(() => p.agents.update(chris.id, muse.id, { name: "Not Valid" }))).toBe("bad_request");
  });

  test("a session's name only has to be free on its own computer", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const a = addSession(p, addComputer(p, chris, "macbook").computer, { repo: "web" }).agent;
    addSession(p, addComputer(p, chris, "studio").computer, { repo: "api" });
    expect(p.agents.update(chris.id, a.id, { name: "api-claude" }).name).toBe("api-claude");
  });

  test("an app can't take a name a session goes by, so the session's messages can't be redirected", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    addSession(p, addComputer(p, chris).computer, { repo: "portico" });
    expect(() => p.agents.create({ ownerId: maya.id, name: "portico-claude", kind: "muse", type: "app" })).toThrow(
      "The name portico-claude is already in use.",
    );
    const { agent } = addAppAgent(p, maya, "maya-muse");
    expect(errorCode(() => p.agents.update(maya.id, agent.id, { name: "portico-claude" }))).toBe("conflict");
  });

  test("only the person who manages an agent can change or remove it", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const { agent } = addAppAgent(p, maya, "maya-dot", { kind: "dots" });
    expect(errorCode(() => p.agents.update(chris.id, agent.id, { approvalRequired: true }))).toBe("not_allowed");
    expect(errorCode(() => p.agents.remove(chris.id, agent.id))).toBe("not_allowed");
    expect(p.agents.update(maya.id, agent.id, { approvalRequired: true }).approvalRequired).toBe(true);
  });

  test("removing an agent signs it out: its token fails and its stream closes", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { agent, token } = addAppAgent(p, chris, "muse");
    let closed = false;
    p.agentStreams.connect(agent.id, agent.id, { send() {}, close: () => (closed = true) });
    p.agents.remove(chris.id, agent.id);
    expect(p.agents.byToken(token)).toBeNull();
    expect(closed).toBe(true);
  });
});

describe("tokens", () => {
  test("expired tokens and refresh tokens don't sign an agent in", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const agent = p.agents.create({ ownerId: chris.id, name: "dots", kind: "dots", type: "connector" });
    const access = p.agents.issueToken(agent.id, "access", { expiresAt: new Date(p.now().getTime() + HOUR).toISOString() });
    const refresh = p.agents.issueToken(agent.id, "refresh");
    expect(access.startsWith("pt_")).toBe(true);
    expect(p.agents.byToken(access)?.id).toBe(agent.id);
    expect(p.agents.byToken(refresh)).toBeNull();
    expect(p.agents.byToken(refresh, ["refresh"])?.id).toBe(agent.id);
    p.clock.advance(HOUR);
    expect(p.agents.byToken(access)).toBeNull();
  });
});
