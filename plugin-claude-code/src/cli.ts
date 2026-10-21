import { runCli } from "./cli-run";
process.exit(await runCli(process.argv.slice(2), { env: process.env, cwd: process.cwd(), out: (line) => console.log(line), err: (line) => console.error(line) }));
