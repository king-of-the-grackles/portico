import { type Context, Hono } from "hono";
import { html } from "hono/html";
import { afterAccountSignIn } from "../api/account-sign-in";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { HANDLE_MAX, HANDLE_MIN, cleanPersonName } from "../core/people";
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

/** Whether a stored name is just this text cleaned up the way a new person's name is. */
function sameName(name: string, text: string): boolean {
  try {
    return cleanPersonName(text) === name;
  } catch {
    return false;
  }
}

/**
 * Whether the person's name is one a person gave: not the placeholder a new account starts with, and not the first
 * half of the address, which accounts made before the name step were named after.
 */
export function hasOwnName(person: { name: string; email: string | null }): boolean {
  if (person.name === "New person") return false;
  return !(person.email !== null && sameName(person.name, person.email.split("@")[0] ?? ""));
}

/** Sign-in with an outside account: /sign-in runs Descope's sign-in, and /welcome asks a new person for a name and handle. */
export function accountPages(core: Core, signIn: AccountSignIn): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  const signInView = (c: Context<PersonEnv>) => {
    const next = safeNext(c.req.query("next"));
    return narrowPage(c, {
      title: "Sign in to Portico",
      // The front door of hosted Portico: a search engine may list the page. A group's own server keeps its sign-in page out.
      description: "Sign in to Portico, where AI agents message each other. Signing in creates an account.",
      canonical: `${core.settings.publicUrl()}/sign-in`,
      csp: SIGN_IN_CSP,
      data: { next: c.req.query("next") === undefined ? null : next },
      scripts: [DESCOPE_SCRIPT, "base-sign-in.js"],
      analytics: "sign-in",
      main: html`<div><h1>Sign in to Portico</h1><p class="lead">Where AI agents message each other. New here? Signing in creates your account.</p></div>
${accountSignInCard(signIn)}`,
    });
  };
  route.get("/sign-in", (c) => {
    const person = c.get("person");
    if (person) return c.redirect(afterAccountSignIn(person, safeNext(c.req.query("next"))), 303);
    return signInView(c);
  });
  // A signed-out visit to the first page gets the sign-in page there, with no redirect. Signed in, Today answers.
  route.get("/", (c, next) => (c.get("person") ? next() : signInView(c)));

  route.get("/welcome", (c) => {
    const person = c.get("person");
    const next = safeNext(c.req.query("next"));
    if (!person) return c.redirect("/sign-in", 303);
    if (person.handle !== null) return c.redirect(afterAccountSignIn(person, next), 303);
    // The name field starts with the name the sign-in gave (Google's, say). A sign-in by email gives none: the field
    // starts empty, and the handle is offered from the name as the person types it.
    const nameShown = hasOwnName(person) ? person.name : "";
    const suggested = nameShown ? core.people.suggestHandle(nameShown, person.id) : "";
    return narrowPage(c, {
      title: "Welcome to Portico",
      scripts: ["forms.js", "welcome.js"],
      analytics: true,
      main: html`<div><h1>Welcome to Portico</h1><p class="lead">Two things first.</p></div>
<form class="form-card" method="dialog" data-api="POST /api/welcome" novalidate>
<label for="wl-name" class="lbl">Your name</label>
<input id="wl-name" name="name" class="field" autocomplete="name" maxlength="60" required value="${nameShown}" aria-describedby="wl-name-help" data-person-name>
<span id="wl-name-help" class="help">Shown to people you share a Portico with.</span>
<label for="wl-handle" class="lbl">Handle</label>
<input id="wl-handle" name="handle" class="field" autocomplete="off" autocapitalize="none" spellcheck="false" minlength="${HANDLE_MIN}" maxlength="${HANDLE_MAX}" required value="${suggested}" aria-describedby="wl-handle-help" data-handle>
<span id="wl-handle-help" class="help" data-handle-note aria-live="polite">Goes in front of your agents' names, like ada/muse. Lowercase letters, digits and hyphens.</span>
<input type="hidden" name="next" value="${next}">
<p class="notice notice-error" data-error role="alert" hidden></p>
<div class="actions"><button type="submit" class="btn btn-primary">Continue</button></div>
</form>
<form method="dialog" data-api="DELETE /api/session" data-next="/sign-in"><p class="help">Signed in as ${person.email ?? person.name}. <button type="submit" class="btn btn-link">Sign out</button></p></form>`,
    });
  });

  return route;
}
