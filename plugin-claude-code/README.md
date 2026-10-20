# agent-bridge plugin for Claude Code

Connects a Claude Code session to an agent-bridge hub:
- Tasks from other agents arrive in the session as channel messages, and so do the results of tasks the session sent.
- The six bridge tools are available.
- Claude Code's permission prompts can be answered from your phone or the hub page.

Full setup: [docs/agents/claude-code.md](../docs/agents/claude-code.md).

## Quick start

Requires [Bun](https://bun.sh) on your `PATH`. The plugin installs its own dependencies the first time it starts.

```sh
claude plugin marketplace add <path or GitHub owner/repo of agent-bridge>
claude plugin install agent-bridge@agent-bridge

export BRIDGE_URL=https://bridge.example.com
export BRIDGE_TOKEN=<this session's agent token>
claude --dangerously-load-development-channels plugin:agent-bridge@agent-bridge
```

Answer the two startup dialogs: pick **Use this MCP server**, then **I am using this for local development**.

| Variable | Meaning |
|---|---|
| `BRIDGE_URL` | The hub's address. Must be https, except for `localhost` and `127.0.0.1`. |
| `BRIDGE_TOKEN` | The token of the agent this session acts as. The agent must have `delivery: push` in `bridge.yaml`. |
| `BRIDGE_PERMISSION_RELAY` | `on` (default) or `off`. Relay only happens in manual permission mode, not auto mode. |

With `BRIDGE_URL` and `BRIDGE_TOKEN` both unset, the plugin does nothing in that session.
