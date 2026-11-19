import { runCli } from "./cli-run";
import { terminalCode } from "./join";
process.exit(
  await runCli(
    process.argv.slice(2),
    { env: process.env, cwd: process.cwd(), out: (line) => console.log(line), err: (line) => console.error(line) },
    { readCode: terminalCode(), command: `bun "${import.meta.path}"` },
  ),
);
