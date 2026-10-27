import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage, safeNext } from "./layout";

/** The key icon on "Sign in with a passkey". */
const KEY_ICON = html`<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="15" r="4"></circle><path d="M10.8 12.2 L20 3 M16 7 L19 10 M18 5 L21 8"></path></svg>`;

/**
 * /sign-in (board K2): a name and password, or a passkey where the browser has passkeys. `?next=` is the page to return
 * to, kept to Portico's own paths. A signed-in visit goes straight there; a claim still waiting goes to /invite.
 */
export function signInPage(_core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/sign-in", (c) => {
    const next = safeNext(c.req.query("next"));
    const person = c.get("person");
    if (person) return c.redirect(person.status === "pending" ? "/invite" : next, 303);
    return narrowPage(c, {
      title: "Sign in to Portico",
      scripts: ["forms.js", "passkey.js"],
      main: html`<h1>Sign in to Portico</h1>
<div class="form-card">
  <div data-passkey-option hidden>
    <div style="display: flex; flex-direction: column; gap: 8px">
      <button type="button" class="btn btn-secondary" style="width: 100%" data-passkey-sign-in data-next="${next}">${KEY_ICON}Sign in with a passkey</button>
      <p class="notice notice-error" data-passkey-error role="alert" hidden></p>
      <div style="display: flex; align-items: center; gap: 12px; margin: 8px 0; font-size: 12px; line-height: 16px; color: var(--muted)"><span aria-hidden="true" style="flex: 1 1 auto; height: 1px; background: #d5dbd3"></span>or<span aria-hidden="true" style="flex: 1 1 auto; height: 1px; background: #d5dbd3"></span></div>
    </div>
  </div>
  <form data-api="POST /api/session" style="display: flex; flex-direction: column; gap: 8px">
    <label for="in-name" class="lbl">Name</label>
    <input id="in-name" name="name" class="field" autocomplete="username" autocapitalize="words" spellcheck="false" required>
    <label for="in-pw" class="lbl">Password</label>
    <input id="in-pw" name="password" class="field" type="password" autocomplete="current-password" required>
    <p class="notice notice-error" data-error role="alert" hidden></p>
    <div class="actions"><button type="submit" class="btn btn-primary">Sign in</button></div>
    <input type="hidden" name="next" value="${next}">
  </form>
</div>
<p class="help">No account yet? Ask the person who runs this Portico for an invite link.</p>`,
    });
  });
  return route;
}
