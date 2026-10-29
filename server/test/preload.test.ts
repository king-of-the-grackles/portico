import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { codexHome } from "../../plugin-claude-code/src/codex-config";
import { claudeHome, computerConfigPath } from "../../plugin-claude-code/src/computer";

// Run from server/, as from the repo root and plugin-claude-code/: portico leave under test once rewrote the real
// Codex config.toml and hooks.json because this folder had no guard.
test("no server test reaches the real home folder, where Codex, Claude Code and Portico keep a real setup", () => {
  expect(homedir()).not.toBe(process.env.HOME);
  expect(homedir().startsWith(tmpdir())).toBe(true);
  for (const path of [codexHome({}), claudeHome({}), computerConfigPath({})]) expect(path.startsWith(homedir())).toBe(true);
});
