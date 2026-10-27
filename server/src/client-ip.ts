import type { Context } from "hono";

/**
 * The address a request came from, for the limiters. On Fly (FLY_APP_NAME set), Fly-Client-IP, which Fly's proxy sets.
 * Elsewhere the last X-Forwarded-For entry, the one the nearest proxy added (earlier entries are whatever the client
 * sent). Else "local". A client can still pick its own address where no proxy adds one, so limiters also cap per name.
 */
export function clientIp(c: Context, env: Record<string, string | undefined> = process.env): string {
  if (env.FLY_APP_NAME) {
    const fly = c.req.header("fly-client-ip")?.trim();
    if (fly) return fly;
  }
  return c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "local";
}
