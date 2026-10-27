import type { CliIo } from "./io";

/** `portico setup [--reset]`: prints a one-time setup link. Built by the Accounts track. */
export async function setupCommand(_args: string[], io: CliIo): Promise<number> {
  io.err("portico setup isn't built yet.");
  return 1;
}
