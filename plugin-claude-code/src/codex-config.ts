// The Codex bridge's own setup: Portico as an MCP server in Codex's config.toml, and the Stop hook in hooks.json that
// hands each turn's new messages to the session. Runs before the plugin's dependencies are installed (join and leave), so it imports only node:* and computer.ts.
import { accessSync, chmodSync, constants, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeFileAtomically } from "./computer";

type Env = Record<string, string | undefined>;

/** Codex's folder: CODEX_HOME, or ~/.codex. */
export function codexHome(env: Env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), ".codex");
}

/** The MCP server's name in Codex: tools show as portico's, and the Stop hook calls the server by this name. */
export const SERVER = "portico";

const BEGIN = "# Portico: begin. Written by the Portico bridge's join; its leave removes this block.";
const END = "# Portico: end";

/** What one file's change came to, for the CLI. */
export type Outcome =
  | { kind: "written"; path: string; backup: string | null }
  | { kind: "unchanged"; path: string }
  | { kind: "manual"; path: string; why: string };

const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? "error";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** How Codex starts the bridge: Bun's path, and the settings the bridge needs that Codex wouldn't pass it. */
export interface ServerOptions {
  /** Let Codex run the Portico tools without asking. */
  allow: boolean;
  /**
   * Bun, by full path when known: Codex started from the Dock or an editor gets a short PATH without ~/.bun/bin or
   * Homebrew. Default: "bun".
   */
  bun?: string;
  /**
   * Codex passes MCP servers only a short list of environment variables (HOME, PATH and a few more), so a setting the
   * join ran with, such as PORTICO_COMPUTER_CONFIG, goes into the table.
   */
  env?: Record<string, string>;
}

/** The `[mcp_servers.portico]` table: Codex starts the bridge with Bun for each conversation. */
export function serverBlock(bridgePath: string, opts: ServerOptions): string {
  const lines = [
    BEGIN,
    `[mcp_servers.${SERVER}]`,
    `command = ${JSON.stringify(opts.bun ?? "bun")}`,
    `args = [${JSON.stringify(bridgePath)}]`,
    "startup_timeout_sec = 30",
    // Above the longest check_inbox wait (40 s).
    "tool_timeout_sec = 60",
  ];
  if (opts.allow) lines.push('default_tools_approval_mode = "approve"');
  const env = Object.entries(opts.env ?? {});
  if (env.length > 0) lines.push(`env = { ${env.map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(", ")} }`);
  lines.push(END);
  return lines.join("\n");
}

const PORTICO_TABLE = /^\[\s*mcp_servers\s*\.\s*"?portico"?\s*(\.|\])/;

/**
 * The text without Portico's table: the marked block, and an unmarked `[mcp_servers.portico]` (with its subtables) up
 * to the next table, e.g. one an earlier setup added by hand. Comments and blank lines just before the next table stay
 * with that table. A begin marker without its end counts as no marker, so nothing past the table is lost.
 */
export function withoutServer(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  let skipping: "block" | "table" | null = null;
  /** In a skipped table: comments and blank lines that may belong to the next table. */
  let held: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (skipping === "block") {
      if (trimmed === END) skipping = null;
      continue;
    }
    if (trimmed === BEGIN) {
      if (lines.slice(i + 1).some((later) => later.trim() === END)) skipping = "block";
      continue;
    }
    if (PORTICO_TABLE.test(trimmed)) {
      skipping = "table";
      held = [];
      continue;
    }
    if (skipping === "table") {
      if (trimmed === "" || trimmed.startsWith("#")) {
        held.push(line);
        continue;
      }
      if (!trimmed.startsWith("[")) {
        held = [];
        continue;
      }
      skipping = null;
      kept.push(...held);
      held = [];
    }
    kept.push(line);
  }
  if (skipping === "table") kept.push(...held);
  const out = kept.join("\n");
  // Only the end is tidied, where join puts the table: the rest of the file keeps its own spacing.
  return out === text ? text : out.replace(/\s+$/, "\n");
}

/** The config with Portico's table at the end, replacing any earlier one. */
export function withServer(text: string, block: string): string {
  const rest = withoutServer(text).replace(/\s+$/, "");
  return rest ? `${rest}\n\n${block}\n` : `${block}\n`;
}

/** The Stop hook: Codex calls check_inbox on the conversation's own bridge, which answers with any new messages. */
export const STOP_HOOK = {
  type: "mcp_tool",
  server: SERVER,
  tool: "check_inbox",
  input: { stop_hook: true },
  timeout: 15,
  statusMessage: "Checking Portico",
} as const;

const isPorticoHook = (hook: unknown) =>
  isObject(hook) && hook.type === "mcp_tool" && hook.server === SERVER && hook.tool === "check_inbox";

/** The hooks file with Portico's Stop hook added once, or (with `add` false) taken out. Other hooks are kept. */
export function withStopHook(config: Record<string, unknown>, add: boolean): Record<string, unknown> {
  const hooks = isObject(config.hooks) ? config.hooks : {};
  const groups = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const others = groups
    .map((group) =>
      isObject(group) && Array.isArray(group.hooks) ? { ...group, hooks: group.hooks.filter((hook) => !isPorticoHook(hook)) } : group,
    )
    .filter((group) => !(isObject(group) && Array.isArray(group.hooks) && group.hooks.length === 0));
  const stop = add ? [...others, { hooks: [STOP_HOOK] }] : others;
  const nextHooks: Record<string, unknown> = { ...hooks, Stop: stop };
  if (stop.length === 0) delete nextHooks.Stop;
  return { ...config, hooks: nextHooks };
}

/**
 * Rewrites a file in Codex's folder through `change`: through a symlink to its target, atomically, keeping the mode,
 * after a one-time `.portico.bak` of the original beside the path. A file that can't be read, parsed or written
 * safely is left alone, and the outcome says why.
 */
function rewrite(path: string, change: (text: string | null) => string | null | { why: string }): Outcome {
  let target = path;
  let text: string | null = null;
  try {
    target = realpathSync(path);
    text = readFileSync(target, "utf8");
  } catch (err) {
    if (code(err) !== "ENOENT") return { kind: "manual", path, why: `unreadable (${code(err)})` };
  }
  const next = change(text);
  if (next !== null && typeof next !== "string") return { kind: "manual", path, why: next.why };
  if (next === null || next === text) return { kind: "unchanged", path };
  const backupPath = `${path}.portico.bak`;
  try {
    if (text !== null) accessSync(target, constants.W_OK);
    const backup = text !== null && keepBackup(backupPath, text) ? backupPath : null;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileAtomically(target, next, text === null ? 0o600 : statSync(target).mode & 0o777);
    return { kind: "written", path, backup };
  } catch (err) {
    return { kind: "manual", path, why: `not writable (${code(err)})` };
  }
}

/** config.toml: Portico's server table added (or replaced), or with `bridgePath` null, removed. */
export function setServer(home: string, bridgePath: string | null, opts: ServerOptions = { allow: true }): Outcome {
  return rewrite(join(home, "config.toml"), (text) => {
    if (bridgePath === null && text === null) return null;
    const next = bridgePath === null ? withoutServer(text ?? "") : withServer(text ?? "", serverBlock(bridgePath, opts));
    try {
      Bun.TOML.parse(next);
    } catch {
      return { why: "not valid TOML" };
    }
    return next;
  });
}

/** hooks.json: Portico's Stop hook added once, or with `add` false, removed. */
export function setStopHook(home: string, add: boolean): Outcome {
  return rewrite(join(home, "hooks.json"), (text) => {
    if (!add && text === null) return null;
    let config: unknown = {};
    if (text !== null && text.trim() !== "") {
      try {
        config = JSON.parse(text);
      } catch {
        return { why: "not valid JSON" };
      }
    }
    if (!isObject(config)) return { why: "not a JSON object" };
    if (config.hooks !== undefined && !isObject(config.hooks)) return { why: "hooks is not an object" };
    const next = `${JSON.stringify(withStopHook(config, add), null, 2)}\n`;
    // Unchanged in substance: keep the file as it is.
    return text !== null && JSON.stringify(JSON.parse(next)) === JSON.stringify(config) ? null : next;
  });
}

/** Copies the original to the backup with mode 600. False when an older backup is there: that one is kept. */
function keepBackup(backup: string, text: string): boolean {
  try {
    writeFileSync(backup, text, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (code(err) === "EEXIST") return false;
    throw err;
  }
  chmodSync(backup, 0o600);
  return true;
}
