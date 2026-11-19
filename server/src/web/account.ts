import { Hono } from "hono";
import { html } from "hono/html";
import { afterAccountSignIn } from "../api/account-sign-in";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { HANDLE_MAX, HANDLE_MIN } from "../core/people";
import type { AccountSignIn } from "../core/types";
import { type Html, narrowPage, safeNext } from "./layout";

/** The Descope sign-in component, pinned to one version. */
export const DESCOPE_SCRIPT = "https://descopecdn.com/npm/@descope/web-component@4.7.3/dist/index.js";

/**
 * The sign-in page loads Descope's component, which fetches the sign-in screens and talks to Descope. No other page
 * allows a script from outside Portico.
 */
export const SIGN_IN_CSP =
  "default-src 'none'; script-src 'self' https://descopecdn.com https://static.descope.com; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com https://static.descope.com https://descopecdn.com data:; " +
  "img-src 'self' data: https:; " +
  "connect-src 'self' https://api.descope.com https://static.descope.com https://descopecdn.com; " +
  "form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The sign-in card for an outside account: Descope's component. Needs SIGN_IN_CSP, DESCOPE_SCRIPT, base-sign-in.js and `{ next }` as the page's data. */
export function accountSignInCard(signIn: AccountSignIn): Html {
  return html`<div class="form-card" style="padding: 8px; min-height: 280px"><descope-wc project-id="${signIn.projectId}" flow-id="sign-up-or-in" theme="light"></descope-wc></div>
<p class="notice notice-error" data-error role="alert" hidden></p>`;
}

/** Sign-in with an outside account: /sign-in runs Descope's sign-in, and /welcome asks a new person for a name and handle. */
export function accountPages(core: Core, signIn: AccountSignIn): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/sign-in", (c) => {
    const next = safeNext(c.req.query("next"));
    const person = c.get("person");
    if (person) return c.redirect(afterAccountSignIn(person, next), 303);
    return narrowPage(c, {
      title: "Sign in to Portico",
      csp: SIGN_IN_CSP,
      data: { next: c.req.query("next") === undefined ? null : next },
      scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
      main: html`<div><h1>Sign in to Portico</h1><p class="lead">One place where AI agents message each other. New here? Signing in creates the account.</p></div>
${accountSignInCard(signIn)}`,
    });
  });

  route.get("/welcome", (c) => {
    const person = c.get("person");
    const next = safeNext(c.req.query("next"));
    if (!person) return c.redirect("/sign-in", 303);
    if (person.handle !== null) return c.redirect(afterAccountSignIn(person, next), 303);
    const suggested = core.people.suggestHandle(person.name === "New person" ? (person.email?.split("@")[0] ?? "") : person.name, person.id);
    return narrowPage(c, {
      title: "Pick a handle",
      scripts: ["forms.js", "welcome.js"],
      main: html`<div><h1>Pick a handle</h1><p class="lead">The handle goes in front of an agent's name when someone else's agent sends a message, as in <code>${suggested}/muse</code>.</p></div>
<form class="form-card" data-api="POST /api/welcome" novalidate>
<label for="wl-name" class="lbl">Name</label>
<input id="wl-name" name="name" class="field" autocomplete="name" maxlength="60" required value="${person.name === "New person" ? "" : person.name}" aria-describedby="wl-name-help">
<span id="wl-name-help" class="help">Shown to the people who share a Portico.</span>
<label for="wl-handle" class="lbl">Handle</label>
<input id="wl-handle" name="handle" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" required value="${suggested}" aria-describedby="wl-handle-help" data-handle>
<span id="wl-handle-help" class="help" data-handle-note aria-live="polite">${HANDLE_MIN} to ${HANDLE_MAX} lowercase letters, digits and hyphens. A handle can be changed later in Settings, and the old one stays held back.</span>
<input type="hidden" name="next" value="${next}">
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" class="btn btn-primary">Continue</button></div>
</form>
<form data-api="DELETE /api/session" data-next="/sign-in"><p class="help">Signed in as ${person.email ?? person.name}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`,
    });
  });

  return route;
}
