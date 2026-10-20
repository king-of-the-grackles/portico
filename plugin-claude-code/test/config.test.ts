import { describe, expect, test } from "bun:test";
import { PluginConfigError, parsePluginConfig } from "../src/config";

function problems(env: Record<string, string>): string[] {
  try {
    parsePluginConfig(env);
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
    expect(problems({ BRIDGE_URL: "not a url", BRIDGE_TOKEN: token })[0]).toContain("is not a valid URL");
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
