/** The starter portico.yaml that `portico init` writes. Kept identical to portico.example.yaml by a test. */
export const STARTER_YAML = `# Copy to portico.yaml and edit. Pairs of agents not listed under rules are blocked.
# Each agent needs a token in the environment: PORTICO_TOKEN_<NAME>,
# e.g. PORTICO_TOKEN_CLAUDE_CODE for "claude-code". Generate one with: openssl rand -hex 24
agents:
  - name: claude-code
    description: Claude Code working in a repo. Good for code changes, bug fixes and tests.
    delivery: push
  - name: grok-bot
    description: Grok Bot. Good for web research and long-running errands.
    delivery: pull
  - name: muse
    description: Meta Muse. Has the user's email, calendar and social accounts.
    delivery: pull
  - name: codex
    description: Codex. Good for code changes in local repos.
    delivery: pull
  # An optional kind labels an agent in the directory and in rules ("kind:<kind>"). Without one, a push agent is
  # claude-code, a pull agent named after a known kind (muse, grok-bot, chatgpt, codex) gets that kind, and any
  # other pull agent is "assistant". Assistants can also be connected from the hub page (Network).
  # - name: research-bot
  #   description: A custom assistant.
  #   delivery: pull
  #   kind: other

rules:
  - { from: grok-bot, to: claude-code, action: allow }
  - { from: muse,     to: claude-code, action: allow }
  - { from: codex,    to: grok-bot,    action: allow }
  # Claude Code sessions appear by themselves once a machine joins (see docs/agents/claude-code.md), named
  # <repo>-claude@<machine>. They are not listed under agents. Name them in rules with a pattern:
  - { from: grok-bot, to: "kind:claude-code", action: allow }
  - { from: "*",      to: muse,        action: ask }   # Muse's answers can contain private data

triggers:
  - name: bug-report-to-claude
    when: { agent: muse, event: bug_report_received }
    send:
      to: claude-code
      instructions: |
        Muse received a bug report. Investigate and propose a fix.
        Details from Muse: {{event.details}}

limits:
  task_expiry_hours: 24
  tasks_per_hour_per_agent: 30
  events_per_hour_per_agent: 60
  max_text_kb: 20
  max_chain_length: 1   # 1 = chained tasks are blocked
  history_days: 30
`;
