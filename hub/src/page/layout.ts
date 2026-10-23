import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import type { PorticoConfig, TaskStatus } from "../core/types";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

// An ink primary and one sober accent (teal); no purple. Dark mode follows the system setting.
const STYLE = `
:root{--ink:#16181d;--muted:#5b616e;--line:#e2e4e8;--surface:#fff;--bg:#f5f6f7;--accent:#1f6f5c;--accent-ink:#fff;--danger:#a3392b}
@media (prefers-color-scheme:dark){:root{--ink:#eceef1;--muted:#a1a7b2;--line:#2b2f37;--surface:#1a1d23;--bg:#111317;--accent:#5fb39c;--accent-ink:#0d1f1a;--danger:#e2806f}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px 48px}
nav{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center;max-width:860px;margin:0 auto;padding:12px 16px;border-bottom:1px solid var(--line)}
nav a{color:var(--ink);text-decoration:none;font-weight:600}
nav form{margin-left:auto}
nav button{white-space:nowrap}
h1{font-size:22px;margin:8px 0 16px}
h2{font-size:17px;margin:28px 0 10px}
a{color:var(--accent)}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
.meta{color:var(--muted);font-size:13px}
pre{white-space:pre-wrap;word-break:break-word;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-top:10px}
.grow{flex:1;min-width:220px}
button{font:inherit;font-weight:600;border-radius:8px;padding:8px 14px;border:1px solid var(--line);background:var(--surface);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger{color:var(--danger)}
input,textarea,select{font:inherit;color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:8px}
textarea{width:100%;min-height:60px;margin-bottom:8px}
label{display:block;font-size:13px;color:var(--muted);margin-bottom:4px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
td{overflow-wrap:anywhere}
td summary{overflow-wrap:normal}
.status{font-size:12px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.status.live{border-color:var(--accent);color:var(--accent)}
.paste{width:100%;min-height:72px;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.full{width:100%}
.spaced{margin-bottom:12px}
.fields{align-items:flex-start}
.fields select{height:calc(1.5em + 18px)}
details.confirm summary{cursor:pointer;font-weight:600;color:var(--danger)}
details.confirm form{margin-top:6px}
details.confirm button{padding:6px 8px;font-size:13px}
.message{overflow-wrap:anywhere}
.message .meta a{white-space:nowrap}
.body{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24em;overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;margin:8px 0 0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.body:focus-visible{outline:2px solid var(--accent)}
.error{border-left:3px solid var(--danger)}
@media (max-width:600px){.narrow-hide{display:none}}
`;

export const CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const STATUS_WORDS: Record<TaskStatus, string> = {
  waiting_approval: "waiting for approval",
  queued: "queued",
  working: "in progress",
  done: "done",
  failed: "failed",
  denied: "denied",
  expired: "expired",
};

/** "2026-10-20 12:00 UTC" in a <time> element. */
export function formatTime(iso: string): Html {
  return html`<time datetime="${iso}">${iso.slice(0, 16).replace("T", " ")} UTC</time>`;
}

const NAV = html`<nav><a href="/hub">Waiting</a><a href="/hub/network">Network</a><a href="/hub/history">History</a><a href="/hub/messages">Messages</a><form method="post" action="/hub/logout"><button type="submit">Sign out</button></form></nav>`;

export function layout(title: string, body: Html, opts: { nav?: boolean } = {}): Html {
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><style>${raw(STYLE)}</style></head>
<body>${opts.nav ? NAV : ""}<main>${body}</main></body></html>`;
}

/** Sends a page with the headers every hub page uses. */
export function sendPage(
  c: Context,
  status: 200 | 400 | 401 | 403 | 404 | 413 | 429,
  title: string,
  body: Html,
  opts: { nav?: boolean } = {},
): Response | Promise<Response> {
  c.header("Cache-Control", "no-store");
  // same-origin keeps task URLs out of other sites' logs. Not no-referrer: under it, browsers send
  // `Origin: null` even on the page's own form posts, and sameOrigin() refuses them.
  c.header("Referrer-Policy", "same-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", CSP);
  return c.html(layout(title, body, opts), status);
}

/** Like jsonBodyLimit, but answers with an HTML page, because these forms are posted from a browser. */
export function formBodyLimit(config: PorticoConfig) {
  const maxBodyBytes = config.limits.maxTextKb * 1024 * 3;
  return bodyLimit({
    maxSize: maxBodyBytes,
    onError: (c) => sendPage(c, 413, "Too large", html`<h1>The form is too large.</h1><p class="meta">Nothing was changed.</p>`),
  });
}
