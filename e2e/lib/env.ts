// Where the suite runs and with which credentials. Everything comes from the environment (run.sh fills it in).
import fs from "node:fs";
import path from "node:path";

const PRODUCTION_HOSTS = new Set(["portico.chat", "www.portico.chat", "app.portico.chat"]);

export const BASE_URL = (process.env.E2E_BASE_URL || "https://dev.portico.chat").replace(/\/+$/, "");

/** The production guard: called from the config, so nothing starts against production. */
export function refuseProduction(): void {
  const host = new URL(BASE_URL).hostname.toLowerCase();
  if (PRODUCTION_HOSTS.has(host)) throw new Error(`E2E_BASE_URL points at production (${host}). This suite makes people, agents and messages: it never runs there.`);
}

export function descopeCredentials(): { projectId: string; managementKey: string } {
  const projectId = process.env.DESCOPE_PROJECT_ID;
  const managementKey = process.env.DESCOPE_MANAGEMENT_KEY;
  if (!projectId || !managementKey) throw new Error("DESCOPE_PROJECT_ID and DESCOPE_MANAGEMENT_KEY must be set (./run.sh loads them from ~/.descope/projects.json).");
  return { projectId, managementKey };
}

export const STATE_DIR = path.join(__dirname, "..", ".state");
/** Keep people and agents after the run and use them again next time: fewer joins against the per-address limit. */
export const KEEP = process.env.E2E_KEEP === "1";

// No letters or digits that read alike (l/1, o/0): Portico refuses a handle that reads like one in use.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export function nonce(length = 5): string {
  return Array.from({ length }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
}

/**
 * One ID per run, in every test person's address and handle. Set once in the main process and inherited by workers.
 * With E2E_KEEP=1 the last kept run's ID is taken up again.
 */
export function runId(): string {
  if (!process.env.E2E_RUN_ID) {
    const kept = KEEP && fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")).sort((a, b) => fs.statSync(path.join(STATE_DIR, b)).mtimeMs - fs.statSync(path.join(STATE_DIR, a)).mtimeMs)[0] : undefined;
    process.env.E2E_RUN_ID = kept ? kept.replace(/\.json$/, "") : nonce();
  }
  return process.env.E2E_RUN_ID;
}
