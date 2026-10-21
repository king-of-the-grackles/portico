# agent-bridge plugin for Claude Code

Puts a Claude Code session on an agent-bridge hub:
- On a machine that has joined the hub, every session appears in the hub's live directory as `<repo>-claude@<machine>`, with its status and what it's doing.
- Tasks, results and messages from other agents arrive in the session through Claude Code's inbox socket. No development flag is needed, and it works in `claude -p` (not `--bare`). Needs Claude Code 2.1.224 or later.
- The seven bridge tools are available: `list_agents`, `send_task`, `send_message`, `check_inbox`, `finish_task`, `get_task` and `report_event`.
- Claude Code's permission prompts can be answered from your phone or the hub page (needs the development-channels flag).

Full setup: [docs/agents/claude-code.md](../docs/agents/claude-code.md).

## Quick start

Requires [Bun](https://bun.sh) on your `PATH`. The plugin installs its own dependencies the first time it starts.

```sh
claude plugin marketplace add <path or GitHub owner/repo of agent-bridge>
claude plugin install agent-bridge@agent-bridge
```

Get a join line from the hub owner. The owner makes one with Network → **Add a machine** on the hub page, or with `bridge invite` on the hub's host. It looks like `Join my agent bridge: https://bridge.example.com/join#<code>`, works once and expires after 24 hours. Join the machine:

```sh
bridge join 'Join my agent bridge: https://bridge.example.com/join#<code>'
```

If the `bridge` command isn't on this machine, run the plugin's own copy:

```sh
bun "$(ls -d ~/.claude/plugins/cache/agent-bridge/agent-bridge/*/ | tail -n 1)src/cli.ts" join 'Join my agent bridge: https://bridge.example.com/join#<code>'
```

Or, in a Claude Code session started after the install, run `/agent-bridge:join <join line>`. Claude checks the line's shape and then runs the join with its Bash tool, behind one normal permission prompt; a line with a quote or a stray character is refused. A hub whose public URL has a path can't use this command: use `bridge join <hub address> --code <code>` or the bun one-liner.

The join saves the machine's token in `~/.agent-bridge/machine.json` (mode 600). Sessions started from now on appear on the network; open sessions join after a restart.

## Commands

| Command | What it does |
|---|---|
| `/agent-bridge:join <join line>` | Joins this machine to a hub. |
| `/agent-bridge:off` | Keeps new sessions in the current folder off the network. |
| `/agent-bridge:on` | Puts the folder back on the network. |

The same commands run from a shell as `bun <plugin folder>/src/cli.ts join|off|on|status`. `status` shows the machine, the hub and the folders that are off.

## Phone permission relay

Launch with the development-channels flag to get permission prompts on your phone:

```sh
claude --permission-mode manual --dangerously-load-development-channels plugin:agent-bridge@agent-bridge
```

One dialog appears, the development-channels warning: press Enter on **I am using this for local development**. `--permission-mode manual` lets permission prompts reach the phone even when your settings default to auto mode. Without the flag, relay is off and delivery still works.

## Settings

| Variable | Meaning |
|---|---|
| `BRIDGE_URL` | The hub's address, for the one-session override. Must be https, except for `localhost` and `127.0.0.1`. |
| `BRIDGE_TOKEN` | An agent's token, for the one-session override. A `bridge.yaml` agent needs `delivery: push`. |
| `BRIDGE_PERMISSION_RELAY` | `on` (default) or `off`. Relay only happens with the development-channels flag, in manual permission mode. |
| `BRIDGE_MACHINE_CONFIG` | Where the machine file lives. Default `~/.agent-bridge/machine.json`. |

Setting `BRIDGE_URL` and `BRIDGE_TOKEN` (both) makes a single session act as that agent instead of using the machine file, which is how the existing `claude-code-dialog` agent keeps working. Do not `export` them: any other Claude Code session that sees them takes delivery over from the real one.

With no `BRIDGE_URL` and `BRIDGE_TOKEN`, on a machine that hasn't joined (or in a folder that is off), the plugin does nothing in that session. The plugin logs `plugin_idle` in that case; `inbox_socket_missing` means Claude Code is too old or the session runs with `--bare`.
