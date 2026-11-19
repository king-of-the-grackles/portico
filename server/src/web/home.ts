import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { agentPageData } from "../api/agents";
import type { PersonEnv } from "../api/context";
import { consentCards } from "../api/consents";
import { serverMidnight, taskListData, todayData } from "../api/tasks";
import { agentsInOrder, personViews } from "../api/views";
import { workspacePageData, workspaceViews } from "../api/workspaces";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { homeState, renderHome } from "./client/render/home";
import type { HomeData, Route } from "./client/render/types";
import { sendPage, signInPath } from "./layout";

/**
 * The first data for a page: the same shapes the person API answers. Today counts from the server's midnight; the
 * browser fetches again from its own right away.
 */
export function homeData(core: Core, me: Person, route: Route): HomeData {
  const views = personViews(core, me);
  let resolved = route;
  let agentPage: HomeData["agentPage"] = null;
  if (route.page === "agent") {
    // An agent out of the person's sight goes the same way as one that isn't there.
    try {
      if (core.agents.get(route.id)) agentPage = agentPageData(core, me, route.id);
    } catch {
      agentPage = null;
    }
    if (!agentPage) resolved = { page: "today" };
  }
  let workspacePage: HomeData["workspacePage"] = null;
  if (route.page === "workspace") {
    try {
      workspacePage = workspacePageData(core, me, route.id);
    } catch {
      // Not there, or not one the person is in: Today instead.
      resolved = { page: "today" };
    }
  }
  return {
    page: "home",
    me: views.person(me),
    publicUrl: core.settings.publicUrl(),
    agents: agentsInOrder(core.agents, me).map(views.agent),
    approvals: { held: core.approvals.heldFor(me.id).map(views.held), consents: consentCards(core, me) },
    workspaces: workspaceViews(core, me).list(),
    workspacePage,
    route: resolved,
    today: resolved.page === "today" ? todayData(core, me, serverMidnight(core.now())) : null,
    tasks:
      resolved.page === "activity"
        ? taskListData(core, me, {})
        : resolved.page === "agent"
          ? taskListData(core, me, { agent: resolved.id })
          : resolved.page === "workspace"
            ? taskListData(core, me, { workspace: resolved.id })
            : null,
    agentPage,
  };
}

/** Today (/), Activity (/activity), each agent's page (/a/:agentId) and each Portico's (/p/:id). */
export function homePage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const page = (c: Context<PersonEnv>, open: Route) => {
    const me = c.get("person");
    if (!me) return c.redirect(signInPath(c.req.url), 303);
    // A claimed invite waits for the owner on the invite page.
    if (me.status === "pending") return c.redirect("/invite", 303);
    const data = homeData(core, me, open);
    if (open.page !== data.route.page) return c.redirect("/", 303);
    const first = renderHome(homeState({ ...data, now: core.now().getTime() }));
    const title =
      data.route.page === "activity"
        ? "Activity"
        : data.route.page === "agent"
          ? (data.agentPage?.agent.label ?? "Agent")
          : data.route.page === "workspace"
            ? (data.workspacePage?.workspace.name ?? "A Portico")
            : data.route.page === "agents"
              ? "Agents"
              : "Today";
    return sendPage(c, {
      // "Launch on Portico", but "Your Portico" as it is.
      title: /\bPortico$/.test(title) ? title : `${title} on Portico`,
      body: html`<div id="app">${raw(first)}</div>`,
      data,
      scripts: ["app.js"],
      styles: ["app.css"],
    });
  };
  route.get("/", (c) => page(c, { page: "today" }));
  route.get("/activity", (c) => page(c, { page: "activity" }));
  route.get("/a/:agentId", (c) => page(c, { page: "agent", id: c.req.param("agentId") }));
  route.get("/p/:workspaceId", (c) => page(c, { page: "workspace", id: c.req.param("workspaceId") }));
  route.get("/agents", (c) => page(c, { page: "agents" }));
  return route;
}
