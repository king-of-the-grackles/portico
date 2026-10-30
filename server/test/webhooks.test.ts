import { describe, expect, test } from "bun:test";
import { cleanWebhookUrl, isPublicAddress, retryable, safePost, signWebhook, verifyWebhook, webhookKey } from "../src/core/webhooks";

// The reference vector from the Standard Webhooks specification.
const SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
const ID = "msg_p5jXN8AQM9LWM0D4loKWxJek";
const TS = 1614265330;
const BODY = '{"test": 2432232314}';

describe("Standard Webhooks signing", () => {
  test("matches the specification's reference signature", () => {
    expect(signWebhook([SECRET], ID, TS, BODY)).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  });

  test("signs with both secrets during a rotation, and either verifies", () => {
    const other = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
    const header = signWebhook([SECRET, other], ID, TS, BODY);
    expect(header.split(" ")).toHaveLength(2);
    expect(verifyWebhook(SECRET, ID, TS, BODY, header)).toBe(true);
    expect(verifyWebhook(other, ID, TS, BODY, header)).toBe(true);
    expect(verifyWebhook(SECRET, ID, TS, `${BODY} `, header)).toBe(false);
  });

  test("a secret is whsec_ plus base64 of 24 to 64 bytes", () => {
    expect(webhookKey(SECRET)?.length).toBe(24);
    expect(webhookKey(`whsec_${Buffer.alloc(23).toString("base64")}`)).toBeNull();
    expect(webhookKey(`whsec_${Buffer.alloc(65).toString("base64")}`)).toBeNull();
    expect(webhookKey(Buffer.alloc(32).toString("base64"))).toBeNull();
    expect(webhookKey("whsec_not base64!")).toBeNull();
    expect(webhookKey(42)).toBeNull();
  });
});

describe("addresses Portico may post to", () => {
  test.each([
    ["93.184.215.14", true],
    ["8.8.8.8", true],
    ["127.0.0.1", false],
    ["10.1.2.3", false],
    ["172.16.0.1", false],
    ["172.32.0.1", true],
    ["192.168.1.1", false],
    ["169.254.169.254", false],
    ["100.64.0.1", false],
    ["0.0.0.0", false],
    ["224.0.0.1", false],
    ["255.255.255.255", false],
    ["2606:4700:10::6814:179a", true],
    ["::1", false],
    ["::", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["ff02::1", false],
    ["2001:db8::1", false],
    ["::ffff:127.0.0.1", false],
    ["::ffff:8.8.8.8", true],
    ["64:ff9b::10.0.0.1", false],
    ["not an address", false],
  ])("%s → %p", (address, allowed) => {
    expect(isPublicAddress(address)).toBe(allowed);
  });

  test("webhook URLs are https without credentials; http only when private addresses are allowed", () => {
    expect(cleanWebhookUrl("https://hooks.example.com/run/1?x=1#frag")).toBe("https://hooks.example.com/run/1?x=1");
    expect(cleanWebhookUrl("http://hooks.example.com/run")).toBeNull();
    expect(cleanWebhookUrl("http://localhost:9000/hook", true)).toBe("http://localhost:9000/hook");
    expect(cleanWebhookUrl("https://user:pw@hooks.example.com/")).toBeNull();
    expect(cleanWebhookUrl("ftp://hooks.example.com/")).toBeNull();
    expect(cleanWebhookUrl("nope")).toBeNull();
  });
});

describe("safePost", () => {
  test("refuses private literal addresses and names that resolve to them", async () => {
    const post = safePost();
    expect(await post({ url: "https://127.0.0.1/hook", headers: {}, body: "{}" })).toEqual({ status: null, error: "blocked_address" });
    expect(await post({ url: "https://[::1]/hook", headers: {}, body: "{}" })).toEqual({ status: null, error: "blocked_address" });
    expect(await post({ url: "https://localhost/hook", headers: {}, body: "{}" })).toEqual({ status: null, error: "blocked_address" });
    expect(await post({ url: "http://example.com/hook", headers: {}, body: "{}" })).toEqual({ status: null, error: "bad_url" });
  });

  test("posts with the headers, reads the answer, and never follows a redirect", async () => {
    const seen: { headers: Headers; body: string }[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.push({ headers: req.headers, body: await req.text() });
        if (new URL(req.url).pathname === "/moved") return new Response(null, { status: 302, headers: { location: "/hook" } });
        return Response.json({ ok: true });
      },
    });
    try {
      const post = safePost({ allowPrivate: true });
      const ok = await post({ url: `http://localhost:${server.port}/hook`, headers: { authorization: "Bearer k" }, body: '{"a":1}' });
      expect(ok).toEqual({ status: 200, body: '{"ok":true}' });
      expect(seen[0]!.headers.get("authorization")).toBe("Bearer k");
      expect(seen[0]!.headers.get("content-type")).toBe("application/json");
      expect(seen[0]!.body).toBe('{"a":1}');
      const moved = await post({ url: `http://localhost:${server.port}/moved`, headers: {}, body: "{}" });
      expect(moved.status).toBe(302);
      expect(seen).toHaveLength(2);
    } finally {
      server.stop(true);
    }
  });

  test("a slow answer runs out the deadline, and an endless one is cut off once enough is read", async () => {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const endless = new URL(req.url).pathname === "/endless";
        const stream = new ReadableStream({
          async pull(controller) {
            if (endless) controller.enqueue(new Uint8Array(4096).fill(120));
            else {
              await Bun.sleep(100);
              controller.enqueue(new TextEncoder().encode("x"));
            }
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    try {
      const post = safePost({ allowPrivate: true, timeoutMs: 400 });
      const started = Date.now();
      expect(await post({ url: `http://localhost:${server.port}/slow`, headers: {}, body: "{}" })).toEqual({ status: null, error: "timeout" });
      expect(Date.now() - started).toBeLessThan(2000);
      const endless = await post({ url: `http://localhost:${server.port}/endless`, headers: {}, body: "{}" });
      expect(endless.status).toBe(200);
      expect((endless as { body: string }).body.length).toBe(16 * 1024);
    } finally {
      server.stop(true);
    }
  });

  test("refuses a body over 256 KiB", async () => {
    const post = safePost({ allowPrivate: true });
    expect(await post({ url: "http://localhost:1/hook", headers: {}, body: "x".repeat(256 * 1024 + 1) })).toEqual({
      status: null,
      error: "too_large",
    });
  });

  test("an unreachable host answers with no status, and is worth retrying", async () => {
    const result = await safePost({ allowPrivate: true })({ url: "http://localhost:1/hook", headers: {}, body: "{}" });
    expect(result).toEqual({ status: null, error: "unreachable" });
    expect(retryable(result)).toBe(true);
    expect(retryable({ status: 429, body: "" })).toBe(true);
    expect(retryable({ status: 503, body: "" })).toBe(true);
    expect(retryable({ status: 401, body: "" })).toBe(false);
    expect(retryable({ status: 410, body: "" })).toBe(false);
    expect(retryable({ status: null, error: "blocked_address" })).toBe(false);
  });
});
