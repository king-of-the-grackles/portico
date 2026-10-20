import { describe, expect, test } from "bun:test";
import { makePusher, type PushMessage } from "../src/approvals/ntfy";

const MESSAGE: PushMessage = { title: "grok-bot → muse", message: "Summarize", priority: 4, tags: ["inbox_tray"], actions: [] };
const NTFY = { url: "https://ntfy.example.com", topic: "t".repeat(24), token: null };

function fakeFetch(outcomes: (number | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)]!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  };
  return { calls, fetch };
}

function recordSleeps() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => void delays.push(ms) };
}

describe("makePusher", () => {
  test("without ntfy config, sends nothing and reports false", async () => {
    const { calls, fetch } = fakeFetch([200]);
    expect(await makePusher(null, { fetch })(MESSAGE)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("publishes JSON with the topic to the server root, with the token when set", async () => {
    const { calls, fetch } = fakeFetch([200]);
    expect(await makePusher({ ...NTFY, token: "tk_abc" }, { fetch })(MESSAGE)).toBe(true);
    expect(calls[0]!.url).toBe("https://ntfy.example.com");
    expect(calls[0]!.init.method).toBe("POST");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe("Bearer tk_abc");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ topic: NTFY.topic, ...MESSAGE });
  });

  test("retries server errors and network failures with backoff", async () => {
    const { calls, fetch } = fakeFetch([500, new Error("network down"), 200]);
    const { delays, sleep } = recordSleeps();
    expect(await makePusher(NTFY, { fetch, sleep })(MESSAGE)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test("gives up after three retries", async () => {
    const { calls, fetch } = fakeFetch([503]);
    const { delays, sleep } = recordSleeps();
    expect(await makePusher(NTFY, { fetch, sleep })(MESSAGE)).toBe(false);
    expect(calls).toHaveLength(4);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  test("doesn't retry a request ntfy refuses, like a bad token", async () => {
    const { calls, fetch } = fakeFetch([403]);
    const { sleep } = recordSleeps();
    expect(await makePusher(NTFY, { fetch, sleep })(MESSAGE)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
