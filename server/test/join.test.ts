import { describe, expect, test } from "bun:test";
import type { Topic } from "../src/core/changes";
import { LIMITS } from "../src/core/limits";
import { kindInfo } from "../src/web/client/render/common";
import {
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  copyProblems,
  DAY,
  flush,
  HOUR,
  makePortico,
  openSessionStream,
  PUBLIC_URL,
  signIn,
  visibleCopy,
} from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

interface LineAnswer {
  joinLine: { id: string; kind: string; line: string; expiresAt: string };
}
interface LineState {
  joinLine: {
    id: string;
    kind: string;
    usedAt: string | null;
    agent: { id: string; name: string; computer: { name: string } | null } | null;
    signIn: unknown;
  };
}

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya) };
}

async function makeLine(p: ReturnType<typeof makePortico>, cookie: string, kind = "claude-code") {
  const res = await callPerson(p, cookie, "POST", "/api/join-lines", { kind });
  expect(res.status).toBe(201);
  const { joinLine } = (await res.json()) as LineAnswer;
  return { ...joinLine, secret: joinLine.line.split("#")[1]! };
}

function join(p: ReturnType<typeof makePortico>, token: unknown, computer: unknown = "Chris-MacBook.local", from?: string) {
  return p.app.request("/api/computer/join", {
    method: "POST",
    headers: { "content-type": "application/json", ...(from ? { "x-forwarded-for": from } : {}) },
    body: JSON.stringify({ token, computer }),
  });
}

describe("join lines", () => {
  test("a line per kind: Join Portico, the public URL, /join and a secret after #", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    expect(line.line).toMatch(/^Join Portico: https:\/\/portico\.example\.com\/join#[A-Za-z0-9_-]{22}$/);
    expect(line.kind).toBe("claude-code");
    expect(Date.parse(line.expiresAt) - p.now().getTime()).toBe(24 * HOUR);
    for (const kind of ["codex", "muse", "grok-bot", "dots", "claude-duet", "other"]) expect((await makeLine(p, owner, kind)).kind).toBe(kind);
  });

  test("unknown kinds are refused, and signing in comes first", async () => {
    const { p, owner } = await setup();
    expect((await callPerson(p, owner, "POST", "/api/join-lines", { kind: "robot" })).status).toBe(400);
    expect((await callPerson(p, null, "POST", "/api/join-lines", { kind: "claude-code" })).status).toBe(401);
  });

  test("only the person who made a line can watch the line", async () => {
    const { p, owner, member } = await setup();
    const line = await makeLine(p, owner);
    expect((await callPerson(p, member, "GET", `/api/join-lines/${line.id}`)).status).toBe(404);
    const state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine).toMatchObject({ id: line.id, kind: "claude-code", usedAt: null, agent: null, signIn: null });
  });
});

describe("computer join", () => {
  test("redeems once: a computer for the line's maker, its token, and a slugged name", async () => {
    const { p, chris, owner } = await setup();
    const line = await makeLine(p, owner);
    const res = await join(p, line.secret);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { computer: { id: string; name: string }; token: string };
    expect(body.computer.name).toBe("chris-macbook");
    expect(body.token).toStartWith("pc_");
    expect(p.computers.byToken(body.token)).toMatchObject({ id: body.computer.id, ownerId: chris.id });

    const again = await join(p, line.secret);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "wrong_status", message: expect.stringContaining("already used") });
  });

  test("the whole line works as the token, and a second computer with the same name gets -2", async () => {
    const { p, owner } = await setup();
    addComputer(p, (await p.people.byName("Chris"))!, "chris-macbook");
    const line = await makeLine(p, owner);
    const res = await join(p, line.line);
    expect(await res.json()).toMatchObject({ computer: { name: "chris-macbook-2" } });
  });

  test("expired, unknown and app lines are refused; an app line stays usable", async () => {
    const { p, owner } = await setup();
    const old = await makeLine(p, owner);
    p.clock.advance(24 * HOUR);
    expect(await json(join(p, old.secret))).toMatchObject({ error: "wrong_status", message: expect.stringContaining("expired") });
    expect((await join(p, "x".repeat(22))).status).toBe(404);
    expect((await join(p, 42)).status).toBe(404);

    const muse = await makeLine(p, owner, "muse");
    const res = await join(p, muse.secret);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("app agent");
    expect(p.computers.joinLine(muse.id)?.usedAt).toBeNull();
  });

  test("ten unknown lines in 15 minutes from one address close the route to that address for a while", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    for (let i = 0; i < 10; i++) expect((await join(p, `unknown-secret-${i}`.padEnd(22, "x"), "mac", "6.6.6.6")).status).toBe(404);
    expect((await join(p, line.secret, "mac", "6.6.6.6")).status).toBe(429);
    p.clock.advance(15 * 60_000 + 1);
    expect((await join(p, line.secret, "mac", "6.6.6.6")).status).toBe(201);
  });

  test("one address's failures don't close joining for others", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    for (let i = 0; i < 10; i++) await join(p, `unknown-secret-${i}`.padEnd(22, "x"), "mac", "6.6.6.6");
    expect((await join(p, line.secret, "mac", "1.2.3.4")).status).toBe(201);
  });

  test("joining stays closed until setup is done", async () => {
    const p = makePortico({ setup: false });
    expect(await json(join(p, "x".repeat(22)))).toMatchObject({ error: "setup_required" });
  });

  test("the sheet sees the first session that registers on the new computer", async () => {
    const { p, owner } = await setup();
    const topics: Topic[][] = [];
    p.changes.on((batch) => topics.push(batch));
    const line = await makeLine(p, owner);
    const { token } = (await (await join(p, line.secret)).json()) as { token: string };
    let state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.usedAt).not.toBeNull();
    expect(state.joinLine.agent).toBeNull();

    await flush();
    topics.length = 0;
    const stream = await openSessionStream(p, token, { key: "first-session", repo: "api" });
    await flush();
    await flush();
    expect(topics.flat()).toContain("join-lines");
    state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent).toMatchObject({ name: "api-claude", computer: { name: "chris-macbook" } });

    // A later session doesn't replace the first.
    await openSessionStream(p, token, { key: "second-session", repo: "web", folderId: "b".repeat(64) });
    state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent?.name).toBe("api-claude");
    await stream.events.cancel();
  });
});

describe("Codex on a computer", () => {
  test("a Codex line joins a computer, says its kind, and the sheet waits for the first Codex session", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner, "codex");
    const res = await join(p, line.secret);
    expect(res.status).toBe(201);
    const { token, kind } = (await res.json()) as { token: string; kind: string };
    expect(kind).toBe("codex");
    // A Claude Code session on the computer isn't what the Codex line waits for.
    await openSessionStream(p, token, { key: "claude-session", repo: "api" });
    let state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent).toBeNull();
    const codex = await openSessionStream(p, token, { key: "codex-session", repo: "api", client: "codex" });
    expect(codex.hello).toMatchObject({ name: "api-codex", address: "api-codex@chris-macbook" });
    state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent).toMatchObject({ name: "api-codex", computer: { name: "chris-macbook" } });
    await codex.events.cancel();
  });

  test("a computer that already joined uses a Codex line with POST /lines: no second computer", async () => {
    const { p, owner } = await setup();
    const first = (await (await join(p, (await makeLine(p, owner)).secret)).json()) as { token: string; computer: { id: string } };
    const line = await makeLine(p, owner, "codex");
    const res = await callAs(p, { token: first.token }, "POST", "/api/computer/lines", { token: line.secret });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ computer: { id: first.computer.id, name: "chris-macbook" }, kind: "codex" });
    expect(p.computers.joinLine(line.id)).toMatchObject({ computerId: first.computer.id, usedAt: expect.any(String) });
    // Used once.
    expect((await callAs(p, { token: first.token }, "POST", "/api/computer/lines", { token: line.secret })).status).toBe(409);
    const codex = await openSessionStream(p, first.token, { key: "codex-session", repo: "web", client: "codex" });
    const state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent?.name).toBe("web-codex");
    await codex.events.cancel();
  });

  test("a Codex session that takes over an older Codex row in its folder still counts as the line's session", async () => {
    const { p, owner } = await setup();
    const first = (await (await join(p, (await makeLine(p, owner, "codex")).secret)).json()) as { token: string };
    const old = await openSessionStream(p, first.token, { key: "codex-old", repo: "api", client: "codex" });
    await old.events.cancel();
    await flush();
    p.clock.advance(5 * 60_000);
    const line = await makeLine(p, owner, "codex");
    expect((await callAs(p, { token: first.token }, "POST", "/api/computer/lines", { token: line.secret })).status).toBe(200);
    const next = await openSessionStream(p, first.token, { key: "codex-new", repo: "api", client: "codex" });
    expect(next.hello.name).toBe("api-codex");
    const state = await json<LineState>(callPerson(p, owner, "GET", `/api/join-lines/${line.id}`));
    expect(state.joinLine.agent?.name).toBe("api-codex");
    await next.events.cancel();
  });

  test("POST /lines needs the computer token, and only the computer's own person's line attaches", async () => {
    const { p, owner, member } = await setup();
    const first = (await (await join(p, (await makeLine(p, owner)).secret)).json()) as { token: string };
    const mayas = await makeLine(p, member, "codex");
    expect((await p.app.request("/api/computer/lines", { method: "POST", body: "{}" })).status).toBe(401);
    const res = await callAs(p, { token: first.token }, "POST", "/api/computer/lines", { token: mayas.secret });
    expect(res.status).toBe(403);
    expect(p.computers.joinLine(mayas.id)?.usedAt).toBeNull();
    const muse = await makeLine(p, owner, "muse");
    expect((await callAs(p, { token: first.token }, "POST", "/api/computer/lines", { token: muse.secret })).status).toBe(400);
  });
});

describe("leaving and folders", () => {
  test("DELETE /api/computer removes the computer and its sessions, and closes their streams", async () => {
    const { p, chris } = await setup();
    const { computer, token } = addComputer(p, chris);
    const stream = await openSessionStream(p, token, { key: "leaving-session" });
    const session = p.agents.byAddress(stream.hello.address)!;
    expect(p.agentStreams.isConnected(session.id)).toBe(true);
    expect((await callAs(p, { token }, "DELETE", "/api/computer")).status).toBe(204);
    expect(p.computers.get(computer.id)).toBeNull();
    expect(p.agents.all()).toEqual([]);
    expect(p.agentStreams.isConnected(session.id)).toBe(false);
    await expect(stream.events.next(500)).rejects.toThrow();
    expect((await callAs(p, { token }, "DELETE", "/api/computer")).status).toBe(401);
    expect((await callAs(p, { token: "pa_nope" }, "DELETE", "/api/computer")).status).toBe(401);
  });

  test("a folder switched off refuses new sessions with folder_off, and on lets them join again", async () => {
    const { p, chris } = await setup();
    const { token } = addComputer(p, chris);
    const folderId = "c".repeat(64);
    const off = await callAs(p, { token }, "PUT", `/api/computer/folders/${folderId}`, { joins: false, name: "/Users/chris/secret-repo" });
    expect(await off.json()).toEqual({ folder: { folder_id: folderId, name: "secret-repo", joins: false } });
    const refused = await p.app.request("/api/agent/stream?repo=secret-repo", {
      headers: { authorization: `Bearer ${token}`, "x-portico-session": "new-session-1", "x-portico-folder": folderId },
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: "folder_off" });

    await callAs(p, { token }, "PUT", `/api/computer/folders/${folderId}`, { joins: true, name: "secret-repo" });
    const stream = await openSessionStream(p, token, { key: "new-session-1", repo: "secret-repo", folderId });
    expect(stream.hello.name).toBe("secret-repo-claude");
    await stream.events.cancel();
  });

  test("the folder route checks its input and its token", async () => {
    const { p, chris } = await setup();
    const { token } = addComputer(p, chris);
    expect((await callAs(p, { token }, "PUT", "/api/computer/folders/not-hex", { joins: true })).status).toBe(400);
    expect((await callAs(p, { token }, "PUT", `/api/computer/folders/${"d".repeat(64)}`, { joins: "yes" })).status).toBe(400);
    expect((await callAs(p, { token: "pc_wrong" }, "PUT", `/api/computer/folders/${"d".repeat(64)}`, { joins: true })).status).toBe(401);
  });
});

describe("computers in the person API", () => {
  test("each person sees only their own computers, with every session there", async () => {
    const { p, chris, maya, owner, member } = await setup();
    const macbook = addComputer(p, chris).computer;
    addSession(p, macbook, { repo: "api" });
    addSession(p, macbook, { repo: "web" });
    addComputer(p, maya, "maya-linux");
    const mine = await json<{ computers: { name: string; lastSeen: string | null; sessions: { name: string }[] }[] }>(
      callPerson(p, owner, "GET", "/api/computers"),
    );
    expect(mine.computers.map((c) => [c.name, c.sessions.map((s) => s.name)])).toEqual([["macbook", ["api-claude", "web-claude"]]]);
    const theirs = await json<{ computers: { name: string }[] }>(callPerson(p, member, "GET", "/api/computers"));
    expect(theirs.computers.map((c) => c.name)).toEqual(["maya-linux"]);
  });

  test("removing a computer is for its owner only, and signs out every session there", async () => {
    const { p, chris, owner, member } = await setup();
    const { computer, token } = addComputer(p, chris);
    const stream = await openSessionStream(p, token, { key: "removed-session" });
    expect((await callPerson(p, member, "DELETE", `/api/computers/${computer.id}`)).status).toBe(403);
    expect((await callPerson(p, owner, "DELETE", "/api/computers/nope")).status).toBe(404);
    expect((await callPerson(p, owner, "DELETE", `/api/computers/${computer.id}`)).status).toBe(204);
    expect(p.computers.byToken(token)).toBeNull();
    await expect(stream.events.next(500)).rejects.toThrow();
  });
});

describe("sweeps", () => {
  test("join lines go a day after they expire", async () => {
    const { p, owner } = await setup();
    const line = await makeLine(p, owner);
    p.clock.advance(47 * HOUR);
    p.computers.sweep();
    expect(p.computers.joinLine(line.id)).not.toBeNull();
    p.clock.advance(2 * HOUR);
    expect(p.computers.sweep().joinLines).toBe(1);
    expect(p.computers.joinLine(line.id)).toBeNull();
  });

  test("the daily sweep runs from Portico's own sweep", async () => {
    const { p, owner } = await setup();
    await makeLine(p, owner);
    p.clock.advance(3 * DAY);
    p.sweepDaily();
    expect((p.db.query("SELECT COUNT(*) AS n FROM join_lines").get() as { n: number }).n).toBe(0);
  });
});

describe("/join", () => {
  test("plain steps for Claude Code and app agents, with the plugin source when set", async () => {
    const p = makePortico({ config: { pluginSource: "chrisivester/portico" } });
    const html = await (await p.app.request("/join")).text();
    expect(html).toContain("claude plugin marketplace add chrisivester/portico");
    expect(html).toContain("claude plugin install portico@portico");
    expect(html).toContain(`/portico:join Join Portico: ${PUBLIC_URL}/join#`);
    expect(html).toContain(`${PUBLIC_URL}/api/sign-in-requests`);
    expect(html).toContain(`${PUBLIC_URL}/api/agent/openapi.json`);
    expect(html).toContain("Notes for an AI agent reading this page");
    expect(html).not.toContain("Ask the person who runs Portico for the source");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("app agents are asked to check the inbox on a schedule, and the Add agent sheet says how often", async () => {
    const { p } = await setup();
    const html = await (await p.app.request("/join")).text();
    expect(html).toContain(`Check the inbox every ${LIMITS.appCheckMinutes} minutes.`);
    // Apps that can have a webhook trigger let Portico wake them; ChatGPT watches message.received.
    expect(html).toContain("Let Portico wake the agent");
    expect(html).toContain("under Wake URL in the agent's Settings");
    expect(html).toContain("<code>message.received</code>");
    expect(html).toContain("ends quietly when nothing arrived");
    // Apps describe themselves, mark long work with done: false, and pick up what an earlier check left open.
    expect(html).toContain("describe the agent with <code>update_profile</code>");
    expect(html).toContain("<code>done: false</code>");
    expect(html).toContain("<code>list_tasks</code>");
    expect(copyProblems(html.replace(/<[^>]+>/g, " "))).toEqual([]);
    for (const kind of ["muse", "grok-bot", "dots", "claude-duet"] as const) {
      expect(kindInfo(kind).step).toContain(`checks Portico every ${LIMITS.appCheckMinutes} minutes`);
    }
  });

  test("without a plugin source, the page says who to ask", async () => {
    const html = await (await makePortico().app.request("/join")).text();
    expect(html).toContain("Ask the person who runs Portico for the source");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });
});

describe("error copy", () => {
  test("join and computer errors use no pronouns", async () => {
    const { p, owner, member } = await setup();
    const line = await makeLine(p, owner);
    const messages: string[] = [];
    const collect = async (res: Response | Promise<Response>) => messages.push(((await (await res).json()) as { message: string }).message);
    await collect(join(p, "x".repeat(22)));
    await collect(join(p, (await makeLine(p, owner, "muse")).secret));
    await join(p, line.secret);
    await collect(join(p, line.secret));
    await collect(callPerson(p, owner, "POST", "/api/join-lines", { kind: "dots" }));
    await collect(callPerson(p, owner, "POST", "/api/join-lines", { kind: "x" }));
    const { computer } = addComputer(p, (await p.people.byName("Chris"))!, "studio");
    await collect(callPerson(p, member, "DELETE", `/api/computers/${computer.id}`));
    expect(copyProblems(messages.join(" | "))).toEqual([]);
  });
});
