import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { SERVER_VERSION } from "../src/plugin";

const ROOT = join(import.meta.dir, "../..");
const PLUGIN = join(ROOT, "plugin-claude-code");
const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("marketplace, manifest, package and server agree on the name and version", () => {
  const marketplace = json(join(ROOT, ".claude-plugin/marketplace.json"));
  const manifest = json(join(PLUGIN, ".claude-plugin/plugin.json"));
  const pkg = json(join(PLUGIN, "package.json"));
  expect(marketplace.name).toBe("agent-bridge");
  expect(marketplace.plugins).toEqual([expect.objectContaining({ name: "agent-bridge", source: "./plugin-claude-code" })]);
  expect(manifest.name).toBe("agent-bridge");
  expect(manifest.version).toBe(pkg.version);
  expect(SERVER_VERSION).toBe(pkg.version);
});

test(".mcp.json starts the server from the plugin folder and passes the three settings through", () => {
  expect(json(join(PLUGIN, ".mcp.json"))).toEqual({
    mcpServers: {
      bridge: {
        command: "bun",
        args: ["run", "--cwd", "${CLAUDE_PLUGIN_ROOT}", "--shell=bun", "--silent", "start"],
        env: {
          BRIDGE_URL: "${BRIDGE_URL}",
          BRIDGE_TOKEN: "${BRIDGE_TOKEN}",
          BRIDGE_PERMISSION_RELAY: "${BRIDGE_PERMISSION_RELAY:-on}",
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
