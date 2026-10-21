import { describe, expect, test } from "bun:test";
import { PluginConfigError, parsePluginConfig } from "../src/config";

const MACHINE = { hub: "https://bridge.example.com", machine: "macbook", token: "bm_machine-token", off: [] };

function problems(env: Record<string, string>, machineFile: typeof MACHINE | null = null): string[] {
  try {
    parsePluginConfig(env, machineFile);
  } catch (err) {
    if (err instanceof PluginConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a PluginConfigError");
}

describe("parsePluginConfig", () => {
  test("reads the hub address and token; relay is on by default", () => {
    expect(parsePluginConfig({ BRIDGE_URL: "https://bridge.example.com/", BRIDGE_TOKEN: "t".repeat(30) })).toEqual({
      url: "https://bridge.example.com",
      token: "t".repeat(30),
      permissionRelay: true,
      source: "env",
      machine: null,
    });
  });

  test("BRIDGE_PERMISSION_RELAY=off turns the relay off; other values are refused", () => {
    const base = { BRIDGE_URL: "https://bridge.example.com", BRIDGE_TOKEN: "token-0123456789" };
    expect(parsePluginConfig({ ...base, BRIDGE_PERMISSION_RELAY: "OFF" })?.permissionRelay).toBe(false);
    expect(problems({ ...base, BRIDGE_PERMISSION_RELAY: "maybe" })).toEqual([
      'BRIDGE_PERMISSION_RELAY must be "on" or "off", not "maybe".',
    ]);
  });

  test("returns null when neither the address nor the token is set, so the plugin can idle", () => {
    expect(parsePluginConfig({})).toBeNull();
    // Claude Code passes ${VAR} through literally when VAR isn't set.
    expect(parsePluginConfig({ BRIDGE_URL: "${BRIDGE_URL}", BRIDGE_TOKEN: "${BRIDGE_TOKEN}" })).toBeNull();
  });

  test("names what is missing when only one of the two is set", () => {
    expect(problems({ BRIDGE_URL: "https://bridge.example.com" })).toEqual([
      "BRIDGE_TOKEN is not set. Use the token of this session's agent (BRIDGE_TOKEN_<NAME> in the hub's environment).",
    ]);
    expect(problems({ BRIDGE_TOKEN: "token-0123456789" })[0]).toStartWith("BRIDGE_URL is not set.");
  });

  test("requires https except for localhost", () => {
    const token = "token-0123456789";
    expect(parsePluginConfig({ BRIDGE_URL: "http://localhost:8790", BRIDGE_TOKEN: token })?.url).toBe(
      "http://localhost:8790",
    );
    expect(parsePluginConfig({ BRIDGE_URL: "http://127.0.0.1:8790", BRIDGE_TOKEN: token })?.url).toBe(
      "http://127.0.0.1:8790",
    );
    expect(problems({ BRIDGE_URL: "http://bridge.example.com", BRIDGE_TOKEN: token })[0]).toContain("https://");
    expect(problems({ BRIDGE_URL: "not a url", BRIDGE_TOKEN: token })).toEqual(["BRIDGE_URL is not a valid URL."]);
  });

  test("refuses a user name or password in the address, without repeating it", () => {
    const token = "token-0123456789";
    const found = problems({ BRIDGE_URL: "https://alice:hunter2@bridge.example.com", BRIDGE_TOKEN: token });
    expect(found).toEqual(["BRIDGE_URL must not contain a user name or password."]);
    expect(problems({ BRIDGE_URL: "https://alice@bridge.example.com", BRIDGE_TOKEN: token })).toEqual(found);
  });

  test("keeps the origin and path, without a trailing slash", () => {
    const token = "token-0123456789";
    expect(parsePluginConfig({ BRIDGE_URL: "https://bridge.example.com:8443/hub/", BRIDGE_TOKEN: token })?.url).toBe(
      "https://bridge.example.com:8443/hub",
    );
  });

  test("never repeats the token in an error", () => {
    const token = "very-secret-token-value";
    const err = (() => {
      try {
        parsePluginConfig({ BRIDGE_URL: "ftp://bridge.example.com", BRIDGE_TOKEN: token });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain(token);
  });
});

describe("machine mode", () => {
  test("env settings win over a machine file", () => {
    const env = { BRIDGE_URL: "https://other.example.com", BRIDGE_TOKEN: "token-0123456789" };
    expect(parsePluginConfig(env, MACHINE)).toEqual({
      url: "https://other.example.com",
      token: "token-0123456789",
      permissionRelay: true,
      source: "env",
      machine: null,
    });
    // Half-set env settings still fail, as in v1, rather than falling back to the machine file.
    expect(problems({ BRIDGE_URL: "https://other.example.com" }, MACHINE)[0]).toStartWith("BRIDGE_TOKEN is not set.");
  });

  test("with no env settings, a machine file gives machine mode", () => {
    expect(parsePluginConfig({}, MACHINE)).toEqual({
      url: MACHINE.hub,
      token: MACHINE.token,
      source: "machine",
      machine: "macbook",
      permissionRelay: true,
    });
    // Claude Code's unset ${VAR} placeholders count as unset.
    expect(parsePluginConfig({ BRIDGE_URL: "${BRIDGE_URL}", BRIDGE_TOKEN: "${BRIDGE_TOKEN}" }, MACHINE)?.source).toBe("machine");
    expect(parsePluginConfig({ BRIDGE_PERMISSION_RELAY: "off" }, MACHINE)?.permissionRelay).toBe(false);
    expect(parsePluginConfig({}, { ...MACHINE, hub: "http://localhost:8790/" })?.url).toBe("http://localhost:8790");
  });

  test("with neither, the result is null", () => {
    expect(parsePluginConfig({}, null)).toBeNull();
    expect(parsePluginConfig({})).toBeNull();
  });

  test("a machine file whose hub isn't https is refused, without repeating the token", () => {
    const found = problems({}, { ...MACHINE, hub: "http://example.com" });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("the hub address in machine.json must start with https://");
    expect(problems({}, { ...MACHINE, hub: "not a url" })).toEqual(["the hub address in machine.json is not a valid URL."]);
    expect(found.join("\n")).not.toContain(MACHINE.token);
  });
});
