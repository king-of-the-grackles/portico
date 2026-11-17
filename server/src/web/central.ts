import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import { afterSignIn, startBrowserSession } from "../api/session";
import type { Core } from "../core/core";
import { MINUTE_MS } from "../core/limits";
import { newLinkSecret, sign, verifySigned } from "../core/tokens";
import type { CentralSignIn } from "../core/types";
import { log } from "../log";
import { narrowPage, safeNext } from "./layout";

/** Ties a sign-in's pass to the browser that asked: set when the browser leaves for the base domain, read on return. */
const STATE_COOKIE = "portico_handoff";
/** An account that signed in but has no place here yet: enough to claim an invite, and nothing else. */
const ACCOUNT_COOKIE = "portico_account";
const STATE_MS = 10 * MINUTE_MS;
/** Long enough to read the invite page and type a name. */
const ACCOUNT_MS = 60 * MINUTE_MS;

const secure = (core: Core) => core.settings.publicUrl().startsWith("https:");

/** The signed-in account waiting to claim an invite in this browser, or null. */
export function waitingAccount(c: Context, core: Core): string | null {
  const value = getCookie(c, ACCOUNT_COOKIE);
  const payload = value ? verifySigned<{ accountId: string; expiresAt: number }>(core.config.signingKey, "account", value) : null;
  if (!payload || typeof payload.accountId !== "string" || payload.expiresAt <= core.now().getTime()) return null;
  return payload.accountId;
}

export function clearWaitingAccount(c: Context, core: Core): void {
  deleteCookie(c, ACCOUNT_COOKIE, { path: "/", secure: secure(core) });
}

/**
 * A hosted workspace's sign-in. The workspace takes no password: /sign-in/start sends the browser to the base domain,
 * which sends it back to /hand-off with a pass, and the pass becomes this workspace's own session cookie.
 */
export function centralPages(core: Core, central: CentralSignIn): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();

  route.get("/sign-in", (c) => {
    const next = safeNext(c.req.query("next"));
    const person = c.get("person");
    if (person) return c.redirect(afterSignIn(person, next), 303);
    const start = next === "/" ? "/sign-in/start" : `/sign-in/start?next=${encodeURIComponent(next)}`;
    // Straight on to signing in. Only a browser that just signed out stops here, so signing out isn't undone at once.
    if (c.req.query("out") === undefined) return c.redirect(start, 303);
    return narrowPage(c, {
      title: "Sign in to Portico",
      main: html`<div><h1>Sign in to Portico</h1><p class="lead">Signing in opens this workspace.</p></div>
<div class="row-card"><span class="row-text"><strong>${new URL(core.settings.publicUrl()).host}</strong><span class="help">Workspace address</span></span><a class="btn btn-primary" href="${start}">Sign in</a></div>
<p class="help">No account yet? Ask the person who runs this workspace for an invite link.</p>`,
    });
  });

  route.get("/sign-in/start", (c) => {
    const next = safeNext(c.req.query("next"));
    const person = c.get("person");
    if (person) return c.redirect(afterSignIn(person, next), 303);
    const state = newLinkSecret();
    setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: secure(core), sameSite: "Lax", path: "/hand-off", maxAge: STATE_MS / 1000 });
    c.header("Cache-Control", "no-store");
    return c.redirect(central.startUrl(state, next), 303);
  });

  route.get("/hand-off", (c) => {
    const next = safeNext(c.req.query("next"));
    const state = getCookie(c, STATE_COOKIE);
    deleteCookie(c, STATE_COOKIE, { path: "/hand-off", secure: secure(core) });
    // Asking uses the pass up, whatever else is wrong, so a pass that went astray can't be tried again elsewhere.
    const accountId = central.take(c.req.query("pass") ?? "", state ?? "");
    // The pass is in this address: nothing after this page may learn the address.
    c.header("Referrer-Policy", "no-referrer");
    if (!accountId) {
      const again = next === "/" ? "/sign-in/start" : `/sign-in/start?next=${encodeURIComponent(next)}`;
      return narrowPage(c, {
        title: "Sign-in didn't finish",
        status: 400,
        referrer: "no-referrer",
        main: html`<div><h1>Sign-in didn't finish</h1><p class="lead">The sign-in took too long or was started in another browser.</p></div>
<div class="row-card"><span class="row-text"><strong>${new URL(core.settings.publicUrl()).host}</strong><span class="help">Workspace address</span></span><a class="btn btn-primary" href="${again}">Sign in again</a></div>`,
      });
    }
    const person = core.people.byExternalId(accountId);
    if (person) {
      clearWaitingAccount(c, core);
      startBrowserSession(c, core, person.id);
      central.joined(accountId);
      log("info", "central_sign_in", { person_id: person.id });
      return c.redirect(afterSignIn(person, next), 303);
    }
    // No place here yet. An invite link is the only way in, so the account is remembered just long enough to claim one.
    const expiresAt = core.now().getTime() + ACCOUNT_MS;
    setCookie(c, ACCOUNT_COOKIE, sign(core.config.signingKey, "account", { accountId, expiresAt }), {
      httpOnly: true,
      secure: secure(core),
      sameSite: "Lax",
      path: "/",
      maxAge: ACCOUNT_MS / 1000,
    });
    if (next === "/invite") return c.redirect("/invite", 303);
    return narrowPage(c, {
      title: "No account in this workspace",
      status: 403,
      referrer: "no-referrer",
      main: html`<div><h1>No account in this workspace</h1><p class="lead">Joining takes an invite link from the person who runs this workspace.</p></div>
<p class="help"><a href="${central.homeUrl}">See other workspaces</a></p>`,
    });
  });

  return route;
}
