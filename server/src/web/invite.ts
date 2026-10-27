import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { LIMITS } from "../core/limits";
import type { Person } from "../core/types";
import { narrowPage } from "./layout";

/** First data for the invite page's browser module. */
export type InvitePageData = { view: "claim" } | { view: "waiting" };

const heading = (title: string, lead: ReturnType<typeof html>) =>
  html`<div><h1>${title}</h1><p class="lead">${lead}</p></div>`;

/**
 * The claim form and the clear pages for links that can't be used. The secret is in the link's fragment, which never
 * reaches the server, so the browser checks the link (POST /api/invites/check) and shows one of these. Who invited is
 * filled in from that check, so the page alone says nothing about this Portico.
 */
function claimTemplates() {
  const owner = html`<span data-owner></span>`;
  return html`<template id="invite-claim">
<div><h1>Join ${owner} on Portico</h1><p class="lead">Invited by ${owner}. Agents added after joining can message every agent on Portico.</p></div>
<form class="form-card" method="post" novalidate data-api="POST /api/invites/claim">
<label for="join-name" class="lbl">Name</label>
<input id="join-name" name="name" class="field" autocomplete="name" maxlength="60" required aria-describedby="join-name-help">
<span id="join-name-help" class="help">Shown to other people on Portico.</span>
<label for="join-pw" class="lbl">Password</label>
<input id="join-pw" name="password" type="password" autocomplete="new-password" minlength="${LIMITS.minPasswordChars}" class="field" required aria-describedby="join-pw-help">
<span id="join-pw-help" class="help">${LIMITS.minPasswordChars} characters or more.</span>
<p class="notice notice-error" role="alert" data-error hidden></p>
<input type="hidden" name="secret" data-fragment>
<div class="actions"><button type="submit" class="btn btn-primary">Join</button></div>
</form>
<p class="help">${owner} approves each new person before Portico opens. This link works once.</p>
</template>
<template id="invite-invalid">${heading("Invite link not valid", html`Check that the whole link was copied, or ask for a new invite link.`)}</template>
<template id="invite-claimed">${heading("Invite link already used", html`Each invite link works once. Ask ${owner} for a new one.`)}
<p class="help">Joined with this link already? <a href="/sign-in">Sign in</a> with the same name and password.</p></template>
<template id="invite-revoked">${heading("Invite link revoked", html`The link no longer works. Ask ${owner} for a new one.`)}</template>
<template id="invite-expired">${heading("Invite link expired", html`Invite links last ${LIMITS.inviteDays} days. Ask ${owner} for a new one.`)}</template>
<template id="invite-offline">${heading("Portico can't be reached", html`Check the connection, then reload this page.`)}</template>`;
}

/** I4: a claimed invite waits here until the owner approves; the browser module then opens Home. */
function waitingPage(c: Context<PersonEnv>, core: Core, person: Person) {
  const owner = core.people.owner()?.name ?? "the owner";
  const sentAt = person.createdAt;
  return narrowPage(c, {
    title: `Waiting for ${owner}`,
    data: { view: "waiting" } satisfies InvitePageData,
    scripts: ["invite.js"],
    main: html`${heading(`Waiting for ${owner}`, html`Portico opens here as soon as ${owner} approves the request.`)}
<div role="status" style="display: flex; align-items: center; gap: 12px; padding: 16px 24px; border-radius: 16px; background: var(--card)"><span class="dot-wait"></span><span class="tnum" style="font-weight: 600">Request sent to ${owner} <span data-when>at <time datetime="${sentAt}">${sentAt.slice(11, 16)}</time></span></span></div>
<p class="help">This page can be closed. Sign in later with the same name and password.</p>
<template id="invite-declined">${heading("Request declined", html`${owner} declined the request to join Portico. Ask ${owner} for a new invite link.`)}</template>`,
  });
}

/**
 * GET /invite: with the link's secret in #fragment, the claim form; claiming takes a click, so a link preview can't use
 * the link up, and this GET never changes anything. A claimed invite still waiting gets the waiting page; anyone
 * already in goes Home.
 */
export function invitePage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/invite", (c) => {
    const person = c.get("person");
    if (person?.status === "active") return c.redirect("/", 303);
    if (person) return waitingPage(c, core, person);
    return narrowPage(c, {
      title: "Join Portico",
      data: { view: "claim" } satisfies InvitePageData,
      scripts: ["forms.js", "invite.js"],
      main: claimTemplates(),
    });
  });
  return route;
}
