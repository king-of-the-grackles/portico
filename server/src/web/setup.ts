import { type Context, Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { cleanPublicUrl } from "../core/settings";
import { narrowPage } from "./layout";

/** The address the browser used, as a proxy in front of Portico reports it: the public URL's best first guess. */
function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const first = (name: string) => c.req.header(name)?.split(",")[0]?.trim() || null;
  const proto = first("x-forwarded-proto") ?? url.protocol.replace(/:$/, "");
  const host = first("x-forwarded-host") ?? c.req.header("host") ?? url.host;
  const origin = `${proto}://${host}`;
  return cleanPublicUrl(origin) ?? origin;
}

/**
 * /setup#<token> (board A1): the one-time setup link's page. Before setup it creates the owner and confirms the public
 * URL; after setup, a link from `portico setup --reset` sets a new owner password. The token stays in the fragment,
 * which browsers never send; forms.js posts it.
 */
export function setupPage(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  route.get("/setup", (c) => {
    if (core.settings.setupDone()) {
      return narrowPage(c, {
        title: "Reset the owner password",
        scripts: ["forms.js"],
        main: html`<div>
  <h1>Reset the owner password</h1>
  <p class="lead">Set a new password for the owner account. Every browser signed in as the owner is signed out, and the owner's computers and agents have to join again.</p>
</div>
<form class="form-card" data-api="POST /api/setup">
  <label for="reset-pw" class="lbl">New password</label>
  <input id="reset-pw" name="password" class="field" type="password" autocomplete="new-password" minlength="12" required aria-describedby="reset-pw-help">
  <span id="reset-pw-help" class="help">12 characters or more.</span>
  <p class="notice notice-error" data-error role="alert" style="font-variant-ligatures: none" hidden></p>
  <input type="hidden" name="token" data-fragment>
  <div class="actions"><button type="submit" class="btn btn-primary">Set new password</button></div>
</form>
<p class="help">This reset link works once. For a new link, run <code>portico setup --reset</code> on the host.</p>`,
      });
    }
    const publicUrl = core.config.publicUrl ?? core.settings.get("public_url") ?? requestOrigin(c);
    return narrowPage(c, {
      title: "Set up Portico",
      scripts: ["forms.js"],
      main: html`<div>
  <h1>Set up Portico</h1>
  <p class="lead">Create the owner account. The owner adds agents, invites people and approves sign in requests.</p>
</div>
<form class="form-card" data-api="POST /api/setup">
  <label for="setup-name" class="lbl">Name</label>
  <input id="setup-name" name="name" class="field" autocomplete="name" required aria-describedby="setup-name-help">
  <span id="setup-name-help" class="help">Shown to invited people.</span>
  <label for="setup-pw" class="lbl">Password</label>
  <input id="setup-pw" name="password" class="field" type="password" autocomplete="new-password" minlength="12" required aria-describedby="setup-pw-help">
  <span id="setup-pw-help" class="help">12 characters or more.</span>
  <label for="setup-url" class="lbl">Public URL</label>
  <input id="setup-url" name="publicUrl" class="field" type="url" inputmode="url" autocomplete="url" spellcheck="false" required value="${publicUrl}" aria-describedby="setup-url-help">
  <span id="setup-url-help" class="help">The address people and agents use to reach Portico.</span>
  <p class="notice notice-error" data-error role="alert" style="font-variant-ligatures: none" hidden></p>
  <input type="hidden" name="token" data-fragment>
  <div class="actions"><button type="submit" class="btn btn-primary">Create owner account</button></div>
</form>
<p class="help">This setup link works once. Passkeys can be added later in Settings.</p>`,
    });
  });
  return route;
}
