import { describe, expect, test } from "bun:test";
import { checkHandle, handleKey } from "../src/core/people";
import type { Agent, Person } from "../src/core/types";
import {
  addAppAgent,
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  errorCode,
  fakeAccounts,
  makePortico,
  signIn,
  together,
  type TestPortico,
} from "./helpers";

const on = () => makePortico();

/**
 * Chris (handle chris) with muse and grok-bot, Robert (handle robert) with muse and dots, Maya (handle maya) with
 * scout. Chris and Robert share "Launch", with Chris's muse and Robert's muse in it. Nobody shares anything with Maya.
 */
async function world() {
  const p = on();
  const chris = p.people.setHandle((await addOwner(p, "Chris")).id, "chris");
  const robert = p.people.setHandle((await addMember(p, "Robert")).id, "robert");
  const maya = p.people.setHandle((await addMember(p, "Maya")).id, "maya");
  const muse = addAppAgent(p, chris, "muse");
  const grok = addAppAgent(p, chris, "grok-bot", { kind: "grok-bot" });
  const rmuse = addAppAgent(p, robert, "muse");
  const dots = addAppAgent(p, robert, "dots", { kind: "dots" });
  const scout = addAppAgent(p, maya, "scout");
  const launch = p.workspaces.create(chris.id, "Launch");
  p.workspaces.admit(launch.id, robert.id);
  p.workspaces.addAgent(chris.id, launch.id, muse.agent.id);
  p.workspaces.addAgent(robert.id, launch.id, rmuse.agent.id);
  return { p, chris, robert, maya, muse, grok, rmuse, dots, scout, launch };
}

const say = (p: TestPortico, from: Agent, to: string, subject = "Hello") => p.messages.send(from, { to, subject, text: "x" }).message;
const names = (p: TestPortico, viewer: Agent) => p.agents.entriesFor(viewer).map((e) => e.display);

describe("handles", () => {
  test("a handle is 3 to 20 lowercase letters, digits and single hyphens, and never a reserved word", () => {
    expect(checkHandle(" robert ")).toBe("robert");
    for (const bad of ["ab", "Robert", "a--b", "-ab", "ab-", "a".repeat(21), "rob ert", "rob/ert", "rob@ert", 7]) {
      expect(errorCode(() => checkHandle(bad))).toBe("bad_request");
    }
    for (const reserved of ["portico", "admin", "personal", "p0rtico", "adm1n", "sign-in"]) {
      expect(errorCode(() => checkHandle(reserved))).toBe("conflict");
    }
  });

  test("look-alikes fold to one key", () => {
    expect(handleKey("r0bert")).toBe(handleKey("robert"));
    expect(handleKey("li-am")).toBe(handleKey("11am"));
    expect(handleKey("rnaya")).toBe(handleKey("maya"));
    expect(handleKey("robert")).not.toBe(handleKey("roberta"));
  });

  test("a handle is unique, and so is anything that reads like one", async () => {
    const p = on();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    expect(p.people.setHandle(chris.id, "chris").handle).toBe("chris");
    expect(p.people.byHandle("chris")?.id).toBe(chris.id);
    expect(errorCode(() => p.people.setHandle(maya.id, "chris"))).toBe("conflict");
    expect(errorCode(() => p.people.setHandle(maya.id, "chr1s"))).toBe("conflict");
    expect(errorCode(() => p.people.setHandle(maya.id, "ch-ris"))).toBe("conflict");
    expect(p.people.handleFree("chris", maya.id)).toBe(false);
    expect(p.people.handleFree("chris", chris.id)).toBe(true);
    expect(p.people.handleFree("maya", maya.id)).toBe(true);
  });

  test("a handle let go stays held back from everyone else, and its first holder can take it again", async () => {
    const p = on();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    p.people.setHandle(chris.id, "chris");
    p.people.setHandle(chris.id, "chris-i");
    expect(p.people.byHandle("chris")).toBeNull();
    expect(errorCode(() => p.people.setHandle(maya.id, "chris"))).toBe("conflict");
    expect(errorCode(() => p.people.setHandle(maya.id, "chr1s"))).toBe("conflict");
    expect(p.people.setHandle(chris.id, "chris").handle).toBe("chris");
    expect(errorCode(() => p.people.setHandle(maya.id, "chris-i"))).toBe("conflict");
  });

  test("a suggestion is a free handle near the name", async () => {
    const p = on();
    const chris = await addOwner(p, "Chris");
    p.people.setHandle(chris.id, "robert");
    expect(p.people.suggestHandle("Robert Álvarez")).toBe("robert-alvarez");
    expect(p.people.suggestHandle("Robert")).toBe("robert-2");
    expect(p.people.suggestHandle("Robert", chris.id)).toBe("robert");
    expect(p.people.suggestHandle("Jo")).toBe("jo-person");
    expect(p.people.suggestHandle("!!")).toBe("person");
    expect(p.people.suggestHandle("Admin")).toBe("admin-2");
    expect(p.people.suggestHandle("A very long name that goes on and on").length).toBeLessThanOrEqual(20);
  });

  test("an email is stored lowercased", async () => {
    const p = on();
    const chris = await addOwner(p);
    expect(p.people.setEmail(chris.id, " Chris@Example.com ").email).toBe("chris@example.com");
    expect(errorCode(() => p.people.setEmail(chris.id, "nope"))).toBe("bad_request");
  });
});

describe("workspaces", () => {
  test("a new agent joins its owner's own Portico, which is made on first use", async () => {
    const p = on();
    const chris = await addOwner(p);
    expect(p.workspaces.forPerson(chris.id)).toEqual([]);
    const { agent: muse } = addAppAgent(p, chris, "muse");
    const [personal] = p.workspaces.forPerson(chris.id);
    expect(personal).toMatchObject({ name: "Chris's Portico", phrase: "Chris's Portico", named: false, kind: "personal", ownerId: chris.id });
    // The stored name is internal: nothing reads it back.
    expect((p.db.query("SELECT name FROM workspaces WHERE id = $id").get({ id: personal!.id }) as { name: string }).name).toBe("Personal");
    const { computer } = addComputer(p, chris);
    const { agent: session } = addSession(p, computer);
    expect(p.workspaces.agentsIn(personal!.id).sort()).toEqual([muse.id, session.id].sort());
    expect(p.workspaces.personal(chris.id).id).toBe(personal!.id);
  });

  test("a personal workspace made late takes every agent the person already has", async () => {
    const p = on();
    const chris = await addOwner(p);
    const { agent: muse } = addAppAgent(p, chris, "muse");
    p.db.run("DELETE FROM workspaces");
    expect(p.workspaces.reach(muse.id, muse.id)).toBe(true);
    const personal = p.workspaces.personal(chris.id);
    expect(p.workspaces.agentsIn(personal.id)).toEqual([muse.id]);
  });

  test("a person's own Portico can't be shared, renamed or deleted", async () => {
    const { p, chris, robert, muse, rmuse } = await world();
    const personal = p.workspaces.personal(chris.id);
    expect(errorCode(() => p.workspaces.admit(personal.id, robert.id))).toBe("not_allowed");
    // To someone else, another person's personal workspace looks like one that isn't there.
    expect(errorCode(() => p.workspaces.addAgent(robert.id, personal.id, rmuse.agent.id))).toBe("not_found");
    expect(errorCode(() => p.workspaces.removeAgent(robert.id, personal.id, muse.agent.id))).toBe("not_found");
    expect(errorCode(() => p.workspaces.rename(chris.id, personal.id, "Mine"))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.remove(chris.id, personal.id))).toBe("not_allowed");
    expect(p.workspaces.peopleIn(personal.id)).toEqual([chris.id]);
  });

  test("a shared workspace needs a handle from its maker and from everyone let in", async () => {
    // Signing in with an outside account makes a person with no handle yet.
    const p = makePortico({ accountCheck: fakeAccounts });
    const chris = await addOwner(p);
    const maya = await addMember(p);
    expect(errorCode(() => p.workspaces.create(chris.id, "Launch"))).toBe("wrong_status");
    p.people.setHandle(chris.id, "chris");
    const launch = p.workspaces.create(chris.id, "  Launch   team ");
    expect(launch).toMatchObject({ name: "Launch team", kind: "shared", ownerId: chris.id });
    expect(errorCode(() => p.workspaces.create(chris.id, 7))).toBe("bad_request");
    expect(errorCode(() => p.workspaces.create(chris.id, "x".repeat(61)))).toBe("bad_request");
    expect(errorCode(() => p.workspaces.admit(launch.id, maya.id))).toBe("wrong_status");
    p.people.setHandle(maya.id, "maya");
    p.workspaces.admit(launch.id, maya.id);
    p.workspaces.admit(launch.id, maya.id);
    expect(p.workspaces.peopleIn(launch.id)).toEqual([chris.id, maya.id]);
    expect(p.workspaces.forPerson(maya.id).map((w) => w.name)).toEqual(["Launch team"]);
  });

  test("only the person who manages an agent puts the agent in, and only into a workspace the person is in", async () => {
    const { p, chris, robert, maya, grok, dots, scout, launch } = await world();
    expect(errorCode(() => p.workspaces.addAgent(chris.id, launch.id, dots.agent.id))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.addAgent(maya.id, launch.id, scout.agent.id))).toBe("not_found");
    p.workspaces.addAgent(chris.id, launch.id, grok.agent.id);
    p.workspaces.addAgent(robert.id, launch.id, dots.agent.id);
    expect(p.workspaces.agentsIn(launch.id)).toHaveLength(4);
  });

  test("an agent leaves by its manager or the workspace's owner, nobody else", async () => {
    const { p, chris, robert, maya, muse, rmuse, launch } = await world();
    expect(errorCode(() => p.workspaces.removeAgent(robert.id, launch.id, muse.agent.id))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.removeAgent(maya.id, launch.id, muse.agent.id))).toBe("not_found");
    p.workspaces.removeAgent(chris.id, launch.id, rmuse.agent.id);
    expect(p.workspaces.hasAgent(launch.id, rmuse.agent.id)).toBe(false);
    p.workspaces.addAgent(robert.id, launch.id, rmuse.agent.id);
    p.workspaces.removeAgent(robert.id, launch.id, rmuse.agent.id);
    expect(p.workspaces.hasAgent(launch.id, rmuse.agent.id)).toBe(false);
  });

  test("a person leaves, or is removed by the owner, with every agent the person had there", async () => {
    const { p, chris, robert, maya, muse, rmuse, dots, launch } = await world();
    p.workspaces.addAgent(robert.id, launch.id, dots.agent.id);
    expect(errorCode(() => p.workspaces.removePerson(robert.id, launch.id, chris.id))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.removePerson(chris.id, launch.id, chris.id))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.removePerson(maya.id, launch.id, robert.id))).toBe("not_found");
    p.workspaces.removePerson(robert.id, launch.id, robert.id);
    expect(p.workspaces.peopleIn(launch.id)).toEqual([chris.id]);
    expect(p.workspaces.agentsIn(launch.id)).toEqual([muse.agent.id]);
    expect(p.workspaces.reach(muse.agent.id, rmuse.agent.id)).toBe(false);
    p.workspaces.admit(launch.id, robert.id);
    p.workspaces.removePerson(chris.id, launch.id, robert.id);
    expect(p.workspaces.forPerson(robert.id).map((w) => w.kind)).toEqual(["personal"]);
  });

  test("only the owner renames or deletes a shared workspace", async () => {
    const { p, chris, robert, muse, rmuse, launch } = await world();
    expect(errorCode(() => p.workspaces.rename(robert.id, launch.id, "Mine now"))).toBe("not_allowed");
    expect(errorCode(() => p.workspaces.remove(robert.id, launch.id))).toBe("not_allowed");
    expect(p.workspaces.rename(chris.id, launch.id, "Launch 2").name).toBe("Launch 2");
    p.workspaces.remove(chris.id, launch.id);
    expect(p.workspaces.get(launch.id)).toBeNull();
    expect(p.workspaces.reach(muse.agent.id, rmuse.agent.id)).toBe(false);
  });

  test("removing a person or an agent from Portico takes both out of every workspace", async () => {
    const { p, chris, robert, muse, rmuse, launch } = await world();
    p.agents.remove(chris.id, muse.agent.id);
    expect(p.workspaces.agentsIn(launch.id)).toEqual([rmuse.agent.id]);
    p.people.remove(robert.id);
    expect(p.workspaces.peopleIn(launch.id)).toEqual([chris.id]);
    expect(p.workspaces.agentsIn(launch.id)).toEqual([]);
  });

  test("a person made on a server with its own sign-in has a handle from the name, unique and changeable", async () => {
    const p = on();
    const chris = await addOwner(p, "Chris");
    expect(chris.handle).toBe("chris");
    expect((await addMember(p, "Chris!")).handle).toBe("chris-2");
    expect((await addMember(p, "Admin")).handle).toBe("admin-2");
    expect((await addMember(p, "李")).handle).toMatch(/^[a-z0-9-]{3,20}$/);
    expect(p.people.setHandle(chris.id, "ivester").handle).toBe("ivester");
    // Nobody waits for a handle, so sharing works at once.
    expect(p.workspaces.create(chris.id, "Launch").kind).toBe("shared");
  });

  test("agents of different people reach each other only once they share a workspace", async () => {
    const p = on();
    const chris = await addOwner(p);
    const maya = await addMember(p);
    const { agent: muse } = addAppAgent(p, chris, "muse");
    const { agent: scout } = addAppAgent(p, maya, "scout");
    expect(p.workspaces.forPerson(chris.id).map((w) => w.kind)).toEqual(["personal"]);
    expect(p.workspaces.reach(muse.id, scout.id)).toBe(false);
    expect(p.workspaces.reachable(muse.id)).toEqual(new Set());
    expect(errorCode(() => say(p, muse, "maya/scout"))).toBe("unknown_agent");
    const shared = together(p, muse, scout);
    expect(say(p, muse, "maya/scout")).toMatchObject({ toId: scout.id, workspaceId: shared.id });
    expect(p.messages.threadsBetween(muse.id, scout.id).map((t) => t.workspaceId)).toEqual([shared.id]);
  });
});

describe("the reach rule", () => {
  test("two agents reach each other only while both are in one workspace", async () => {
    const { p, muse, grok, rmuse, dots, scout } = await world();
    const reach = (a: { agent: Agent }, b: { agent: Agent }) => [p.workspaces.reach(a.agent.id, b.agent.id), p.workspaces.reach(b.agent.id, a.agent.id)];
    expect(reach(muse, grok)).toEqual([true, true]);
    expect(reach(muse, rmuse)).toEqual([true, true]);
    expect(reach(rmuse, dots)).toEqual([true, true]);
    expect(reach(grok, rmuse)).toEqual([false, false]);
    expect(reach(muse, dots)).toEqual([false, false]);
    expect(reach(grok, dots)).toEqual([false, false]);
    for (const other of [muse, grok, rmuse, dots]) expect(reach(scout, other)).toEqual([false, false]);
  });

  test("list_agents shows only the agents the caller reaches, with a handle on everyone else's", async () => {
    const { p, muse, grok, rmuse, dots, scout } = await world();
    expect(names(p, muse.agent).sort()).toEqual(["grok-bot", "robert/muse"]);
    expect(names(p, grok.agent)).toEqual(["muse"]);
    expect(names(p, rmuse.agent).sort()).toEqual(["chris/muse", "dots"]);
    expect(names(p, dots.agent)).toEqual(["muse"]);
    expect(names(p, scout.agent)).toEqual([]);
  });

  test("list_agents over the API carries the address, the owner and the Porticos in common", async () => {
    const { p, muse } = await world();
    const res = await callAs(p, muse, "GET", "/api/agent/agents");
    const { agents } = (await res.json()) as { agents: { name: string; address: string; owner: string; porticos: { name: string }[] }[] };
    expect(agents.map((a) => [a.name, a.address, a.owner, a.porticos.map((w) => w.name)]).sort()).toEqual([
      ["grok-bot", "grok-bot", "Chris", ["Chris's Portico"]],
      ["robert/muse", "robert/muse", "Robert", ["Launch"]],
    ]);
  });

  test("a plain name always means one of the sender's owner's own agents", async () => {
    const { p, muse, grok, rmuse, dots } = await world();
    expect(p.agents.resolve("muse", grok.agent.id).id).toBe(muse.agent.id);
    expect(p.agents.resolve("muse", dots.agent.id).id).toBe(rmuse.agent.id);
    expect(p.agents.resolve("chris/muse", grok.agent.id).id).toBe(muse.agent.id);
    expect(p.agents.resolve("robert/muse", muse.agent.id).id).toBe(rmuse.agent.id);
    expect(p.agents.resolve("chris/muse", rmuse.agent.id).id).toBe(muse.agent.id);
  });

  test("an agent out of reach answers exactly as a name nobody has", async () => {
    const { p, muse, grok } = await world();
    const message = (to: string, from: Agent) => {
      try {
        p.agents.resolve(to, from.id);
        return "found";
      } catch (err) {
        return (err as Error).message.replace(`"${to}"`, '"X"');
      }
    };
    const nobody = message("robert/nobody", muse.agent);
    expect(nobody).toBe('No agent named "X". Valid agents: grok-bot, robert/muse.');
    // dots exists but shares no workspace with muse; scout's owner shares none; one handle doesn't exist at all.
    for (const to of ["robert/dots", "maya/scout", "nobody/muse", "dots", "scout"]) expect(message(to, muse.agent)).toBe(nobody);
    // grok-bot isn't in Launch, so Robert's muse is out of its reach though Chris's muse reaches it.
    expect(message("robert/muse", grok.agent)).toBe('No agent named "X". Valid agents: muse.');
    expect(errorCode(() => p.agents.resolve("robert/dots", muse.agent.id))).toBe("unknown_agent");
  });

  test("a message goes only to an agent the sender reaches, and its thread records the workspace", async () => {
    const { p, chris, muse, grok, rmuse, launch } = await world();
    expect(say(p, muse.agent, "robert/muse").toId).toBe(rmuse.agent.id);
    expect(p.messages.threadsBetween(muse.agent.id, rmuse.agent.id).map((t) => t.workspaceId)).toEqual([launch.id]);
    expect(say(p, muse.agent, "grok-bot").toId).toBe(grok.agent.id);
    expect(p.messages.threadsBetween(muse.agent.id, grok.agent.id).map((t) => t.workspaceId)).toEqual([p.workspaces.personal(chris.id).id]);
    expect(errorCode(() => say(p, grok.agent, "robert/muse"))).toBe("unknown_agent");
    expect(errorCode(() => say(p, muse.agent, "robert/dots"))).toBe("unknown_agent");
    expect(errorCode(() => say(p, muse.agent, "maya/scout"))).toBe("unknown_agent");
  });

  test("when two agents stop sharing a workspace the conversation stays readable and takes nothing new", async () => {
    const { p, robert, muse, rmuse, launch } = await world();
    const ask = say(p, muse.agent, "robert/muse", "Fares?");
    expect(p.messages.inbox(rmuse.agent).messages.map((m) => m.id)).toEqual([ask.id]);
    const answer = p.messages.send(rmuse.agent, { replyTo: ask.id, subject: "Re", text: "x" }).message;
    p.workspaces.removeAgent(robert.id, launch.id, rmuse.agent.id);

    // A reply names no agent, so the reach check, not the name lookup, has to stop it. Both directions.
    expect(errorCode(() => p.messages.send(muse.agent, { replyTo: answer.id, subject: "More", text: "x" }))).toBe("not_allowed");
    expect(errorCode(() => p.messages.send(rmuse.agent, { replyTo: ask.id, subject: "More", text: "x" }))).toBe("not_allowed");
    // A plain refusal, said only because the two shared a Portico once.
    expect(() => say(p, muse.agent, "robert/muse")).toThrow("You and `robert/muse` no longer share a Portico. list_agents shows who can be reached now.");
    expect(errorCode(() => say(p, muse.agent, "robert/muse"))).toBe("not_allowed");
    expect(names(p, muse.agent)).toEqual(["grok-bot"]);

    // What was sent before still arrives and can be read, by the agents and over the API.
    expect(p.messages.inbox(muse.agent).messages.map((m) => m.id)).toEqual([answer.id]);
    const [thread] = p.messages.threadsBetween(muse.agent.id, rmuse.agent.id);
    expect(p.messages.inThread(thread!).messages).toHaveLength(2);
    // Robert's agent left the workspace, and still reads what it said there.
    expect(p.messages.threadsBetween(rmuse.agent.id, muse.agent.id).map((t) => t.id)).toEqual([thread!.id]);
    const task = (await (await callAs(p, muse, "GET", `/api/agent/tasks/${ask.id}`)).json()) as { task: { with: string } };
    expect(task.task.with).toBe("robert/muse");

    // Back in a workspace together, the same thread carries on.
    p.workspaces.addAgent(robert.id, launch.id, rmuse.agent.id);
    expect(p.messages.send(muse.agent, { replyTo: answer.id, subject: "More", text: "x" }).message.threadId).toBe(thread!.id);
  });

  test("a thread never moves: when its workspace goes, the thread is read-only and the two start a new one in another they share", async () => {
    const { p, chris, robert, muse, rmuse, launch } = await world();
    const first = say(p, muse.agent, "robert/muse");
    const second = p.workspaces.create(robert.id, "Second");
    p.workspaces.admit(second.id, chris.id);
    p.workspaces.addAgent(chris.id, second.id, muse.agent.id);
    p.workspaces.addAgent(robert.id, second.id, rmuse.agent.id);
    // A reply stays in the workspace of the message it answers.
    const reply = p.messages.send(rmuse.agent, { replyTo: first.id, subject: "Re", text: "x" });
    expect(reply.message).toMatchObject({ workspaceId: launch.id, threadId: first.threadId, rootId: first.id });
    expect(reply.note).toBeNull();
    p.workspaces.remove(chris.id, launch.id);
    const [old] = p.messages.threadsBetween(muse.agent.id, rmuse.agent.id);
    expect(old).toMatchObject({ id: first.threadId, workspaceId: launch.id });
    // The reply can't go where the conversation was, so the message starts a new conversation and says so.
    p.clock.advance(60_000);
    const next = p.messages.send(muse.agent, { replyTo: reply.message.id, subject: "More", text: "x" });
    expect(next.message).toMatchObject({ workspaceId: second.id, replyTo: null, rootId: next.message.id });
    expect(next.message.threadId).not.toBe(first.threadId);
    expect(next.note).toContain("read-only");
    expect(next.note).toContain("a new conversation in the Second Portico");
    expect(p.messages.threadsBetween(muse.agent.id, rmuse.agent.id).map((t) => t.workspaceId)).toEqual([second.id, launch.id]);
    // The old thread is still read, with nothing new in it.
    expect(p.messages.inThread(old!).messages.map((m) => m.id)).toEqual([first.id, reply.message.id]);
  });

  test("messages name the other agent as the reader addresses that agent", async () => {
    const { p, muse, rmuse } = await world();
    const sent = (await (await callAs(p, muse, "POST", "/api/agent/messages", { to: "robert/muse", subject: "Hi", text: "x" })).json()) as {
      message: { from: string; to: string };
    };
    expect([sent.message.from, sent.message.to]).toEqual(["muse", "robert/muse"]);
    const inbox = (await (await callAs(p, rmuse, "GET", "/api/agent/inbox")).json()) as { messages: { from: string; to: string; framed_message: string }[] };
    expect([inbox.messages[0]!.from, inbox.messages[0]!.to]).toEqual(["chris/muse", "muse"]);
    expect(inbox.messages[0]!.framed_message).toContain('from="chris/muse"');
  });

  test("a held message's note and the tasks list use the same names", async () => {
    const { p, robert, muse, rmuse } = await world();
    p.agents.update(robert.id, rmuse.agent.id, { approvalRequired: true });
    const { note, delivery } = p.messages.send(muse.agent, { to: "robert/muse", subject: "Hi", text: "x" });
    expect(delivery).toBe("held");
    expect(note).toContain("Held: robert/muse requires approval");
    const tasks = (await (await callAs(p, muse, "GET", "/api/agent/tasks")).json()) as { tasks: { with: string }[] };
    expect(tasks.tasks.map((t) => t.with)).toEqual(["robert/muse"]);
    expect(errorCode(() => p.agents.resolve("robert/dots", muse.agent.id))).toBe("unknown_agent");
  });

  test("list_tasks with a name out of reach finds nothing to name", async () => {
    const { p, muse } = await world();
    const res = await callAs(p, muse, "GET", "/api/agent/tasks?with=robert/dots");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("unknown_agent");
  });
});

describe("names with workspaces", () => {
  test("a name is unique among one owner's agents, not across people", async () => {
    const { p, chris, robert } = await world();
    expect(errorCode(() => p.agents.create({ ownerId: chris.id, name: "muse", kind: "muse", type: "app" }))).toBe("conflict");
    expect(p.agents.nameFree("muse", chris.id)).toBe(false);
    expect(p.agents.nameFree("dots", chris.id)).toBe(true);
    expect(p.agents.create({ ownerId: chris.id, name: "dots", kind: "dots", type: "app" }).name).toBe("dots");
    const { agent: scout } = addAppAgent(p, robert, "scout");
    expect(errorCode(() => p.agents.update(robert.id, scout.id, { name: "dots" }))).toBe("conflict");
    expect(p.agents.update(robert.id, scout.id, { name: "grok-bot" }).name).toBe("grok-bot");
  });

  test("a name one person let go is free for another at once", async () => {
    const { p, chris, robert, grok } = await world();
    p.agents.remove(chris.id, grok.agent.id);
    expect(p.agents.create({ ownerId: robert.id, name: "grok-bot", kind: "grok-bot", type: "app" }).ownerId).toBe(robert.id);
  });

  test("a session is addressed by its short name, or name@computer when its owner has two of the name", async () => {
    const { p, chris, robert, muse, rmuse, launch } = await world();
    const { computer: macbook } = addComputer(p, chris, "macbook");
    const { computer: studio } = addComputer(p, chris, "studio");
    const { agent: api } = addSession(p, macbook, { repo: "api" });
    p.workspaces.addAgent(chris.id, launch.id, api.id);
    expect(names(p, rmuse.agent).sort()).toEqual(["chris/api-claude", "chris/muse", "dots"]);
    expect(p.agents.resolve("chris/api-claude", rmuse.agent.id).id).toBe(api.id);
    expect(p.agents.resolve("chris/api-claude@macbook", rmuse.agent.id).id).toBe(api.id);
    expect(p.agents.resolve("api-claude", muse.agent.id).id).toBe(api.id);
    expect(p.agents.entriesFor(rmuse.agent).find((e) => e.agent.id === api.id)?.address).toBe("chris/api-claude@macbook");

    // Robert's own session of the same name doesn't disturb Chris's short name.
    const { computer: rmac } = addComputer(p, robert, "robert-mac");
    const { agent: rapi } = addSession(p, rmac, { repo: "api" });
    expect(p.agents.display(api)).toBe("api-claude");
    expect(p.agents.resolve("api-claude", rmuse.agent.id).id).toBe(rapi.id);

    // A second one of Chris's own does: both then go by name@computer, and the short name names neither.
    const { agent: api2 } = addSession(p, studio, { repo: "api" });
    p.workspaces.addAgent(chris.id, launch.id, api2.id);
    expect(names(p, rmuse.agent)).toContain("chris/api-claude@macbook");
    expect(names(p, rmuse.agent)).toContain("chris/api-claude@studio");
    expect(p.agents.resolve("chris/api-claude@studio", rmuse.agent.id).id).toBe(api2.id);
    let said = "";
    try {
      p.agents.resolve("chris/api-claude", rmuse.agent.id);
    } catch (err) {
      said = (err as Error).message;
    }
    expect(said).toBe('"chris/api-claude" is on 2 computers. Use one of: chris/api-claude@macbook, chris/api-claude@studio.');
    // Only one of the two in reach: the short name finds it, and says nothing of the other.
    p.workspaces.removeAgent(chris.id, launch.id, api2.id);
    expect(p.agents.resolve("chris/api-claude", rmuse.agent.id).id).toBe(api.id);
  });
});

describe("what a person reads with workspaces", () => {
  const get = async <T>(p: TestPortico, person: Person, path: string) => {
    const res = await callPerson(p, signIn(p, person), "GET", path);
    return { status: res.status, body: (await res.json()) as T };
  };

  test("a person reads a conversation only when one of the person's own agents is in it, the owner included", async () => {
    const { p, chris, robert, maya, muse, grok, rmuse, dots } = await world();
    const shared = say(p, muse.agent, "robert/muse", "Shared");
    const mine = say(p, muse.agent, "grok-bot", "Mine");
    const theirs = say(p, rmuse.agent, "dots", "Theirs");
    const subjects = async (person: Person) =>
      (await get<{ tasks: { subject: string }[] }>(p, person, "/api/tasks")).body.tasks.map((t) => t.subject).sort();
    // Chris owns Portico and the workspace, and still doesn't read Robert's own conversation.
    expect(await subjects(chris)).toEqual(["Mine", "Shared"]);
    expect(await subjects(robert)).toEqual(["Shared", "Theirs"]);
    expect(await subjects(maya)).toEqual([]);

    const threads = async (person: Person) => (await get<{ threads: { id: string }[] }>(p, person, "/api/threads")).body.threads.map((t) => t.id).sort();
    expect(await threads(chris)).toEqual([shared.threadId, mine.threadId].sort());
    expect(await threads(maya)).toEqual([]);
    expect((await get(p, chris, `/api/threads/${theirs.threadId}`)).status).toBe(404);
    expect((await get(p, chris, `/api/tasks/${theirs.id}`)).status).toBe(404);
    expect((await get(p, maya, `/api/threads/${shared.threadId}`)).status).toBe(404);
    expect((await get(p, robert, `/api/threads/${shared.threadId}`)).status).toBe(200);
    expect((await get(p, chris, `/api/tasks/${shared.id}`)).status).toBe(200);
    expect(grok.agent.ownerId).toBe(chris.id);
    expect(dots.agent.ownerId).toBe(robert.id);
  });

  test("a person sees the agents and people of the person's own workspaces, named as the person's agents address them", async () => {
    const { p, chris, robert, maya, dots, scout } = await world();
    const agents = async (person: Person) =>
      (await get<{ agents: { display: string }[] }>(p, person, "/api/agents")).body.agents.map((a) => a.display).sort();
    expect(await agents(chris)).toEqual(["grok-bot", "muse", "robert/muse"]);
    expect(await agents(robert)).toEqual(["chris/muse", "dots", "muse"]);
    expect(await agents(maya)).toEqual(["scout"]);
    expect((await get(p, chris, `/api/agents/${dots.agent.id}`)).status).toBe(404);
    expect((await get(p, chris, `/api/agents/${scout.agent.id}`)).status).toBe(404);
    expect((await get(p, maya, `/api/agents/${scout.agent.id}`)).status).toBe(200);

    const people = async (person: Person) => (await get<{ people: { name: string }[] }>(p, person, "/api/people")).body.people.map((x) => x.name).sort();
    expect(await people(robert)).toEqual(["Chris", "Robert"]);
    expect(await people(maya)).toEqual(["Maya"]);
    // Chris owns this server, with its own sign-in, so Chris also lists every account: accounts, not conversations.
    expect(await people(chris)).toEqual(["Chris", "Maya", "Robert"]);
  });

  test("a file is read by the people whose agents sent or received it, the owner included", async () => {
    const { p, chris, robert, maya, rmuse } = await world();
    const { file } = await p.files.createUpload(rmuse.agent, { name: "notes.txt", text: "hello" });
    p.messages.send(rmuse.agent, { to: "dots", subject: "Notes", text: "x", attachments: [file.id] });
    const stored = p.files.forPerson(robert, file.id)!;
    expect(stored.workspaceId).toBe(p.workspaces.personal(robert.id).id);
    expect(p.files.personMayDownload(robert, stored)).toBe(true);
    expect(p.files.personMayDownload(chris, stored)).toBe(false);
    expect(p.files.personMayDownload(maya, stored)).toBe(false);
    expect(p.files.forPerson(chris, file.id)).toBeNull();
    expect(p.files.forPerson(maya, file.id)).toBeNull();
  });
});
