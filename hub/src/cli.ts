#!/usr/bin/env bun
import { ConfigError, loadConfig } from "./config";
import { startServer } from "./server";

const USAGE = `Usage: bridge <command>

Commands:
  serve    Run the hub. Reads bridge.yaml from BRIDGE_CONFIG (default ./bridge.yaml)
           and secrets from the environment (Bun also loads ./.env).
  help     Show this message.
`;

async function main(argv: string[]): Promise<number | "running"> {
  const [command] = argv;
  if (command === "serve") {
    try {
      const running = startServer(await loadConfig(process.env));
      const shutdown = () => {
        running.stop();
        process.exit(0);
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      return "running";
    } catch (err) {
      if (err instanceof ConfigError) {
        console.error(err.message);
        return 1;
      }
      throw err;
    }
  }
  console.log(USAGE);
  return command === undefined || command === "help" || command === "--help" ? 0 : 1;
}

const outcome = await main(process.argv.slice(2));
if (outcome !== "running") process.exit(outcome);
