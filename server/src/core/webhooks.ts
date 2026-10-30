import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

/** The largest request body Portico sends to a webhook. */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
/** How much of a webhook's answer Portico reads: enough for a verification echo. */
const MAX_ANSWER_BYTES = 16 * 1024;
/** The whole post, answer included, gets this long. */
const TIMEOUT_MS = 10_000;

/**
 * A Standard Webhooks secret's key: the base64 after `whsec_`, 24 to 64 bytes once decoded. Null for anything else.
 */
export function webhookKey(secret: unknown): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return null;
  const b64 = secret.slice("whsec_".length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const key = Buffer.from(b64, "base64");
  return key.length >= 24 && key.length <= 64 ? key : null;
}

/**
 * The `webhook-signature` header: one `v1,<base64 HMAC-SHA256>` per secret over `id.timestamp.body`, space-separated.
 * Two secrets sign during a rotation.
 */
export function signWebhook(secrets: readonly string[], id: string, timestamp: number, body: string): string {
  return secrets
    .map((secret) => {
      const key = webhookKey(secret);
      if (!key) throw new Error("Not a webhook secret.");
      return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")}`;
    })
    .join(" ");
}

/** Whether a `webhook-signature` header holds a valid signature for the secret. For tests and the verification echo. */
export function verifyWebhook(secret: string, id: string, timestamp: number, body: string, header: string): boolean {
  const expected = Buffer.from(signWebhook([secret], id, timestamp, body).slice(3), "base64");
  return header.split(" ").some((part) => {
    if (!part.startsWith("v1,")) return false;
    const got = Buffer.from(part.slice(3), "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

function publicIpv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127 || a! >= 224) return false; // this network, private, loopback, multicast, reserved
  if (a === 100 && b! >= 64 && b! <= 127) return false; // shared address space (CGNAT)
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b! >= 16 && b! <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // protocol assignments, documentation
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // documentation
  if (a === 203 && b === 0 && c === 113) return false; // documentation
  return true;
}

/** The eight 16-bit groups of an IPv6 address, an embedded IPv4 tail included. Null when it isn't one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (tail) {
    const v4 = ipv4Bytes(tail[1]!);
    if (!v4) return null;
    text = `${text.slice(0, -tail[1]!.length)}${((v4[0]! << 8) | v4[1]!).toString(16)}:${((v4[2]! << 8) | v4[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const parse = (s: string) => (s === "" ? [] : s.split(":").map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : fill < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest];
  return groups.every((g) => Number.isInteger(g)) ? groups : null;
}

/**
 * Whether Portico may post to this address: public unicast only. Loopback, private, link-local, shared (CGNAT),
 * documentation, multicast and unique-local addresses are refused, and so are IPv6 forms that carry an IPv4 address,
 * unless that address is public.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address.split("%")[0]!);
  if (version === 4) return publicIpv4(ipv4Bytes(address)!);
  if (version !== 6) return false;
  const g = ipv6Groups(address);
  if (!g) return false;
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): judged by the IPv4 address.
  const embedded = [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255];
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicIpv4(embedded);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicIpv4(embedded);
  // Global unicast is 2000::/3, less documentation (2001:db8::/32), Teredo (2001::/32) and 6to4 (2002::/16).
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && (g[1] === 0x0db8 || g[1] === 0)) return false;
  return g[0] !== 0x2002;
}

export interface WebhookRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A status is the HTTP answer, redirects included (never followed); null means no answer: refused, unreachable or timed out. */
export type WebhookResult = { status: number; body: string } | { status: null; error: string };

export type WebhookPost = (req: WebhookRequest) => Promise<WebhookResult>;

/**
 * Checks a webhook address before Portico stores it: an https:// URL without a user name or password. With
 * allowPrivate (local development only), http:// is accepted too. Returns the URL, normalized, or null.
 */
export function cleanWebhookUrl(value: unknown, allowPrivate = false): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) return null;
  if (url.username || url.password || !url.hostname) return null;
  url.hash = "";
  return url.toString();
}

/**
 * Posts JSON to a webhook. Every address the host resolves to is checked when connecting, so a name that points at a
 * private address later is still refused; redirects aren't followed. The whole exchange has one deadline, and at most
 * MAX_ANSWER_BYTES of the answer are read, so a slow or endless answer can't hold a post open. With allowPrivate (local
 * development and tests), any address and http:// are allowed.
 */
export function safePost(opts: { allowPrivate?: boolean; timeoutMs?: number } = {}): WebhookPost {
  const allowPrivate = opts.allowPrivate ?? false;
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  return (req) =>
    new Promise<WebhookResult>((resolve) => {
      const url = cleanWebhookUrl(req.url, allowPrivate);
      if (!url) return resolve({ status: null, error: "bad_url" });
      const target = new URL(url);
      const host = target.hostname.replace(/^\[|\]$/g, "");
      if (!allowPrivate && isIP(host) && !isPublicAddress(host)) return resolve({ status: null, error: "blocked_address" });
      if (Buffer.byteLength(req.body, "utf8") > MAX_WEBHOOK_BYTES) return resolve({ status: null, error: "too_large" });

      const lookup = (hostname: string, options: { all?: boolean }, cb: (...args: unknown[]) => void) => {
        dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
          if (err) return cb(err);
          if (!allowPrivate && addresses.some((a) => !isPublicAddress(a.address))) {
            return cb(Object.assign(new Error("blocked_address"), { code: "EBLOCKED" }));
          }
          if (options.all) return cb(null, addresses);
          cb(null, addresses[0]!.address, addresses[0]!.family);
        });
      };
      const send = target.protocol === "https:" ? httpsRequest : httpRequest;
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const done = (result: WebhookResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        resolve(result);
      };
      const request = send(
        target,
        {
          method: "POST",
          headers: { ...req.headers, "content-type": "application/json", "content-length": String(Buffer.byteLength(req.body)) },
          lookup: lookup as never,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const answer = () => ({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).subarray(0, MAX_ANSWER_BYTES).toString("utf8") });
          res.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            size += chunk.length;
            // Enough read: the rest of an overlong answer is never waited for.
            if (size >= MAX_ANSWER_BYTES) {
              done(answer());
              request.destroy();
            }
          });
          res.on("end", () => done(answer()));
          res.on("error", () => done(answer()));
        },
      );
      deadline = setTimeout(() => {
        done({ status: null, error: "timeout" });
        request.destroy();
      }, timeoutMs);
      request.on("error", (err: NodeJS.ErrnoException) =>
        done({ status: null, error: err.code === "EBLOCKED" || err.message === "blocked_address" ? "blocked_address" : "unreachable" }),
      );
      request.end(req.body);
    });
}

/** How a post went, as stored and shown: "ok" for any 2xx, "http_401" and the like, or why there was no answer. */
export function statusOf(result: WebhookResult): string {
  if (result.status === null) return result.error;
  return result.status >= 200 && result.status < 300 ? "ok" : `http_${result.status}`;
}

/** Whether a failed post is worth trying again: no answer, a timeout, rate limiting or a server error. */
export function retryable(result: WebhookResult): boolean {
  if (result.status === null) return result.error === "unreachable" || result.error === "timeout";
  return result.status === 408 || result.status === 429 || result.status >= 500;
}

/** Pauses before each retry: about half a minute, then 2 and 10 minutes. */
export const RETRY_DELAYS_MS = [30_000, 120_000, 600_000] as const;

/** Runs a retry later without keeping the process alive for it. */
export const laterTimer = (fn: () => void, ms: number): void => {
  setTimeout(fn, ms).unref?.();
};

export interface RetryingPost {
  post: WebhookPost;
  schedule: (fn: () => void, ms: number) => void;
  now: () => Date;
  /** The request for this try, built fresh (a new timestamp and signature), or null when nothing should be sent any more. */
  request: () => WebhookRequest | null;
  /** Each try's status ("ok", "http_503", "timeout") and when the try was sent. */
  onResult: (status: string, sentAt: Date, tries: number) => void;
  /** Once the chain ends: delivered, given up, or stopped by `request`. */
  onEnd?: () => void;
}

/** Posts, reports each try, and retries what's worth retrying after RETRY_DELAYS_MS. */
export function postWithRetry(opts: RetryingPost): void {
  const attempt = async (tries: number): Promise<void> => {
    const req = opts.request();
    if (!req) return opts.onEnd?.();
    const sentAt = opts.now();
    let result: WebhookResult;
    try {
      result = await opts.post(req);
    } catch {
      result = { status: null, error: "unreachable" };
    }
    const status = statusOf(result);
    opts.onResult(status, sentAt, tries + 1);
    if (status !== "ok" && retryable(result) && tries < RETRY_DELAYS_MS.length) {
      opts.schedule(() => void attempt(tries + 1), RETRY_DELAYS_MS[tries]!);
      return;
    }
    opts.onEnd?.();
  };
  void attempt(0);
}
