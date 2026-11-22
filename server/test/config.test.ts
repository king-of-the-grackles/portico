import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, ensureSigningKey, parseEnv } from "../src/config";

describe("config", () => {
  test("every setting is optional", () => {
    expect(parseEnv({}, "k")).toEqual({
      port: 8790,
      dbPath: "data/portico.db",
      dataDir: "./data",
      pluginSource: null,
      publicUrl: null,
      signingKey: "k",
      secretsKey: null,
      secretsKeyOld: null,
      webhooksAllowPrivate: false,
      retiredHosts: [],
      feedbackReviewToken: null,
      commit: "unknown",
      files: null,
      mail: null,
      descopeProjectId: null,
    });
  });

  test("PORTICO_COMMIT names the commit the build was made from, and is unknown when unset or blank", () => {
    expect(parseEnv({ PORTICO_COMMIT: " 75fc629abc " }, "k").commit).toBe("75fc629abc");
    expect(parseEnv({ PORTICO_COMMIT: "  " }, "k").commit).toBe("unknown");
  });

  test("PORTICO_DATA_DIR names the data folder, which holds the database", () => {
    expect(parseEnv({ PORTICO_DATA_DIR: "/data/portico" }, "k")).toMatchObject({ dataDir: "/data/portico", dbPath: "/data/portico/portico.db" });
  });

  test("the settings from before the data folder are refused, each with what to set now", () => {
    for (const name of ["PORTICO_DB_PATH", "PORTICO_HOSTED_DOMAIN", "PORTICO_HOSTED_DATA"]) {
      let problems: string[] = [];
      try {
        parseEnv({ [name]: "x" }, "k");
      } catch (err) {
        problems = (err as ConfigError).problems;
      }
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${name} is no longer read`);
      expect(problems[0]).toContain("PORTICO_DATA_DIR");
    }
    expect(() => parseEnv({ PORTICO_HOSTED_DOMAIN: "portico.example" }, "k")).toThrow("PORTICO_PUBLIC_URL");
  });

  test("PORTICO_DESCOPE_PROJECT_ID switches sign-in to Descope, and has to look like a project ID", () => {
    expect(parseEnv({ PORTICO_DESCOPE_PROJECT_ID: " P2abcDEF123 " }, "k").descopeProjectId).toBe("P2abcDEF123");
    expect(() => parseEnv({ PORTICO_DESCOPE_PROJECT_ID: "not a project" }, "k")).toThrow(ConfigError);
  });

  test("email needs a sender: PORTICO_MAIL_FROM, or the public URL's host", () => {
    expect(parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example" }, "k").mail).toBeNull();
    expect(parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example", PORTICO_RESEND_API_KEY: "re_x", PORTICO_RESEND_WEBHOOK_SECRET: "whsec_abc" }, "k").mail).toEqual({
      apiKey: "re_x",
      from: "Portico <invites@mail.portico.example>",
      webhookSecret: "whsec_abc",
    });
    expect(parseEnv({ PORTICO_RESEND_API_KEY: "re_x", PORTICO_MAIL_FROM: "Portico <hi@portico.example>" }, "k").mail?.from).toBe("Portico <hi@portico.example>");
    expect(() => parseEnv({ PORTICO_RESEND_API_KEY: "re_x" }, "k")).toThrow(ConfigError);
    expect(() => parseEnv({ PORTICO_PUBLIC_URL: "https://portico.example", PORTICO_RESEND_API_KEY: "re_x", PORTICO_MAIL_FROM: "not an address" }, "k")).toThrow(ConfigError);
  });

  test("private webhook addresses are allowed only with PORTICO_WEBHOOKS_ALLOW_PRIVATE=1", () => {
    expect(parseEnv({ PORTICO_WEBHOOKS_ALLOW_PRIVATE: "1" }, "k").webhooksAllowPrivate).toBe(true);
    expect(parseEnv({ PORTICO_WEBHOOKS_ALLOW_PRIVATE: "true" }, "k").webhooksAllowPrivate).toBe(false);
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
