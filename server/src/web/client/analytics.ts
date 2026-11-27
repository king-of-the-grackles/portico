// Page views, reported to Portico itself (POST /api/analytics), which sends on only the page's shape. On a page only
// where analytics is on. One thing is kept in the browser: a random visit ID, in localStorage for up to 30 minutes and
// until sign-in, so a sign-in that leaves the page and comes back (Google's, an emailed link) is still the same
// visit. No cookie, no sessionStorage, nothing else. For a browser that says Do Not Track or Global Privacy Control
// nothing runs, nothing is read, and a kept ID is removed.

const ID = /^[A-Za-z0-9_.:-]{8,128}$/;
const KEPT = "portico-anon";
const KEPT_MS = 30 * 60_000;
const privacy = navigator as Navigator & { doNotTrack?: string | null; globalPrivacyControl?: boolean };
const off = privacy.doNotTrack === "1" || privacy.globalPrivacyControl === true;
const signInPage = document.querySelector('script[src="/assets/analytics.js"][data-view="sign-in"]') !== null;

const query = new URLSearchParams(location.search);

function forget(): void {
  try {
    localStorage.removeItem(KEPT);
  } catch {
    // Nothing kept.
  }
}

function kept(): string | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEPT) ?? "null") as { id?: unknown; at?: unknown } | null;
    if (value && typeof value.id === "string" && ID.test(value.id) && typeof value.at === "number" && Date.now() - value.at < KEPT_MS) return value.id;
  } catch {
    // Nothing kept, or nothing readable.
  }
  return null;
}

function keep(id: string): string {
  try {
    localStorage.setItem(KEPT, JSON.stringify({ id, at: Date.now() }));
  } catch {
    // No storage: the ID lasts for this page.
  }
  return id;
}

/**
 * The visit's ID: the one a link carries (`ph_id`), else the one kept from a moment ago, else a new one. Any page
 * with this module but the sign-in page is a signed-in one, where Portico knows the person: nothing is kept there.
 */
function visitId(): string | null {
  if (off || !signInPage) forget();
  if (off) return null;
  try {
    const carried = query.get("ph_id") ?? "";
    const id = ID.test(carried) ? carried : ((signInPage ? kept() : null) ?? crypto.randomUUID());
    return signInPage ? keep(id) : id;
  } catch {
    return null;
  }
}
const id = visitId();

/** The anonymous ID of this page's visit, for the sign-in to hand to Portico. Null when nothing is reported. */
export function anonId(): string | null {
  return id;
}

/** Campaign tags from the address as it is now, the only part of the query that is sent. */
function utm(): Record<string, string> {
  const now = new URLSearchParams(location.search);
  const tags: Record<string, string> = {};
  for (const name of ["source", "medium", "campaign", "term", "content"]) {
    const value = now.get(`utm_${name}`);
    if (value) tags[name] = value;
  }
  return tags;
}

// Never the query, the fragment or the title: an address can hold a secret, and a title a name.
function send(event: "pageview" | "sign_in_viewed"): void {
  if (id === null) return;
  try {
    void fetch("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The referrer is where this page load came from: a move within the page afterwards has none.
      body: JSON.stringify({ event, anon_id: id, path: location.pathname, referrer: moved ? "" : document.referrer, utm: utm() }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Reporting a page view never gets in the page's way.
  }
}

let seen: string | null = null;
let moved = false;
function pageview(): void {
  if (location.pathname === seen) return;
  moved = seen !== null;
  seen = location.pathname;
  send("pageview");
}

if (!off) {
  pageview();
  if (signInPage) send("sign_in_viewed");
  // The signed-in pages move between each other without loading a page.
  const pushState = history.pushState.bind(history);
  history.pushState = (...args: Parameters<History["pushState"]>) => {
    pushState(...args);
    pageview();
  };
  window.addEventListener("popstate", pageview);
}
