// What one run made, kept in e2e/.state/<run id>.json: the people (with their browser sessions) and the agents (with
// their tokens). A worker that restarts after a failed test reads it back instead of joining again, and the teardown
// reads it to delete what the run made. The folder is git-ignored: it holds dev credentials.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR, runId } from "./env";

export interface StoredPerson {
  role: string;
  email: string;
  name: string;
  /** Null until the person picked one. */
  handle: string | null;
  /** Playwright storage state holding the portico_session cookie; null until signed in. */
  storage: any | null;
}

export interface StoredAgent {
  owner: string;
  name: string;
  token: string;
}

export interface RunState {
  runId: string;
  /** Every Descope login ID the run made, whether or not the person got any further. */
  descopeUsers: string[];
  people: Record<string, StoredPerson>;
  agents: Record<string, StoredAgent>;
  /** The Portico alice shares with bob, once a spec or helper made it. */
  shared: { id: string; name: string } | null;
  /** Whether alice and bob have each allowed the other's agents (first contact). */
  introduced?: boolean;
}

export const stateFile = (id = runId()) => path.join(STATE_DIR, `${id}.json`);

export function loadState(id = runId()): RunState {
  try {
    return JSON.parse(fs.readFileSync(stateFile(id), "utf8"));
  } catch {
    return { runId: id, descopeUsers: [], people: {}, agents: {}, shared: null };
  }
}

export function saveState(state: RunState): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(stateFile(state.runId), JSON.stringify(state, null, 2), { mode: 0o600 });
}
