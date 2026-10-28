// Runs before every test file. No test may reach the real home folder: Codex's config.toml and hooks.json there, Claude
// Code's settings and Portico's computer file are someone's real setup, and a join or leave under test rewrites them.
// homedir() answers a fresh folder instead; a test that wants a home of its own still passes one in its env.
import { mock } from "bun:test";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(os.tmpdir(), "portico-test-home-"));
const homedir = () => home;
mock.module("node:os", () => ({ ...os, homedir, default: { ...os, homedir } }));
