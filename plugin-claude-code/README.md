# Portico plugin for Claude Code

Puts a Claude Code session on a Portico hub:
- On a machine that has joined the hub, every session appears in the hub's live directory as `<repo>-claude@<machine>`, with its status and what it's doing.
- Tasks, results and messages from other agents arrive in the session through Claude Code's inbox socket. No development flag is needed, and it works in `claude -p` (not `--bare`). Needs Claude Code 2.1.224 or later.
- The seven Portico tools are available: `list_agents`, `send_task`, `send_message`, `check_inbox`, `finish_task`, `get_task` and `report_event`.
- Tasks that wait for approval pop up on the desktop (a panel on macOS, a notification on Linux), one per machine, with the hub page as a fallback.

Full setup: [docs/agents/claude-code.md](../docs/agents/claude-code.md).

## Quick start

Requires [Bun](https://bun.sh) on your `PATH`. The plugin installs its own dependencies the first time it starts.

```sh
claude plugin marketplace add <path or GitHub owner/repo of portico>
claude plugin install portico@portico
```

Get a join line from the hub owner. The owner makes one with Network → **Add a machine** on the hub page, or with `portico invite` on the hub's host. It looks like `Join my Portico hub: https://portico.example.com/join#<code>`, works once and expires after 24 hours. Join the machine:

```sh
portico join 'Join my Portico hub: https://portico.example.com/join#<code>'
```

If the `portico` command isn't on this machine, run the plugin's own copy:

```sh
bun "$(ls -d ~/.claude/plugins/cache/portico/portico/*/ | sort -V | tail -n 1)src/cli.ts" join 'Join my Portico hub: https://portico.example.com/join#<code>'
```

Or, in a Claude Code session started after the install, run `/portico:join <join line>`. Claude checks the line's shape and then runs the join with its Bash tool, behind one normal permission prompt; a line with a quote or a stray character is refused. A hub whose public URL has a path can't use this command: use `portico join <hub address> --code <code>` or the bun one-liner.

The join saves the machine's token in `~/.portico/machine.json` (mode 600). It also adds `mcp__plugin_portico_portico` to `permissions.allow` in `~/.claude/settings.json`, once, so Claude Code doesn't ask before each Portico tool call; pass `--no-allow` to skip that. Sessions started from now on appear on the network; open sessions join after a restart.

## Commands

| Command | What it does |
|---|---|
| `/portico:join <join line>` | Joins this machine to a hub. |
| `/portico:off` | Keeps new sessions in the current folder off the network. |
| `/portico:on` | Puts the folder back on the network. |

The same commands run from a shell as `bun <plugin folder>/src/cli.ts join|off|on|status`. `status` shows the machine, the hub and the folders that are off.

## Approvals

A task that waits for approval shows a pop-up on the machine: a floating panel on macOS, a notification with Approve and Deny on Linux. Only one session per machine shows it, and the hub page always works as a fallback. Details and limits: [docs/agents/claude-code.md](../docs/agents/claude-code.md#4-approvals-on-this-machine).

## Settings

| Variable | Meaning |
|---|---|
| `PORTICO_URL` | The hub's address, for the one-session override. Must be https, except for `localhost` and `127.0.0.1`. |
| `PORTICO_TOKEN` | An agent's token, for the one-session override. A `portico.yaml` agent needs `delivery: push`. |
| `PORTICO_POPUP` | `off` turns approval pop-ups off for this session. |
| `PORTICO_MACHINE_CONFIG` | Where the machine file lives. Default `~/.portico/machine.json`. |

Setting `PORTICO_URL` and `PORTICO_TOKEN` (both) makes a single session act as that agent instead of using the machine file, which is how the existing `claude-code-dialog` agent keeps working. Do not `export` them: any other Claude Code session that sees them takes delivery over from the real one.

With no `PORTICO_URL` and `PORTICO_TOKEN`, on a machine that hasn't joined (or in a folder that is off), the plugin does nothing in that session. The plugin logs `plugin_idle` in that case; `inbox_socket_missing` means Claude Code is too old or the session runs with `--bare`.
