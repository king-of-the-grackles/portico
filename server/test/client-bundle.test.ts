import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundleSource, STUB } from "../scripts/bundle-client";
import { listClientModules } from "../src/web/client-modules";
import { makePortico } from "./helpers";

describe("browser modules", () => {
  test("every module under client/ is found, without type files or hook logs", () => {
    const modules = listClientModules();
    for (const path of ["api.js", "app.js", "forms.js", "render/home.js"]) expect(modules).toContain(path);
    expect(modules.some((path) => path.includes("types.d") || path.startsWith("logs/"))).toBe(false);
  });

  test("the bundle a single-file build carries holds every module as JavaScript, and the stub is what's committed", async () => {
    const source = await bundleSource();
    const out = join(mkdtempSync(join(tmpdir(), "portico-bundle-")), "client-bundle.gen.ts");
    await Bun.write(out, source);
    const { CLIENT_BUNDLE } = (await import(out)) as { CLIENT_BUNDLE: Record<string, string> };
    expect(Object.keys(CLIENT_BUNDLE).sort()).toEqual(listClientModules());
    expect(CLIENT_BUNDLE["forms.js"]).toContain('from "./api.js"');
    expect(CLIENT_BUNDLE["forms.js"]).not.toContain(": HTMLFormElement");
    expect(await Bun.file(join(import.meta.dir, "..", "src", "web", "client-bundle.gen.ts")).text()).toBe(STUB);
  });

  test("only module-shaped paths are read: no climbing out of client/", async () => {
    const p = makePortico();
    expect((await p.app.request("/assets/render/home.js")).status).toBe(200);
    for (const path of ["/assets/..%2Fassets.js", "/assets/..%2F..%2Fcli.js", "/assets/App.js", "/assets/app.ts"]) {
      expect(`${path} ${(await p.app.request(path)).status}`).toBe(`${path} 404`);
    }
  });
});
