import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyProblems } from "../../server/test/helpers";
import {
  type AllowOutcome,
  allowLine,
  allowPorticoTools,
  claudeSettingsPath,
  PORTICO_ALLOW_RULE,
  removeLine,
  removePorticoAllowRule,
} from "../src/claude-settings";
import { tempDir } from "./helpers";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
/** A temp folder with symlinks resolved (on macOS /var is /private/var), so reported paths compare equal. */
const folder = () => realpathSync(tempDir());

describe("the allow rule in Claude Code's settings", () => {
  test("the file is settings.json in the Claude home", () => {
    expect(claudeSettingsPath({ PORTICO_CLAUDE_HOME: "/x/.claude" })).toBe("/x/.claude/settings.json");
  });

  test("adds the rule, keeping every other key in order and the file's mode, after a one-time backup", () => {
    const path = join(folder(), "settings.json");
    const original = `{\n    "model": "opus",\n    "permissions": { "allow": ["Bash(git status)"], "deny": ["Read(.env)"] },\n    "env": { "A": "1" }\n}\n`;
    writeFileSync(path, original);
    chmodSync(path, 0o644);
    expect(allowPorticoTools(path)).toEqual({ kind: "added", path, backup: `${path}.portico.bak` });
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)", PORTICO_ALLOW_RULE], deny: ["Read(.env)"] }, env: { A: "1" } }, null, 2)}\n`,
    );
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect(readFileSync(`${path}.portico.bak`, "utf8")).toBe(original);
    expect(statSync(`${path}.portico.bak`).mode & 0o777).toBe(0o600);
  });

  test("a second run finds the rule and changes nothing; the first backup is never overwritten", () => {
    const path = join(folder(), "settings.json");
    writeFileSync(path, '{"theme":"dark"}');
    allowPorticoTools(path);
    const after = readFileSync(path, "utf8");
    expect(allowPorticoTools(path)).toEqual({ kind: "present", path });
    expect(readFileSync(path, "utf8")).toBe(after);
    // Someone removes the rule by hand: the next join adds it again and keeps the backup from the first time.
    writeFileSync(path, '{"theme":"light"}');
    expect(allowPorticoTools(path)).toEqual({ kind: "added", path, backup: null });
    expect(readFileSync(`${path}.portico.bak`, "utf8")).toBe('{"theme":"dark"}');
  });

  test("creates a missing file and its folder, with mode 600 and no backup", () => {
    const path = join(folder(), "home", ".claude", "settings.json");
    expect(allowPorticoTools(path)).toEqual({ kind: "added", path, backup: null });
    expect(read(path)).toEqual({ permissions: { allow: [PORTICO_ALLOW_RULE] } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(`${path}.portico.bak`)).toBe(false);
  });

  test("a blank file counts as no settings", () => {
    const path = join(folder(), "settings.json");
    writeFileSync(path, "  \n");
    expect(allowPorticoTools(path).kind).toBe("added");
    expect(read(path)).toEqual({ permissions: { allow: [PORTICO_ALLOW_RULE] } });
  });

  test("leaves the file alone when the JSON is invalid or the shape is wrong", () => {
    const dir = folder();
    for (const [text, why] of [
      ["{ not json", "not valid JSON"],
      ["[1, 2]", "not a JSON object"],
      ['{"permissions": "all"}', "permissions is not an object"],
      ['{"permissions": {"allow": "Bash"}}', "permissions.allow is not a list"],
    ] as const) {
      const path = join(dir, `${why.replace(/\W+/g, "-")}.json`);
      writeFileSync(path, text);
      expect(allowPorticoTools(path)).toEqual({ kind: "manual", path, why });
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(existsSync(`${path}.portico.bak`)).toBe(false);
    }
  });

  test("writes through a symlinked settings file to its target, with the backup beside the link", () => {
    const dir = folder();
    const target = join(dir, "dotfiles-settings.json");
    writeFileSync(target, '{"theme":"dark"}');
    const path = join(dir, "settings.json");
    symlinkSync(target, path);
    expect(allowPorticoTools(path)).toEqual({ kind: "added", path, backup: `${path}.portico.bak` });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(read(target)).toEqual({ theme: "dark", permissions: { allow: [PORTICO_ALLOW_RULE] } });
    // The backup sits in the Claude home as settings.json.portico.bak, never inside a dotfiles folder.
    expect(readFileSync(`${path}.portico.bak`, "utf8")).toBe('{"theme":"dark"}');
    expect(lstatSync(`${path}.portico.bak`).isSymbolicLink()).toBe(false);
    expect(existsSync(`${target}.portico.bak`)).toBe(false);
  });

  test("a symlink to a missing file is left alone, never replaced by a plain file", () => {
    const dir = folder();
    const target = join(dir, "dotfiles", "settings.json");
    const path = join(dir, "settings.json");
    symlinkSync(target, path);
    expect(allowPorticoTools(path)).toEqual({ kind: "manual", path, why: "a symlink to a missing file" });
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${path}.portico.bak`)).toBe(false);
  });

  test("a folder that can't be written leaves the file alone", () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    const dir = folder();
    const path = join(dir, "settings.json");
    writeFileSync(path, "{}");
    chmodSync(dir, 0o500);
    try {
      expect(allowPorticoTools(path)).toEqual({ kind: "manual", path, why: "not writable (EACCES)" });
      expect(readFileSync(path, "utf8")).toBe("{}");
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("a read-only file is left alone, with no backup, even in a folder that can be written", () => {
    if (process.getuid?.() === 0) return; // root writes anyway
    const dir = folder();
    const path = join(dir, "settings.json");
    writeFileSync(path, '{ "theme": "dark" }\n');
    chmodSync(path, 0o444);
    try {
      expect(allowPorticoTools(path)).toEqual({ kind: "manual", path, why: "not writable (EACCES)" });
      expect(readFileSync(path, "utf8")).toBe('{ "theme": "dark" }\n');
      expect(statSync(path).mode & 0o777).toBe(0o444);
      expect(existsSync(`${path}.portico.bak`)).toBe(false);
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("the CLI lines: one for an added rule, none when present, the rule to add by hand otherwise, and no pronouns", () => {
    const path = "/h/.claude/settings.json";
    const added: AllowOutcome = { kind: "added", path, backup: null };
    const manual: AllowOutcome = { kind: "manual", path, why: "not valid JSON" };
    expect(allowLine(added)).toBe(
      `Added ${PORTICO_ALLOW_RULE} to permissions.allow in ${path}, so Claude Code runs the Portico tools without asking. To skip this step, join with --no-allow.`,
    );
    expect(allowLine({ kind: "present", path })).toBeNull();
    expect(allowLine(manual)).toBe(
      `${path} was left unchanged (not valid JSON). To let Claude Code run the Portico tools without asking, add "${PORTICO_ALLOW_RULE}" to permissions.allow in that file.`,
    );
    for (const outcome of [added, manual]) expect(copyProblems(allowLine(outcome)!)).toEqual([]);
  });
});

describe("taking the allow rule out again", () => {
  test("removes only the rule, keeping every other key, the order and the file's mode", () => {
    const path = join(folder(), "settings.json");
    writeFileSync(
      path,
      JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)", PORTICO_ALLOW_RULE], deny: ["Read(.env)"] } }),
    );
    chmodSync(path, 0o640);
    expect(removePorticoAllowRule(path)).toEqual({ kind: "removed", path });
    expect(readFileSync(path, "utf8")).toBe(
      `${JSON.stringify({ model: "opus", permissions: { allow: ["Bash(git status)"], deny: ["Read(.env)"] } }, null, 2)}\n`,
    );
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(removePorticoAllowRule(path)).toEqual({ kind: "absent", path });
  });

  test("a missing file, or one without the rule, is left alone", () => {
    const dir = folder();
    expect(removePorticoAllowRule(join(dir, "none.json"))).toEqual({ kind: "absent", path: join(dir, "none.json") });
    const path = join(dir, "settings.json");
    for (const text of ["", "{}", '{ "permissions": {} }', '{ "permissions": { "allow": ["Bash(ls)"] } }']) {
      writeFileSync(path, text);
      expect(removePorticoAllowRule(path)).toEqual({ kind: "absent", path });
      expect(readFileSync(path, "utf8")).toBe(text);
    }
  });

  test("goes through a symlink to its target, keeping the link", () => {
    const dir = folder();
    const target = join(dir, "dotfiles-settings.json");
    writeFileSync(target, JSON.stringify({ permissions: { allow: [PORTICO_ALLOW_RULE] } }));
    const link = join(dir, "settings.json");
    symlinkSync(target, link);
    expect(removePorticoAllowRule(link)).toEqual({ kind: "removed", path: link });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(read(target)).toEqual({ permissions: { allow: [] } });
  });

  test("a file that can't be parsed is left alone, with the rule to take out by hand", () => {
    const path = join(folder(), "settings.json");
    writeFileSync(path, "{ broken");
    const outcome = removePorticoAllowRule(path);
    expect(outcome).toEqual({ kind: "manual", path, why: "not valid JSON" });
    expect(readFileSync(path, "utf8")).toBe("{ broken");
    expect(removeLine(outcome)).toBe(
      `${path} was left unchanged (not valid JSON). Remove "${PORTICO_ALLOW_RULE}" from permissions.allow in that file by hand.`,
    );
    writeFileSync(path, '{ "permissions": { "allow": "all" } }');
    expect(removePorticoAllowRule(path)).toEqual({ kind: "manual", path, why: "permissions.allow is not a list" });
  });

  test("the CLI lines follow the copy rules", () => {
    const path = "/h/.claude/settings.json";
    expect(removeLine({ kind: "removed", path })).toBe(`Removed ${PORTICO_ALLOW_RULE} from permissions.allow in ${path}.`);
    expect(removeLine({ kind: "absent", path })).toBeNull();
    expect(copyProblems(removeLine({ kind: "removed", path })!)).toEqual([]);
    expect(copyProblems(removeLine({ kind: "manual", path, why: "not valid JSON" })!)).toEqual([]);
  });
});
