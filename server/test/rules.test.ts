import { describe, expect, test } from "bun:test";
import { resolveRule, rulePatternProblem, unknownRuleNames } from "../src/core/rules";
import type { MemberRef, RuleConfig } from "../src/core/types";

const r = (address: string, kind = "assistant"): MemberRef => ({ address, kind });

describe("resolveRule", () => {
  test("blocks when no rule matches", () => {
    expect(resolveRule([], r("a"), r("b"))).toEqual({ action: "block", rule: null });
    const rules: RuleConfig[] = [{ from: "x", to: "b", action: "allow" }];
    expect(resolveRule(rules, r("a"), r("b"))).toEqual({ action: "block", rule: null });
  });

  test("an exact pair beats wildcards", () => {
    const rules: RuleConfig[] = [
      { from: "*", to: "b", action: "ask" },
      { from: "a", to: "b", action: "allow" },
      { from: "*", to: "*", action: "block" },
    ];
    expect(resolveRule(rules, r("a"), r("b"))).toEqual({ action: "allow", rule: rules[1]! });
  });

  test("one wildcard beats two", () => {
    const rules: RuleConfig[] = [
      { from: "*", to: "*", action: "allow" },
      { from: "a", to: "*", action: "ask" },
    ];
    expect(resolveRule(rules, r("a"), r("b")).action).toBe("ask");
  });

  test("ties at the same level go to the stricter action", () => {
    const mixed: RuleConfig[] = [
      { from: "a", to: "*", action: "allow" },
      { from: "*", to: "b", action: "block" },
    ];
    expect(resolveRule(mixed, r("a"), r("b")).action).toBe("block");
    const duplicates: RuleConfig[] = [
      { from: "a", to: "b", action: "ask" },
      { from: "a", to: "b", action: "allow" },
    ];
    expect(resolveRule(duplicates, r("a"), r("b")).action).toBe("ask");
  });

  test("a wildcard-to-everything rule applies to any pair", () => {
    const rules: RuleConfig[] = [{ from: "*", to: "*", action: "allow" }];
    expect(resolveRule(rules, r("x"), r("y")).action).toBe("allow");
  });
});

describe("rule patterns", () => {
  const session = r("dialog-claude@macbook", "claude-code");
  const other = r("api-claude@studio", "claude-code");

  test("kind: matches members of that kind", () => {
    expect(resolveRule([{ from: "kind:claude-code", to: "muse", action: "ask" }], session, r("muse", "muse")).action).toBe("ask");
    expect(
      resolveRule([{ from: "kind:claude-code", to: "muse", action: "ask" }], r("grok-bot", "grok-bot"), r("muse", "muse")).action,
    ).toBe("block");
  });

  test("a glob matches the full address, with * spanning any characters", () => {
    const rules = [
      { from: "grok-bot", to: "dialog-*", action: "allow" as const },
      { from: "grok-bot", to: "*@studio", action: "ask" as const },
    ];
    expect(resolveRule(rules, r("grok-bot"), session).action).toBe("allow");
    expect(resolveRule(rules, r("grok-bot"), other).action).toBe("ask");
    expect(resolveRule(rules, r("grok-bot"), r("dialog")).action).toBe("block");
    // Regex characters in an address are matched literally.
    expect(resolveRule([{ from: "*", to: "a.b*", action: "allow" }], r("x"), r("axb-1")).action).toBe("block");
  });

  test("exact beats glob beats kind beats *, by the sum of both sides", () => {
    const rules = [
      { from: "*", to: "kind:claude-code", action: "block" as const }, // 0 + 1
      { from: "*", to: "dialog-*", action: "ask" as const }, // 0 + 2
      { from: "muse", to: "kind:claude-code", action: "allow" as const }, // 3 + 1
    ];
    expect(resolveRule(rules, r("muse", "muse"), session).action).toBe("allow");
    expect(resolveRule(rules, r("codex", "codex"), session).action).toBe("ask");
    expect(resolveRule(rules, r("codex", "codex"), other).action).toBe("block");
    expect(resolveRule([...rules, { from: "codex", to: "dialog-claude@macbook", action: "allow" }], r("codex", "codex"), session).action).toBe(
      "allow",
    );
  });

  test("a tie goes to the stricter action", () => {
    const glob = [
      { from: "kind:muse", to: "dialog-*", action: "allow" as const }, // 1 + 2
      { from: "muse", to: "*", action: "ask" as const }, // 3 + 0
    ];
    expect(resolveRule(glob, r("muse", "muse"), session).action).toBe("ask");
    const kinds = [
      { from: "kind:muse", to: "*", action: "allow" as const }, // 1 + 0
      { from: "*", to: "kind:claude-code", action: "block" as const }, // 0 + 1
    ];
    expect(resolveRule(kinds, r("muse", "muse"), session).action).toBe("block");
  });

  test("rulePatternProblem accepts exact names, addresses, globs, kind: and *, and names what's wrong otherwise", () => {
    for (const ok of ["muse", "dialog-claude@macbook", "dialog-*", "*@macbook", "kind:claude-code", "*"]) {
      expect(rulePatternProblem(ok)).toBeNull();
    }
    for (const bad of ["Muse", "kind:", "kind:Claude", "dialog claude", "a@b@c", "@macbook"]) {
      expect(rulePatternProblem(bad)).not.toBeNull();
    }
    expect(rulePatternProblem("Muse")).toBe('not a valid name, address, glob, kind:<kind> or "*"');
  });

  test("a glob of only * and @, other than the bare *, is refused with its own problem", () => {
    for (const bare of ["**", "*@*", "@*", "*@", "***"]) {
      expect(rulePatternProblem(bare)).toBe('a glob without any name; use "*" for everyone, or a glob like "dialog-*" or "*@macbook"');
    }
    expect(rulePatternProblem("*")).toBeNull();
    expect(rulePatternProblem("@")).toBe('not a valid name, address, glob, kind:<kind> or "*"');
  });

  test("unknownRuleNames lists exact names nothing knows, never patterns", () => {
    const rules: RuleConfig[] = [
      { from: "muse", to: "dialog-claude@macbook", action: "allow" },
      { from: "ghost", to: "*", action: "ask" },
      { from: "kind:ghost", to: "dialog-*", action: "allow" },
      { from: "ghost", to: "muse", action: "block" },
      { from: "*@nowhere", to: "kind:claude-code", action: "allow" },
    ];
    expect(unknownRuleNames(rules, (name) => name === "muse")).toEqual(["dialog-claude@macbook", "ghost"]);
    expect(unknownRuleNames(rules, () => true)).toEqual([]);
  });
});
