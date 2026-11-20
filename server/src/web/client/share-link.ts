// Browser code for /share: the page a share link opens. The link's secret is in the fragment, which the browser never
// sends, so this reads it, asks Portico what the link is for, and shows a person one button: Join <the Portico>. A person
// who isn't signed in signs in (or up) first and comes back here; the secret waits in this browser meanwhile.
import { api, ApiError } from "./api.js";

interface Preview {
  portico: string;
  by: string;
  signedIn: boolean;
  me?: string;
  ready?: boolean;
  forMe?: boolean;
  already?: boolean;
  workspaceId?: string | null;
  agents?: { id: string; label: string }[];
}

const KEPT = "portico.share";
const box = document.querySelector<HTMLElement>("[data-invite]");
const steps = document.querySelector<HTMLDetailsElement>("[data-steps]");
const part = (name: string) => box?.querySelector<HTMLElement>(`[data-invite-${name}]`) ?? null;

/** The secret from the address, or the one kept while the person signed in (for a quarter of an hour at most). */
function secret(): string | null {
  const fromHash = location.hash.replace(/^#/, "");
  if (fromHash) return fromHash;
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT) ?? "null") as { secret?: string; at?: number } | null;
    localStorage.removeItem(KEPT);
    if (kept?.secret && typeof kept.at === "number" && Date.now() - kept.at < 15 * 60 * 1000) {
      history.replaceState(null, "", `#${kept.secret}`);
      return kept.secret;
    }
  } catch {
    // Nothing kept, or storage is off.
  }
  return null;
}

function fail(text: string): void {
  const error = part("error");
  if (!error) return;
  error.textContent = text;
  error.hidden = false;
}

async function start(): Promise<void> {
  const s = secret();
  if (!box || !s) return;
  const link = `${location.origin}/share#${s}`;
  let preview: Preview;
  try {
    preview = await api<Preview>("POST", "/api/share-links/preview", { link });
  } catch (err) {
    box.hidden = false;
    part("title")!.textContent = "This link doesn't work";
    part("by")!.textContent = err instanceof ApiError ? err.message : "Try again in a moment.";
    part("what")!.hidden = true;
    part("join")!.hidden = true;
    return;
  }
  // A person reads the short page: the steps for agents fold away.
  if (steps) steps.open = false;
  box.hidden = false;
  document.title = `Join ${preview.portico}`;
  part("title")!.textContent = `Join ${preview.portico}`;
  part("by")!.textContent = preview.by ? `${preview.by} invited you.` : "";
  const join = part("join") as HTMLButtonElement;
  const note = part("note")!;
  join.textContent = `Join ${preview.portico}`;

  if (!preview.signedIn || !preview.ready) {
    // Not signed in, or signed up a moment ago with the name step still to do: both come back here afterwards.
    note.textContent = preview.signedIn ? "One step first: your name." : "Sign in first. New here? Signing in creates your account.";
    join.addEventListener("click", () => {
      try {
        localStorage.setItem(KEPT, JSON.stringify({ secret: s, at: Date.now() }));
      } catch {
        // Storage is off: the person opens the link again after signing in.
      }
      location.assign(preview.signedIn ? "/welcome?next=%2Fshare" : "/sign-in?next=%2Fshare");
    });
    return;
  }
  if (preview.already && preview.workspaceId) {
    note.textContent = `Signed in as ${preview.me ?? ""}. Already in ${preview.portico}.`;
    join.textContent = `Open ${preview.portico}`;
    join.addEventListener("click", () => location.assign(`/p/${encodeURIComponent(preview.workspaceId!)}`));
    return;
  }
  if (!preview.forMe) {
    join.hidden = true;
    fail(`This invite is for another email address. Signed in as ${preview.me ?? ""}.`);
    return;
  }
  note.textContent = `Signed in as ${preview.me ?? ""}.`;
  const agents = preview.agents ?? [];
  if (agents.length > 0) {
    const ticks = part("ticks")!;
    for (const agent of agents) {
      const label = document.createElement("label");
      label.className = "tick-line";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = agent.id;
      input.checked = agents.length === 1;
      label.append(input, ` ${agent.label}`);
      ticks.append(label);
    }
    part("agents")!.hidden = false;
  }
  join.addEventListener("click", async () => {
    join.disabled = true;
    try {
      const picked = [...box.querySelectorAll<HTMLInputElement>("[data-invite-ticks] input:checked")].map((input) => input.value);
      const { workspace } = await api<{ workspace: { id: string } }>("POST", "/api/share-links/enter", { link, agents: picked });
      location.assign(`/p/${encodeURIComponent(workspace.id)}`);
    } catch (err) {
      join.disabled = false;
      fail(err instanceof ApiError ? err.message : "Something went wrong. Try again.");
    }
  });
}

void start();
