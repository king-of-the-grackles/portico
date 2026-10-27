import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ensureSigningKey, parseEnv } from "../src/config";

describe("config", () => {
  test("every setting is optional", () => {
    expect(parseEnv({}, "k")).toEqual({
      port: 8790,
      dbPath: "./portico.db",
      dataDir: process.cwd(),
      pluginSource: null,
      publicUrl: null,
      signingKey: "k",
    });
  });

  test("a public URL must be https, or http on localhost; a bad port is refused", () => {
    expect(parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example.com/" }, "k").publicUrl).toBe("https://portico.example.com");
    expect(parseEnv({ PORTICO_PUBLIC_URL: "http://localhost:8790" }, "k").publicUrl).toBe("http://localhost:8790");
    expect(() => parseEnv({ PORTICO_PUBLIC_URL: "http://portico.example.com" }, "k")).toThrow(ConfigError);
    expect(() => parseEnv({ PORT: "99999" }, "k")).toThrow(ConfigError);
  });

  test("the signing key is made once in the data folder, readable only by this account", () => {
    const dir = mkdtempSync(join(tmpdir(), "portico-config-"));
    const key = ensureSigningKey(dir);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureSigningKey(dir)).toBe(key);
    expect(statSync(join(dir, "signing.key")).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, "signing.key"), "nonsense");
    expect(() => ensureSigningKey(dir)).toThrow(ConfigError);
    expect(readFileSync(join(dir, "signing.key"), "utf8")).toBe("nonsense");
  });
});
