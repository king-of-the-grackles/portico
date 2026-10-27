import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { CLIENT_BUNDLE } from "./client-bundle.gen";
import { CLIENT_DIR, MODULE_PATH, transpileClient } from "./client-modules";
import baseCss from "./client/base.css" with { type: "text" };
import iconSvg from "./client/icon.svg" with { type: "text" };
import appCss from "./client/app.css" with { type: "text" };
import iconClaudeCode from "./client/icons/claude-code.svg" with { type: "text" };
import iconCodex from "./client/icons/codex.svg" with { type: "text" };
import iconMuse from "./client/icons/muse.svg" with { type: "text" };
import iconGrokBot from "./client/icons/grok-bot.svg" with { type: "text" };
import iconDots from "./client/icons/dots.svg" with { type: "text" };
import iconClaudeDuet from "./client/icons/claude-duet.svg" with { type: "text" };
import iconOther from "./client/icons/other.svg" with { type: "text" };
import onboardingCss from "./client/onboarding.css" with { type: "text" };

type Source = { css: string } | { svg: string };

/**
 * Styles and images served at /assets/<path>, imported as text so the single-file build carries them. Browser modules
 * (the TypeScript files under client/) need no entry here: they're served as /assets/<name>.js (see moduleSource).
 */
export const ASSETS: Record<string, Source> = {
  "base.css": { css: baseCss },
  "icon.svg": { svg: iconSvg },
  "app.css": { css: appCss },
  "icons/claude-code.svg": { svg: iconClaudeCode },
  "icons/codex.svg": { svg: iconCodex },
  "icons/muse.svg": { svg: iconMuse },
  "icons/grok-bot.svg": { svg: iconGrokBot },
  "icons/dots.svg": { svg: iconDots },
  "icons/claude-duet.svg": { svg: iconClaudeDuet },
  "icons/other.svg": { svg: iconOther },
  "onboarding.css": { css: onboardingCss },
};

const built = new Map<string, { body: string; type: string; etag: string }>();

/**
 * A browser module's JavaScript: from the bundle a single-file build carries, or else transpiled from its TypeScript
 * under client/. The same file can't be both imported as code (pages render with it) and as text in one build.
 */
async function moduleSource(path: string): Promise<string | null> {
  if (!MODULE_PATH.test(path)) return null;
  if (CLIENT_BUNDLE) return CLIENT_BUNDLE[path] ?? null;
  const file = join(CLIENT_DIR, path.replace(/\.js$/, ".ts"));
  return existsSync(file) ? transpileClient(await Bun.file(file).text()) : null;
}

async function build(path: string): Promise<{ body: string; type: string; etag: string } | null> {
  const cached = built.get(path);
  if (cached) return cached;
  const source = ASSETS[path];
  let body: string;
  let type: string;
  if (source) {
    body = "css" in source ? source.css : source.svg;
    type = "css" in source ? "text/css; charset=utf-8" : "image/svg+xml";
  } else {
    const js = await moduleSource(path);
    if (js === null) return null;
    body = js;
    type = "text/javascript; charset=utf-8";
  }
  const asset = { body, type, etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 16)}"` };
  built.set(path, asset);
  return asset;
}

/** GET /assets/*: Portico's own CSS and browser modules. */
export function assetRoutes(): Hono {
  const route = new Hono();
  route.get("/*", async (c) => {
    const asset = await build(c.req.path.replace(/^\/assets\//, ""));
    if (!asset) return c.text("Not found", 404);
    if (c.req.header("if-none-match") === asset.etag) return c.body(null, 304, { ETag: asset.etag });
    return c.body(asset.body, 200, { "Content-Type": asset.type, "Cache-Control": "no-cache", ETag: asset.etag });
  });
  return route;
}
