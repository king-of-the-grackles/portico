import { describe, expect, test } from "bun:test";
import { sessionBaseName } from "../src/core/agents";
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
    p.agentStreams.connect(live.id, { send() {}, close() {} });
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
    for (const a of [busy, idle]) p.agentStreams.connect(a.id, { send() {}, close() {} });
    p.presence.report(busy.id, { status: "busy", doing: "Fixing", repo: "busy", branch: "main" }, p.now().toISOString());
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
  test("the same key keeps its row, a stale session in the folder is inherited, and names count up", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "b".repeat(64);
    const first = p.agents.registerSession(computer, { key: "key-00001", repo: "api", folderId });
    expect(first.agent.name).toBe("api-claude");
    expect(first.agent.ownerId).toBe(chris.id);
    expect(p.agents.registerSession(computer, { key: "key-00001", repo: "api", folderId }).agent.id).toBe(first.agent.id);
    p.agentStreams.connect(first.agent.id, { send() {}, close() {} });
    const second = p.agents.registerSession(computer, { key: "key-00002", repo: "api", folderId });
    expect(second.agent.name).toBe("api-claude-2");
    p.agentStreams.closeAll([first.agent.id]);
    const third = p.agents.registerSession(computer, { key: "key-00003", repo: "api", folderId });
    expect(third).toMatchObject({ inherited: true });
    expect(third.agent.id).toBe(first.agent.id);
    expect(sessionBaseName("My Repo!")).toBe("my-repo-claude");
  });

  test("a new session in a folder switched off is refused with folder_off; the running one keeps its row", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    const folderId = "c".repeat(64);
    const { agent } = p.agents.registerSession(computer, { key: "key-running", repo: "api", folderId });
    p.agents.update(chris.id, agent.id, { joinFromFolder: false });
    expect(p.agents.joinsFromFolder(p.agents.require(agent.id))).toBe(false);
    expect(errorCode(() => p.agents.registerSession(computer, { key: "key-new-one", repo: "api", folderId }))).toBe("folder_off");
    expect(p.agents.registerSession(computer, { key: "key-running", repo: "api", folderId }).agent.id).toBe(agent.id);
    p.agents.update(chris.id, agent.id, { joinFromFolder: true });
    expect(errorCode(() => p.agents.registerSession(computer, { key: "key-new-one", repo: "api", folderId }))).toBeNull();
  });

  test("sessions offline for a week are deleted; connected ones are kept", async () => {
    const p = makePortico();
    const chris = await addOwner(p);
    const { computer } = addComputer(p, chris);
    addSession(p, computer, { repo: "old" });
    const { agent: live } = addSession(p, computer, { repo: "live" });
    p.agentStreams.connect(live.id, { send() {}, close() {} });
    p.clock.advance(8 * DAY);
    expect(p.agents.sweep()).toBe(1);
    expect(p.agents.all().map((a) => a.name)).toEqual(["live-claude"]);
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
    p.agentStreams.connect(agent.id, { send() {}, close: () => (closed = true) });
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
