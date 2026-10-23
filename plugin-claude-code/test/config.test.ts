import { describe, expect, test } from "bun:test";
import { PluginConfigError, parsePluginConfig } from "../src/config";

const MACHINE = { hub: "https://portico.example.com", machine: "macbook", token: "bm_machine-token", off: [] };

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
  test("reads the hub address and token", () => {
    expect(parsePluginConfig({ PORTICO_URL: "https://portico.example.com/", PORTICO_TOKEN: "t".repeat(30) })).toEqual({
      url: "https://portico.example.com",
      token: "t".repeat(30),
      source: "env",
      machine: null,
    });
  });

  test("PORTICO_PERMISSION_RELAY is no longer read: any value is ignored", () => {
    const base = { PORTICO_URL: "https://portico.example.com", PORTICO_TOKEN: "token-0123456789" };
    expect(parsePluginConfig({ ...base, PORTICO_PERMISSION_RELAY: "maybe" })).toEqual(parsePluginConfig(base));
    expect(parsePluginConfig(base)).not.toHaveProperty("permissionRelay");
  });

  test("returns null when neither the address nor the token is set, so the plugin can idle", () => {
    expect(parsePluginConfig({})).toBeNull();
    // Claude Code passes ${VAR} through literally when VAR isn't set.
    expect(parsePluginConfig({ PORTICO_URL: "${PORTICO_URL}", PORTICO_TOKEN: "${PORTICO_TOKEN}" })).toBeNull();
  });

  test("names what is missing when only one of the two is set", () => {
    expect(problems({ PORTICO_URL: "https://portico.example.com" })).toEqual([
      "PORTICO_TOKEN is not set. Use the token of this session's agent (PORTICO_TOKEN_<NAME> in the hub's environment).",
    ]);
    expect(problems({ PORTICO_TOKEN: "token-0123456789" })[0]).toStartWith("PORTICO_URL is not set.");
  });

  test("requires https except for localhost", () => {
    const token = "token-0123456789";
    expect(parsePluginConfig({ PORTICO_URL: "http://localhost:8790", PORTICO_TOKEN: token })?.url).toBe(
      "http://localhost:8790",
    );
    expect(parsePluginConfig({ PORTICO_URL: "http://127.0.0.1:8790", PORTICO_TOKEN: token })?.url).toBe(
      "http://127.0.0.1:8790",
    );
    expect(problems({ PORTICO_URL: "http://portico.example.com", PORTICO_TOKEN: token })[0]).toContain("https://");
    expect(problems({ PORTICO_URL: "not a url", PORTICO_TOKEN: token })).toEqual(["PORTICO_URL is not a valid URL."]);
  });

  test("refuses a user name or password in the address, without repeating it", () => {
    const token = "token-0123456789";
    const found = problems({ PORTICO_URL: "https://alice:hunter2@portico.example.com", PORTICO_TOKEN: token });
    expect(found).toEqual(["PORTICO_URL must not contain a user name or password."]);
    expect(problems({ PORTICO_URL: "https://alice@portico.example.com", PORTICO_TOKEN: token })).toEqual(found);
  });

  test("keeps the origin and path, without a trailing slash", () => {
    const token = "token-0123456789";
    expect(parsePluginConfig({ PORTICO_URL: "https://portico.example.com:8443/hub/", PORTICO_TOKEN: token })?.url).toBe(
      "https://portico.example.com:8443/hub",
    );
  });

  test("never repeats the token in an error", () => {
    const token = "very-secret-token-value";
    const err = (() => {
      try {
        parsePluginConfig({ PORTICO_URL: "ftp://portico.example.com", PORTICO_TOKEN: token });
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain(token);
  });
});

describe("machine mode", () => {
  test("env settings win over a machine file", () => {
    const env = { PORTICO_URL: "https://other.example.com", PORTICO_TOKEN: "token-0123456789" };
    expect(parsePluginConfig(env, MACHINE)).toEqual({
      url: "https://other.example.com",
      token: "token-0123456789",
      source: "env",
      machine: null,
    });
    // Half-set env settings still fail, as in v1, rather than falling back to the machine file.
    expect(problems({ PORTICO_URL: "https://other.example.com" }, MACHINE)[0]).toStartWith("PORTICO_TOKEN is not set.");
  });

  test("with no env settings, a machine file gives machine mode", () => {
    expect(parsePluginConfig({}, MACHINE)).toEqual({
      url: MACHINE.hub,
      token: MACHINE.token,
      source: "machine",
      machine: "macbook",
    });
    // Claude Code's unset ${VAR} placeholders count as unset.
    expect(parsePluginConfig({ PORTICO_URL: "${PORTICO_URL}", PORTICO_TOKEN: "${PORTICO_TOKEN}" }, MACHINE)?.source).toBe("machine");
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
