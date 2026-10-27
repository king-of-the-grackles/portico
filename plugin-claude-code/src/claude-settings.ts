// Runs before the plugin's dependencies are installed (the join and leave commands), so it imports only node:* and
// computer.ts.
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeHome, writeFileAtomically } from "./computer";

/** Lets Claude Code run every tool of the plugin's MCP server (`portico`) without asking. */
export const PORTICO_ALLOW_RULE = "mcp__plugin_portico_portico";

export type AllowOutcome =
  /** `backup`: the `.portico.bak` written by this run, or null (no original, or an older backup kept). */
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
 * Adds Portico's allow rule to Claude Code's user settings, once. Other keys and their order are kept. The file is
 * written atomically, through a symlink to its target, after a one-time backup kept beside `path` (so a dotfiles
 * folder never gets one). When the file can't be read, parsed or written safely, it's left alone and the outcome says
 * why.
 */
export function allowPorticoTools(path: string): AllowOutcome {
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
  if (allow.includes(PORTICO_ALLOW_RULE)) return { kind: "present", path };

  const next = { ...settings, permissions: { ...permissions, allow: [...allow, PORTICO_ALLOW_RULE] } };
  const backupPath = `${path}.portico.bak`;
  try {
    // A read-only file is left alone: the rename below would replace it even so, in a folder that can be written.
    if (text !== null) accessSync(target, constants.W_OK);
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
        `Added ${PORTICO_ALLOW_RULE} to permissions.allow in ${outcome.path}, so Claude Code runs the Portico tools ` +
        "without asking. To skip this step, join with --no-allow."
      );
    case "present":
      return null;
    case "manual":
      return (
        `${outcome.path} was left unchanged (${outcome.why}). To let Claude Code run the Portico tools without asking, ` +
        `add "${PORTICO_ALLOW_RULE}" to permissions.allow in that file.`
      );
  }
}

export type RemoveOutcome =
  | { kind: "removed"; path: string }
  | { kind: "absent"; path: string }
  | { kind: "manual"; path: string; why: string };

/**
 * Takes Portico's allow rule back out of Claude Code's user settings, keeping everything else. Written atomically,
 * through a symlink to its target. When the file can't be read, parsed or written safely, it's left alone and the
 * outcome says why.
 */
export function removePorticoAllowRule(path: string): RemoveOutcome {
  let target = path;
  let text: string;
  try {
    target = realpathSync(path);
    text = readFileSync(target, "utf8");
  } catch (err) {
    if (code(err) === "ENOENT") return { kind: "absent", path };
    return { kind: "manual", path, why: `unreadable (${code(err)})` };
  }
  if (text.trim() === "") return { kind: "absent", path };
  let settings: unknown;
  try {
    settings = JSON.parse(text);
  } catch {
    return { kind: "manual", path, why: "not valid JSON" };
  }
  if (!isObject(settings)) return { kind: "manual", path, why: "not a JSON object" };
  const permissions = settings.permissions;
  if (permissions === undefined) return { kind: "absent", path };
  if (!isObject(permissions)) return { kind: "manual", path, why: "permissions is not an object" };
  const allow = permissions.allow;
  if (allow === undefined) return { kind: "absent", path };
  if (!Array.isArray(allow)) return { kind: "manual", path, why: "permissions.allow is not a list" };
  if (!allow.includes(PORTICO_ALLOW_RULE)) return { kind: "absent", path };

  const next = { ...settings, permissions: { ...permissions, allow: allow.filter((rule) => rule !== PORTICO_ALLOW_RULE) } };
  try {
    accessSync(target, constants.W_OK);
    writeFileAtomically(target, `${JSON.stringify(next, null, 2)}\n`, statSync(target).mode & 0o777);
    return { kind: "removed", path };
  } catch (err) {
    return { kind: "manual", path, why: `not writable (${code(err)})` };
  }
}

/** The CLI line for a removal: what changed, or the rule to take out by hand. Null when the rule wasn't there. */
export function removeLine(outcome: RemoveOutcome): string | null {
  switch (outcome.kind) {
    case "removed":
      return `Removed ${PORTICO_ALLOW_RULE} from permissions.allow in ${outcome.path}.`;
    case "absent":
      return null;
    case "manual":
      return `${outcome.path} was left unchanged (${outcome.why}). Remove "${PORTICO_ALLOW_RULE}" from permissions.allow in that file by hand.`;
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
