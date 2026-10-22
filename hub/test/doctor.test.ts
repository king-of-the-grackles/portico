import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctorCommand } from "../src/commands/doctor";
import { BASE_YAML, makeApp, PRONOUNS, testEnv } from "./helpers";

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
  const env = testEnv({ BRIDGE_PUBLIC_URL: url, BRIDGE_CONFIG: "bridge.yaml", ...extraEnv });
  return { url, dir, env, stopHub: () => server.stop(true) };
}

async function doctor(setup: ReturnType<typeof setUp>, args: string[] = []) {
  const lines: string[] = [];
  const code = await doctorCommand(
    args,
    { env: setup.env, cwd: setup.dir, out: (line) => lines.push(line), err: (line) => lines.push(line) },
    { timeoutMs: 2000 },
  );
  return { code, lines };
}

describe("bridge doctor", () => {
  test("all checks pass against a running hub, with no push check", async () => {
    const setup = setUp();
    const { code, lines } = await doctor(setup);
    expect(lines).toEqual([
      "✓ Config: 4 agents, 6 rules, 2 triggers.",
      "✓ Tokens are set for all 4 agents.",
      `! BRIDGE_PUBLIC_URL is ${setup.url}: only this machine can reach the hub there. Agents in the cloud need a public https address.`,
      `✓ ${setup.url}/healthz answered.`,
      `✓ The hub at ${setup.url} accepts the tokens of all 4 agents.`,
      "All checks passed.",
    ]);
    expect(code).toBe(0);
  });

  test("stops after listing config problems", async () => {
    const setup = setUp({ BRIDGE_TOKEN_MUSE: "" });
    const { code, lines } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ missing BRIDGE_TOKEN_MUSE for agent "muse"', "Fix the config first: the other checks depend on the config."]);
  });

  test("reports a hub that doesn't answer, and skips the token check", async () => {
    const setup = setUp();
    setup.stopHub();
    const { code, lines } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines.some((line) => line.startsWith(`✗ ${setup.url}/healthz didn't answer`))).toBe(true);
    expect(lines.some((line) => line.includes("accepts the tokens"))).toBe(false);
  });

  test("names an agent whose token the running hub rejects", async () => {
    const setup = setUp({ BRIDGE_TOKEN_MUSE: "a-different-muse-token-0123456789" });
    const { code, lines } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines).toContain(
      `✗ The hub at ${setup.url} rejected the token for muse. The running hub may use a different .env.`,
    );
  });

  test("warns about leftover BRIDGE_NTFY_* variables by name, and still passes", async () => {
    const setup = setUp({ BRIDGE_NTFY_TOPIC: "old-topic-0123456789abcdef", BRIDGE_NTFY_URL: "https://ntfy.example.com" });
    const { code, lines } = await doctor(setup);
    expect(code).toBe(0);
    expect(lines).toContain(
      "! BRIDGE_NTFY_TOPIC and BRIDGE_NTFY_URL are set but no longer used: approvals pop up on joined machines and wait on the hub page. Remove the variables from the hub's environment.",
    );
    expect(lines.join("\n")).not.toContain("old-topic-0123456789abcdef");
    const one = await doctor(setUp({ BRIDGE_NTFY_TOPIC: "old-topic-0123456789abcdef" }));
    expect(one.lines).toContain(
      "! BRIDGE_NTFY_TOPIC is set but no longer used: approvals pop up on joined machines and wait on the hub page. Remove the variable from the hub's environment.",
    );
  });

  test("accepts --no-push from older scripts and ignores it; rejects other options", async () => {
    const setup = setUp();
    expect((await doctor(setup, ["--no-push"])).lines).toEqual((await doctor(setup)).lines);
    const { code, lines } = await doctor(setup, ["--fix"]);
    expect(code).toBe(1);
    expect(lines).toEqual(["Unknown option: --fix. Usage: bridge doctor"]);
  });

  test("prints no secrets and no pronouns", async () => {
    const setup = setUp({ BRIDGE_NTFY_TOPIC: "old-topic-0123456789abcdef" });
    const { lines } = await doctor(setup);
    const printed = lines.join("\n");
    for (const [key, value] of Object.entries(setup.env)) {
      if (/^BRIDGE_(TOKEN_|SIGNING_SECRET|ADMIN_PASSWORD|NTFY_TOPIC)/.test(key)) expect(printed).not.toContain(value);
    }
    for (const line of lines) expect(line).not.toMatch(PRONOUNS);
  });
});
