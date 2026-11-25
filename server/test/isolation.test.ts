import { describe, expect, test } from "bun:test";
import { appTools } from "../src/agent-api/mcp";
import { porticoTools } from "../src/agent-api/portico-tools";
import { acquaint, addAppAgent, addComputer, addMember, addOwner, addSession, callAs, callPerson, fakeBucket, makePortico, signIn, type TestPortico } from "./helpers";

/**
 * The isolation sweep. Two parties on one Portico server:
 *
 * - The other party: Zara and Alice share the Portico "Zebra Den", with agents, a conversation, a held message, a
 *   file, a share link, requests waiting on the consent page, a computer and a session. Everything of theirs carries
 *   the word ZEBRA.
 * - The caller: Bob, with one agent and one computer. Bob shares a different Portico ("Beta") with one other agent of
 *   Alice's, so Bob is no stranger to the server, only to Zebra Den.
 *
 * Every route the app has, every MCP tool and every Portico tool is called as Bob (the wrong person) and as Bob's
 * agent (an agent from the wrong Portico), with each real ID of the other party in each place an ID or a name can go.
 * Each answer must be exactly the answer the same call gives for an ID that doesn't exist, and nothing of the other
 * party's may appear in any answer at all. The routes and tools are read from the app and the tool lists, so a route
 * or a tool added later is swept without being named here.
 */
const SECRET = /zebra/i;
const UNKNOWN = "no-such-thing-0000";

/**
 * An ID that names nothing, of the same shape as a real one: where a route checks the shape before looking anything
 * up (a folder ID is 64 hex characters, another person's agent is `handle/name`), both calls get past that check.
 */
function unknownLike(id: string): string {
  if (/^[0-9a-f]{64}$/.test(id)) return "0".repeat(64);
  if (id.includes("/")) return "nobody/no-such-agent";
  return UNKNOWN;
}

async function world(serverOwner: "alice" | "bob" = "alice") {
  const bucket = fakeBucket();
  const p = makePortico({ fileStore: bucket.store });
  // On a server with its own sign-in one person runs the accounts. Either party can be that person.
  if (serverOwner === "bob") await addOwner(p, "Bob");
  const person = async (name: string, handle: string, owner = false) => {
    const made = p.people.byName(name) ?? (owner ? await addOwner(p, name) : await addMember(p, name));
    p.people.setEmail(made.id, handle === "zara" ? "zara@zebra.example" : `${handle}@example.com`);
    return p.people.setHandle(made.id, handle);
  };
  // The other party.
  const alice = await person("Alice", "alice", serverOwner === "alice");
  const zara = await person("Zara Zebra", "zara");
  const a1 = addAppAgent(p, alice, "zebra-one");
  const a2 = addAppAgent(p, alice, "beta-helper");
  const z1 = addAppAgent(p, zara, "zebra-agent");
  p.agents.updateOwn(z1.agent, { description: "ZEBRA description", doing: "ZEBRA doing" });
  const den = p.workspaces.create(alice.id, "Zebra Den");
  p.workspaces.admit(den.id, zara.id);
  p.workspaces.addAgent(alice.id, den.id, a1.agent.id);
  p.workspaces.addAgent(zara.id, den.id, z1.agent.id);
  const upload = await p.files.createUpload(a1.agent, { name: "zebra-file.txt", text: "ZEBRA file body" });
  const loose = await p.files.createUpload(z1.agent, { name: "zebra-loose.txt", text: "ZEBRA loose body" });
  const held = p.messages.send(z1.agent, { to: "alice/zebra-one", subject: "ZEBRA held subject", text: "ZEBRA held text" }).message;
  acquaint(p, alice.id, zara.id);
  const sent = p.messages.send(a1.agent, { to: "zara/zebra-agent", subject: "ZEBRA subject", text: "ZEBRA text", attachments: [upload.file.id] }).message;
  p.messages.inbox(z1.agent);
  const reply = p.messages.send(z1.agent, { replyTo: sent.id, subject: "ZEBRA reply", text: "ZEBRA reply text", summary: "ZEBRA summary" }).message;
  const share = p.shares.create(alice.id, den.id, { email: "invited@zebra.example" });
  const asked = p.consents.ask(a1.agent, "delete", den.id);
  const removal = p.consents.ask(a1.agent, "remove_person", den.id, { person: "zara" });
  // A join Alice allowed, whose code shows on her page and waits to be handed in.
  const joining = p.consents.startJoin({ kind: "computer", name: "zebra-studio" }, "test").request;
  const joinCode = p.consents.decide(alice.id, joining.id, { decision: "approve" }).request.code!;
  const { computer: box } = addComputer(p, alice, "zebra-box");
  const session = addSession(p, box, { repo: "zebra-repo", folderId: "9".repeat(64) });
  const invite = p.people.createInvite(p.people.owner()!.id, "Zebra invitee").invite;
  const personal = p.workspaces.personal(alice.id);

  // The caller.
  const bob = await person("Bob", "bob");
  const b1 = addAppAgent(p, bob, "bee");
  const beta = p.workspaces.create(bob.id, "Beta");
  p.workspaces.admit(beta.id, alice.id);
  p.workspaces.addAgent(bob.id, beta.id, b1.agent.id);
  p.workspaces.addAgent(alice.id, beta.id, a2.agent.id);
  acquaint(p, bob.id, alice.id);
  const mine = p.messages.send(b1.agent, { to: "alice/beta-helper", subject: "Bob's own", text: "Bob's text" }).message;
  const bobBox = addComputer(p, bob, "bob-box");
  for (const agent of [a1, a2, z1, b1]) p.agentNotices.take(agent.agent.id);

  /** Every real ID, name and address of the other party that a caller could put where an ID goes. */
  const theirs: Record<string, string> = {
    portico: den.id,
    ownPortico: personal.id,
    agent: z1.agent.id,
    aliceAgent: a1.agent.id,
    session: session.agent.id,
    person: zara.id,
    thread: sent.threadId,
    message: sent.id,
    reply: reply.id,
    heldMessage: held.id,
    file: upload.file.id,
    looseFile: loose.file.id,
    share: share.share.id,
    consent: asked.id,
    removal: removal.id,
    allowedJoin: joining.id,
    computer: box.id,
    invite: invite.id,
    folder: "9".repeat(64),
    sessionKey: session.key,
    porticoName: "Zebra Den",
    agentAddress: "zara/zebra-agent",
    aliceAddress: "alice/zebra-one",
    agentName: "zebra-agent",
    handle: "zara",
  };
  /** Bob's own, to fill the other places of a path so the check for the swept place is reached. */
  const own: Record<string, string> = { portico: beta.id, agent: b1.agent.id, person: bob.id, message: mine.id, thread: mine.threadId, computer: bobBox.computer.id };
  return { p, alice, zara, bob, b1, bobBox, cookie: signIn(p, bob), theirs, own, den, joinCode };
}

type World = Awaited<ReturnType<typeof world>>;

/** A body that gets past validation wherever a route reads one: every route takes what it knows and ignores the rest. */
const BODY = {
  name: "plain-name",
  decision: "allow_once",
  code: "0000",
  agents: "self",
  email: "someone@example.com",
  url: "https://hook.example.com/wake",
  key: "k",
  approvalRequired: true,
  outboundHold: true,
  description: "d",
  joins: true,
  subject: "s",
  text: "t",
};

interface Answer {
  status: number;
  body: string;
  location: string | null;
}

/** The answer with every form of the ID that was asked about taken out: what is left must not depend on the ID. */
function normalised(answer: Answer, id: string): string {
  const forms = [id, encodeURIComponent(id), id.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;")];
  let text = `${answer.status} ${answer.location ?? ""} ${answer.body}`;
  for (const form of forms) text = text.split(form).join("<ID>");
  return text;
}

async function answerOf(res: Response): Promise<Answer> {
  return { status: res.status, body: await res.text(), location: res.headers.get("location") };
}

/** Which of Bob's own IDs fills a place in a path that isn't the one being swept. */
function ownFor(path: string, param: string, own: Record<string, string>): string {
  if (/agent/i.test(param)) return own.agent!;
  if (/person/i.test(param)) return own.person!;
  if (/message/i.test(param)) return own.message!;
  if (path.includes("/porticos/") || path.startsWith("/p/")) return own.portico!;
  if (path.includes("/agents/") || path.startsWith("/a/")) return own.agent!;
  if (path.includes("/threads/")) return own.thread!;
  if (path.includes("/computers/")) return own.computer!;
  if (path.includes("/tasks/") || path.includes("/held/")) return own.message!;
  return UNKNOWN;
}

/** The app's routes, read from the app itself: each method and path once, without the middleware. */
function routesOf(p: TestPortico): { method: string; path: string }[] {
  const seen = new Map<string, { method: string; path: string }>();
  for (const route of p.app.routes) {
    if (route.path.includes("*")) continue;
    for (const method of route.method === "ALL" ? ["GET", "POST", "DELETE"] : [route.method]) seen.set(`${method} ${route.path}`, { method, path: route.path });
  }
  return [...seen.values()];
}

/** Calls a route as the caller it is for: Bob's browser, Bob's agent, Bob's computer, or nobody for the open ones. */
async function call(w: World, method: string, path: string): Promise<Answer> {
  const body = method === "GET" || method === "HEAD" ? undefined : BODY;
  if (path.startsWith("/api/agent/") || path.startsWith("/mcp")) return answerOf(await callAs(w.p, w.b1, method, path, body));
  // The computer's own API is /api/computer; /api/computers is the person's, and takes the browser's cookie.
  if (path === "/api/computer" || path.startsWith("/api/computer/")) return answerOf(await callAs(w.p, { token: w.bobBox.token }, method, path, body));
  return answerOf(await callPerson(w.p, w.cookie, method, path, body));
}

describe("isolation sweep: routes", () => {
  test("the sweep sees the whole app: every surface has routes in it", async () => {
    const { p } = await world();
    const routes = routesOf(p);
    expect(routes.length).toBeGreaterThan(100);
    for (const prefix of ["/api/agent/", "/api/porticos", "/api/agents", "/api/threads", "/api/tasks", "/api/consents", "/api/approvals", "/api/computer", "/api/join", "/files/", "/mcp", "/c/", "/held/", "/p/", "/a/"]) {
      expect(routes.some((route) => route.path.startsWith(prefix))).toBe(true);
    }
    expect(routes.filter((route) => route.path.includes(":")).length).toBeGreaterThan(35);
  });

  /** Every parameterised route, with each of the other party's IDs in each place of its path, against an unknown ID there. */
  async function sweep(w: World, skip?: (path: string, kind: string) => boolean): Promise<{ problems: string[]; calls: number }> {
    const problems: string[] = [];
    let calls = 0;
    for (const route of routesOf(w.p).filter((r) => r.path.includes(":"))) {
      const params = [...route.path.matchAll(/:([A-Za-z]+)/g)].map((match) => match[1]!);
      for (const swept of params) {
        // The other places in the path: once with Bob's own IDs, so the swept check is reached, and once with nothing real.
        for (const fill of ["own", "unknown"] as const) {
          const pathFor = (id: string) =>
            route.path.replace(/:([A-Za-z]+)/g, (_all, param: string) => encodeURIComponent(param === swept ? id : fill === "own" ? ownFor(route.path, param, w.own) : UNKNOWN));
          if (fill === "unknown" && params.length === 1) continue;
          for (const [kind, id] of Object.entries(w.theirs)) {
            if (skip?.(route.path, kind)) continue;
            const baseline = normalised(await call(w, route.method, pathFor(unknownLike(id))), unknownLike(id));
            const answer = await call(w, route.method, pathFor(id));
            calls++;
            if (SECRET.test(normalised(answer, id))) problems.push(`${route.method} ${route.path} [${swept}=${kind}, ${fill}] shows the other party's content: ${answer.body.slice(0, 160)}`);
            if (normalised(answer, id) !== baseline) {
              problems.push(`${route.method} ${route.path} [${swept}=${kind}, ${fill}] answers ${answer.status} ${answer.body.slice(0, 120)} but an unknown ID answers ${baseline.slice(0, 120)}`);
            }
          }
        }
      }
    }
    return { problems, calls };
  }

  test("every route with an ID in its path answers someone else's ID exactly as an ID that doesn't exist", async () => {
    const { problems, calls } = await sweep(await world());
    expect(problems).toEqual([]);
    expect(calls).toBeGreaterThan(800);
  });

  test("the same holds when the caller runs the Portico server's accounts: owning the server opens nobody's Portico", async () => {
    // The server's owner removes accounts and handles invites, by design: those three routes are the owner's own.
    const accounts = /^\/api\/(people|claims|invites)\//;
    const { problems, calls } = await sweep(await world("bob"), (path) => accounts.test(path));
    expect(problems).toEqual([]);
    expect(calls).toBeGreaterThan(700);
  });

  test("every GET with no ID in its path, as the wrong person and as the wrong agent, shows nothing of the other party", async () => {
    const w = await world();
    const leaks: string[] = [];
    let calls = 0;
    for (const route of routesOf(w.p).filter((r) => r.method === "GET" && !r.path.includes(":"))) {
      // Streams stay open; the sign-in pages and assets carry nobody's data.
      if (/stream|events|assets|openapi|\.well-known|healthz/.test(route.path)) continue;
      for (const query of ["", `?portico=${w.theirs.portico}`, `?agent=${w.theirs.agent}`, `?workspace=${w.theirs.portico}`, `?with=${encodeURIComponent(w.theirs.agentAddress!)}`, "?events=1&outcome=all"]) {
        const answer = await call(w, "GET", `${route.path}${query}`);
        calls++;
        // What the caller typed may come back in a refusal ("No agent named …"): that is the caller's own text.
        if (SECRET.test(normalised(answer, w.theirs.agentAddress!))) leaks.push(`GET ${route.path}${query}: ${answer.body.match(/.{0,60}zebra.{0,60}/i)?.[0]}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(calls).toBeGreaterThan(100);
  });

  test("the sweep can tell answers apart: what Bob may see but not change is refused, and what Bob may not see is not found", async () => {
    const w = await world();
    const visible = w.p.agents.byAddress("beta-helper")!.id;
    // Alice's agent in Beta is no secret to Bob: changing it is refused as not allowed, which an unknown ID never is.
    const refused = await call(w, "PATCH", `/api/agents/${visible}`);
    const unknown = await call(w, "PATCH", `/api/agents/${UNKNOWN}`);
    const hidden = await call(w, "PATCH", `/api/agents/${w.theirs.agent}`);
    expect([refused.status, unknown.status, hidden.status]).toEqual([403, 404, 404]);
    expect(normalised(refused, visible)).not.toBe(normalised(unknown, UNKNOWN));
    expect(normalised(hidden, w.theirs.agent!)).toBe(normalised(unknown, UNKNOWN));
    // And the sweep's own check for content finds it where it really is: Zara's own view.
    const zara = signIn(w.p, w.zara);
    expect((await (await callPerson(w.p, zara, "GET", `/api/porticos/${w.theirs.portico}`)).text())).toMatch(SECRET);
    expect((await (await callPerson(w.p, zara, "GET", `/api/threads/${w.theirs.thread}`)).text())).toMatch(SECRET);
  });

  test("the pages of someone else's Portico, agent, request and held message are the page for nothing at all", async () => {
    const w = await world();
    for (const [path, ids] of [
      ["/p/", [w.theirs.portico, w.theirs.ownPortico]],
      ["/a/", [w.theirs.agent, w.theirs.aliceAgent, w.theirs.session]],
      ["/c/", [w.theirs.consent, w.theirs.removal, w.theirs.allowedJoin]],
      ["/held/", [w.theirs.heldMessage, w.theirs.message]],
    ] as const) {
      const unknown = await call(w, "GET", `${path}${UNKNOWN}`);
      for (const id of ids) {
        const page = await call(w, "GET", `${path}${id}`);
        expect(normalised(page, id!)).toBe(normalised(unknown, UNKNOWN));
        expect(page.body).not.toMatch(SECRET);
      }
    }
    // The code of a join someone else allowed shows on that person's page and nowhere a stranger can look.
    const mine = await callPerson(w.p, signIn(w.p, w.alice), "GET", `/c/${w.theirs.allowedJoin}`);
    expect(await mine.text()).toContain(`>${w.joinCode}</p>`);
    for (const cookie of [w.cookie, null]) {
      for (const path of [`/c/${w.theirs.allowedJoin}`, "/", "/api/approvals", "/api/activity?events=1"]) {
        expect(await (await callPerson(w.p, cookie, "GET", path)).text()).not.toContain(`>${w.joinCode}<`);
      }
    }
    for (const path of [`/api/join/${w.theirs.allowedJoin}`, `/api/join/${w.theirs.allowedJoin}/code`]) {
      const res = await w.p.app.request(path, { method: path.endsWith("/code") ? "POST" : "GET", headers: { authorization: `Bearer ${w.b1.token}`, "content-type": "application/json" }, body: path.endsWith("/code") ? JSON.stringify({ code: w.joinCode }) : undefined });
      expect(res.status).toBe(401);
    }
    expect(w.p.computers.list(w.alice.id).map((computer) => computer.name)).toEqual(["zebra-box"]);
  });
});

describe("isolation sweep: tools", () => {
  const tools = [...appTools(), ...porticoTools()] as { name: string; inputSchema: { properties?: Record<string, { type?: string }> } }[];
  const mcp = async (w: World, name: string, args: Record<string, unknown>): Promise<Answer> =>
    answerOf(await callAs(w.p, w.b1, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }));
  /** What every tool needs besides the argument being swept, so the call gets as far as looking the swept value up. */
  const base = (w: World, name: string, swept: string): Record<string, unknown> => {
    const filled: Record<string, Record<string, unknown>> = {
      send_message: { subject: "s", text: "t", ...(swept === "to" || swept === "reply_to" ? {} : { to: "alice/beta-helper" }) },
      create_upload: { name: "note.txt", text: "x" },
      add_to_portico: { portico: w.own.portico, agent: "bee" },
      remove_from_portico: { portico: w.own.portico },
      rename_portico: { portico: w.own.portico, name: "Beta" },
      delete_portico: { portico: w.own.portico },
      share_portico: { portico: w.own.portico },
      set_wake_url: { url: "https://hook.example.com/wake", key: "k" },
      set_inbox_schedule: { minutes: 30 },
      submit_feedback: { kind: "bug", title: "t", details: "d" },
      request_input: { question: "q" },
    };
    const args = { ...(filled[name] ?? {}) };
    delete args[swept];
    return args;
  };

  test("the sweep covers every tool an agent has", () => {
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "add_to_portico", "check_inbox", "create_portico", "create_upload", "delete_portico", "get_task", "join_portico", "list_agents", "list_porticos",
        "list_tasks", "remove_from_portico", "rename_portico", "request_input", "send_message", "set_inbox_schedule", "set_wake_url", "share_portico", "submit_feedback", "update_profile",
      ].sort(),
    );
  });

  test("every tool, with someone else's ID or name in each argument, answers as for one that doesn't exist, and shows nothing", async () => {
    const problems: string[] = [];
    let calls = 0;
    for (const tool of tools) {
      for (const [swept, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
        if (schema.type !== "string" && schema.type !== "array") continue;
        // Free text is stored or matched as given (a new name, a description, a subject): nothing is looked up by it.
        if (["name", "description", "doing", "subject", "text", "summary", "key", "url", "type", "email", "outcome", "since", "before", "agents", "title", "details", "question", "detail"].includes(swept) && schema.type === "string") continue;
        // A fresh world for each argument: a call that goes through (a send to Bob's own contact, say) changes nothing for the next.
        const w = await world();
        const value = (id: string) => (schema.type === "array" ? [id] : id);
        for (const [kind, id] of Object.entries(w.theirs)) {
          const baseline = normalised(await mcp(w, tool.name, { ...base(w, tool.name, swept), [swept]: value(unknownLike(id)) }), unknownLike(id));
          const answer = await mcp(w, tool.name, { ...base(w, tool.name, swept), [swept]: value(id) });
          calls++;
          const text = normalised(answer, id);
          if (SECRET.test(text)) problems.push(`${tool.name}(${swept}=${kind}) shows the other party's content: ${text.match(/.{0,80}zebra.{0,80}/i)?.[0]}`);
          if (text !== baseline) problems.push(`${tool.name}(${swept}=${kind}) answers ${text.slice(0, 200)} but an unknown value answers ${baseline.slice(0, 200)}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(calls).toBeGreaterThan(250);
  });

  test("the Portico tools over REST answer the same way", async () => {
    const w = await world();
    for (const name of ["add_to_portico", "remove_from_portico", "rename_portico", "delete_portico", "share_portico"]) {
      const args = (portico: string) => ({ portico, agent: "bee", name: "Renamed", person: "alice" });
      const unknown = await answerOf(await callAs(w.p, w.b1, "POST", `/api/agent/portico-tools/${name}`, args(UNKNOWN)));
      for (const id of [w.theirs.portico!, w.theirs.ownPortico!, w.theirs.porticoName!]) {
        const answer = await answerOf(await callAs(w.p, w.b1, "POST", `/api/agent/portico-tools/${name}`, args(id)));
        expect(normalised(answer, id)).toBe(normalised(unknown, UNKNOWN));
      }
    }
    const listed = await answerOf(await callAs(w.p, w.b1, "GET", `/api/agent/agents?portico=${w.theirs.portico}`));
    expect(normalised(listed, w.theirs.portico!)).toBe(normalised(await answerOf(await callAs(w.p, w.b1, "GET", `/api/agent/agents?portico=${UNKNOWN}`)), UNKNOWN));
  });

  test("what the caller does see is the caller's own: the lists hold Bob's side and Beta, and nothing else", async () => {
    const w = await world();
    const agents = (await (await callAs(w.p, w.b1, "GET", "/api/agent/agents")).json()) as { agents: { name: string }[] };
    expect(agents.agents.map((a) => a.name)).toEqual(["alice/beta-helper"]);
    const porticos = (await (await callAs(w.p, w.b1, "POST", "/api/agent/portico-tools/list_porticos", {})).json()) as { porticos: { name: string }[] };
    expect(porticos.porticos.map((x) => x.name)).toEqual(["Bob's Portico", "Bob's shared Portico", "Beta"]);
    const people = (await (await callPerson(w.p, w.cookie, "GET", "/api/people")).json()) as { people: { name: string; agentCount: number }[] };
    expect(people.people.map((x) => x.name).sort()).toEqual(["Alice", "Bob"]);
    // Alice has two agents, and Bob reaches one: the count tells Bob nothing about the other.
    expect(people.people.find((x) => x.name === "Alice")!.agentCount).toBe(1);
  });
});
