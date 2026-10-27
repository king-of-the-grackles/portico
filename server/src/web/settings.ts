import { Hono } from "hono";
import { html, raw } from "hono/html";
import { computerView } from "../api/computers";
import type { PersonEnv } from "../api/context";
import { passkeyView } from "../api/passkeys";
import { peopleListing } from "../api/people";
import { agentsInOrder, personViews } from "../api/views";
import type { Core } from "../core/core";
import type { Person } from "../core/types";
import { renderSettings, settingsState } from "./client/render/settings";
import type { SettingsData } from "./client/render/types";
import { sendPage, signInPath } from "./layout";

/**
 * Settings' first data, in the shapes GET /api/me, /api/agents, /api/people, /api/computers and /api/passkeys answer.
 * Invites and claims are the owner's only.
 */
export function settingsData(core: Core, me: Person): SettingsData {
  const views = personViews(core, me);
  return {
    page: "settings",
    me: views.person(me),
    publicUrl: core.settings.publicUrl(),
    agents: agentsInOrder(core.agents, me).map(views.agent),
    people: peopleListing(core, me),
    computers: core.computers.list(me.id).map((computer) => computerView(core, me, computer)),
    passkeys: core.accounts.passkeys.list(me.id).map(passkeyView),
  };
}

/** /settings: People, Computers and Account. */
export function settingsPage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/settings", (c) => {
    const me = c.get("person");
    if (!me) return c.redirect(signInPath(c.req.url), 303);
    // A claimed invite waits for the owner on the invite page.
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
