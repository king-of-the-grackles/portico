---
description: Join this computer to Portico with a join line
argument-hint: <join line, or https://host/join#token> [--no-allow]
---

The join line given: $ARGUMENTS

Check the join line before running anything:

1. The line may end with ` --no-allow`. Set that ending aside before the checks below, and remember it. Then take the address from the line. The line is either the address alone, or `Join Portico: ` followed by the address. Nothing else may be in the line.
2. The address must match this exact shape, every character of it:

   `^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)/join#[A-Za-z0-9_-]{16,64}$`

   That is `https://<host>/join#<token>`, or `http://localhost` or `http://127.0.0.1` with an optional port, then `/join#<token>`, where the token is only letters, digits, `_` and `-`. The address has no whitespace, quotes, backticks, `$`, `;`, `&`, `|`, `<`, `>` or backslash anywhere.
3. If the line doesn't fit, refuse: run no command, say that the join line doesn't have the expected shape, and ask the user to paste the line again exactly as Portico gave it.
4. If the line fits, run this one command with the Bash tool, with the address in place of `<address>`, adding ` --no-allow` at the end only when the line ended with it:

   `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" join '<address>'`

   Then show the output to the user unchanged. If the computer joined, add that Claude Code sessions started from now on join Portico. This session joins within a few seconds, and a Portico notice then names the session; if no notice comes (the plugin was installed after this session started), this session joins after a restart. When the join adds the Portico tools to Claude Code's settings, or can't and gives the rule to add by hand, the output says so; when the tools were already allowed, the output says nothing about them.
