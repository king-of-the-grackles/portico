#!/usr/bin/env bun
// For local development only: seeds a Portico database so pages can be tried in a browser.
// Usage: bun server/scripts/dev-seed.ts <database path> [--port 8790]
// Creates an owner if missing, marks setup done, and prints a sign-in cookie for each person, so the setup page can be
// skipped. Run it before starting the server on the same database.
import { hashPassword } from "../src/core/accounts";
import { openDb } from "../src/db";
import { captureLogs } from "../src/log";
import { createPortico } from "../src/portico";

const args = process.argv.slice(2);
const dbPath = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg));
if (!dbPath) {
  console.error("Usage: bun server/scripts/dev-seed.ts <database path> [--port 8790]");
  process.exit(1);
}
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8790;
const publicUrl = `http://localhost:${port}`;
const PASSWORD = "portico-dev-password";
captureLogs(() => {});

const p = createPortico(
  { port, dbPath, dataDir: ".", pluginSource: null, publicUrl, signingKey: "0".repeat(64), webhooksAllowPrivate: false },
  { db: openDb(dbPath) },
);
p.settings.set("public_url", publicUrl);
p.settings.set("setup_done_at", p.settings.get("setup_done_at") ?? new Date().toISOString());
const hash = await hashPassword(PASSWORD);
p.people.owner() ?? p.people.create({ name: "Owner", role: "owner", status: "active", passwordHash: hash });

for (const person of p.people.list()) {
  const { token } = p.accounts.startSession(person.id);
  console.log(`${person.name} (${person.role}): portico_session=${token}`);
}
console.log(`Password for everyone: ${PASSWORD}`);
// Notices run in a microtask; let them finish before closing the database.
await Bun.sleep(10);
p.db.close();
