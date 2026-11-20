import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { uploadKey, workspaceFileKey } from "../src/core/file-store";
import { LOOP_LIMIT } from "../src/core/guards";
import { LIMITS } from "../src/core/limits";
import type { Agent, Person, Workspace } from "../src/core/types";
import { CONTENT, DIRECTORY, FRESH_FOLDER, SchemaMismatchError } from "../src/db";
import { acquaint, addAppAgent, callAs, callPerson, DAY, errorCode, fakeBucket, flush, HOUR, makePortico, MINUTE, signIn, type TestPortico } from "./helpers";

type Opts = Parameters<typeof makePortico>[0];

/** A person with a handle, as hosted Portico's welcome page leaves one. */
async function person(p: TestPortico, name: string): Promise<Person> {
  const made = p.people.create({ name, role: p.people.owner() ? "member" : "owner", status: "active", passwordHash: "x" });
  return p.people.setHandle(made.id, name.toLowerCase());
}

/** A shared workspace owned by the first person, with the others admitted and the agents put in by their owners. */
function shared(p: TestPortico, name: string | undefined, people: Person[], agents: Agent[]): Workspace {
  const workspace = p.workspaces.create(people[0]!.id, name);
  for (const other of people.slice(1)) p.workspaces.admit(workspace.id, other.id);
  for (const agent of agents) p.workspaces.addAgent(agent.ownerId, workspace.id, agent.id);
  // These tests are about where content lives: nobody's first message is held, and Portico's own notices are read.
  acquaint(p, ...people.map((one) => one.id));
  for (const agent of agents) p.agentNotices.take(agent.id);
  // Each workspace is made at its own time, so "the oldest" is never a tie.
  p.clock.advance(MINUTE);
  return workspace;
}

/**
 * The plan's worked example. Chris has grok, code and muse. "Launch" is the oldest shared workspace, with Chris,
 * Robert, Bill and Dana and one agent of each (and Chris's muse); "Chris and Robert" came later, with grok and
 * `robert/dots`; "Later" holds Chris, Robert and Bill, with grok and `bill/scout`.
 */
async function world(opts: Opts = {}) {
  const p = makePortico(opts);
  const chris = await person(p, "Chris");
  const robert = await person(p, "Robert");
  const bill = await person(p, "Bill");
  const dana = await person(p, "Dana");
  const grok = addAppAgent(p, chris, "grok", { kind: "grok-bot" });
  const code = addAppAgent(p, chris, "code");
  const muse = addAppAgent(p, chris, "muse");
  const dots = addAppAgent(p, robert, "dots", { kind: "dots" });
  const scout = addAppAgent(p, bill, "scout");
  const dmuse = addAppAgent(p, dana, "muse");
  const personal = p.workspaces.personal(chris.id);
  p.clock.advance(MINUTE);
  const launch = shared(p, "Launch", [chris, robert, bill, dana], [grok.agent, muse.agent, dots.agent, scout.agent, dmuse.agent]);
  const pair = shared(p, undefined, [chris, robert], [grok.agent, dots.agent]);
  const later = shared(p, "Later", [chris, robert, bill], [grok.agent, scout.agent]);
  return { p, chris, robert, bill, dana, grok, code, muse, dots, scout, dmuse, personal, launch, pair, later };
}

const say = (p: TestPortico, from: { agent: Agent }, to: string, subject = "Hello", extra: Record<string, unknown> = {}) =>
  p.messages.send(from.agent, { to, subject, text: `${subject} text`, ...extra }).message;
const reply = (p: TestPortico, from: { agent: Agent }, to: string, subject = "Re", extra: Record<string, unknown> = {}) =>
  p.messages.send(from.agent, { replyTo: to, subject, text: `${subject} text`, ...extra });

/** What one content database holds, read straight from it. */
function held(db: Database) {
  const column = (sql: string) => (db.query(sql).all() as { v: string }[]).map((row) => row.v).sort();
  return {
    threads: column("SELECT id AS v FROM threads"),
    messages: column("SELECT id AS v FROM messages"),
    subjects: column("SELECT subject AS v FROM messages"),
    files: column("SELECT id AS v FROM files"),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "portico-data-"));
}

/** Every file under a folder, as paths from the folder. */
function filesUnder(dir: string, from = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path, from) : [relative(from, path)];
  });
}

describe("where a conversation goes", () => {
  test("the most private workspace the two share: the owner's own, then one with only the two people, then the oldest", async () => {
    const { p, grok, code, muse, dots, scout, dmuse, personal, launch, pair } = await world();
    // One person's own agents: the personal workspace, though grok and muse are both in Launch too.
    expect(say(p, grok, "code").workspaceId).toBe(personal.id);
    expect(say(p, grok, "muse").workspaceId).toBe(personal.id);
    expect(p.workspaces.shared(grok.agent.id, muse.agent.id).map((w) => w.id)).toEqual([personal.id, launch.id]);
    // Chris's and Robert's agents: the workspace with only those two people, though Launch is older.
    expect(p.workspaces.shared(grok.agent.id, dots.agent.id).map((w) => w.name)).toEqual(["Launch", "Chris and Robert"]);
    expect(say(p, grok, "robert/dots").workspaceId).toBe(pair.id);
    expect(say(p, dots, "chris/grok").workspaceId).toBe(pair.id);
    // Chris's and Bill's agents share Launch and Later, and neither holds only the two: the oldest.
    expect(p.workspaces.shared(grok.agent.id, scout.agent.id).map((w) => w.name)).toEqual(["Launch", "Later"]);
    expect(say(p, grok, "bill/scout").workspaceId).toBe(launch.id);
    // Robert's and Bill's agents meet only in Launch. So do Chris's muse and Robert's dots.
    expect(say(p, dots, "bill/scout").workspaceId).toBe(launch.id);
    expect(say(p, muse, "robert/dots").workspaceId).toBe(launch.id);
    expect(say(p, dmuse, "chris/grok").workspaceId).toBe(launch.id);
    // Nothing joins code and anyone outside Chris's own workspace.
    expect(errorCode(() => say(p, code, "robert/dots"))).toBe("unknown_agent");
    expect(code.agent.ownerId).toBe(grok.agent.ownerId);
  });

  test("a message and its thread say which workspace holds them, and the send result names the thread there", async () => {
    const { p, grok, dots, pair } = await world();
    const sent = say(p, grok, "robert/dots");
    const thread = p.messages.thread({ agent: grok.agent.id }, sent.threadId)!;
    expect(thread).toMatchObject({ workspaceId: pair.id, startedBy: grok.agent.id });
    expect(p.messages.get({ agent: dots.agent.id }, sent.id)).toMatchObject({ id: sent.id, workspaceId: pair.id });
    expect(p.tasks.get({ agent: dots.agent.id }, sent.id)!.task.workspaceId).toBe(pair.id);
  });

  test("a reply stays in the workspace of the message it answers, even where a new conversation would go elsewhere", async () => {
    const { p, chris, robert, grok, dots, launch, pair } = await world();
    // The two talked in Launch before the workspace with only the two of them took over new conversations.
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    const first = say(p, grok, "robert/dots", "In Launch");
    expect(first.workspaceId).toBe(launch.id);
    p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
    expect(say(p, grok, "robert/dots", "New").workspaceId).toBe(pair.id);

    const answer = reply(p, dots, first.id, "Answer");
    expect(answer.message).toMatchObject({ workspaceId: launch.id, threadId: first.threadId, replyTo: first.id, rootId: first.id });
    expect(answer.note).toBeNull();
    const more = reply(p, grok, answer.message.id, "More");
    expect(more.message).toMatchObject({ workspaceId: launch.id, threadId: first.threadId, rootId: first.id });
    expect(robert.id).toBe(dots.agent.ownerId);
  });

  test("a pair has one thread in each workspace the two have talked through", async () => {
    const { p, chris, robert, grok, dots, launch, pair } = await world();
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    const inLaunch = say(p, grok, "robert/dots", "In Launch");
    p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
    p.clock.advance(MINUTE);
    const inPair = say(p, grok, "robert/dots", "In the pair");
    expect(inPair.threadId).not.toBe(inLaunch.threadId);
    // The latest message first, from either side.
    for (const [x, y] of [
      [grok, dots],
      [dots, grok],
    ] as const) {
      expect(p.messages.threadsBetween(x.agent.id, y.agent.id).map((t) => [t.id, t.workspaceId])).toEqual([
        [inPair.threadId, pair.id],
        [inLaunch.threadId, launch.id],
      ]);
    }
    // Each person's thread list shows both, and each thread pages its own messages only.
    for (const who of [chris, robert]) {
      const res = await callPerson(p, signIn(p, who), "GET", "/api/threads");
      const { threads } = (await res.json()) as { threads: { id: string; count: number }[] };
      expect(threads.map((t) => [t.id, t.count])).toEqual([
        [inPair.threadId, 1],
        [inLaunch.threadId, 1],
      ]);
    }
    const page = await callPerson(p, signIn(p, chris), "GET", `/api/threads/${inLaunch.threadId}`);
    expect(((await page.json()) as { messages: { subject: string }[] }).messages.map((m) => m.subject)).toEqual(["In Launch"]);
    // One more in each lands in the thread that workspace already has.
    expect(say(p, dots, "chris/grok", "Again").threadId).toBe(inPair.threadId);
    expect(reply(p, dots, inLaunch.id).message.threadId).toBe(inLaunch.threadId);
  });

  test("once a conversation's workspace stops joining the two, the conversation is read-only and the next message starts a new one", async () => {
    const { p, chris, grok, dots, launch, pair } = await world();
    const first = say(p, grok, "robert/dots", "Plan");
    expect(first.workspaceId).toBe(pair.id);
    const answer = reply(p, dots, first.id, "Plan answer").message;
    // Chris takes grok out of the workspace the conversation is in. Launch still joins the two.
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    p.clock.advance(MINUTE);
    const next = reply(p, grok, answer.id, "Follow-up");
    expect(next.message).toMatchObject({ workspaceId: launch.id, replyTo: null, rootId: next.message.id });
    expect(next.message.threadId).not.toBe(first.threadId);
    expect(next.note).toContain("no longer joins this agent and robert/dots");
    expect(next.note).toContain("read-only");
    expect(next.note).toContain("new conversation in the Portico “Launch”");
    // The same from the other side, and over the API the note comes back with the message.
    const res = await callAs(p, dots, "POST", "/api/agent/messages", { reply_to: first.id, subject: "Late answer", text: "x" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { message: { id: string; reply_to: string | null }; note?: string };
    expect(body.message.reply_to).toBeNull();
    expect(body.note).toContain("read-only");
    expect(p.messages.get({ agent: dots.agent.id }, body.message.id)!.workspaceId).toBe(launch.id);
    // Nothing new went into the old thread, which both sides still read.
    const old = p.messages.thread({ agent: grok.agent.id }, first.threadId)!;
    expect(p.messages.inThread(old).messages.map((m) => m.subject)).toEqual(["Plan", "Plan answer"]);
    expect(p.messages.thread({ agent: dots.agent.id }, first.threadId)).not.toBeNull();
    // A retry of the moved reply under its key is still the same message, not a second one.
    const keyed = reply(p, grok, answer.id, "Keyed", { key: "k-moved" });
    expect(keyed.message.replyTo).toBeNull();
    expect(reply(p, grok, answer.id, "Keyed", { key: "k-moved" }).message.id).toBe(keyed.message.id);
    // An update with more to come needs a conversation to update, and gets one in the new workspace all the same.
    expect(reply(p, grok, answer.id, "Still on it", { done: false }).message.workspaceId).toBe(launch.id);
  });

  test("when the two share nothing any more, the send is refused as before and the conversation stays readable", async () => {
    const { p, chris, robert, grok, dots, launch, pair } = await world();
    const first = say(p, grok, "robert/dots", "Plan");
    p.workspaces.removePerson(chris.id, pair.id, robert.id);
    p.workspaces.removeAgent(robert.id, launch.id, dots.agent.id);
    expect(errorCode(() => reply(p, grok, first.id))).toBe("not_allowed");
    expect(errorCode(() => reply(p, dots, first.id))).toBe("not_allowed");
    expect(errorCode(() => say(p, grok, "robert/dots"))).toBe("not_allowed");
    // Robert is out of the workspace, and Robert's agent still reads what was said there.
    expect(p.workspaces.forPerson(robert.id).map((w) => w.id)).not.toContain(pair.id);
    // What was still on its way is withdrawn: never delivered, and the sender hears so once.
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    expect(p.messages.inbox(grok.agent).updates.map((m) => [m.id, m.status])).toEqual([[first.id, "withdrawn"]]);
    expect(p.messages.threads({ person: robert.id }, { involving: [dots.agent.id] }).map((t) => t.id)).toEqual([first.threadId]);
    const task = await callAs(p, dots, "GET", `/api/agent/tasks/${first.id}`);
    expect(task.status).toBe(200);
  });
});

describe("a caller's content is a small set of workspaces", () => {
  test("a lookup by ID finds only what is in the caller's own workspaces", async () => {
    const { p, chris, robert, bill, dana, grok, code, dots, scout, dmuse, personal, pair, launch } = await world();
    const own = say(p, grok, "code", "Own");
    const paired = say(p, grok, "robert/dots", "Paired");
    const wide = say(p, dots, "bill/scout", "Wide");
    expect(p.content.workspaceIds({ agent: code.agent.id })).toEqual([personal.id]);
    expect(p.content.workspaceIds({ agent: dots.agent.id })).toEqual([p.workspaces.personal(robert.id).id, launch.id, pair.id]);
    expect(p.content.workspaceIds({ person: dana.id }).sort()).toEqual([p.workspaces.personal(dana.id).id, launch.id].sort());

    const finds = (scope: Parameters<typeof p.messages.get>[0]) => [own, paired, wide].map((m) => p.messages.get(scope, m.id) !== null);
    expect(finds({ agent: grok.agent.id })).toEqual([true, true, true]);
    expect(finds({ agent: code.agent.id })).toEqual([true, false, false]);
    expect(finds({ agent: dots.agent.id })).toEqual([false, true, true]);
    expect(finds({ person: bill.id })).toEqual([false, false, true]);
    expect(finds({ workspace: pair.id })).toEqual([false, true, false]);
    // Narrowing to a workspace outside the caller's set gives nothing, not that workspace.
    expect(finds({ person: bill.id, workspace: pair.id })).toEqual([false, false, false]);
    expect(finds({ agent: scout.agent.id, workspace: launch.id })).toEqual([false, false, true]);

    // Launch holds a conversation between Robert's and Bill's agents. Chris and Dana are in Launch, and it isn't theirs.
    for (const [who, status] of [
      [chris, 404],
      [dana, 404],
      [robert, 200],
      [bill, 200],
    ] as const) {
      const cookie = signIn(p, who);
      expect((await callPerson(p, cookie, "GET", `/api/tasks/${wide.id}`)).status).toBe(status);
      expect((await callPerson(p, cookie, "GET", `/api/threads/${wide.threadId}`)).status).toBe(status);
    }
    // An agent in the same workspace asks for the task by ID, and by a reply_to, and learns nothing.
    expect((await callAs(p, dmuse, "GET", `/api/agent/tasks/${wide.id}`)).status).toBe(404);
    expect((await callAs(p, grok, "GET", `/api/agent/tasks/${wide.id}`)).status).toBe(404);
    expect(errorCode(() => reply(p, dmuse, wide.id))).toBe("bad_request");
    expect(errorCode(() => reply(p, code, paired.id))).toBe("bad_request");
  });

  test("the inbox, the unread count and the delivery list merge every workspace, oldest first", async () => {
    const { p, grok, code, dots, scout, personal, pair, launch } = await world();
    const sent: [string, string][] = [];
    for (const [from, to, subject] of [
      [scout, "chris/grok", "From Launch"],
      [code, "grok", "From Chris's own"],
      [dots, "chris/grok", "From the pair"],
      [scout, "chris/grok", "From Launch again"],
    ] as const) {
      const m = say(p, from, to, subject);
      sent.push([m.subject, m.workspaceId]);
      p.clock.advance(MINUTE);
    }
    expect(sent.map(([, id]) => id)).toEqual([launch.id, personal.id, pair.id, launch.id]);
    expect(p.messages.unreadCount(grok.agent.id)).toBe(4);
    expect(p.messages.pending(grok.agent).messages.map((m) => [m.subject, m.workspaceId])).toEqual(sent);
    const inbox = (await (await callAs(p, grok, "GET", "/api/agent/inbox")).json()) as { messages: { subject: string }[] };
    expect(inbox.messages.map((m) => m.subject)).toEqual(sent.map(([subject]) => subject));
    expect(p.messages.unreadCount(grok.agent.id)).toBe(0);
    expect(p.messages.inbox(grok.agent).messages).toEqual([]);
    // Each was marked delivered in its own database.
    for (const id of [launch.id, personal.id, pair.id]) {
      expect(p.content.for(id).db.query("SELECT COUNT(*) AS n FROM messages WHERE status != 'delivered'").get()).toEqual({ n: 0 });
    }
  });

  test("a session's acknowledgement marks messages in whichever workspace each is in", async () => {
    const { p, grok, code, dots, scout } = await world();
    const ids = [say(p, scout, "chris/grok").id, say(p, code, "grok").id, say(p, dots, "chris/grok").id];
    expect(p.messages.ack(grok.agent, { messages: [...ids, "no-such-message"], updates: [] })).toEqual({ messages: 3, updates: 0 });
    p.clock.advance(MINUTE);
    expect(p.messages.ack(grok.agent, { messages: ids, updates: [] })).toEqual({ messages: 0, updates: 0 });
    // Nobody acknowledges another agent's messages.
    const other = say(p, grok, "robert/dots");
    expect(p.messages.ack(scout.agent, { messages: [other.id], updates: [] })).toEqual({ messages: 0, updates: 0 });
    expect(p.messages.get({ agent: dots.agent.id }, other.id)!.status).toBe("pending");
  });

  test("tasks merge across workspaces, newest first, for an agent and for a person, and filter by workspace", async () => {
    const { p, chris, robert, grok, dots, personal, pair, launch } = await world();
    const subjects: string[] = [];
    for (const [to, subject] of [
      ["code", "Own"],
      ["robert/dots", "Paired"],
      ["bill/scout", "Wide"],
      ["muse", "Own again"],
    ] as const) {
      say(p, grok, to, subject);
      subjects.unshift(subject);
      p.clock.advance(MINUTE);
    }
    const listed = (await (await callAs(p, grok, "GET", "/api/agent/tasks?outcome=all")).json()) as { tasks: { subject: string }[] };
    expect(listed.tasks.map((t) => t.subject)).toEqual(subjects);
    const mine = p.tasks.all({ person: chris.id }, { visible: [grok.agent.id] });
    expect(mine.map((t) => [t.subject, t.workspaceId])).toEqual([
      ["Own again", personal.id],
      ["Wide", launch.id],
      ["Paired", pair.id],
      ["Own", personal.id],
    ]);
    const page = await callPerson(p, signIn(p, chris), "GET", `/api/tasks?workspace=${pair.id}`);
    expect(((await page.json()) as { tasks: { subject: string }[] }).tasks.map((t) => t.subject)).toEqual(["Paired"]);
    // Robert sees the one task with Robert's agent, and nothing through a workspace filter that isn't Robert's.
    expect(p.tasks.all({ person: robert.id }, { visible: [dots.agent.id] }).map((t) => t.subject)).toEqual(["Paired"]);
    const foreign = await callPerson(p, signIn(p, robert), "GET", `/api/tasks?workspace=${personal.id}`);
    expect(((await foreign.json()) as { tasks: unknown[] }).tasks).toEqual([]);
  });

  test("held messages for a person come from every workspace, and Always allow decides each where it is", async () => {
    const { p, chris, grok, dots, launch, pair } = await world();
    p.agents.update(chris.id, grok.agent.id, { approvalRequired: true });
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    const inLaunch = say(p, dots, "chris/grok", "Held in Launch");
    p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
    p.clock.advance(MINUTE);
    const inPair = say(p, dots, "chris/grok", "Held in the pair");
    expect([inLaunch.status, inPair.status, inLaunch.workspaceId, inPair.workspaceId]).toEqual(["held", "held", launch.id, pair.id]);
    expect(p.approvals.heldFor(chris.id).map((m) => m.subject)).toEqual(["Held in Launch", "Held in the pair"]);
    const cards = (await (await callPerson(p, signIn(p, chris), "GET", "/api/porticos")).json()) as { workspaces: { name: string; needs: boolean }[] };
    expect(cards.workspaces.filter((w) => w.needs).map((w) => w.name).sort()).toEqual(["Chris and Robert", "Launch"]);

    p.approvals.decide(chris.id, inPair.id, "always_allow");
    expect(p.approvals.heldFor(chris.id)).toEqual([]);
    for (const m of [inLaunch, inPair]) expect(p.messages.get({ agent: grok.agent.id }, m.id)).toMatchObject({ status: "pending", decision: "always_allow" });
    expect(p.messages.inbox(grok.agent).messages.map((m) => m.subject)).toEqual(["Held in Launch", "Held in the pair"]);
  });

  test("a held message whose workspace stopped joining the two can only be turned down", async () => {
    const { p, chris, grok, dots, pair } = await world();
    p.agents.update(chris.id, grok.agent.id, { approvalRequired: true });
    const held = say(p, dots, "chris/grok", "Held");
    expect(held.workspaceId).toBe(pair.id);
    // Launch still joins the two, and the message isn't in Launch.
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    // The message is withdrawn with the agent's leaving: nothing is left to decide, and the sender hears so.
    expect(p.messages.get({ person: chris.id }, held.id)).toMatchObject({ status: "withdrawn" });
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "allow_once"))).toBe("wrong_status");
    expect(errorCode(() => p.approvals.decide(chris.id, held.id, "deny"))).toBe("wrong_status");
    expect(p.messages.inbox(dots.agent).updates.map((m) => m.status)).toEqual(["withdrawn"]);
  });

  test("the hourly limit counts a sender's messages in every workspace, and a key is found in any of them", async () => {
    const { p, grok } = await world();
    const receivers = ["code", "muse", "robert/dots", "bill/scout", "dana/muse"];
    let sent = 0;
    while (sent < LIMITS.messagesPerHour) {
      for (const to of receivers) for (let i = 0; i < 8 && sent < LIMITS.messagesPerHour; i++, sent++) say(p, grok, to, `n${sent}`, { key: `k${sent}` });
      p.clock.advance(11 * MINUTE);
    }
    const spread = p.content.workspaceIds({ agent: grok.agent.id }).map((id) => (p.content.find(id)?.db.query("SELECT COUNT(*) AS n FROM messages").get() as { n: number } | undefined)?.n ?? 0);
    expect(spread.filter((n) => n > 0)).toHaveLength(3);
    expect(spread.reduce((a, b) => a + b, 0)).toBe(LIMITS.messagesPerHour);
    for (const to of receivers) {
      let message = "";
      try {
        say(p, grok, to, "one too many");
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toContain(`${LIMITS.messagesPerHour} messages an hour`);
    }
    // A key used in one workspace is the same message when sent again, wherever a new conversation would go now.
    expect(say(p, grok, "bill/scout", "n24", { key: "k24" }).subject).toBe("n24");
    expect(errorCode(() => say(p, grok, "code", "n24", { key: "k24" }))).toBe("conflict");
  });

  test("the loop guard counts the two agents' messages across the workspaces the two share", async () => {
    const { p, chris, grok, dots, launch, pair } = await world();
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    const inLaunch = say(p, grok, "robert/dots", "In Launch");
    p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
    for (let i = 1; i < LOOP_LIMIT; i++) {
      const m = i % 2 ? reply(p, dots, inLaunch.id).message : say(p, grok, "robert/dots");
      expect(m.workspaceId).toBe(i % 2 ? launch.id : pair.id);
    }
    expect(errorCode(() => say(p, grok, "robert/dots"))).toBe("rate_limited");
    expect(errorCode(() => reply(p, dots, inLaunch.id))).toBe("rate_limited");
    p.clock.advance(11 * MINUTE);
    expect(say(p, grok, "robert/dots").workspaceId).toBe(pair.id);
  });
});

describe("removals, with no cascade between databases", () => {
  test("removing an agent deletes its threads and messages in every workspace it was in, and nothing else", async () => {
    const { p, chris, grok, code, dots, scout, personal, pair, launch } = await world();
    say(p, grok, "code", "Own");
    say(p, grok, "robert/dots", "Paired");
    say(p, grok, "bill/scout", "Wide");
    const kept = say(p, dots, "bill/scout", "Not grok's");
    const ownKept = say(p, code, "muse", "Not grok's either");
    // grok left the pair's workspace before going: past membership still names the workspace to clear.
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);

    p.agents.remove(chris.id, grok.agent.id);
    expect(held(p.content.for(pair.id).db)).toEqual({ threads: [], messages: [], subjects: [], files: [] });
    expect(held(p.content.for(launch.id).db).subjects).toEqual(["Not grok's"]);
    expect(held(p.content.for(personal.id).db).subjects).toEqual(["Not grok's either"]);
    expect(p.messages.get({ agent: scout.agent.id }, kept.id)).not.toBeNull();
    expect(p.messages.get({ agent: code.agent.id }, ownKept.id)).not.toBeNull();
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    expect(p.messages.inbox(scout.agent).messages.map((m) => m.subject)).toEqual(["Not grok's"]);
    expect(p.db.query("SELECT COUNT(*) AS n FROM workspace_agents WHERE agent_id = $id").get({ id: grok.agent.id })).toEqual({ n: 0 });
  });

  test("removing a computer clears its sessions' conversations", async () => {
    const { p, chris, code } = await world();
    const { computer } = p.computers.create(chris.id, "macbook");
    const { agent: session } = p.agents.registerSession(computer, { key: "run-1", repo: "api", folderId: "f".repeat(64), client: "claude-code" });
    const sent = p.messages.send(session, { to: "code", subject: "From the session", text: "x" }).message;
    expect(p.messages.get({ agent: code.agent.id }, sent.id)).not.toBeNull();
    p.agents.forget(p.computers.remove(computer.id));
    expect(p.agents.get(session.id)).toBeNull();
    expect(p.messages.get({ agent: code.agent.id }, sent.id)).toBeNull();
    expect(p.messages.inbox(code.agent).messages).toEqual([]);
  });

  test("removing a person clears the person's agents' conversations and archives the workspaces the person owns", async () => {
    const { p, chris, robert, bill, grok, dots, scout, launch, pair } = await world();
    const owned = shared(p, "Side project", [robert, bill], [dots.agent, scout.agent]);
    const mine = say(p, dots, "bill/scout", "In Robert's");
    expect(mine.workspaceId).toBe(owned.id);
    const others = say(p, scout, "robert/dots", "Bill's question");
    say(p, grok, "robert/dots", "Paired");
    const wide = say(p, grok, "bill/scout", "Wide");

    p.people.removeMember(chris.id, robert.id);
    expect(p.agents.get(dots.agent.id)).toBeNull();
    // Every conversation with Robert's agents is gone, wherever it was; the others' conversations stay.
    for (const id of [owned.id, pair.id]) expect(held(p.content.for(id).db).messages).toEqual([]);
    expect(held(p.content.for(launch.id).db).messages).toEqual([wide.id]);
    expect(p.messages.get({ agent: scout.agent.id }, others.id)).toBeNull();
    // Robert's workspace is archived, not left behind: nobody is in it or reaches through it.
    expect(p.workspaces.get(owned.id)).toBeNull();
    expect(p.workspaces.forPerson(bill.id).map((w) => w.id)).not.toContain(owned.id);
    expect(p.workspaces.archived().sort()).toEqual([owned.id, ...(p.db.query("SELECT id FROM workspaces WHERE (kind = 'personal' OR name = 'Shared') AND owner_id = $id").all({ id: robert.id }) as { id: string }[]).map((v) => v.id)].sort());
    // With nothing left in them, the next daily sweep drops the rows.
    expect(await p.sweepArchived()).toBe(3);
    expect(p.workspaces.archived()).toEqual([]);
  });

  test("threads a crash left with no agent are cleared by the daily sweep", async () => {
    const { p, grok, dots, scout, pair, launch } = await world();
    say(p, grok, "robert/dots", "Paired");
    const kept = say(p, grok, "bill/scout", "Wide");
    // As if the server stopped between the directory's delete and the content's.
    p.db.query("DELETE FROM agents WHERE id = $id").run({ id: dots.agent.id });
    expect(held(p.content.for(pair.id).db).messages).toHaveLength(1);
    expect(p.messages.prune()).toEqual({ messages: 0, threads: 1 });
    expect(held(p.content.for(pair.id).db)).toEqual({ threads: [], messages: [], subjects: [], files: [] });
    expect(held(p.content.for(launch.id).db).messages).toEqual([kept.id]);
    expect(scout.agent.id).toBe(kept.toId);
  });

  test("leaving a workspace keeps the row as past membership: no reach, no listing, and the conversations stay readable", async () => {
    const { p, chris, robert, grok, dots, pair, launch } = await world();
    const first = say(p, grok, "robert/dots", "Plan");
    p.workspaces.removeAgent(chris.id, pair.id, grok.agent.id);
    expect(p.db.query("SELECT left_at IS NOT NULL AS gone FROM workspace_agents WHERE workspace_id = $w AND agent_id = $a").get({ w: pair.id, a: grok.agent.id })).toEqual({ gone: 1 });
    expect(p.workspaces.agentsIn(pair.id)).toEqual([dots.agent.id]);
    expect(p.workspaces.hasAgent(pair.id, grok.agent.id)).toBe(false);
    expect(p.workspaces.ofAgent(grok.agent.id).map((w) => w.id)).not.toContain(pair.id);
    expect(p.workspaces.shared(grok.agent.id, dots.agent.id).map((w) => w.id)).toEqual([launch.id]);
    expect(p.content.workspaceIds({ agent: grok.agent.id })).toContain(pair.id);
    expect(p.messages.get({ person: chris.id }, first.id)).not.toBeNull();
    // Coming back takes the same row, and the conversation takes replies again.
    p.workspaces.addAgent(chris.id, pair.id, grok.agent.id);
    expect(p.db.query("SELECT COUNT(*) AS n, SUM(left_at IS NULL) AS here FROM workspace_agents WHERE workspace_id = $w AND agent_id = $a").get({ w: pair.id, a: grok.agent.id })).toEqual({ n: 1, here: 1 });
    expect(reply(p, dots, first.id).message.workspaceId).toBe(pair.id);
    // A person taken out leaves the same record for each of the person's agents there.
    p.workspaces.removePerson(chris.id, pair.id, robert.id);
    expect(p.workspaces.reach(grok.agent.id, dots.agent.id)).toBe(true);
    expect(p.workspaces.shared(grok.agent.id, dots.agent.id).map((w) => w.id)).toEqual([launch.id]);
    expect(p.content.workspaceIds({ person: robert.id })).toContain(pair.id);
    expect(p.messages.get({ person: robert.id }, first.id)).not.toBeNull();
  });
});

describe("on disk: a real data folder", () => {
  test("each workspace's content.db holds only its own threads, messages and files, and the directory holds no message at all", async () => {
    const dataDir = tempDir();
    const { p, grok, code, dots, scout, personal, pair, launch, later } = await world({ dataDir });
    const sentIn: Record<string, { threads: Set<string>; messages: string[]; subjects: string[]; files: string[] }> = {};
    const note = (m: { id: string; workspaceId: string; threadId: string; subject: string }, file?: string) => {
      const seen = (sentIn[m.workspaceId] ??= { threads: new Set(), messages: [], subjects: [], files: [] });
      seen.threads.add(m.threadId);
      seen.messages.push(m.id);
      seen.subjects.push(m.subject);
      if (file) seen.files.push(file);
    };
    // Traffic in three workspaces, each with words and a file found nowhere else.
    const plans: [{ agent: Agent }, string, string][] = [
      [grok, "code", "OWNMARK"],
      [grok, "robert/dots", "PAIRMARK"],
      [dots, "bill/scout", "LAUNCHMARK"],
    ];
    for (const [from, to, mark] of plans) {
      const { file } = await p.files.createUpload(from.agent, { name: `${mark}-notes.txt`, text: `${mark}-FILE-BYTES` });
      const first = say(p, from, to, `${mark} subject one`, { attachments: [file.id], summary: `${mark} summary` });
      note(first, file.id);
      const receiver = p.agents.require(first.toId);
      p.messages.inbox(receiver);
      note(p.messages.send(receiver, { replyTo: first.id, subject: `${mark} subject two`, text: `${mark} answer text` }).message);
      note(say(p, from, to, `${mark} subject three`));
    }
    await flush();
    await p.sweepFiles();
    expect(Object.keys(sentIn).sort()).toEqual([personal.id, pair.id, launch.id].sort());

    // The layout: one directory, and a folder per workspace that has content. Later has none, and no folder.
    const top = readdirSync(dataDir).filter((name) => !name.includes("-wal") && !name.includes("-shm")).sort();
    expect(top).toEqual(["portico.db", "porticos", "uploads"]);
    expect(readdirSync(join(dataDir, "porticos")).sort()).toEqual(Object.keys(sentIn).sort());
    expect(existsSync(join(dataDir, "porticos", later.id))).toBe(false);

    p.close();
    p.db.close();

    for (const [workspaceId, sent] of Object.entries(sentIn)) {
      const db = new Database(join(dataDir, "porticos", workspaceId, "content.db"), { readonly: true });
      expect(db.query("PRAGMA application_id").get()).toEqual({ application_id: CONTENT.applicationId });
      expect(held(db)).toEqual({
        threads: [...sent.threads].sort(),
        messages: [...sent.messages].sort(),
        subjects: [...sent.subjects].sort(),
        files: [...sent.files].sort(),
      });
      // Nothing in it points into the directory, and nothing names another workspace.
      expect((db.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual([
        "files",
        "message_files",
        "messages",
        "threads",
      ]);
      expect(db.query("SELECT COUNT(*) AS n FROM files WHERE source IS NOT NULL").get()).toEqual({ n: 0 });
      db.close();
      expect(readdirSync(join(dataDir, "porticos", workspaceId, "files")).sort()).toEqual([...sent.files].sort());
    }

    const directory = new Database(join(dataDir, "portico.db"), { readonly: true });
    expect(directory.query("PRAGMA application_id").get()).toEqual({ application_id: DIRECTORY.applicationId });
    const tables = (directory.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const table of ["messages", "threads", "message_files", "files"]) expect(tables).not.toContain(table);
    // No column anywhere in the directory holds a word of any message, summary or file.
    for (const table of tables) {
      const dump = JSON.stringify(directory.query(`SELECT * FROM ${table}`).all());
      for (const [, , mark] of plans) {
        if (table === "uploads") expect(dump.replaceAll(`${mark}-notes.txt`, "")).not.toContain(mark);
        else expect(dump).not.toContain(mark);
      }
    }
    directory.close();

    // Byte for byte: each mark is found only inside its own workspace's folder, and in the upload the file came from.
    const all = filesUnder(dataDir);
    const marks: [string, string][] = [
      ["OWNMARK", personal.id],
      ["PAIRMARK", pair.id],
      ["LAUNCHMARK", launch.id],
    ];
    for (const [mark, workspaceId] of marks) {
      const found = all.filter((path) => readFileSync(join(dataDir, path)).includes(mark));
      const own = `porticos${sep}${workspaceId}${sep}`;
      expect(found.length).toBeGreaterThan(1);
      for (const path of found) {
        const inUploads = path.startsWith(`uploads${sep}`) || path.startsWith("portico.db");
        expect(path.startsWith(own) || inUploads).toBe(true);
        // In the directory only as the upload's file name; in uploads only as the file's bytes.
        if (path.startsWith("portico.db")) expect(readFileSync(join(dataDir, path)).includes(`${mark} `)).toBe(false);
      }
      expect(found.some((path) => path === join("porticos", workspaceId, "content.db") || path.startsWith(`${own}content.db`))).toBe(true);
    }
    expect(code.agent.id).not.toBe(scout.agent.id);
  });

  test("a content database closes when idle and opens again on the next use; reading makes no folder", async () => {
    const dataDir = tempDir();
    const { p, chris, grok, dots, pair, later } = await world({ dataDir });
    // Lists and lookups over workspaces with no content make nothing on disk.
    expect(p.messages.inbox(grok.agent).messages).toEqual([]);
    expect(p.tasks.all({ person: chris.id }, { visible: null })).toEqual([]);
    expect(existsSync(join(dataDir, "porticos"))).toBe(false);

    const sent = say(p, grok, "robert/dots");
    expect(p.content.isOpen(pair.id)).toBe(true);
    expect(existsSync(join(dataDir, "porticos", pair.id, "content.db"))).toBe(true);
    p.clock.advance(9 * MINUTE);
    p.sweepMinute();
    await flush();
    expect(p.content.isOpen(pair.id)).toBe(true);
    p.clock.advance(2 * MINUTE);
    // The minute sweep closes the idle database, and its own passes over every workspace leave the database closed.
    p.sweepMinute();
    await flush();
    expect(p.content.isOpen(pair.id)).toBe(false);
    // The sweeps open a closed database, do their work, and close it again.
    p.clock.advance(4 * DAY);
    expect(p.messages.expireDue().map((m) => m.id)).toEqual([sent.id]);
    expect(p.content.isOpen(pair.id)).toBe(false);
    expect(p.messages.inbox(dots.agent).messages).toEqual([]);
    expect(p.content.isOpen(pair.id)).toBe(true);
    expect(p.messages.get({ agent: grok.agent.id }, sent.id)!.status).toBe("expired");
    expect(existsSync(join(dataDir, "porticos", later.id))).toBe(false);
    p.close();
    expect(p.content.isOpen(pair.id)).toBe(false);
    p.db.close();
  });

  test("a deleted workspace is archived, read-only until its history empties, and then its row, database, files and folder go", async () => {
    const dataDir = tempDir();
    const { p, chris, robert, grok, dots, pair, launch } = await world({ dataDir });
    const { file } = await p.files.createUpload(grok.agent, { name: "plan.txt", text: "the plan" });
    const first = say(p, grok, "robert/dots", "Plan", { attachments: [file.id] });
    expect(first.workspaceId).toBe(pair.id);
    p.messages.inbox(dots.agent);
    const answer = reply(p, dots, first.id, "Plan answer").message;
    await flush();
    const folder = join(dataDir, "porticos", pair.id);
    expect(existsSync(join(folder, "files", file.id))).toBe(true);
    const link = p.shares.create(chris.id, pair.id);

    p.workspaces.remove(chris.id, pair.id);
    // Gone for everyone: not listed, not found, nobody in it, its share links ended.
    expect(p.workspaces.get(pair.id)).toBeNull();
    expect(p.workspaces.forPerson(chris.id).map((w) => w.id)).not.toContain(pair.id);
    expect(p.workspaces.forPerson(robert.id).map((w) => w.id)).not.toContain(pair.id);
    expect(p.workspaces.agentsIn(pair.id)).toEqual([]);
    expect(p.shares.get(link.share.id)).toBeNull();
    expect((await callPerson(p, signIn(p, chris), "GET", `/api/porticos/${pair.id}`)).status).toBe(404);
    // The conversation is still read by both sides, files included, and takes nothing new: the next message starts
    // another conversation in Launch.
    expect(p.messages.inThread(p.messages.thread({ person: robert.id }, first.threadId)!).messages.map((m) => m.id)).toEqual([first.id, answer.id]);
    expect((await callAs(p, dots, "GET", `/api/agent/files/${file.id}`)).status).toBe(302);
    // What was on its way through the deleted Portico is withdrawn, never delivered.
    expect(p.messages.inbox(grok.agent).messages).toEqual([]);
    expect(p.messages.get({ agent: grok.agent.id }, answer.id)).toMatchObject({ status: "withdrawn" });
    const next = reply(p, grok, answer.id, "After the delete");
    expect(next.message).toMatchObject({ workspaceId: launch.id, replyTo: null });
    expect(next.note).toContain("read-only");

    // Not yet: the history window hasn't passed.
    p.clock.advance(29 * DAY);
    p.messages.expireDue();
    p.messages.prune();
    expect(await p.sweepArchived()).toBe(0);
    expect(existsSync(join(folder, "content.db"))).toBe(true);
    expect(p.workspaces.archived()).toEqual([pair.id]);

    p.clock.advance(2 * DAY);
    p.messages.expireDue();
    p.messages.prune();
    expect(await p.sweepArchived()).toBe(1);
    expect(existsSync(folder)).toBe(false);
    expect(p.workspaces.archived()).toEqual([]);
    expect(p.db.query("SELECT COUNT(*) AS n FROM workspaces WHERE id = $id").get({ id: pair.id })).toEqual({ n: 0 });
    expect(p.db.query("SELECT COUNT(*) AS n FROM workspace_agents WHERE workspace_id = $id").get({ id: pair.id })).toEqual({ n: 0 });
    expect(p.content.workspaceIds({ agent: grok.agent.id })).not.toContain(pair.id);
    expect(p.messages.get({ person: chris.id }, first.id)).toBeNull();
    // Launch, with the conversation that started after the delete, is untouched.
    expect(existsSync(join(dataDir, "porticos", launch.id, "content.db"))).toBe(true);
    p.close();
    p.db.close();
  });

  test("a folder a crash left with no workspace is removed by the sweep, and never opened for a caller", async () => {
    const dataDir = tempDir();
    const { p, chris, grok, pair } = await world({ dataDir });
    const sent = say(p, grok, "robert/dots");
    // As if the server stopped after the directory row went and before the folder did.
    p.db.query("DELETE FROM workspaces WHERE id = $id").run({ id: pair.id });
    expect(p.content.find(pair.id)).toBeNull();
    expect(() => p.content.for(pair.id)).toThrow();
    expect(p.messages.get({ workspace: pair.id }, sent.id)).toBeNull();
    expect(p.messages.get({ person: chris.id }, sent.id)).toBeNull();
    expect(p.content.orphans()).toEqual([pair.id]);
    expect(await p.sweepArchived()).toBe(1);
    expect(existsSync(join(dataDir, "porticos", pair.id))).toBe(false);
    p.close();
    p.db.close();
  });

  test("a data folder an earlier Portico made is refused with the fresh-folder message", () => {
    const dataDir = tempDir();
    const old = new Database(join(dataDir, "portico.db"));
    old.run("CREATE TABLE messages (id TEXT PRIMARY KEY, subject TEXT, text TEXT)");
    old.run("PRAGMA user_version = 110");
    old.close();
    let error: unknown;
    try {
      makePortico({ dataDir });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(SchemaMismatchError);
    expect((error as Error).message).toBe(FRESH_FOLDER);
    expect((error as Error).message).toContain("Start with a fresh data folder");
    expect(readdirSync(dataDir).sort()).toEqual(["portico.db"]);
  });
});

describe("files and workspaces", () => {
  test("a file attached from an upload lands under the workspace's own prefix, in a bucket as on disk", async () => {
    const bucket = fakeBucket();
    const { p, grok, dots, pair } = await world({ fileStore: bucket.store });
    const { file } = await p.files.createUpload(grok.agent, { name: "plan.txt", text: "the plan" });
    expect([...bucket.objects.keys()]).toEqual([uploadKey(file.id)]);
    expect(p.files.upload(file.id)).toMatchObject({ workspaceId: null, status: "ready" });

    const sent = say(p, grok, "robert/dots", "Plan", { attachments: [file.id] });
    // Inside the send's transaction: the workspace's own record, still reading from the upload.
    expect(p.files.of(sent)).toMatchObject([{ id: file.id, workspaceId: pair.id, source: uploadKey(file.id) }]);
    await flush();
    const own = workspaceFileKey(pair.id, file.id);
    expect(own).toBe(`porticos/${pair.id}/files/${file.id}`);
    expect(new TextDecoder().decode(bucket.objects.get(own))).toBe("the plan");
    expect(p.files.of(sent)).toMatchObject([{ id: file.id, workspaceId: pair.id, source: null }]);
    const got = await callAs(p, dots, "GET", `/api/agent/files/${file.id}`);
    expect(got.headers.get("location")).toStartWith(`https://bucket.example/${own}?`);
    // The upload itself goes by age: a day after it started, with the workspace's copy untouched.
    p.clock.advance(HOUR + MINUTE);
    await p.sweepFiles();
    expect(bucket.objects.has(uploadKey(file.id))).toBe(true);
    p.clock.advance(DAY);
    await p.sweepFiles();
    expect([...bucket.objects.keys()]).toEqual([own]);
    expect(p.files.upload(file.id)).toBeNull();
    expect((await callAs(p, dots, "GET", `/api/agent/files/${file.id}`)).status).toBe(302);
  });

  test("a received file passed on into another workspace is copied there, and each workspace keeps its own copy", async () => {
    const bucket = fakeBucket();
    const { p, chris, robert, grok, dots, scout, pair, launch } = await world({ fileStore: bucket.store });
    const { file } = await p.files.createUpload(grok.agent, { name: "plan.txt", text: "the plan" });
    const sent = say(p, grok, "robert/dots", "Plan", { attachments: [file.id] });
    await flush();
    // Only an agent that has the file can pass the file on.
    expect(errorCode(() => say(p, scout, "robert/dots", "Stolen", { attachments: [file.id] }))).toBe("bad_request");
    expect(p.files.forAgent(scout.agent, file.id)).toBeNull();
    // The upload is long gone by the time the receiver passes the file on.
    p.clock.advance(2 * DAY);
    await p.sweepFiles();
    expect(p.files.upload(file.id)).toBeNull();
    p.messages.inbox(dots.agent);

    const passed = say(p, dots, "bill/scout", "Passing on", { attachments: [file.id] });
    expect(passed.workspaceId).toBe(launch.id);
    expect(p.files.of(passed)).toMatchObject([{ id: file.id, workspaceId: launch.id, source: workspaceFileKey(pair.id, file.id), name: "plan.txt" }]);
    await flush();
    expect([...bucket.objects.keys()].sort()).toEqual([workspaceFileKey(launch.id, file.id), workspaceFileKey(pair.id, file.id)].sort());
    expect(new TextDecoder().decode(bucket.objects.get(workspaceFileKey(launch.id, file.id)))).toBe("the plan");
    expect(p.files.forAgent(scout.agent, file.id)).toMatchObject({ workspaceId: launch.id, source: null });
    // Having uploaded the file gives no way into Launch's copy: grok is in Launch, and not in that conversation.
    expect(p.files.agentMayDownload(grok.agent, p.files.forAgent(scout.agent, file.id)!)).toBe(false);
    expect(p.files.personMayDownload(chris, p.files.forAgent(scout.agent, file.id)!)).toBe(false);
    // Bill's agent reads Launch's copy; Chris's and Robert's agents still read the pair's.
    expect((await callAs(p, scout, "GET", `/api/agent/files/${file.id}`)).headers.get("location")).toContain(`porticos/${launch.id}/files/`);
    expect((await callAs(p, grok, "GET", `/api/agent/files/${file.id}`)).headers.get("location")).toContain(`porticos/${pair.id}/files/`);

    // Deleting the pair's workspace, and its content with the history, takes nothing from Launch.
    p.workspaces.remove(chris.id, pair.id);
    p.clock.advance(31 * DAY);
    p.messages.expireDue();
    p.messages.prune();
    await p.sweepFiles();
    await p.sweepArchived();
    expect(p.messages.get({ person: robert.id }, sent.id)).toBeNull();
    expect([...bucket.objects.keys()]).toEqual([]);
  });

  test("on disk the passed-on copy is a file of its own in the other workspace's folder, and downloads from there", async () => {
    const dataDir = tempDir();
    const { p, grok, dots, scout, pair, launch } = await world({ dataDir });
    const { file } = await p.files.createUpload(grok.agent, { name: "plan.txt", text: "the plan" });
    say(p, grok, "robert/dots", "Plan", { attachments: [file.id] });
    await flush();
    p.messages.inbox(dots.agent);
    say(p, dots, "bill/scout", "Passing on", { attachments: [file.id] });
    // Before the copy lands the address reads the bytes where they still are; afterwards from Launch's own folder.
    const early = await callAs(p, scout, "GET", `/api/agent/files/${file.id}`);
    expect(new URL(early.headers.get("location")!).searchParams.get("w")).toBe(launch.id);
    const read = async (res: Response) => {
      const url = new URL(res.headers.get("location")!);
      return await (await p.app.request(`${url.pathname}${url.search}`)).text();
    };
    expect(await read(early)).toBe("the plan");
    await flush();
    for (const id of [pair.id, launch.id]) expect(readFileSync(join(dataDir, "porticos", id, "files", file.id), "utf8")).toBe("the plan");
    expect(await read(await callAs(p, scout, "GET", `/api/agent/files/${file.id}`))).toBe("the plan");
    // An address signed for one workspace's copy doesn't open another's.
    const url = new URL((await callAs(p, scout, "GET", `/api/agent/files/${file.id}`)).headers.get("location")!);
    url.searchParams.set("w", pair.id);
    expect((await p.app.request(`${url.pathname}${url.search}`)).status).toBe(404);
    p.close();
    p.db.close();
  });
});
