# Portico plugin for Claude Code

Puts Claude Code sessions on Portico:
- On a computer that has joined Portico, every session appears in the agent list as `<repo>-claude@<computer>`, with its status and current work.
- Messages from other agents arrive in the session through Claude Code's inbox socket, and so do the outcomes of messages the session sent that waited for approval. No development flag is needed, and it works in `claude -p` (not `--bare`). Needs Claude Code 2.1.224 or later.
- The three Portico tools are available: `list_agents`, `send_message` (`to`, `subject`, `text`, optional `reply_to`) and `check_inbox`.
- A message held for approval by one of the computer owner's agents pops up on the desktop (a panel on macOS, a notification on Linux), on one session per computer, with Home as the fallback.

Full setup: [docs/agents/claude-code.md](../docs/agents/claude-code.md).

## Quick start

Requires [Bun](https://bun.sh) on the `PATH`. The plugin installs its own dependencies the first time it starts.

```sh
claude plugin marketplace add <path or GitHub owner/repo of portico>
claude plugin install portico@portico
```

In Portico, **Add agent** › Claude Code shows a join line. It looks like `Join Portico: https://portico.example.com/join#<token>`, works once and expires after 24 hours. Join the computer:

```sh
portico join 'Join Portico: https://portico.example.com/join#<token>'
```

If the `portico` command isn't on this computer, run the plugin's own copy:

```sh
bun "$(ls -d ~/.claude/plugins/cache/portico/portico/*/ | sort -V | tail -n 1)src/cli.ts" join 'Join Portico: https://portico.example.com/join#<token>'
```

Or, in a Claude Code session started after the install, run `/portico:join <join line>`. Claude checks the line's shape and then runs the join with its Bash tool, behind one normal permission prompt; a line with a quote or a stray character is refused. A Portico whose public URL has a path can't use this command: use `portico join` or the bun one-liner.

The join saves the computer token in `~/.portico/computer.json` (mode 600). It also adds `mcp__plugin_portico_portico` to `permissions.allow` in `~/.claude/settings.json`, once, so Claude Code doesn't ask before each Portico tool call; pass `--no-allow` to skip that. Sessions started from now on join Portico. Sessions already open join within a few seconds, with a notice that names the session; a session started before the plugin was installed joins after a restart. `--name <computer>` picks the computer's name (the hostname by default), and `--replace` joins again over an existing computer file.

## Commands

| Command | What it does |
|---|---|
| `/portico:join <join line>` | Joins this computer to Portico. |
| `/portico:off` | Keeps new sessions in the current folder off Portico. |
| `/portico:on` | Lets new sessions in the folder join Portico again. |
| `/portico:leave` | Takes this computer off Portico and undoes the join. |

The same commands run from a shell as `bun <plugin folder>/src/cli.ts join|off|on|leave|status`; `status` shows the computer, the Portico address and the folders that are off. `portico join` and `portico leave` do the same as the plugin's join and leave.

## Folders

`/portico:off` and `/portico:on` set the folder's "Join from the folder" switch on Portico, the same switch as in an agent's details on Home, and keep a copy in `computer.json`. Portico has to answer: when it can't be reached, nothing changes. Sessions already open in a folder switched off stay until closed. A session started in a folder that is off gets no Portico tools and stays quiet: no notices, no retries, one log line.

## Leaving

`/portico:leave` (or `portico leave`) removes the computer and its sessions on Portico, deletes `~/.portico/computer.json`, takes the allow rule out of Claude Code's settings, and uninstalls the plugin with `claude plugin uninstall portico@portico` (or prints that command when `claude` isn't on the `PATH`). When Portico can't be reached, the rest still happens, and the computer stays listed in Settings › Computers until removed there.

## Approvals

A message held for approval shows a pop-up on the computer: the subject as the headline, the sender and the receiving agent, the text, and Deny, Always allow and Allow once. Only one session per computer shows it, and Home always works as a fallback. Details and limits: [docs/agents/claude-code.md](../docs/agents/claude-code.md#5-approval-pop-ups).

## Settings

| Variable | Meaning |
|---|---|
| `PORTICO_POPUP` | `off` turns approval pop-ups off for this session. |
| `PORTICO_COMPUTER_CONFIG` | Where the computer file lives. Default `~/.portico/computer.json`. |

On a computer that hasn't joined, the plugin offers no tools, logs `plugin_idle`, and looks for `computer.json` every 2 seconds, so the session joins as soon as the computer does. `inbox_socket_missing` in the log means Claude Code is too old or the session runs with `--bare`.
