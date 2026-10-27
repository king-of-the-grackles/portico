/** What a command needs from the outside world, so tests can run commands without a real process. */
export interface CliIo {
  env: Record<string, string | undefined>;
  /** The folder that relative paths resolve against, and where init writes files. */
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}
