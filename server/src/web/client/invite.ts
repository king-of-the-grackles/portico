// Browser code for /invite. Signed out: checks the link's secret (in the fragment) and shows the claim form or a clear
// page for a link that can't be used; forms.js then posts the claim. Waiting: listens for changes and opens Home once
// the owner approves, or says the request was declined.
import { api, ApiError, firstData } from "./api.js";

type PageData = { view: "claim"; central?: boolean; signedIn?: boolean } | { view: "waiting" };
type Check = { status: "open" | "claimed" | "revoked" | "expired"; invitedBy: string; expiresAt: string };

const main = document.querySelector("main");

/** Shows one of the page's templates in place of what shows now, with the inviting person's name filled in. */
function show(templateId: string, owner = ""): void {
  const template = document.getElementById(templateId);
  if (!main || !(template instanceof HTMLTemplateElement)) return;
  const content = template.content.cloneNode(true) as DocumentFragment;
  for (const el of Array.from(content.querySelectorAll("[data-owner]"))) el.textContent = owner;
  for (const el of Array.from(main.children)) if (!(el instanceof HTMLTemplateElement)) el.remove();
  main.prepend(content);
  const title = main.querySelector("h1")?.textContent?.trim();
  if (title) document.title = title;
}

/**
 * Where the link's secret waits while the browser is away signing in, for half an hour. Kept for this address in any
 * tab, since an emailed sign-in link opens a new one; removed once the link is claimed or can't be.
 */
const KEPT_SECRET = "portico-invite";
const KEPT_MS = 30 * 60_000;

function kept(): string {
  try {
    const value = JSON.parse(localStorage.getItem(KEPT_SECRET) ?? "null") as { secret?: unknown; at?: unknown } | null;
    if (value && typeof value.secret === "string" && typeof value.at === "number" && Date.now() - value.at < KEPT_MS) return value.secret;
  } catch {
    // Nothing kept, or nothing readable.
  }
  return "";
}

function keep(secret: string): void {
  try {
    if (secret) localStorage.setItem(KEPT_SECRET, JSON.stringify({ secret, at: Date.now() }));
    else localStorage.removeItem(KEPT_SECRET);
  } catch {
    // No storage: the link has to be opened again after signing in.
  }
}

/** The secret in the link's fragment, or the one kept while the browser signed in. */
function secretFromLink(central: boolean): string {
  try {
    const secret = decodeURIComponent(location.hash.replace(/^#/, "")).trim();
    return secret || (central ? kept() : "");
  } catch {
    return "";
  }
}

async function checkLink(data: { central?: boolean; signedIn?: boolean }): Promise<void> {
  const central = Boolean(data.central);
  const secret = secretFromLink(central);
  if (!secret) return show("invite-invalid");
  try {
    const check = await api<Check>("POST", "/api/invites/check", { secret });
    if (check.status !== "open") {
      keep("");
      return show(`invite-${check.status}`, check.invitedBy);
    }
    if (central && !data.signedIn) {
      // Kept now, not on the click: the sign-in may be opened in another tab.
      keep(secret);
      show("invite-sign-in", check.invitedBy);
      return;
    }
    show("invite-claim", check.invitedBy);
    const field = document.querySelector<HTMLInputElement>("input[data-secret]");
    if (field) field.value = secret;
    // Joined: the kept secret has done its work.
    document.querySelector("form[data-api]")?.addEventListener("portico:done", () => keep(""));
    document.getElementById("join-name")?.focus();
  } catch (err) {
    show(err instanceof ApiError && err.status === 404 ? "invite-invalid" : "invite-offline");
  }
}

/** "at 10:12 AM" today, or "on Oct 27 at 10:12 AM", in the reader's own time zone. */
function showSentAt(): void {
  const when = document.querySelector<HTMLElement>("[data-when]");
  const time = when?.querySelector("time");
  if (!when || !time) return;
  const at = new Date(time.dateTime);
  if (Number.isNaN(at.getTime())) return;
  time.textContent = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const today = at.toDateString() === new Date().toDateString();
  when.replaceChildren(today ? "at " : `on ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })} at `, time);
}

function waitForApproval(): void {
  showSentAt();
  const events = new EventSource("/api/events");
  let running = false;
  let again = false;
  // One check at a time; a change that lands mid-check runs one more, so an approval is never missed.
  const check = async (): Promise<void> => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      const { person } = await api<{ person: { status: string } }>("GET", "/api/me");
      if (person.status === "active") {
        events.close();
        location.assign("/?welcome");
      }
    } catch (err) {
      // Signed out means the claim was declined (or the person removed). Anything else is a dropped connection.
      if (err instanceof ApiError && err.status === 401) {
        events.close();
        show("invite-declined");
      }
    } finally {
      running = false;
      if (again) {
        again = false;
        void check();
      }
    }
  };
  events.addEventListener("hello", () => void check());
  events.addEventListener("changed", (event) => {
    let topics: string[] = [];
    try {
      topics = (JSON.parse((event as MessageEvent<string>).data) as { topics?: string[] }).topics ?? [];
    } catch {
      return;
    }
    if (topics.includes("me") || topics.includes("people")) void check();
  });
  events.addEventListener("error", () => void check());
}

const data = firstData<PageData>();
if (data?.view === "waiting") waitForApproval();
else if (data?.view === "claim") {
  void checkLink(data);
  window.addEventListener("hashchange", () => void checkLink(data));
}
