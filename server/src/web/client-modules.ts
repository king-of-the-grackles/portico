import { readdirSync } from "node:fs";
import { join } from "node:path";

/** Where the browser modules live, when running from source. */
export const CLIENT_DIR = join(import.meta.dir, "client");

/** A served browser module path: lowercase names, folders allowed, ending in .js. */
export const MODULE_PATH = /^[a-z0-9-]+(\/[a-z0-9-]+)*\.js$/;

/** Every browser module under the folder, as served paths ("api.js", "render/home.js"). */
export function listClientModules(dir: string = CLIENT_DIR): string[] {
  const found: string[] = [];
  const walk = (sub: string) => {
    for (const entry of readdirSync(join(dir, sub), { withFileTypes: true })) {
      const rel = sub ? `${sub}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "logs") walk(rel);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
        found.push(rel.replace(/\.ts$/, ".js"));
      }
    }
  };
  walk("");
  return found.filter((path) => MODULE_PATH.test(path)).sort();
}

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

/** A browser module's TypeScript as the JavaScript the browser loads. */
export function transpileClient(source: string): string {
  return transpiler.transformSync(source);
}
