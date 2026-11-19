---
description: Join this computer to Portico
argument-hint: <the Portico server's address, such as https://portico.example.com> [--no-allow]
---

The address given: $ARGUMENTS

Check the address before running anything:

1. The text may end with ` --no-allow`. Set that ending aside before the checks below, and remember it. The text may start with `Join Portico at `; set that aside too. What is left is the address, and nothing else may be in the text.
2. The address must match this exact shape, every character of it:

   `^(https://[A-Za-z0-9.-]+(:[0-9]+)?|http://(localhost|127\.0\.0\.1)(:[0-9]+)?)(/join)?/?$`

   That is `https://<host>`, or `http://localhost` or `http://127.0.0.1` with an optional port, with `/join` allowed at the end. The address has no whitespace, quotes, backticks, `$`, `;`, `&`, `|`, `<`, `>`, `#`, `?` or backslash anywhere.
3. If the address doesn't fit, refuse: run no command, say that the address doesn't have the expected shape, and ask the user for the Portico server's address.
4. If the address fits, run this one command with the Bash tool, with the address in place of `<address>`, adding ` --no-allow` at the end only when the text ended with it:

   `bun "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" join '<address>' --wait 0`

   The command asks Portico to let this computer join and prints a link and a 4-digit code. Show the user those lines unchanged, in full: the link to open, the code to type there, and when the code runs out. Say that the user opens the link, signs in to Portico, types the code and presses Allow. Never type the code anywhere, and never open the link: only the user does both.

   When the output says the computer is already on Portico, show that and stop: nothing needs allowing.
5. Then run the same command with ` --wait 100` in place of ` --wait 0`, to wait for the user. When the output says the join still waits, run that command again, until the output says the computer joined, the join wasn't allowed, or the code ran out. When the code ran out, start again from step 4 for a fresh link and code.
6. Show the final output to the user unchanged. If the computer joined, add that Claude Code sessions started from now on join Portico. This session joins within a few seconds, and a Portico notice then names the session; if no notice comes (the plugin was installed after this session started), this session joins after a restart. When the join adds the Portico tools to Claude Code's settings, or can't and gives the rule to add by hand, the output says so; when the tools were already allowed, the output says nothing about them.
