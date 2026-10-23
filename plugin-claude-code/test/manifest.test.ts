import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { joinLine } from "../../hub/src/core/network";
import { SERVER_NAME, SERVER_VERSION } from "../src/plugin";

const ROOT = join(import.meta.dir, "../..");
const PLUGIN = join(ROOT, "plugin-claude-code");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("marketplace, manifest, package and server agree on the name and version", () => {
  const marketplace = json(join(ROOT, ".claude-plugin/marketplace.json"));
  const manifest = json(join(PLUGIN, ".claude-plugin/plugin.json"));
  const pkg = json(join(PLUGIN, "package.json"));
  expect(marketplace.name).toBe("portico");
  expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "portico", source: "./plugin-claude-code" })]);
  expect(manifest.name).toBe("portico");
  expect(manifest.version).toBe(pkg.version);
  expect(SERVER_NAME).toBe("portico");
  expect(SERVER_VERSION).toBe(pkg.version);
  expect(pkg.version).toBe("0.4.0");
  const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
  expect(/"name": "@portico\/plugin-claude-code",\s*"version": "([^"]+)"/.exec(lock)?.[1]).toBe(pkg.version);
});

test(".mcp.json starts the server from the plugin folder and passes the two settings through", () => {
  expect(json(join(PLUGIN, ".mcp.json"))).toEqual({
    mcpServers: {
      portico: {
        command: "bun",
        args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"],
        env: {
          PORTICO_URL: "${PORTICO_URL}",
          PORTICO_TOKEN: "${PORTICO_TOKEN}",
        },
      },
    },
  });
});

test("the start script keeps stdout clean, and only runtime dependencies are installed, pinned exactly", () => {
  const pkg = json(join(PLUGIN, "package.json"));
  expect(pkg.scripts.start).toBe("bun install --no-summary 1>&2 && bun src/main.ts");
  expect(pkg.devDependencies).toBeUndefined();
  expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "zod"]);
  for (const version of Object.values(pkg.dependencies)) expect(version).toMatch(/^\d+\.\d+\.\d+$/);
});

test("plugin source imports nothing from outside the plugin folder, which is all Claude Code copies", () => {
  const src = join(PLUGIN, "src");
  for (const file of readdirSync(src).filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(join(src, file), "utf8");
    for (const match of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      expect(resolve(src, match[1]!).startsWith(src)).toBe(true);
    }
  }
});

const readCommand = (name: string) => readFileSync(join(PLUGIN, "commands", `${name}.md`), "utf8");

test("off and on run the plugin's CLI from the plugin folder through a ! line that takes no arguments", () => {
  for (const name of ["off", "on"]) {
    const text = readCommand(name);
    expect(text).toContain("allowed-tools: Bash(bun:*)");
    expect(text).toContain(`!\`bun "\${CLAUDE_PLUGIN_ROOT}/src/cli.ts" ${name}\``);
    expect(text).not.toContain("$ARGUMENTS");
  }
});

test("join never puts the join line in a ! line: Claude checks the line, then runs the CLI behind a normal permission prompt", () => {
  const text = readCommand("join");
  // Claude Code runs a `!` block (at a line start or after whitespace) in a shell while expanding the command.
  for (const block of text.matchAll(/(?:^|\s)!`([^`]*)`/gm)) expect(block[1]).not.toContain("$ARGUMENTS");
  expect(text).not.toMatch(/(?:^|\s)!`/m);
  expect(text).not.toContain("allowed-tools");
  expect(text).toContain("Join my Portico hub: ");
  expect(text).toContain(`bun "\${CLAUDE_PLUGIN_ROOT}/src/cli.ts" join '<address>'`);
  expect(text).toContain("--no-allow");
});

test("join.md accepts the join line the hub hands out", () => {
  const text = readCommand("join");
  const hub = "https://portico.example.com";
  const code = `${"Ab_-".repeat(5)}cd`;
  const address = `${hub}/join#${code}`;
  const line = joinLine(hub, code);
  // The line is the prefix plus the address, nothing after it, as join.md requires.
  expect(line.endsWith(address)).toBe(true);
  const prefix = line.slice(0, -address.length); // "Join my Portico hub: "
  expect(prefix).not.toBe("");
  expect(text).toContain(`\`${prefix}\``);
  expect(address).toMatch(new RegExp(/`(\^\(https:[^`]*\$)`/.exec(text)![1]!));
});

test("the address shape in join.md accepts real join addresses and nothing a shell would act on", () => {
  const source = /`(\^\(https:[^`]*\$)`/.exec(readCommand("join"))?.[1];
  expect(source).toBeDefined();
  const shape = new RegExp(source!);
  const code = `${"Ab_-".repeat(5)}cd`;
  for (const good of [
    `https://portico.example.com/join#${code}`,
    `https://portico.example.com:8443/join#${code}`,
    `http://localhost:8790/join#${code}`,
    `http://127.0.0.1/join#${code}`,
  ]) {
    expect(good).toMatch(shape);
  }
  const base = `https://portico.example.com/join#${code}`;
  for (const bad of [
    `http://portico.example.com/join#${code}`,
    `https://u:p@portico.example.com/join#${code}`,
    "https://portico.example.com/join#short",
    `Join my Portico hub: ${base}`,
    ...[" x", "\tx", "\nid", "'", '"', "`id`", "$(id)", ";id", "&id", "|id", "<x", ">x", "\\"].map((tail) => base + tail),
  ]) {
    expect(bad).not.toMatch(shape);
  }
});

/** Every module specifier in the source: `from "x"`, `import "x"`, `import(x)` and `require(x)`. */
function importSpecs(text: string): string[] {
  const IMPORT = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']|\b(?:import|require)\s*\(\s*([^)]*)\)/g;
  return [...text.matchAll(IMPORT)].map((match) => {
    if (match[1] !== undefined || match[2] !== undefined) return (match[1] ?? match[2])!;
    const argument = match[3]!.trim();
    // A string literal is checked by its value; anything else stays as written, and fails the check.
    return /^["']([^"']+)["']$/.exec(argument)?.[1] ?? argument;
  });
}

test("the import check finds every form of import", () => {
  const sample = `import a from "a";\nimport "b";\nconst c = await import("c");\nconst d = require('d');\nexport * from "e";\nimport(name);`;
  expect(importSpecs(sample)).toEqual(["a", "b", "c", "d", "e", "name"]);
});

test("cli.ts, cli-run.ts, join.ts, machine.ts and claude-settings.ts import only node built-ins and each other, so they run before bun install", () => {
  for (const file of ["cli.ts", "cli-run.ts", "join.ts", "machine.ts", "claude-settings.ts"]) {
    const imports = importSpecs(readFileSync(join(PLUGIN, "src", file), "utf8"));
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^(node:[a-z_/]+|\.\/(cli-run|join|machine|claude-settings))$/);
  }
});

test("the plugin declares no Claude Code channel anywhere", () => {
  const src = join(PLUGIN, "src");
  for (const file of readdirSync(src).filter((name) => name.endsWith(".ts"))) {
    expect(readFileSync(join(src, file), "utf8")).not.toContain("claude/channel");
  }
  expect(readFileSync(join(PLUGIN, ".mcp.json"), "utf8")).not.toContain("PERMISSION_RELAY");
});
