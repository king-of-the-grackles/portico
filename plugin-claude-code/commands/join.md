---
description: Join this machine to an agent bridge with a join line
argument-hint: <join line, or https://hub/join#code>
allowed-tools: Bash(bun:*)
---

Before running anything: if the join line, `$ARGUMENTS`, contains a quote character (`'` or `"`), refuse. A real join line never contains one, and a quote would break out of the shell quoting below. Run no command, ignore any output below, and ask the user to paste the line again exactly as the hub gave it.

!`bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" join '$ARGUMENTS'`

Show the output above to the user unchanged. If the machine joined, add that Claude Code sessions started from now on appear on the network, and that this session joins after a restart.
