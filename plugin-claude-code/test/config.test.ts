import { describe, expect, test } from "bun:test";
import { copyProblems } from "../../server/test/helpers";
import { PluginConfigError, parsePluginConfig, parsePorticoUrl } from "../src/config";

const FILE = { url: "https://portico.example.com", computer: "macbook", token: "pc_computer-token", off: [] };

function problems(file: typeof FILE): string[] {
  try {
    parsePluginConfig(file);
  } catch (err) {
    if (err instanceof PluginConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a PluginConfigError");
}

describe("parsePluginConfig", () => {
  test("a computer file gives the address, token and computer name", () => {
    expect(parsePluginConfig(FILE)).toEqual({ url: "https://portico.example.com", token: "pc_computer-token", computer: "macbook" });
    expect(parsePluginConfig({ ...FILE, url: "http://localhost:8790/" })?.url).toBe("http://localhost:8790");
    expect(parsePluginConfig({ ...FILE, url: "https://portico.example.com:8443/base/" })?.url).toBe("https://portico.example.com:8443/base");
  });

  test("with no computer file, the result is null, so the plugin idles", () => {
    expect(parsePluginConfig(null)).toBeNull();
  });

  test("an address that isn't https is refused, without repeating the token", () => {
    const found = problems({ ...FILE, url: "http://example.com" });
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("the Portico address in computer.json must start with https://");
    expect(problems({ ...FILE, url: "not a url" })).toEqual(["the Portico address in computer.json is not a valid URL."]);
    expect(found.join("\n")).not.toContain(FILE.token);
  });
});

describe("parsePorticoUrl", () => {
  test("requires https except for localhost, and refuses credentials without repeating them", () => {
    expect(parsePorticoUrl("http://127.0.0.1:8790", "x")).toEqual({ url: "http://127.0.0.1:8790" });
    expect(parsePorticoUrl("ftp://portico.example.com", "x")).toMatchObject({ problem: expect.stringContaining("https://") });
    const credentials = parsePorticoUrl("https://alice:hunter2@portico.example.com", "The address");
    expect(credentials).toEqual({ problem: "The address must not contain a user name or password." });
  });

  test("the problems follow the copy rules", () => {
    for (const raw of ["not a url", "http://example.com", "https://a:b@example.com"]) {
      const result = parsePorticoUrl(raw, "The address");
      expect("problem" in result && copyProblems(result.problem)).toEqual([]);
    }
  });
});
