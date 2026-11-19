import type { Context } from "hono";

/**
 * The address a request came from, for the limiters, from the one place that can be believed where Portico runs:
 * - on Fly (FLY_APP_NAME set), Fly-Client-IP, which Fly's proxy sets and overwrites. Nothing else is read there:
 *   X-Forwarded-For can carry whatever the client sent.
 * - on Render (RENDER set), or where PORTICO_TRUST_FORWARDED_FOR is 1 because a proxy the operator runs fronts
 *   Portico, the last X-Forwarded-For entry: the one the nearest proxy added (earlier entries are the client's own).
 * - anywhere else no header is believed, since a client that connects directly picks its own. The connection's own
 *   remote address counts instead, so one client can't use up a limit for everyone. A loopback or private address
 *   there is "local": it is this computer, the local network, or a proxy nobody told Portico about, and locking that
 *   one address out would lock out everyone behind it.
 * An IPv6 address is cut to its /64, the block one subscriber holds, so one client can't rotate through addresses.
 */
export function clientIp(c: Context, env: Record<string, string | undefined> = process.env): string {
  if (env.FLY_APP_NAME) return limitKey(c.req.header("fly-client-ip")?.trim() || "local");
  if (env.RENDER || env.PORTICO_TRUST_FORWARDED_FOR === "1") return limitKey(c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim() || "local");
  const remote = socketAddress(c);
  return remote === null || isPrivate(remote) ? "local" : limitKey(remote);
}

/** The connection's remote address: Bun.serve hands its server to the app as the request's environment. */
function socketAddress(c: Context): string | null {
  try {
    const server = c.env as { requestIP?: (req: Request) => { address: string } | null } | undefined;
    const address = typeof server?.requestIP === "function" ? server.requestIP(c.req.raw)?.address : undefined;
    return typeof address === "string" && address !== "" ? address : null;
  } catch {
    return null;
  }
}

/** Loopback, link-local and private ranges, IPv4 (also as IPv4-mapped IPv6) and IPv6. */
function isPrivate(address: string): boolean {
  const key = limitKey(address);
  if (!key.includes(":")) {
    const [a, b] = key.split(".").map(Number) as [number, number];
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
  }
  return /^(0:0:0:0::|f[cd][0-9a-f]{0,2}:|fe[89ab][0-9a-f]?:)/.test(key);
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
