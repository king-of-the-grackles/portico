#!/usr/bin/env bun
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import type { CliIo } from "./commands/io";
import { serveCommand } from "./commands/serve";

const USAGE = `Usage: bridge <command>

Commands:
  serve             Run the hub. Reads bridge.yaml from BRIDGE_CONFIG (default ./bridge.yaml)
                    and secrets from the environment (./.env is loaded too).
  init [--shell]    Write a starter bridge.yaml if there is none, and generate every secret
                    into ./.env, or with --shell into ./bridge-secrets.sh as export lines.
  doctor [--no-push]
                    Check the config, the public URL, each agent's token on the running hub,
                    and send a test push.
  help              Show this message.
`;

const io: CliIo = {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

async function main(argv: string[]): Promise<number | "running"> {
  const [command, ...args] = argv;
  switch (command) {
    case "serve":
      return serveCommand(io);
    case "init":
      return initCommand(args, io);
    case "doctor":
      return doctorCommand(args, io);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      io.out(USAGE);
      return 0;
    default:
      io.err(`Unknown command: ${command}\n`);
      io.err(USAGE);
      return 1;
  }
}

const outcome = await main(process.argv.slice(2));
if (outcome !== "running") process.exit(outcome);
