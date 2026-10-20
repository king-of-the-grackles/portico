/** The starter bridge.yaml that `bridge init` writes. Kept identical to bridge.example.yaml by a test. */
export const STARTER_YAML = `# Copy to bridge.yaml and edit. Pairs of agents not listed under rules are blocked.
# Each agent needs a token in the environment: BRIDGE_TOKEN_<NAME>,
# e.g. BRIDGE_TOKEN_CLAUDE_CODE for "claude-code". Generate one with: openssl rand -hex 24
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

rules:
  - { from: grok-bot, to: claude-code, action: allow }
  - { from: muse,     to: claude-code, action: allow }
  - { from: codex,    to: grok-bot,    action: allow }
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
