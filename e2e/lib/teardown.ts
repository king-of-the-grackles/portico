// After the run: delete the Descope users the run made, and tidy what they made on Portico. E2E_KEEP=1 skips it.
import fs from "node:fs";
import { deleteUser } from "./descope";
import { KEEP, STATE_DIR, refuseProduction, runId } from "./env";
import { personApi } from "./person";
import { type RunState, loadState, stateFile } from "./state";

/** Best effort: the dev deployment's data is disposable, so a failure here only leaves clutter. */
async function tidyPortico(state: RunState): Promise<void> {
  for (const person of Object.values(state.people)) {
    if (!person.storage) continue;
    const api = await personApi(person.storage);
    try {
      const porticos = await api.get("/api/porticos");
      for (const w of porticos.ok() ? (await porticos.json()).workspaces : []) {
        if (w.kind === "shared" && w.isOwner) await api.delete(`/api/porticos/${w.id}`);
      }
      const agents = await api.get("/api/agents");
      for (const a of agents.ok() ? (await agents.json()).agents : []) {
        if (a.mine) await api.delete(`/api/agents/${a.id}`);
      }
      await api.delete("/api/session");
    } catch {
      // Clutter only.
    } finally {
      await api.dispose();
    }
  }
}

export async function cleanRun(id: string): Promise<void> {
  const state = loadState(id);
  await tidyPortico(state);
  const failed: string[] = [];
  for (const email of state.descopeUsers) {
    await deleteUser(email).catch(() => failed.push(email));
  }
  if (failed.length > 0) throw new Error(`Could not delete Descope users: ${failed.join(", ")}. The state file stays; run ./run.sh --cleanup.`);
  fs.rmSync(stateFile(id), { force: true });
  console.log(`e2e: deleted ${state.descopeUsers.length} Descope test users of run ${id}.`);
}

/** Every run that left a state file: kept runs and runs that died before their teardown. */
export async function cleanAll(): Promise<void> {
  refuseProduction();
  const files = fs.existsSync(STATE_DIR) ? fs.readdirSync(STATE_DIR).filter((f) => f.endsWith(".json")) : [];
  for (const file of files) await cleanRun(file.replace(/\.json$/, ""));
  if (files.length === 0) console.log("e2e: nothing to clean.");
}

export default async function globalTeardown(): Promise<void> {
  if (KEEP) {
    console.log(`e2e: E2E_KEEP=1, so run ${runId()} keeps its people and agents. ./run.sh --cleanup deletes them.`);
    return;
  }
  await cleanRun(runId());
}

if (require.main === module) {
  cleanAll().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
