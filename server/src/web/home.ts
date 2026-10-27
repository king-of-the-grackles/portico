import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import type { PersonEnv } from "../api/context";
import { pendingSignIns } from "../api/sign-ins";
import { agentsInOrder, canSeeThread, personViews } from "../api/views";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { homeState, renderHome } from "./client/render/home";
import type { HomeData, OpenPanel } from "./client/render/types";
import { sendPage, signInPath } from "./layout";

/** Home's first data: the same shapes GET /api/me, /api/agents, /api/approvals and /api/threads answer. */
export function homeData(core: Core, me: Person, open: { kind: "thread" | "agent"; id: string } | null): HomeData {
  const views = personViews(core, me);
  const involving = me.role === "owner" ? undefined : core.agents.ownedBy(me.id).map((a) => a.id);
  let panel: OpenPanel | null = null;
  if (open?.kind === "thread") {
    const thread = core.messages.thread(open.id);
    if (thread && canSeeThread(core.agents, me, thread)) {
      panel = {
        kind: "thread",
        id: thread.id,
        data: views.threadData(thread),
      };
    }
  } else if (open?.kind === "agent") {
    const agent = core.agents.get(open.id);
    if (agent) {
      const allowList = agent.ownerId === me.id ? core.approvals.allowListFor(me.id, agent.id).map(views.allowEntry) : null;
      panel = { kind: "agent", id: agent.id, data: { agent: views.agent(agent), allowList } };
    }
  }
  return {
    page: "home",
    me: views.person(me),
    publicUrl: core.settings.publicUrl(),
    agents: agentsInOrder(core.agents, me).map(views.agent),
    approvals: { held: core.approvals.heldFor(me.id).map(views.held), signIns: pendingSignIns(core, me) },
    threads: core.messages.threads({ involving }).map(views.thread),
    open: panel,
  };
}

/** Home: /, /c/:threadId (a thread open in the right panel) and /a/:agentId (an agent's details). */
export function homePage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const home = (c: Context<PersonEnv>, open: { kind: "thread" | "agent"; id: string } | null) => {
    const me = c.get("person");
    if (!me) return c.redirect(signInPath(c.req.url), 303);
    // A claimed invite waits for the owner on the invite page.
    if (me.status === "pending") return c.redirect("/invite", 303);
    const data = homeData(core, me, open);
    const first = renderHome(homeState({ ...data, now: core.now().getTime() }));
    return sendPage(c, {
      title: "Portico",
      body: html`<div id="app">${raw(first)}</div>`,
      data,
      scripts: ["app.js"],
      styles: ["app.css"],
    });
  };
  route.get("/", (c) => home(c, null));
  route.get("/c/:threadId", (c) => home(c, { kind: "thread", id: c.req.param("threadId") }));
  route.get("/a/:agentId", (c) => home(c, { kind: "agent", id: c.req.param("agentId") }));
  return route;
}
