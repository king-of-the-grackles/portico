import { expect, test } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { codexHome } from "../src/codex-config";
import { claudeHome, computerConfigPath } from "../src/computer";

test("no test reaches the real home folder, where Codex, Claude Code and Portico keep a real setup", () => {
  expect(homedir()).not.toBe(process.env.HOME);
  expect(homedir().startsWith(tmpdir())).toBe(true);
  for (const path of [codexHome({}), claudeHome({}), computerConfigPath({})]) expect(path.startsWith(homedir())).toBe(true);
});
