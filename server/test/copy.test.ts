import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mcpTools } from "../src/agent-api/mcp";
import { openApiDocument } from "../src/agent-api/openapi";
import { porticoTools } from "../src/agent-api/portico-tools";
import { newAgentWords, utcDay } from "../src/core/consent-words";
import { shareEmail } from "../src/core/mail";
import { filesUnder, sourceWordProblems, stringPieces } from "./copy-source";
import { addOwner, callAs, copyProblems, makePortico, PUBLIC_URL, signIn, visibleCopy, wordProblems, workedExample } from "./helpers";

/**
 * The copy sweeps: no "I", "we" or "they" (the reader is "you"), no "hub", and the word rule for
 * Porticos, on every page and in agent-facing text. Each track adds its pages and renderers to PAGES or its own sweep
 * test, using copyProblems(visibleCopy(html)).
 *
 * The word rule: "Portico" with no article is the service; "a Portico", "your Portico", "the Portico “Launch”" is the
 * place; an installation is a "Portico server". Nothing a person or an agent sees says "workspace" or "Personal". The
 * code keeps the name `workspace`, since `Portico` there names the running app.
 */
const PAGES = ["/", "/settings", "/sign-in", "/setup", "/invite", "/join", "/nowhere", "/agents", "/activity", "/share"];

const REPO = join(import.meta.dir, "..", "..");

describe("copy sweeps", () => {
  test("pages", async () => {
    const p = makePortico();
    const cookie = signIn(p, await addOwner(p));
    for (const path of PAGES) {
      const html = await (await p.app.request(path, { headers: { cookie } })).text();
      expect(`${path}: ${copyProblems(visibleCopy(html)).join("; ")}`).toBe(`${path}: `);
    }
    const before = makePortico({ setup: false });
    expect(copyProblems(visibleCopy(await (await before.app.request("/")).text()))).toEqual([]);
  });

  test("each Portico's page, with agents taken out, a share waiting and a conversation gone read-only", async () => {
    const p = makePortico();
    const w = await workedExample(p);
    const first = p.messages.send(w.grok.agent, { to: "robert/dots", subject: "Plan", text: "x" }).message;
    p.workspaces.removeAgent(w.robert.id, w.pair.id, w.dots.agent.id);
    p.messages.send(w.grok.agent, { replyTo: first.id, subject: "More", text: "x" });
    p.workspaces.removeAgent(w.chris.id, w.own.id, w.claude.agent.id);
    p.consents.ask(w.grok.agent, "share", w.launch.id, { email: "erin@example.com" });
    p.consents.ask(w.grok.agent, "delete", w.launch.id);
    p.consents.ask(w.grok.agent, "remove_person", w.launch.id, { person: "dana" });
    const cookie = signIn(p, w.chris);
    for (const path of ["/", `/p/${w.own.id}`, `/p/${w.pair.id}`, `/p/${w.launch.id}`, `/a/${w.grok.agent.id}`, "/activity"]) {
      const res = await p.app.request(path, { headers: { cookie } });
      expect(`${path}: ${res.status}`).toBe(`${path}: 200`);
      const html = await res.text();
      expect(`${path}: ${copyProblems(visibleCopy(html)).join("; ")}`).toBe(`${path}: `);
      // The page's first data too: the person API's field names stay the code's, its values never say the old word.
      const data = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
      for (const piece of stringPieces(data)) expect(wordProblems(/\s/.test(piece.text) ? piece.text : "")).toEqual([]);
    }
    // The address is /p/:id, and the old one is gone.
    expect((await p.app.request(`/w/${w.launch.id}`, { headers: { cookie } })).status).toBe(404);
  });

  test("agent-facing tool and API descriptions", () => {
    expect(copyProblems(JSON.stringify(mcpTools()))).toEqual([]);
    expect(copyProblems(JSON.stringify(porticoTools()))).toEqual([]);
    expect(copyProblems(JSON.stringify(openApiDocument(PUBLIC_URL)))).toEqual([]);
  });

  test("tool names, arguments and OpenAPI paths never say workspace", () => {
    const everything = JSON.stringify([mcpTools(), porticoTools(), openApiDocument(PUBLIC_URL)]);
    expect(everything).not.toMatch(/workspace|personal/i);
    expect(porticoTools().map((tool) => tool.name)).toEqual([
      "list_porticos", "create_portico", "add_to_portico", "remove_from_portico", "rename_portico", "delete_portico", "share_portico", "join_portico",
    ]);
    const paths = Object.keys(openApiDocument(PUBLIC_URL).paths);
    for (const tool of porticoTools()) expect(paths).toContain(`/api/agent/portico-tools/${tool.name}`);
    const ids = Object.values(openApiDocument(PUBLIC_URL).paths).flatMap((path) => Object.values(path).map((op) => (op as { operationId: string }).operationId));
    expect(ids).toContain("listPorticos");
    expect(ids).toContain("removeFromPortico");
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("what the agent API answers: no result, field name or refusal says workspace or Personal", async () => {
    const p = makePortico();
    const w = await workedExample(p);
    const seen: string[] = [];
    const rest = async (who: { token: string }, method: string, path: string, body?: unknown) => {
      const res = await callAs(p, who, method, path, body);
      const text = await res.text();
      seen.push(text);
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
    };
    const tool = (who: { token: string }, name: string, args: unknown = {}) => rest(who, "POST", `/api/agent/portico-tools/${name}`, args);
    const mcp = async (who: { token: string }, name: string, args: unknown = {}) => {
      const res = await callAs(p, who, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
      seen.push(await res.text());
    };
    await rest(w.grok, "GET", "/api/agent/agents");
    await rest(w.grok, "GET", "/api/agent/agents?portico=Launch");
    await rest(w.grok, "GET", "/api/agent/agents?portico=nope");
    const sent = await rest(w.grok, "POST", "/api/agent/messages", { to: "robert/dots", subject: "Plan", text: "x" });
    await rest(w.dots, "GET", "/api/agent/inbox");
    await rest(w.grok, "GET", "/api/agent/tasks");
    await rest(w.grok, "GET", `/api/agent/tasks/${sent.body.message.id}`);
    await tool(w.grok, "list_porticos");
    const made = await tool(w.grok, "create_portico", {});
    await tool(w.grok, "create_portico", { name: "Marketing", agents: ["muse", "grok-bot"] });
    await tool(w.grok, "add_to_portico", { portico: made.body.portico.id, agent: "muse" });
    await tool(w.grok, "remove_from_portico", { portico: made.body.portico.id, agent: "muse" });
    await tool(w.grok, "remove_from_portico", { portico: "Launch", person: "dana" });
    await tool(w.grok, "remove_from_portico", { portico: "Launch", agent: "dana/muse" });
    await tool(w.grok, "rename_portico", { portico: "Marketing", name: "Growth" });
    await tool(w.grok, "delete_portico", { portico: "Growth" });
    const share = await tool(w.grok, "share_portico", { portico: "Launch", email: "erin@example.com" });
    await tool(w.grok, "list_porticos");
    await mcp(w.grok, "list_porticos");
    await mcp(w.grok, "list_agents", { portico: "Launch" });
    await mcp(w.grok, "send_message", { to: "bill/scout", subject: "Hello", text: "x" });
    await mcp(w.scout, "check_inbox");
    // Refusals: every way these tools say no.
    await tool(w.grok, "share_portico", { portico: w.own.id });
    await tool(w.grok, "delete_portico", { portico: w.own.id });
    await tool(w.grok, "rename_portico", { portico: w.own.id, name: "Mine" });
    await tool(w.dots, "delete_portico", { portico: "Launch" });
    await tool(w.dots, "rename_portico", { portico: "Launch", name: "Ours" });
    await tool(w.dots, "remove_from_portico", { portico: "Launch", person: "chris" });
    await tool(w.dots, "remove_from_portico", { portico: "Launch", person: "bill" });
    await tool(w.grok, "remove_from_portico", { portico: "Launch", person: "nobody" });
    await tool(w.grok, "add_to_portico", { portico: "nope", agent: "muse" });
    await tool(w.grok, "add_to_portico", { portico: "Launch", agent: "nobody" });
    await tool(w.grok, "join_portico", { link: "https://portico.example.com/share#not-a-real-secret-0000" });
    p.workspaces.removeAgent(w.chris.id, w.own.id, w.claude.agent.id);
    await tool(w.grok, "add_to_portico", { portico: "Launch", agent: "claude-code" });
    await rest(w.grok, "POST", "/api/agent/messages", { to: "claude-code", subject: "Hello", text: "x" });
    p.workspaces.remove(w.chris.id, w.launch.id);
    await rest(w.grok, "POST", "/api/agent/messages", { to: "bill/scout", subject: "Hello", text: "x" });
    expect(share.body.status).toBe("waiting_for_person");
    expect(seen.length).toBeGreaterThan(35);
    for (const text of seen) {
      expect(text).not.toMatch(/workspace|\bPersonal\b|"personal"/i);
      expect(wordProblems(text)).toEqual([]);
    }
    // And each one names the Portico in question.
    expect(seen.filter((text) => /the Portico “Launch”|Chris's Portico|the Portico “Growth”|the Portico “Marketing”/.test(text)).length).toBeGreaterThan(12);
  });

  test("the share email", () => {
    const mail = shareEmail({ inviter: "Chris", senderEmail: "chris@example.com", portico: "Launch", to: "dana@example.com", link: `${PUBLIC_URL}/share#secret`, stopUrl: `${PUBLIC_URL}/mail/stop?t=x` });
    for (const part of [mail.subject, mail.text, visibleCopy(mail.html)]) expect(wordProblems(part)).toEqual([]);
    expect(mail.subject).toBe("Chris invited you to join Launch");
  });

  test("everything the server and the plugin can say: error messages, notes, pages and emails in the source", () => {
    const files = [...filesUnder(join(REPO, "server", "src"), [".ts"]), ...filesUnder(join(REPO, "plugin-claude-code", "src"), [".ts"])];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap(sourceWordProblems)).toEqual([]);
  });

  test("nothing a person or an agent reads says an agent joined lately: a new agent is new, and not yet confirmed", () => {
    const files = [...filesUnder(join(REPO, "server", "src"), [".ts"]), ...filesUnder(join(REPO, "plugin-claude-code", "src"), [".ts"])];
    expect(files.length).toBeGreaterThan(100);
    const lately = /joined (Portico )?lately/i;
    const said = files.flatMap((path) => stringPieces(readFileSync(path, "utf8")).filter((piece) => lately.test(piece.text)).map((piece) => `${path}:${piece.line}`));
    expect(said).toEqual([]);
    // The rule sees such words in a string, so the sweep above is not empty by accident.
    expect(stringPieces('const note = "this agent joined Portico lately";').some((piece) => lately.test(piece.text))).toBe(true);
    // The four tools that change a Portico say what a new agent gets, in the server's list and in the plugin's copy.
    for (const path of [join(REPO, "server", "src", "agent-api", "portico-tools.ts"), join(REPO, "plugin-claude-code", "src", "portico-tools.ts")]) {
      expect(readFileSync(path, "utf8").split("A new agent that person hasn't confirmed yet gets waiting_for_person instead")).toHaveLength(5);
    }
  });

  test("the READMEs and the plugin's commands", () => {
    const docs = [join(REPO, "README.md"), join(REPO, "plugin-claude-code", "README.md"), ...filesUnder(join(REPO, "plugin-claude-code", "commands"), [".md"])];
    for (const path of docs) {
      // Code is paste-ready text and names: another product's own commands and prompts stay as that product has them.
      const prose = readFileSync(path, "utf8")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .replace(/\]\([^)]*\)/g, "]");
      expect(`${path}: ${wordProblems(prose).join("; ")}`).toBe(`${path}: `);
    }
    const readme = readFileSync(join(REPO, "README.md"), "utf8");
    for (const part of ["`portico.db`", "`porticos/<id>/content.db`", "`uploads/`"]) expect(readme).toContain(part);
  });

  test("the scanner reads strings, not comments or code", () => {
    const source = [
      "// a workspace in a comment",
      "/* another workspace */",
      "const workspace = `No such workspace ${workspace.id} here`;",
      'const re = /"workspace"/; const s = "Personal holds agents";',
      "const sql = `SELECT * FROM workspaces WHERE id = $id`;",
      'emit("workspaces");',
    ].join("\n");
    expect(stringPieces(source).map((piece) => piece.text)).toEqual(["No such workspace ", " here", "Personal holds agents", "SELECT * FROM workspaces WHERE id = $id", "workspaces"]);
  });

  test("the word rule", () => {
    expect(wordProblems("Share the Portico “Launch”. Your Portico holds every agent. Join Portico with one line.")).toEqual([]);
    expect(wordProblems("Ask the person who runs this Portico server.")).toEqual([]);
    expect(wordProblems("Delete workspace")).toHaveLength(1);
    expect(wordProblems("Workspaces")).toHaveLength(1);
    expect(wordProblems("Email isn't set up on this Portico.")).toHaveLength(1);
    expect(wordProblems("Each Portico instance keeps a data folder.")).toHaveLength(1);
    expect(copyProblems("No such workspace.")).toHaveLength(1);
  });

  test("the allowed phrases are the only exceptions", () => {
    expect(copyProblems(visibleCopy("<h2>Add your first agent</h2>"))).toEqual([]);
    expect(copyProblems(visibleCopy("<h1>Your Portico</h1><p>Each new agent starts in Your Portico.</p>"))).toEqual([]);
    expect(copyProblems(visibleCopy("<p>Your agents</p>"))).toEqual([]);
    expect(copyProblems(visibleCopy("<p>We keep their agents</p>"))).toHaveLength(2);
    expect(copyProblems(visibleCopy("<p>The hub is down</p>"))).toHaveLength(1);
    expect(copyProblems(visibleCopy("<pre>you can paste this</pre><p>Portico</p>"))).toEqual([]);
  });
});

describe("the day a new agent was added, as the server writes it", () => {
  const agent = { createdAt: "2026-10-27T23:30:00.000Z" };

  test("the year shows only when it isn't the application clock's year", () => {
    expect(utcDay(agent.createdAt, new Date("2026-11-24T12:00:00Z"))).toBe("Oct 27");
    expect(utcDay(agent.createdAt, new Date("2027-01-01T00:00:00Z"))).toBe("Oct 27, 2026");
    expect(newAgentWords(agent, new Date("2026-12-31T23:59:59Z"))).toBe("New agent, added Oct 27. You haven't confirmed this agent yet.");
    expect(newAgentWords(agent, new Date("2027-01-01T00:00:00Z"))).toBe("New agent, added Oct 27, 2026. You haven't confirmed this agent yet.");
  });

  test("it is a UTC day, whatever the server's own time zone", () => {
    expect(utcDay("2026-10-27T23:30:00-08:00", new Date("2026-11-24T12:00:00Z"))).toBe("Oct 28");
  });

  test("the clock is always handed in: nothing here reads the computer's own date", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "core", "consent-words.ts"), "utf8");
    expect(source).not.toContain("new Date()");
    expect(source).not.toContain("Date.now()");
  });
});
