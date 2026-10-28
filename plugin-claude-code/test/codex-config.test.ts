import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexHome, serverBlock, setServer, setStopHook, STOP_HOOK, withoutServer, withServer, withStopHook } from "../src/codex-config";
import { tempDir } from "./helpers";

const BRIDGE = "/Users/chris/.portico/portico-codex.js";

describe("config.toml", () => {
  test("Portico's table goes at the end, replaces an earlier one (marked or not), and comes out cleanly", () => {
    const original = 'model = "gpt-5"\n\n[mcp_servers.docs]\ncommand = "docs-mcp"\n';
    const added = withServer(original, serverBlock(BRIDGE, { allow: true }));
    const parsed = Bun.TOML.parse(added) as { model: string; mcp_servers: Record<string, Record<string, unknown>> };
    expect(parsed.model).toBe("gpt-5");
    expect(parsed.mcp_servers.docs).toEqual({ command: "docs-mcp" });
    expect(parsed.mcp_servers.portico).toEqual({
      command: "bun",
      args: [BRIDGE],
      startup_timeout_sec: 30,
      tool_timeout_sec: 60,
      default_tools_approval_mode: "approve",
    });
    // Joining again changes nothing; a new path replaces the table.
    expect(withServer(added, serverBlock(BRIDGE, { allow: true }))).toBe(added);
    const moved = withServer(added, serverBlock("/opt/portico-codex.js", { allow: false }));
    expect((Bun.TOML.parse(moved) as { mcp_servers: Record<string, unknown> }).mcp_servers.portico).toEqual({
      command: "bun",
      args: ["/opt/portico-codex.js"],
      startup_timeout_sec: 30,
      tool_timeout_sec: 60,
    });
    expect(withoutServer(added).trim()).toBe(original.trim());

    // A table someone wrote by hand, with a subtable, goes too, and the table after it stays.
    const byHand = '[mcp_servers.portico]\nurl = "https://old"\n\n[mcp_servers.portico.tools.check_inbox]\napproval_mode = "approve"\n\n[profiles.fast]\nmodel = "x"\n';
    expect(Bun.TOML.parse(withoutServer(byHand))).toEqual({ profiles: { fast: { model: "x" } } });
  });

  test("a lost end marker drops only Portico's table; comments before the next table and spacing elsewhere stay", () => {
    const block = serverBlock(BRIDGE, { allow: true });
    const noEnd = `model = "x"\n\n\n\n${block.replace("# Portico: end", "")}\n# Fast profile, keep\n[profiles.fast]\nmodel = "y"\n`;
    const out = withoutServer(noEnd);
    expect(out).toContain('model = "x"\n\n\n\n');
    expect(out).toContain("# Fast profile, keep\n[profiles.fast]");
    expect(Bun.TOML.parse(out)).toEqual({ model: "x", profiles: { fast: { model: "y" } } });
    // Nothing of Portico's: nothing changes.
    expect(withoutServer('a = 1\n\n\n\nb = 2\n')).toBe('a = 1\n\n\n\nb = 2\n');
  });

  test("Bun's full path and the join's settings go into the table, since Codex passes the bridge only a few variables", () => {
    const block = serverBlock(BRIDGE, { allow: false, bun: "/opt/homebrew/bin/bun", env: { PORTICO_COMPUTER_CONFIG: "/x/computer.json" } });
    expect((Bun.TOML.parse(block) as { mcp_servers: Record<string, unknown> }).mcp_servers.portico).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: [BRIDGE],
      startup_timeout_sec: 30,
      tool_timeout_sec: 60,
      env: { PORTICO_COMPUTER_CONFIG: "/x/computer.json" },
    });
  });

  test("setServer writes atomically with a one-time backup, keeps the mode, and refuses to break the file", () => {
    const home = tempDir("cx-");
    const path = join(home, "config.toml");
    writeFileSync(path, 'model = "gpt-5"\n', { mode: 0o640 });
    expect(setServer(home, BRIDGE)).toEqual({ kind: "written", path, backup: `${path}.portico.bak` });
    expect(readFileSync(`${path}.portico.bak`, "utf8")).toBe('model = "gpt-5"\n');
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(setServer(home, BRIDGE)).toEqual({ kind: "unchanged", path });
    expect(setServer(home, null)).toMatchObject({ kind: "written", backup: null });
    expect(readFileSync(path, "utf8").trim()).toBe('model = "gpt-5"');

    writeFileSync(path, "model = [unclosed\n");
    expect(setServer(home, BRIDGE)).toEqual({ kind: "manual", path, why: "not valid TOML" });
    expect(readFileSync(path, "utf8")).toBe("model = [unclosed\n");
  });

  test("a missing config.toml is created with mode 600, and removing from a missing one does nothing", () => {
    const home = join(tempDir("cx-"), "codex");
    expect(setServer(home, null).kind).toBe("unchanged");
    expect(existsSync(home)).toBe(false);
    expect(setServer(home, BRIDGE)).toMatchObject({ kind: "written", backup: null });
    expect(statSync(join(home, "config.toml")).mode & 0o777).toBe(0o600);
  });

  test("a symlinked config (dotfiles) is written through to its target", () => {
    const dir = tempDir("cx-");
    const home = join(dir, "codex");
    mkdirSync(home);
    writeFileSync(join(dir, "real.toml"), 'model = "gpt-5"\n');
    symlinkSync(join(dir, "real.toml"), join(home, "config.toml"));
    expect(setServer(home, BRIDGE).kind).toBe("written");
    expect(readFileSync(join(dir, "real.toml"), "utf8")).toContain("[mcp_servers.portico]");
  });

  test("CODEX_HOME moves Codex's folder", () => {
    expect(codexHome({ CODEX_HOME: "/tmp/codex-home" })).toBe("/tmp/codex-home");
    expect(codexHome({})).toEndWith("/.codex");
  });
});

describe("hooks.json", () => {
  const existing = {
    description: "Hooks",
    hooks: {
      Stop: [{ matcher: null, hooks: [{ type: "command", command: "notify-done" }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: "check" }] }],
    },
  };

  test("Portico's Stop hook is added once beside the others, and removed without touching them", () => {
    const added = withStopHook(existing, true);
    expect(added).toEqual({
      description: "Hooks",
      hooks: {
        Stop: [{ matcher: null, hooks: [{ type: "command", command: "notify-done" }] }, { hooks: [STOP_HOOK] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "check" }] }],
      },
    });
    expect(withStopHook(added, true)).toEqual(added);
    expect(withStopHook(added, false)).toEqual(existing);
    expect(withStopHook({}, true)).toEqual({ hooks: { Stop: [{ hooks: [STOP_HOOK] }] } });
    expect(withStopHook({ hooks: { Stop: [{ hooks: [STOP_HOOK] }] } }, false)).toEqual({ hooks: {} });
  });

  test("the hook calls check_inbox on Portico's server with stop_hook", () => {
    expect(STOP_HOOK).toMatchObject({ type: "mcp_tool", server: "portico", tool: "check_inbox", input: { stop_hook: true } });
  });

  test("setStopHook writes the file, leaves a broken one alone, and backs up the original once", () => {
    const home = tempDir("cx-");
    const path = join(home, "hooks.json");
    writeFileSync(path, JSON.stringify(existing));
    expect(setStopHook(home, true)).toEqual({ kind: "written", path, backup: `${path}.portico.bak` });
    expect(JSON.parse(readFileSync(path, "utf8")).hooks.Stop).toHaveLength(2);
    expect(setStopHook(home, true).kind).toBe("unchanged");
    expect(setStopHook(home, false).kind).toBe("written");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(existing);
    writeFileSync(path, "{ not json");
    expect(setStopHook(home, true)).toEqual({ kind: "manual", path, why: "not valid JSON" });
  });
});
