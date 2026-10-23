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

/** A running hub on a random port, and a folder holding portico.yaml, with an env pointing at both. */
function setUp(extraEnv: Record<string, string> = {}) {
  const hub = makeApp();
  const server = Bun.serve({ port: 0, fetch: hub.app.fetch });
  const dir = mkdtempSync(join(tmpdir(), "portico-doctor-"));
  writeFileSync(join(dir, "portico.yaml"), BASE_YAML);
  stops.push(() => server.stop(true), () => rmSync(dir, { recursive: true, force: true }));
  const url = `http://127.0.0.1:${server.port}`;
  const env = testEnv({ PORTICO_PUBLIC_URL: url, PORTICO_CONFIG: "portico.yaml", ...extraEnv });
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

describe("portico doctor", () => {
  test("all checks pass against a running hub, with no push check", async () => {
    const setup = setUp();
    const { code, lines } = await doctor(setup);
    expect(lines).toEqual([
      "✓ Config: 4 agents, 6 rules, 2 triggers.",
      "✓ Tokens are set for all 4 agents.",
      `! PORTICO_PUBLIC_URL is ${setup.url}: only this machine can reach the hub there. Agents in the cloud need a public https address.`,
      `✓ ${setup.url}/healthz answered.`,
      `✓ The hub at ${setup.url} accepts the tokens of all 4 agents.`,
      "All checks passed.",
    ]);
    expect(code).toBe(0);
  });

  test("stops after listing config problems", async () => {
    const setup = setUp({ PORTICO_TOKEN_MUSE: "" });
    const { code, lines } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines).toEqual(['✗ missing PORTICO_TOKEN_MUSE for agent "muse"', "Fix the config first: the other checks depend on the config."]);
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
    const setup = setUp({ PORTICO_TOKEN_MUSE: "a-different-muse-token-0123456789" });
    const { code, lines } = await doctor(setup);
    expect(code).toBe(1);
    expect(lines).toContain(
      `✗ The hub at ${setup.url} rejected the token for muse. The running hub may use a different .env.`,
    );
  });

  test("accepts --no-push from older scripts and ignores it; rejects other options", async () => {
    const setup = setUp();
    expect((await doctor(setup, ["--no-push"])).lines).toEqual((await doctor(setup)).lines);
    const { code, lines } = await doctor(setup, ["--fix"]);
    expect(code).toBe(1);
    expect(lines).toEqual(["Unknown option: --fix. Usage: portico doctor"]);
  });

  test("prints no secrets and no pronouns", async () => {
    const setup = setUp();
    const { lines } = await doctor(setup);
    const printed = lines.join("\n");
    for (const [key, value] of Object.entries(setup.env)) {
      if (/^PORTICO_(TOKEN_|SIGNING_SECRET|ADMIN_PASSWORD)/.test(key)) expect(printed).not.toContain(value);
    }
    for (const line of lines) expect(line).not.toMatch(PRONOUNS);
  });
});
