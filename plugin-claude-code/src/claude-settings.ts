// Runs before the plugin's dependencies are installed (the join), so it imports only node:* and machine.ts.
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeHome, writeFileAtomically } from "./machine";

/** Lets Claude Code run every tool of the plugin's MCP server (`bridge`) without asking. */
export const BRIDGE_ALLOW_RULE = "mcp__plugin_agent-bridge_bridge";

export type AllowOutcome =
  /** `backup`: the `.agent-bridge.bak` written by this run, or null (no original, or an older backup kept). */
  | { kind: "added"; path: string; backup: string | null }
  | { kind: "present"; path: string }
  | { kind: "manual"; path: string; why: string };

export function claudeSettingsPath(env: Record<string, string | undefined>): string {
  return join(claudeHome(env), "settings.json");
}

const code = (err: unknown) => (err as NodeJS.ErrnoException).code ?? "error";
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Adds the bridge's allow rule to Claude Code's user settings, once. Other keys and their order are kept. The file is
 * written atomically, through a symlink to its target, after a one-time backup kept beside `path` (so a dotfiles
 * folder never gets one). When the file can't be read, parsed or written safely, it's left alone and the outcome says
 * why.
 */
export function allowBridgeTools(path: string): AllowOutcome {
  let target = path;
  let text: string | null = null;
  try {
    target = realpathSync(path); // a dotfiles symlink stays a symlink: write its target
    text = readFileSync(target, "utf8");
  } catch (err) {
    if (code(err) !== "ENOENT") return { kind: "manual", path, why: `unreadable (${code(err)})` };
    // Writing here would replace the link with a plain file.
    if (isSymlink(path)) return { kind: "manual", path, why: "a symlink to a missing file" };
  }
  let settings: Record<string, unknown> = {};
  if (text !== null && text.trim() !== "") {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "manual", path, why: "not valid JSON" };
    }
    if (!isObject(data)) return { kind: "manual", path, why: "not a JSON object" };
    settings = data;
  }
  const permissions = settings.permissions ?? {};
  if (!isObject(permissions)) return { kind: "manual", path, why: "permissions is not an object" };
  const allow = permissions.allow ?? [];
  if (!Array.isArray(allow)) return { kind: "manual", path, why: "permissions.allow is not a list" };
  if (allow.includes(BRIDGE_ALLOW_RULE)) return { kind: "present", path };

  const next = { ...settings, permissions: { ...permissions, allow: [...allow, BRIDGE_ALLOW_RULE] } };
  const backupPath = `${path}.agent-bridge.bak`;
  try {
    const backup = text !== null && keepBackup(backupPath, text) ? backupPath : null;
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileAtomically(target, `${JSON.stringify(next, null, 2)}\n`, text === null ? 0o600 : statSync(target).mode & 0o777);
    return { kind: "added", path, backup };
  } catch (err) {
    return { kind: "manual", path, why: `not writable (${code(err)})` };
  }
}

/** The CLI line for an outcome: what changed, or the rule to add by hand. Null when the rule was already there. */
export function allowLine(outcome: AllowOutcome): string | null {
  switch (outcome.kind) {
    case "added":
      return (
        `Added ${BRIDGE_ALLOW_RULE} to permissions.allow in ${outcome.path}, so Claude Code runs the network tools ` +
        "without asking. To skip this step, join with --no-allow."
      );
    case "present":
      return null;
    case "manual":
      return (
        `${outcome.path} was left unchanged (${outcome.why}). To let Claude Code run the network tools without asking, ` +
        `add "${BRIDGE_ALLOW_RULE}" to permissions.allow in that file.`
      );
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Copies the original to the backup with mode 600. False when an older backup is there: that one is kept. */
function keepBackup(backup: string, text: string): boolean {
  try {
    writeFileSync(backup, text, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if (code(err) === "EEXIST") return false;
    throw err;
  }
  chmodSync(backup, 0o600); // the mode above is reduced by the umask
  return true;
}
