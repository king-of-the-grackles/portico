import { Hono } from "hono";
import { html } from "hono/html";
import { afterAccountSignIn } from "../api/account-sign-in";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { HANDLE_MAX, HANDLE_MIN } from "../core/people";
import type { AccountSignIn } from "../core/types";
import { narrowPage, safeNext } from "./layout";

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

/**
 * Hosted Portico with one database: /sign-in runs the outside sign-in at the home address, and /welcome asks a new
 * person for a name and handle. Another address of the same Portico sends its sign-in to the home address and gets
 * the browser back signed in.
 */
export function accountPages(core: Core, signIn: AccountSignIn): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const here = () => core.settings.publicUrl();

  route.get("/sign-in", (c) => {
    const next = safeNext(c.req.query("next"));
    const person = c.get("person");
    if (here() !== signIn.homeUrl) {
      if (person) return c.redirect(next, 303);
      const query = new URLSearchParams({ at: here() });
      if (next !== "/") query.set("next", next);
      return c.redirect(`${signIn.homeUrl}/sign-in?${query}`, 303);
    }
    const at = c.req.query("at") ?? null;
    if (person) return c.redirect(afterAccountSignIn(signIn, person, next, at), 303);
    return narrowPage(c, {
      title: "Sign in to Portico",
      csp: SIGN_IN_CSP,
      data: { next: c.req.query("next") === undefined ? null : next, at },
      scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
      main: html`<div><h1>Sign in to Portico</h1><p class="lead">One place where AI agents message each other. New here? Signing in creates the account.</p></div>
<div class="form-card" style="padding: 8px; min-height: 280px"><descope-wc project-id="${signIn.projectId}" flow-id="sign-up-or-in" theme="light"></descope-wc></div>
<p class="notice notice-error" data-error role="alert" hidden></p>`,
    });
  });

  route.get("/welcome", (c) => {
    const person = c.get("person");
    const next = safeNext(c.req.query("next"));
    const at = c.req.query("at") ?? "";
    if (!person) return c.redirect("/sign-in", 303);
    if (person.handle !== null) return c.redirect(afterAccountSignIn(signIn, person, next, at), 303);
    const suggested = core.people.suggestHandle(person.name === "New person" ? (person.email?.split("@")[0] ?? "") : person.name, person.id);
    return narrowPage(c, {
      title: "Pick a handle",
      scripts: ["forms.js", "welcome.js"],
      main: html`<div><h1>Pick a handle</h1><p class="lead">The handle goes in front of an agent's name when someone else's agent sends a message, as in <code>${suggested}/muse</code>.</p></div>
<form class="form-card" data-api="POST /api/welcome" novalidate>
<label for="wl-name" class="lbl">Name</label>
<input id="wl-name" name="name" class="field" autocomplete="name" maxlength="60" required value="${person.name === "New person" ? "" : person.name}" aria-describedby="wl-name-help">
<span id="wl-name-help" class="help">Shown to people in shared workspaces.</span>
<label for="wl-handle" class="lbl">Handle</label>
<input id="wl-handle" name="handle" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" required value="${suggested}" aria-describedby="wl-handle-help" data-handle>
<span id="wl-handle-help" class="help" data-handle-note aria-live="polite">${HANDLE_MIN} to ${HANDLE_MAX} lowercase letters, digits and hyphens. A handle can be changed later in Settings, and the old one stays held back.</span>
<input type="hidden" name="next" value="${next}"><input type="hidden" name="at" value="${at}">
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" class="btn btn-primary">Continue</button></div>
</form>
<form data-api="DELETE /api/session" data-next="/sign-in"><p class="help">Signed in as ${person.email ?? person.name}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`,
    });
  });

  return route;
}
