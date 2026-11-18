import { Hono } from "hono";
import { html } from "hono/html";
import type { PersonEnv } from "../api/context";
import type { Core } from "../core/core";
import { narrowPage } from "./layout";

/**
 * /mail/stop: the link at the foot of every email Portico sends. The page asks first, since mail scanners open links;
 * the button, or a mail app's one-click POST, stops every later email to the address. Public: the link is signed.
 */
export function mailPages(core: Core): Hono<PersonEnv> {
  const route = new Hono<PersonEnv>();
  const bad = (c: Parameters<typeof narrowPage>[0]) =>
    narrowPage(c, {
      title: "Link doesn't work",
      status: 404,
      main: html`<div><h1>This link doesn't work</h1><p class="lead">Use the link at the foot of an email from Portico.</p></div>`,
    });

  route.get("/mail/stop", (c) => {
    const token = c.req.query("t") ?? "";
    const email = core.mail.stopTarget(token);
    if (!email) return bad(c);
    if (core.mail.isBlocked(email)) {
      return narrowPage(c, { title: "Emails stopped", main: html`<div><h1>Emails stopped</h1><p class="lead">Portico sends no more email to ${email}.</p></div>` });
    }
    return narrowPage(c, {
      title: "Stop emails from Portico",
      referrer: "no-referrer",
      main: html`<div><h1>Stop emails from Portico</h1><p class="lead">Portico then sends no more email to ${email}. Share links sent before keep working.</p></div>
<form method="post" action="/mail/stop?t=${encodeURIComponent(token)}" class="row-card"><span class="row-text"><strong>${email}</strong><span class="help">Nobody can email a share link to this address afterwards.</span></span><button type="submit" class="btn btn-primary">Stop emails</button></form>`,
    });
  });

  route.post("/mail/stop", (c) => {
    const email = core.mail.stopTarget(c.req.query("t") ?? "");
    if (!email) return bad(c);
    core.mail.block(email, "opted_out");
    return narrowPage(c, { title: "Emails stopped", main: html`<div><h1>Emails stopped</h1><p class="lead">Portico sends no more email to ${email}.</p></div>` });
  });

  return route;
}
