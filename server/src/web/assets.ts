import { createHash } from "node:crypto";
import { Hono } from "hono";
import baseCss from "./client/base.css" with { type: "text" };
import iconSvg from "./client/icon.svg" with { type: "text" };
// Browser modules are TypeScript, imported as text (so the single-file build carries them) and transpiled once when
// first served. A track adding a browser module adds one line here.
// @ts-ignore: imported as text, not as a module
import apiTs from "./client/api.ts" with { type: "text" };
// @ts-ignore: imported as text, not as a module
import formsTs from "./client/forms.ts" with { type: "text" };
// @ts-ignore: imported as text, not as a module
import inviteTs from "./client/invite.ts" with { type: "text" };
// @ts-ignore: imported as text, not as a module
import passkeyTs from "./client/passkey.ts" with { type: "text" };

type Source = { css: string } | { svg: string } | { ts: string };

/** Served at /assets/<path>. Browser modules import each other as "./name.js". */
export const ASSETS: Record<string, Source> = {
  "base.css": { css: baseCss },
  "icon.svg": { svg: iconSvg },
  "api.js": { ts: apiTs as string },
  "forms.js": { ts: formsTs as string },
  "invite.js": { ts: inviteTs as string },
  "passkey.js": { ts: passkeyTs as string },
};

const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });
const built = new Map<string, { body: string; type: string; etag: string }>();

function build(path: string): { body: string; type: string; etag: string } | null {
  const cached = built.get(path);
  if (cached) return cached;
  const source = ASSETS[path];
  if (!source) return null;
  const body = "css" in source ? source.css : "svg" in source ? source.svg : transpiler.transformSync(source.ts);
  const type =
    "css" in source ? "text/css; charset=utf-8" : "svg" in source ? "image/svg+xml" : "text/javascript; charset=utf-8";
  const asset = { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 16)}"` };
  built.set(path, asset);
  return asset;
}

/** GET /assets/*: Portico's own CSS and browser modules. */
export function assetRoutes(): Hono {
  const route = new Hono();
  route.get("/*", (c) => {
    const asset = build(c.req.path.replace(/^\/assets\//, ""));
    if (!asset) return c.text("Not found", 404);
    if (c.req.header("if-none-match") === asset.etag) return c.body(null, 304, { ETag: asset.etag });
    return c.body(asset.body, 200, { "Content-Type": asset.type, "Cache-Control": "no-cache", ETag: asset.etag });
  });
  return route;
}
