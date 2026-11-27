import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { clientIp } from "../client-ip";
import { WindowLimiter } from "../computer-api/limiter";
import { SESSION_COOKIE } from "../core/accounts";
import { ANON_ID, type AnalyticsProperties, optedOut } from "../core/analytics";
import type { Core } from "../core/core";
import { HOUR_MS } from "../core/limits";

const MAX_BODY_CHARS = 2048;
const PER_ADDRESS_AN_HOUR = 600;

/** The pages the browser module runs on, as shapes: the only form of an address that is ever sent on. */
const SHAPES: [RegExp, string][] = [
  [/^\/$/, "/"],
  [/^\/sign-in\/?$/, "/sign-in"],
  [/^\/welcome\/?$/, "/welcome"],
  [/^\/activity\/?$/, "/activity"],
  [/^\/settings\/?$/, "/settings"],
  [/^\/a\/[^/?#]+\/?$/, "/a/:id"],
  [/^\/p\/[^/?#]+\/?$/, "/p/:id"],
];
const UTM = ["source", "medium", "campaign", "term", "content"] as const;
const UTM_VALUE = /^[\w .\-]{1,100}$/;

/** The page's path as one of the known shapes, or "other": an ID, a query or anything unexpected never leaves. */
export function pathShape(path: unknown): string {
  return typeof path === "string" ? (SHAPES.find(([shape]) => shape.test(path))?.[1] ?? "other") : "other";
}

/**
 * POST /api/analytics, there only while analytics is on: what the browser module (web/client/analytics.ts) reports,
 * a page view or that the sign-in page was seen. This server sends the event on to PostHog, reduced to the page's
 * shape, the referring site's host and campaign tags. Always answers 204: the page has nothing to do with the outcome.
 * Nothing is sent on for a browser that says Do Not Track or Global Privacy Control.
 */
export function analyticsRoute(core: Core): (c: Context) => Promise<Response> {
  const limiter = new WindowLimiter(core.now, PER_ADDRESS_AN_HOUR, HOUR_MS);
  return async (c) => {
    c.header("Cache-Control", "no-store");
    try {
      const address = clientIp(c);
      const text = await c.req.text();
      if (text.length <= MAX_BODY_CHARS && !optedOut((name) => c.req.header(name)) && !limiter.blocked(address)) {
        limiter.record(address);
        forward(core, c, JSON.parse(text));
      }
    } catch {
      // Not JSON, or nothing usable: dropped.
    }
    return c.body(null, 204);
  };
}

function forward(core: Core, c: Context, body: unknown): void {
  if (typeof body !== "object" || body === null) return;
  const { event, anon_id: anonId, path, referrer, utm } = body as Record<string, unknown>;
  if (event !== "pageview" && event !== "sign_in_viewed") return;
  const person = core.accounts.personForSession(getCookie(c, SESSION_COOKIE));
  const distinctId = person?.id ?? (typeof anonId === "string" && ANON_ID.test(anonId) ? anonId : null);
  if (distinctId === null) return;
  const publicUrl = core.settings.publicUrl();
  const shape = pathShape(path);
  const properties: AnalyticsProperties = { $pathname: shape, $current_url: `${publicUrl}${shape === "other" ? "" : shape}`, signed_in: person !== null };
  try {
    const from = new URL(String(referrer));
    if ((from.protocol === "https:" || from.protocol === "http:") && from.hostname !== new URL(publicUrl).hostname) properties.$referring_domain = from.hostname;
  } catch {
    // No referrer, or not an address.
  }
  const first: AnalyticsProperties = {};
  if (typeof utm === "object" && utm !== null) {
    for (const name of UTM) {
      const value = (utm as Record<string, unknown>)[name];
      if (typeof value !== "string" || !UTM_VALUE.test(value)) continue;
      properties[`utm_${name}`] = value;
      first[`initial_utm_${name}`] = value;
    }
  }
  core.analytics.capture(event === "pageview" ? "$pageview" : "sign_in_viewed", distinctId, properties, first);
}
