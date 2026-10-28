import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { agentPageData } from "../api/agents";
import type { PersonEnv } from "../api/context";
import { pendingSignIns } from "../api/sign-ins";
import { serverMidnight, taskListData, todayData } from "../api/tasks";
import { agentsInOrder, personViews } from "../api/views";
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
    if (core.agents.get(route.id)) agentPage = agentPageData(core, me, route.id);
    else resolved = { page: "today" };
  }
  return {
    page: "home",
    me: views.person(me),
    publicUrl: core.settings.publicUrl(),
    agents: agentsInOrder(core.agents, me).map(views.agent),
    approvals: { held: core.approvals.heldFor(me.id).map(views.held), signIns: pendingSignIns(core, me) },
    route: resolved,
    today: resolved.page === "today" ? todayData(core, me, serverMidnight(core.now())) : null,
    tasks:
      resolved.page === "activity"
        ? taskListData(core, me, {})
        : resolved.page === "agent"
          ? taskListData(core, me, { agent: resolved.id })
          : null,
    agentPage,
  };
}

/** Today (/), Activity (/activity) and each agent's page (/a/:agentId). An old thread link (/c/:id) goes to Activity. */
export function homePage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const page = (c: Context<PersonEnv>, open: Route) => {
    const me = c.get("person");
    if (!me) return c.redirect(signInPath(c.req.url), 303);
    // A claimed invite waits for the owner on the invite page.
    if (me.status === "pending") return c.redirect("/invite", 303);
    const data = homeData(core, me, open);
    if (open.page === "agent" && data.route.page !== "agent") return c.redirect("/", 303);
    const first = renderHome(homeState({ ...data, now: core.now().getTime() }));
    const title = data.route.page === "activity" ? "Activity" : data.route.page === "agent" ? (data.agentPage?.agent.label ?? "Agent") : "Today";
    return sendPage(c, {
      title: `${title} on Portico`,
      body: html`<div id="app">${raw(first)}</div>`,
      data,
      scripts: ["app.js"],
      styles: ["app.css"],
    });
  };
  route.get("/", (c) => page(c, { page: "today" }));
  route.get("/activity", (c) => page(c, { page: "activity" }));
  route.get("/a/:agentId", (c) => page(c, { page: "agent", id: c.req.param("agentId") }));
  route.get("/c/:threadId", (c) => (c.get("person") ? c.redirect("/activity", 303) : c.redirect(signInPath(c.req.url), 303)));
  return route;
}
