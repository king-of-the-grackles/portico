import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { PersonEnv } from "../api/context";
import { agentsInOrder, personViews } from "../api/views";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { renderSettings, settingsState } from "./client/render/settings";
import type { SettingsData } from "./client/render/types";
import { sendPage, signInPath } from "./layout";

/**
 * Settings' first data. People (with invites and claims), computers and passkeys load right after from GET /api/people,
 * /api/computers and /api/passkeys, which their own tracks build.
 */
export function settingsData(core: Core, me: Person): SettingsData {
  const views = personViews(core, me);
  return {
    page: "settings",
    me: views.person(me),
    publicUrl: core.settings.publicUrl(),
    agents: agentsInOrder(core.agents, me).map(views.agent),
    people: null,
    computers: null,
    passkeys: null,
  };
}

/** /settings: People, Computers and Account. */
export function settingsPage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/settings", (c) => {
    const me = c.get("person");
    if (!me) return c.redirect(signInPath(c.req.url), 303);
    if (me.status === "pending") return c.redirect("/invite", 303);
    const data = settingsData(core, me);
    const first = renderSettings(settingsState({ ...data, now: core.now().getTime() }));
    return sendPage(c, {
      title: "Settings",
      body: html`<div id="app">${raw(first)}</div>`,
      data,
      scripts: ["app.js"],
      styles: ["app.css"],
    });
  });
  return route;
}
