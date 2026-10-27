---
description: Take this computer off Portico and undo the join
allowed-tools: Bash(bun:*)
disable-model-invocation: true
---

!`bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" leave`

Show the output above to the user unchanged. Sessions open on this computer lose Portico when they restart.
