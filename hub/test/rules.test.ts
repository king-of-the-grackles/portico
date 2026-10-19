import { describe, expect, test } from "bun:test";
import { resolveRule } from "../src/core/rules";
import type { RuleConfig } from "../src/core/types";

describe("resolveRule", () => {
  test("blocks when no rule matches", () => {
    expect(resolveRule([], "a", "b")).toEqual({ action: "block", rule: null });
    const rules: RuleConfig[] = [{ from: "x", to: "b", action: "allow" }];
    expect(resolveRule(rules, "a", "b")).toEqual({ action: "block", rule: null });
  });

  test("an exact pair beats wildcards", () => {
    const rules: RuleConfig[] = [
      { from: "*", to: "b", action: "ask" },
      { from: "a", to: "b", action: "allow" },
      { from: "*", to: "*", action: "block" },
    ];
    expect(resolveRule(rules, "a", "b")).toEqual({ action: "allow", rule: rules[1]! });
  });

  test("one wildcard beats two", () => {
    const rules: RuleConfig[] = [
      { from: "*", to: "*", action: "allow" },
      { from: "a", to: "*", action: "ask" },
    ];
    expect(resolveRule(rules, "a", "b").action).toBe("ask");
  });

  test("ties at the same level go to the stricter action", () => {
    const mixed: RuleConfig[] = [
      { from: "a", to: "*", action: "allow" },
      { from: "*", to: "b", action: "block" },
    ];
    expect(resolveRule(mixed, "a", "b").action).toBe("block");
    const duplicates: RuleConfig[] = [
      { from: "a", to: "b", action: "ask" },
      { from: "a", to: "b", action: "allow" },
    ];
    expect(resolveRule(duplicates, "a", "b").action).toBe("ask");
  });

  test("a wildcard-to-everything rule applies to any pair", () => {
    const rules: RuleConfig[] = [{ from: "*", to: "*", action: "allow" }];
    expect(resolveRule(rules, "x", "y").action).toBe("allow");
  });
});
