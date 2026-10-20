import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PushMessage } from "../src/approvals/ntfy";
import { doctorCommand } from "../src/commands/doctor";
import { BASE_YAML, makeApp, testEnv } from "./helpers";

const PRONOUNS = /\b(i|me|my|we|us|our|you|your|it|its|they|them|their)\b/i;
const TOPIC = "doctor-topic-0123456789abcdef";
const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

/** A running hub on a random port, and a folder holding bridge.yaml, with an env pointing at both. */
function setUp(extraEnv: Record<string, string> = {}) {
  const hub = makeApp();
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch });
  const dir = mkdtempSync(join(tmpdir(), "bridge-doctor-"));
  writeFileSync(join(dir, "bridge.yaml"), BASE_YAML);
  stops.push(() => server.stop(true), () => rmSync(dir, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.port}`;
  const env = testEnv({ BRIDGE_PUBLIC_URL: url, BRIDGE_CONFIG: "bridge.yaml", BRIDGE_NTFY_TOPIC: TOPIC, ...extraEnv });
  return { url, dir, env, stopHub: () => server.stop(true) };
}

async function doctor(
  setup: ReturnType<typeof setUp>,
  args: string[] = [],
  push: (message: PushMessage) => Promise<boolean> = async () => true,
) {
  const lines: string[] = [];
  const pushes: PushMessage[] = [];
  const code = await doctorCommand(
    args,
    { env: setup.env, cwd: setup.dir, out: (line) => lines.push(line), err: (line) => lines.push(line) },
    {
      push: async (message) => {
        pushes.push(message);
        return push(message);
      },
      timeoutMs: 2000,
    },
  );
  return { code, lines, pushes };
}

describe("bridge doctor", () => {
  test("all checks pass against a running hub", async () => {
    const setup = setUp();
    const { code, lines, pushes } = await doctor(setup);
    expect(lines).toEqual([
      "✓ Config: 4 agents, 6 rules, 2 triggers.",
      "✓ Tokens are set for all 4 agents.",
      `! BRIDGE_PUBLIC_URL is ${setup.url}: only this machine can reach the hub there. Agents in the cloud need a public https address.`,
      `✓ ${setup.url}/healthz answered.`,
      `✓ The hub at ${setup.url} accepts the tokens of all 4 agents.`,
      "✓ Test push sent. Check that the push arrived on the phone.",
      "All checks passed.",
    ]);
    expect(code).toBe(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.title).toBe("Test push");
  });

  test("stops after listing config problems", async () => {
    const setup = setUp({ BRIDGE_TOKEN_MUSE: "" });
    const { code, lines, pushes } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ missing BRIDGE_TOKEN_MUSE for agent "muse"', "Fix the config first: the other checks depend on the config."]);
    expect(pushes).toEqual([]);
  });

  test("reports a hub that doesn't answer, and skips the token check", async () => {
    const setup = setUp();
    setup.stopHub();
    const { code, lines } = await doctor(setup, ["--no-push"]);
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith(`✗ ${setup.url}/healthz didn't answer`))).toBe(true);
    expect(lines.some((line) => line.includes("accepts the tokens"))).toBe(false);
  });

  test("names an agent whose token the running hub rejects", async () => {
    const setup = setUp({ BRIDGE_TOKEN_MUSE: "a-different-muse-token-0123456789" });
    const { code, lines } = await doctor(setup, ["--no-push"]);
    expect(code).toBe(1);
    expect(lines).toContain(
      `✗ The hub at ${setup.url} rejected the token for muse. The running hub may use a different .env.`,
    );
  });

  test("reports a failed push; --no-push skips it; no topic is a warning", async () => {
    const failed = await doctor(setUp(), [], async () => false);
    expect(failed.code).toBe(1);
    expect(failed.lines).toContain("✗ The test push failed. Check BRIDGE_NTFY_URL, BRIDGE_NTFY_TOPIC and BRIDGE_NTFY_TOKEN.");

    const skipped = await doctor(setUp(), ["--no-push"]);
    expect(skipped.code).toBe(0);
    expect(skipped.pushes).toEqual([]);
    expect(skipped.lines).toContain("! Test push skipped.");

    const noTopic = await doctor(setUp({ BRIDGE_NTFY_TOPIC: "" }));
    expect(noTopic.code).toBe(0);
    expect(noTopic.lines).toContain("! BRIDGE_NTFY_TOPIC isn't set: approvals happen on the hub page only.");
  });

  test("rejects unknown options", async () => {
    const { code, lines } = await doctor(setUp(), ["--fix"]);
    expect(code).toBe(1);
    expect(lines).toEqual(["Unknown option: --fix. Usage: bridge doctor [--no-push]"]);
  });

  test("prints no secrets and no pronouns", async () => {
    const setup = setUp();
    const { lines } = await doctor(setup);
    const printed = lines.join("\n");
    for (const [key, value] of Object.entries(setup.env)) {
      if (/^BRIDGE_(TOKEN_|SIGNING_SECRET|ADMIN_PASSWORD|NTFY_TOPIC)/.test(key)) expect(printed).not.toContain(value);
    }
    for (const line of lines) expect(line).not.toMatch(PRONOUNS);
  });
});
