#!/usr/bin/env bun
// For local development only: seeds a Portico database so pages can be tried in a browser.
// Usage: bun server/scripts/dev-seed.ts <database path> [--port 8790] [--demo]
// Creates the owner (Chris) if missing, marks setup done, and prints a sign-in cookie for each person. With --demo,
// adds a member (Maya), computers, sessions, apps and threads like the design canvas, including a held message.
// Run it before starting the server on the same database.
import { hashPassword } from "../src/core/accounts";
import { openDb } from "../src/db";
import { captureLogs } from "../src/log";
import { createPortico } from "../src/portico";

const args = process.argv.slice(2);
const dbPath = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg));
if (!dbPath) {
  console.error("Usage: bun server/scripts/dev-seed.ts <database path> [--port 8790] [--demo]");
  process.exit(1);
}
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 8790;
const publicUrl = `http://localhost:${port}`;
const PASSWORD = "portico-dev-password";
captureLogs(() => {});

const p = createPortico(
  { port, dbPath, dataDir: ".", pluginSource: null, publicUrl, signingKey: "0".repeat(64) },
  { db: openDb(dbPath) },
);
p.settings.set("public_url", publicUrl);
p.settings.set("setup_done_at", p.settings.get("setup_done_at") ?? new Date().toISOString());
const hash = await hashPassword(PASSWORD);
const chris = p.people.owner() ?? p.people.create({ name: "Chris", role: "owner", status: "active", passwordHash: hash });

if (args.includes("--demo") && !p.people.byName("Maya Okafor")) {
  const maya = p.people.create({ name: "Maya Okafor", role: "member", status: "active", passwordHash: hash });
  const { computer: macbook } = p.computers.create(chris.id, "macbook");
  const { computer: studio } = p.computers.create(chris.id, "studio");
  const { computer: linux } = p.computers.create(maya.id, "maya-linux");
  const session = (computer: typeof macbook, repo: string, key: string) =>
    p.agents.registerSession(computer, { key, repo, folderId: key.padEnd(64, "0").replace(/[^a-f0-9]/g, "a").slice(0, 64) }).agent;
  const dialog = session(macbook, "dialog", "dialogmac");
  const api = session(macbook, "api", "apimac00");
  session(macbook, "portico", "porticomac");
  session(studio, "dialog", "dialogstudio");
  session(studio, "web", "webstudio");
  session(linux, "portico", "porticolinux");
  const app = (owner: string, name: string, kind: "muse" | "grok-bot" | "claude-duet" | "dots", type: "app" | "connector" = "app") =>
    p.agents.create({ ownerId: owner, name, kind, type });
  const muse = app(chris.id, "muse", "muse");
  const grok = app(chris.id, "grok", "grok-bot");
  const duet = app(chris.id, "duet", "claude-duet", "connector");
  app(maya.id, "maya-dot", "dots", "connector");
  p.agents.update(chris.id, muse.id, { description: "Calendar, email and travel", approvalRequired: true });
  p.messages.send(grok, { to: dialog.name + "@macbook", subject: "Does the billing webhook retry on 5xx?", text: "A customer says a payment notice never arrived." });
  p.messages.send(duet, { to: "grok", subject: "Last quarter churn", text: "Can you pull last quarter churn from the billing dashboard?" });
  const first = p.messages.send(api, { to: "muse", subject: "Find a time with Sam this week", text: "Please find a time with Sam this week for the billing review." }).message;
  p.approvals.decide(chris.id, first.id, "allow_once");
  p.messages.inbox(p.agents.require(muse.id));
  p.messages.send(muse, { replyTo: first.id, subject: "Thursday 2pm confirmed", text: "Sam confirmed Thursday 2pm for the billing review. Calendar invite sent." });
  p.messages.send(api, {
    to: "muse",
    subject: "Add the migration doc link to Thursday's billing review invite",
    text: "Thanks. Please add the migration doc link to the invite: docs/billing-v2.md",
  });
}

for (const person of p.people.list()) {
  const { token } = p.accounts.startSession(person.id);
  console.log(`${person.name} (${person.role}): portico_session=${token}`);
}
console.log(`Password for everyone: ${PASSWORD}`);
// Notices run in a microtask; let them finish before closing the database.
await Bun.sleep(10);
p.db.close();
