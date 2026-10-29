import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { copyProblems, HUB } from "../../server/test/helpers";
import { JOIN_PREFIX, parseJoinLine } from "../src/join";
import { SERVER_NAME, SERVER_VERSION } from "../src/plugin";

const ROOT = join(import.meta.dir, "../..");
const PLUGIN = join(ROOT, "plugin-claude-code");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));
/** Every source file under src/, Codex's bridge included, as paths relative to src/. */
const srcFiles = () =>
  (readdirSync(join(PLUGIN, "src"), { recursive: true }) as string[]).filter((name) => name.endsWith(".ts") && !name.includes("logs/"));

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
  expect(pkg.version).toBe("0.8.0");
  const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
  expect(/"name": "@portico\/plugin-claude-code",\s*"version": "([^"]+)"/.exec(lock)?.[1]).toBe(pkg.version);
});

test("the manifest describes messages, with no pronouns, no retired word and no tasks", () => {
  const manifest = json(join(PLUGIN, ".claude-plugin/plugin.json"));
  expect(manifest.description).toContain("Portico");
  expect(copyProblems(manifest.description)).toEqual([]);
  expect(manifest.description).not.toMatch(/\btasks?\b/i);
});

test(".mcp.json starts the server from the plugin folder, with no settings to pass through", () => {
  expect(json(join(PLUGIN, ".mcp.json"))).toEqual({
    mcpServers: {
      portico: {
        command: "bun",
        args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"],
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
  for (const file of srcFiles()) {
    const text = readFileSync(join(src, file), "utf8");
    for (const match of text.matchAll(/from\s+"(\.{1,2}\/[^"]+)"/g)) {
      expect(resolve(dirname(join(src, file)), match[1]!).startsWith(src)).toBe(true);
    }
  }
});

test("no file name, source line or doc in the plugin says hub", () => {
  const files = [
    ...srcFiles().map((name) => join("src", name)),
    ...readdirSync(join(PLUGIN, "commands")).map((name) => join("commands", name)),
    "README.md",
    ".mcp.json",
    ".claude-plugin/plugin.json",
    "package.json",
  ];
  for (const file of files) {
    expect(file).not.toMatch(HUB);
    expect(readFileSync(join(PLUGIN, file), "utf8")).not.toMatch(HUB);
  }
});

const readCommand = (name: string) => readFileSync(join(PLUGIN, "commands", `${name}.md`), "utf8");

test("off, on and leave run the plugin's CLI from the plugin folder through a ! line that takes no arguments", () => {
  for (const name of ["off", "on", "leave"]) {
    const text = readCommand(name);
    expect(text).toContain("allowed-tools: Bash(bun:*)");
    expect(text).toContain(`!\`bun "\${CLAUDE_PLUGIN_ROOT}/src/cli.ts" ${name}\``);
    expect(text).not.toContain("$ARGUMENTS");
    // The person's switches: never run by the model, say on another agent's request.
    expect(text).toContain("disable-model-invocation: true");
  }
});

test("join never puts the join line in a ! line: Claude checks the line, then runs the CLI behind a normal permission prompt", () => {
  const text = readCommand("join");
  // Claude Code runs a `!` block (at a line start or after whitespace) in a shell while expanding the command.
  for (const block of text.matchAll(/(?:^|\s)!`([^`]*)`/gm)) expect(block[1]).not.toContain("$ARGUMENTS");
  expect(text).not.toMatch(/(?:^|\s)!`/m);
  expect(text).not.toContain("allowed-tools");
  expect(text).toContain(`\`${JOIN_PREFIX}\``);
  expect(text).toContain(`bun "\${CLAUDE_PLUGIN_ROOT}/src/cli.ts" join '<address>'`);
  expect(text).toContain("--no-allow");
});

test("join.md accepts the join line Portico hands out, and the CLI parses the same line", () => {
  const text = readCommand("join");
  const token = `${"Ab_-".repeat(5)}cd`;
  const address = `https://portico.example.com/join#${token}`;
  const line = `Join Portico: ${address}`;
  // The line is the prefix plus the address, nothing after it, as join.md requires.
  expect(line).toBe(`${JOIN_PREFIX}${address}`);
  expect(address).toMatch(new RegExp(/`(\^\(https:[^`]*\$)`/.exec(text)![1]!));
  expect(parseJoinLine(line)).toEqual({ url: "https://portico.example.com", token });
});

test("the address shape in join.md accepts real join addresses and nothing a shell would act on", () => {
  const source = /`(\^\(https:[^`]*\$)`/.exec(readCommand("join"))?.[1];
  expect(source).toBeDefined();
  const shape = new RegExp(source!);
  const token = `${"Ab_-".repeat(5)}cd`;
  for (const good of [
    `https://portico.example.com/join#${token}`,
    `https://portico.example.com:8443/join#${token}`,
    `http://localhost:8790/join#${token}`,
    `http://127.0.0.1/join#${token}`,
  ]) {
    expect(good).toMatch(shape);
  }
  const base = `https://portico.example.com/join#${token}`;
  for (const bad of [
    `http://portico.example.com/join#${token}`,
    `https://u:p@portico.example.com/join#${token}`,
    "https://portico.example.com/join#short",
    `Join Portico: ${base}`,
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

const CLI_FILES = ["cli", "cli-run", "join", "folders", "leave", "computer", "computer-api", "claude-settings", "codex-config"];

test("the CLI's files import only node built-ins and each other, so they run before bun install", () => {
  const allowed = new RegExp(`^(node:[a-z_/]+|\\./(${CLI_FILES.join("|")}))$`);
  for (const file of CLI_FILES) {
    const imports = importSpecs(readFileSync(join(PLUGIN, "src", `${file}.ts`), "utf8"));
    if (file !== "computer-api") expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(allowed);
  }
});

test("the plugin declares no Claude Code channel anywhere", () => {
  const src = join(PLUGIN, "src");
  for (const file of srcFiles()) {
    expect(readFileSync(join(src, file), "utf8")).not.toContain("claude/channel");
  }
  expect(readFileSync(join(PLUGIN, ".mcp.json"), "utf8")).not.toContain("PERMISSION_RELAY");
});
