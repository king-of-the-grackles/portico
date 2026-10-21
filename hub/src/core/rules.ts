import type { MemberRef, RuleAction, RuleConfig } from "./types";

const STRICTNESS: Record<RuleAction, number> = { allow: 0, ask: 1, block: 2 };

export interface Resolution {
  action: RuleAction;
  /** The rule that decided, or null when no rule matched (then the action is "block"). */
  rule: RuleConfig | null;
}

// How specific each side is: exact 3, glob 2, kind: 1, * 0. A rule's specificity is the sum of its two sides.
const WEIGHT = (side: string) => (side === "*" ? 0 : side.startsWith("kind:") ? 1 : side.includes("*") ? 2 : 3);
const escape = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

function matches(side: string, ref: MemberRef): boolean {
  if (side === "*") return true;
  if (side.startsWith("kind:")) return ref.kind === side.slice(5);
  if (side.includes("*")) return new RegExp(`^${side.split("*").map(escape).join(".*")}$`).test(ref.address);
  return side === ref.address;
}

export function resolveRule(rules: RuleConfig[], from: MemberRef, to: MemberRef): Resolution {
  let best: { rule: RuleConfig; specificity: number } | null = null;
  for (const rule of rules) {
    if (!matches(rule.from, from) || !matches(rule.to, to)) continue;
    const specificity = WEIGHT(rule.from) + WEIGHT(rule.to);
    const beatsBest =
      best === null ||
      specificity > best.specificity ||
      (specificity === best.specificity && STRICTNESS[rule.action] > STRICTNESS[best.rule.action]);
    if (beatsBest) best = { rule, specificity };
  }
  return best ? { action: best.rule.action, rule: best.rule } : { action: "block", rule: null };
}

const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)*";
const EXACT = new RegExp(`^${SLUG}(?:@${SLUG})?$`);
const GLOB = /^[a-z0-9@*-]*\*[a-z0-9@*-]*$/;
const KIND = new RegExp(`^kind:${SLUG}$`);

/** Null when the rule side is an exact name or address, a glob, `kind:<kind>` or "*"; otherwise what's wrong. */
export function rulePatternProblem(side: string): string | null {
  return side === "*" || EXACT.test(side) || GLOB.test(side) || KIND.test(side)
    ? null
    : 'not a valid name, address, glob, kind:<kind> or "*"';
}

/** The exact names in the rules that `known` doesn't recognize, once each, in order. Patterns are never listed. */
export function unknownRuleNames(rules: RuleConfig[], known: (name: string) => boolean): string[] {
  const names = new Set<string>();
  for (const rule of rules) {
    for (const side of [rule.from, rule.to]) {
      if (EXACT.test(side) && !known(side)) names.add(side);
    }
  }
  return [...names];
}
