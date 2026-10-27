#!/usr/bin/env bun
import { doctorCommand } from "./commands/doctor";
import { initCommand } from "./commands/init";
import { inviteCommand } from "./commands/invite";
import type { CliIo } from "./commands/io";
import { joinCommand } from "./commands/join";
import { serveCommand } from "./commands/serve";

const USAGE = `Usage: portico <command>

Commands:
  serve             Run the hub. Reads portico.yaml from PORTICO_CONFIG (default ./portico.yaml)
                    and secrets from the environment (./.env is loaded too).
  init [--shell]    Write a starter portico.yaml if there is none, and generate every secret
                    into ./.env, or with --shell into ./portico-secrets.sh as export lines.
  doctor            Check the config, the public URL, and each agent's token on the running hub.
  invite            Make a one-time join line for a new machine (runs where the hub's
                    config and database are).
  join <line> [--code <code>] [--name <machine>] [--replace] [--no-allow]
                    Join this machine to a hub with a join line, and allow the network tools in Claude Code.
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
    case "invite":
      return inviteCommand(args, io);
    case "join":
      return joinCommand(args, io);
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
