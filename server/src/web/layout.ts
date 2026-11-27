import type { Context } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { optedOut } from "../core/analytics";

export type Html = HtmlEscapedString | Promise<HtmlEscapedString>;

/** The request variable the app sets to the Analytics instance while analytics is on. */
export const ANALYTICS_ON = "analyticsOn";

/** Portico's own scripts and styles, Manrope from Google Fonts, and API calls back to Portico only. */
export const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'";

/** The portico mark, linking home. */
export const HOMEMARK = html`<a class="homemark" href="/" aria-label="Portico home"><svg width="24" height="22" viewBox="0 0 30 26" fill="none" stroke="#1F6F5C" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M2 9 L15 2 L28 9 Z"></path><path d="M6 12 V22 M12 12 V22 M18 12 V22 M24 12 V22"></path><path d="M2 24 H28"></path></svg></a>`;

/** JSON safe inside a <script> element: no "<" can close it. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export interface PageOptions {
  title: string;
  body: Html;
  /** The page's first data, read in the browser with firstData(). */
  data?: unknown;
  /**
   * Browser modules under /assets, e.g. "forms.js". A form the modules handle carries `method="dialog"`, so a press
   * before the modules have run does nothing, and no field ever goes into the address. forms.js's one import is
   * fetched alongside, so that moment is short.
   */
  scripts?: string[];
  /** Stylesheets under /assets besides base.css, e.g. "app.css". */
  styles?: string[];
  status?: 200 | 400 | 403 | 404 | 410 | 503;
  /** A page that loads something from outside Portico names its own policy. */
  csp?: string;
  /** A public page a search engine may list, with the line shown under its title there. Every other page says noindex. */
  description?: string;
  /** The one address of a page that answers at two, in full: the sign-in page also answers at / for a signed-out visit. */
  canonical?: string;
  /** A page whose address holds a secret sends no address on: "no-referrer". */
  referrer?: "no-referrer";
  /**
   * The page counts as a page view where analytics is on: it loads analytics.js, which reports the visit to Portico
   * itself. "sign-in" for the sign-in page, which reports that as well. Only pages whose address and content hold no
   * secret say so: never a consent, held-message, join, share or invite page.
   */
  analytics?: boolean | "sign-in";
}

/** Sends a page with the headers every Portico page uses. */
export function sendPage(c: Context, opts: PageOptions): Response | Promise<Response> {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", opts.referrer ?? "same-origin");
  c.header("X-Frame-Options", "DENY");
  c.header("Content-Security-Policy", opts.csp ?? CSP);
  const styles = ["base.css", ...(opts.styles ?? [])];
  // Not for a browser that says Do Not Track or Global Privacy Control: the module isn't even loaded. That the
  // signed-in person is left out of every event is recorded where the person is read (loadPerson), on every page
  // and call, whether or not the page would load the module.
  const analytics = Boolean(opts.analytics) && c.get(ANALYTICS_ON) !== undefined && !optedOut((name) => c.req.header(name));
  const page = html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${opts.description === undefined ? html`<meta name="robots" content="noindex">` : html`<meta name="description" content="${opts.description}">`}${opts.canonical === undefined ? "" : html`<link rel="canonical" href="${opts.canonical}">`}<link rel="icon" href="/assets/icon.svg" type="image/svg+xml"><title>${opts.title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400..700&amp;display=swap">
${styles.map((s) => html`<link rel="stylesheet" href="/assets/${s}">`)}
${opts.data === undefined ? "" : html`<script type="application/json" id="first-data">${raw(scriptJson(opts.data))}</script>`}
${(opts.scripts ?? []).includes("forms.js") ? html`<link rel="modulepreload" href="/assets/api.js">` : ""}
${(opts.scripts ?? []).map((s) => html`<script type="module" src="${s.startsWith("https://") ? s : `/assets/${s}`}"></script>`)}
${analytics ? html`<script type="module" src="/assets/analytics.js" data-view="${opts.analytics === "sign-in" ? "sign-in" : "page"}"></script>` : ""}
</head><body>${opts.body}</body></html>`;
  return c.html(page, opts.status ?? 200);
}

/** A standalone page: the mark at the top, then a narrow column. */
export function narrowPage(c: Context, opts: Omit<PageOptions, "body"> & { main: Html }): Response | Promise<Response> {
  return sendPage(c, { ...opts, body: html`<header class="top">${HOMEMARK}</header><main class="narrow">${opts.main}</main>` });
}

/** "Portico isn't set up yet": every page but /setup shows this until the owner finishes setup. */
export function notSetUpPage(c: Context): Response | Promise<Response> {
  return narrowPage(c, {
    title: "Portico isn't set up yet",
    status: 503,
    main: html`<div><h1>Portico isn't set up yet</h1><p class="lead">Run <code>portico setup</code> on the host for a one-time setup link.</p></div>`,
  });
}

/** Where a signed-out visit goes: the sign-in page, carrying the page to return to. */
export function signInPath(requestUrl: string): string {
  const url = new URL(requestUrl);
  const next = safeNext(url.pathname + url.search);
  return next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`;
}

const NEXT_PATH = /^\/([A-Za-z0-9._~%-]+(\/[A-Za-z0-9._~%-]+)*)?\/?(\?[A-Za-z0-9._~%=&+-]*)?$/;

/**
 * The page to return to after sign-in. Only Portico's own paths are allowed, so a crafted link can't send anyone
 * elsewhere. Anything else, including dot segments (plain or percent-encoded) and the sign-in page, becomes /.
 */
export function safeNext(value: unknown): string {
  if (typeof value !== "string" || !NEXT_PATH.test(value)) return "/";
  const path = value.split("?")[0]!;
  if (path.startsWith("/sign-in") || path.startsWith("/api/") || path.startsWith("/assets/")) return "/";
  const unsafe = path.split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\");
    } catch {
      return true;
    }
  });
  return unsafe ? "/" : value;
}

/**
 * "5:09 PM UTC", or "Nov 22, 5:09 PM UTC" when the time isn't today: a time the server shows before the browser puts
 * it in the reader's own time zone.
 */
export function utcClock(at: Date | string, now: Date = new Date()): string {
  const d = typeof at === "string" ? new Date(at) : at;
  const h = d.getUTCHours();
  const time = `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"} UTC`;
  if (d.toISOString().slice(0, 10) === now.toISOString().slice(0, 10)) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, ${time}`;
}
