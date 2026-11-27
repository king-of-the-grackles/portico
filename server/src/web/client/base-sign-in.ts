// Browser code for the sign-in page where people sign in with Descope. Descope's component runs the sign-in; when it
// finishes, Portico checks the result once (POST /api/session), sets its own cookie, and the page goes on to `next`.
import { api, ApiError, firstData } from "./api.js";

/**
 * Where to go afterwards, kept for ten minutes: a sign-in with Google leaves the page and comes back, and an emailed
 * link opens in another tab.
 */
const KEPT_NEXT = "portico-next";
const KEPT_MS = 10 * 60_000;

/** The page that was kept to go to. */
function kept(): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEPT_NEXT) ?? "null") as { next?: unknown; at?: unknown } | null;
    if (value && typeof value.next === "string" && typeof value.at === "number" && Date.now() - value.at < KEPT_MS) return value.next;
  } catch {
    // Nothing kept, or nothing readable.
  }
  return null;
}

const data = firstData<{ next: string | null }>();
let next = data?.next ?? null;
try {
  if (next !== null) localStorage.setItem(KEPT_NEXT, JSON.stringify({ next, at: Date.now() }));
} catch {
  // No storage: a sign-in that leaves the page lands on the first page.
}
next ??= kept() ?? "/";

const error = document.querySelector<HTMLElement>("[data-error]");
const fail = (message: string) => {
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
};

const flow = document.querySelector("descope-wc");

/**
 * Where analytics is on, the page carries analytics.js: its anonymous ID goes along, so Portico can tie the visit
 * before sign-in to the person. Anywhere else, and whenever that module fails, nothing is added.
 */
async function visit(): Promise<{ anon_id?: string }> {
  if (!document.querySelector('script[src="/assets/analytics.js"]')) return {};
  try {
    const { anonId } = (await import("./analytics.js")) as { anonId: () => string | null };
    const id = anonId();
    return id === null ? {} : { anon_id: id };
  } catch {
    return {};
  }
}

flow?.addEventListener("success", (event) => {
  const token = (event as CustomEvent<{ sessionJwt?: string }>).detail?.sessionJwt;
  void (async () => {
    try {
      const answer = await api<{ next: string }>("POST", "/api/session", { token, next, ...(await visit()) });
      try {
        // Portico's own cookie carries the sign-in from here: what Descope's component kept is no longer needed.
        localStorage.removeItem(KEPT_NEXT);
        // Portico has been told which visit this was (see analytics.ts): the visit's ID is done.
        localStorage.removeItem("portico-anon");
        for (const key of ["DS", "DSR", "DSI"]) localStorage.removeItem(key);
      } catch {
        // Nothing to clear.
      }
      location.assign(answer.next);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "Something went wrong. Reload the page and try again.");
    }
  })();
});

flow?.addEventListener("error", () => fail("Sign-in didn't finish. Reload the page and try again."));
