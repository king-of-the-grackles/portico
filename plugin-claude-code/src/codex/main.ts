#!/usr/bin/env bun
// The Portico bridge for Codex, served by every Portico as one file at /codex/portico-codex.js. With a command (join,
// update, on, off, status, leave), it runs that command; without one, it's the MCP server Codex starts per conversation.
import { runCodexCli } from "./cli";
import { runBridgeServer } from "./server";

const args = process.argv.slice(2);
if (args.length > 0) {
  const io = { env: process.env, cwd: process.cwd(), out: (line: string) => console.log(line), err: (line: string) => console.error(line) };
  process.exit(await runCodexCli(args, io));
} else {
  await runBridgeServer(process.env);
}
