import type { Context } from "hono";

/**
 * The address a request came from, for the limiters, from the one place the deploy's own proxy writes it:
 * - on Fly (FLY_APP_NAME set), Fly-Client-IP, which Fly's proxy sets and overwrites. Nothing else is read there:
 *   X-Forwarded-For can carry whatever the client sent.
 * - on Render (RENDER set), or where PORTICO_TRUST_FORWARDED_FOR is 1 because a proxy the operator runs fronts
 *   Portico, the last X-Forwarded-For entry: the one the nearest proxy added (earlier entries are the client's own).
 * - anywhere else no header is believed, since a client that connects directly picks its own: every request counts
 *   as "local", and the limiters that also cap per name still hold.
 * An IPv6 address is cut to its /64, the block one subscriber holds, so one client can't rotate through addresses.
 */
export function clientIp(c: Context, env: Record<string, string | undefined> = process.env): string {
  if (env.FLY_APP_NAME) return limitKey(c.req.header("fly-client-ip")?.trim() || "local");
  if (env.RENDER || env.PORTICO_TRUST_FORWARDED_FOR === "1") return limitKey(c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "local");
  return "local";
}

/** The address as a limiter counts it: an IPv4 address whole (an IPv4-mapped IPv6 one as its IPv4), an IPv6 one as its /64. */
export function limitKey(address: string): string {
  const text = address.replace(/^\[|\]$/g, "").split("%")[0]!.toLowerCase();
  if (!text.includes(":")) return text;
  const mapped = /^(?:0*:)*:?ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (mapped) return mapped[1]!;
  const [head, tail] = text.split("::") as [string, string | undefined];
  const left = head === "" ? [] : head.split(":");
  const right = tail === undefined || tail === "" ? [] : tail.split(":");
  if (left.length + right.length > 8 || (tail === undefined && left.length !== 8)) return text;
  const groups = [...left, ...Array<string>(8 - left.length - right.length).fill("0"), ...right];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return text;
  return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
