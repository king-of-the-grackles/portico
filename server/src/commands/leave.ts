import type { CliIo } from "./io";

/** `portico leave`: takes this computer off Portico and undoes the join. Built by the plugin track. */
export async function leaveCommand(_args: string[], io: CliIo): Promise<number> {
  io.err("portico leave isn't built yet.");
  return 1;
}
