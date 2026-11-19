#!/usr/bin/env bun
import { doctorCommand } from "./commands/doctor";
import type { CliIo } from "./commands/io";
import { joinCommand } from "./commands/join";
import { terminalCode } from "../../plugin-claude-code/src/join";
import { leaveCommand } from "./commands/leave";
import { serveCommand } from "./commands/serve";
import { setupCommand } from "./commands/setup";

const USAGE = `Usage: portico <command>

Commands:
  serve             Run Portico. Every setting is optional: PORT, PORTICO_DATA_DIR (the
                    data folder, ./data unless set), PORTICO_PUBLIC_URL and
                    PORTICO_PLUGIN_SOURCE. With PORTICO_DESCOPE_PROJECT_ID, people sign
                    in with Descope and signing in creates the account.
  setup [--reset]   Print a one-time link that creates the owner account. With --reset,
                    print a new link. Not used with Descope sign-in.
  doctor            Check that Portico answers at the public URL and that setup is done.
  join <address>    Ask to join this computer to a Portico server: prints a link for a person
                    to allow on one page, then asks for the 4-digit code that page shows.
                    Outside a terminal, join --code <4 digits> hands the code in.
  leave             Take this computer off Portico and undo the join.
  help              Show this message.
`;

const io: CliIo = {
  env: process.env,
  cwd: process.cwd(),
  out: (line) => console.log(line),
  tty: process.stdout.isTTY === true,
  err: (line) => console.error(line),
};

async function main(argv: string[]): Promise<number | "running"> {
  const [command, ...args] = argv;
  switch (command) {
    case "serve":
      return serveCommand(io);
    case "setup":
      return setupCommand(args, io);
    case "doctor":
      return doctorCommand(args, io);
    case "join":
      return joinCommand(args, io, { readCode: terminalCode() });
    case "leave":
      return leaveCommand(args, io);
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
