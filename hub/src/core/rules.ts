import type { RuleAction, RuleConfig } from "./types";

const STRICTNESS: Record<RuleAction, number> = { allow: 0, ask: 1, block: 2 };

export interface Resolution {
  action: RuleAction;
  /** The rule that decided, or null when no rule matched (then the action is "block"). */
  rule: RuleConfig | null;
}

export function resolveRule(rules: RuleConfig[], from: string, to: string): Resolution {
  let best: { rule: RuleConfig; specificity: number } | null = null;
  for (const rule of rules) {
    const fromMatches = rule.from === from || rule.from === "*";
    const toMatches = rule.to === to || rule.to === "*";
    if (!fromMatches || !toMatches) continue;
    const specificity = (rule.from === "*" ? 0 : 1) + (rule.to === "*" ? 0 : 1);
    const beatsBest =
      best === null ||
      specificity > best.specificity ||
      (specificity === best.specificity && STRICTNESS[rule.action] > STRICTNESS[best.rule.action]);
    if (beatsBest) best = { rule, specificity };
  }
  return best ? { action: best.rule.action, rule: best.rule } : { action: "block", rule: null };
}
