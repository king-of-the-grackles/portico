import { describe, expect, test } from "bun:test";
import type { Topic } from "../src/core/changes";
import { LIMITS } from "../src/core/limits";
import {
  addComputer,
  addMember,
  addOwner,
  addSession,
  callAs,
  callPerson,
  copyProblems,
  flush,
  makePortico,
  openSessionStream,
  PUBLIC_URL,
  signIn,
  visibleCopy,
} from "./helpers";

const json = async <T>(res: Response | Promise<Response>) => (await (await res).json()) as T;

async function setup() {
  const p = makePortico();
  const chris = await addOwner(p);
  const maya = await addMember(p);
  return { p, chris, maya, owner: signIn(p, chris), member: signIn(p, maya) };
}

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
    // Someone else's computer answers exactly as one that doesn't exist.
    const theirs = await callPerson(p, member, "DELETE", `/api/computers/${computer.id}`);
    const none = await callPerson(p, member, "DELETE", "/api/computers/nope");
    expect([theirs.status, await theirs.text()]).toEqual([404, await none.text()]);
    expect(p.computers.get(computer.id)).not.toBeNull();
    expect((await callPerson(p, owner, "DELETE", "/api/computers/nope")).status).toBe(404);
    expect((await callPerson(p, owner, "DELETE", `/api/computers/${computer.id}`)).status).toBe(204);
    expect(p.computers.byToken(token)).toBeNull();
    await expect(stream.events.next(500)).rejects.toThrow();
  });
});

describe("/join", () => {
  test("plain steps for Claude Code and app agents, with the plugin source when set", async () => {
    const p = makePortico({ config: { pluginSource: "chrisivester/portico" } });
    const html = await (await p.app.request("/join")).text();
    expect(html).toContain("claude plugin marketplace add chrisivester/portico");
    expect(html).toContain("claude plugin install portico@portico");
    expect(html).toContain(`/portico:join ${PUBLIC_URL}`);
    expect(html).toContain(`curl -sS -X POST ${PUBLIC_URL}/api/join `);
    expect(html).toContain(`<code>GET ${PUBLIC_URL}/api/join/&lt;id&gt;</code>`);
    // No secret anywhere on the page: the agent asks, a person allows the join on one page, and gives the agent the code that page shows.
    expect(html).not.toContain("#&lt;secret&gt;");
    expect(visibleCopy(html)).toContain("The link alone lets nothing in");
    expect(visibleCopy(html)).toContain("Allow alone lets nothing in");
    expect(visibleCopy(html)).toContain(`the request works for ${LIMITS.consentMinutes} minutes`);
    expect(visibleCopy(html)).toContain("Portico never sends the code to an agent");
    // The second call for an agent whose shell can't prompt, and the endpoint an app hands the code to.
    expect(html).toContain("src/cli.ts&quot; join --code &lt;the 4 digits&gt;");
    expect(html).toContain(`curl -sS -X POST ${PUBLIC_URL}/api/join/&lt;id&gt;/code `);
    expect(html).not.toContain("a 4-digit <code>code</code>");
    expect(html).toContain(`${PUBLIC_URL}/api/agent/openapi.json`);
    expect(html).toContain("Notes for an AI agent reading this page");
    expect(html).not.toContain("Ask the person who runs the server for the source");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });

  test("app agents set up waking by default, and check on a schedule only as a backup or when waking isn't possible", async () => {
    const { p } = await setup();
    const html = await (await p.app.request("/join")).text();
    expect(html).toContain("Follow the one section below that matches the agent reading this page");
    // Apps that can have a webhook trigger register the trigger themselves; ChatGPT watches message.received.
    expect(html).toContain("Waking is the default for every agent: do this now, without waiting to be asked");
    expect(html).toContain("never settle for a scheduled check");
    // A connector added from an app's settings registers its own wake URL too, with the tool.
    expect(html).toContain("call <code>set_wake_url</code> with the trigger's <code>url</code> and <code>key</code>");
    expect(html).toContain(`curl -sS -X PUT ${PUBLIC_URL}/api/agent/wake`);
    expect(html).toContain(`every ${LIMITS.wokenCheckHours} hours when the last step set up waking`);
    expect(html).toContain(`every ${LIMITS.appCheckMinutes} minutes only when this app has no webhook trigger at all`);
    expect(html).toContain(`"client": "muse"`);
    expect(html).toContain("<code>message.received</code>");
    expect(html).toContain("ends quietly when nothing arrived");
    // Apps describe themselves, mark long work with done: false, and pick up what an earlier check left open.
    expect(html).toContain("describe the agent with <code>update_profile</code>");
    expect(html).toContain("<code>done: false</code>");
    expect(html).toContain("<code>list_tasks</code>");
    expect(copyProblems(html.replace(/<[^>]+>/g, " "))).toEqual([]);
  });

  test("ChatGPT is told to guide the person through its settings, and any stuck agent to help with the address", async () => {
    const { p } = await setup();
    const html = await (await p.app.request("/join")).text();
    const copy = visibleCopy(html);
    expect(copy).toContain("ChatGPT and dots");
    expect(copy).toContain("Guide the person through the first three steps, one at a time");
    expect(copy).not.toMatch(/join line/i);
    expect(html).toContain('href="https://chatgpt.com/plugins"');
    expect(html).toContain(`<pre><code>${PUBLIC_URL}/mcp</code></pre>`);
    expect(html).toContain("without waiting to be asked, watch Portico's <code>message.received</code> event");
    // No custom MCP server option: the dot joins over HTTP instead.
    expect(html).toContain(`"client": "dots"`);
    // A person with no account: where signing in makes one, and where an invite comes first.
    expect(copy).toContain("only a person with an account can allow a join");
    expect(copy).toContain("When the steps above don't work");
    expect(copy).toContain("in the app's settings for connectors or MCP servers");
    expect(copyProblems(copy)).toEqual([]);
  });

  test("without a plugin source, the page says who to ask", async () => {
    const html = await (await makePortico().app.request("/join")).text();
    expect(html).toContain("Ask the person who runs the server for the source");
    expect(copyProblems(visibleCopy(html))).toEqual([]);
  });
});

describe("error copy", () => {
  test("join and computer errors use no pronouns", async () => {
    const { p, member } = await setup();
    const messages: string[] = [];
    const collect = async (res: Response | Promise<Response>) => messages.push(((await (await res).json()) as { message: string }).message);
    const start = (body: unknown) => p.app.request("/api/join", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await collect(start({ kind: "x", name: "a" }));
    await collect(start({ kind: "agent", name: "Not A Name" }));
    await collect(start({ kind: "agent", name: "muse", client: "claude-code" }));
    await collect(start({ kind: "agent", name: "muse", link: `${PUBLIC_URL}/share#${"x".repeat(22)}` }));
    await collect(p.app.request("/api/join/nope", { headers: { authorization: "Bearer ps_nope" } }));
    // Handing in a code: before Allow, a wrong one, and once the request has closed.
    const asked = (await (await start({ kind: "agent", name: "muse" })).json()) as { id: string; poll_secret: string };
    const hand = () => p.app.request(`/api/join/${asked.id}/code`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${asked.poll_secret}` }, body: JSON.stringify({ code: "x" }) });
    await collect(hand());
    p.consents.decide((await p.people.byName("Chris"))!.id, asked.id, { decision: "approve" });
    for (let i = 0; i < LIMITS.consentCodeTries + 1; i++) await collect(hand());
    await collect(callAs(p, { token: "pc_nope" }, "GET", "/api/computer"));
    const { computer } = addComputer(p, (await p.people.byName("Chris"))!, "studio");
    await collect(callPerson(p, member, "DELETE", `/api/computers/${computer.id}`));
    expect(messages).toHaveLength(8 + LIMITS.consentCodeTries + 1);
    expect(copyProblems(messages.join(" | "))).toEqual([]);
  });
});
