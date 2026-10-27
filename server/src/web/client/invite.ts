// Browser code for /invite. Signed out: checks the link's secret (in the fragment) and shows the claim form or a clear
// page for a link that can't be used; forms.js then posts the claim. Waiting: listens for changes and opens Home once
// the owner approves, or says the request was declined.
import { api, ApiError, firstData } from "./api.js";

type PageData = { view: "claim" } | { view: "waiting" };
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

function secretFromLink(): string {
  try {
    return decodeURIComponent(location.hash.replace(/^#/, "")).trim();
  } catch {
    return "";
  }
}

async function checkLink(): Promise<void> {
  const secret = secretFromLink();
  if (!secret) return show("invite-invalid");
  try {
    const check = await api<Check>("POST", "/api/invites/check", { secret });
    show(check.status === "open" ? "invite-claim" : `invite-${check.status}`, check.invitedBy);
    if (check.status === "open") document.getElementById("join-name")?.focus();
  } catch (err) {
    show(err instanceof ApiError && err.status === 404 ? "invite-invalid" : "invite-offline");
  }
}

/** "at 10:12" today, or "on Oct 27 at 10:12", in the reader's own time zone. */
function showSentAt(): void {
  const when = document.querySelector<HTMLElement>("[data-when]");
  const time = when?.querySelector("time");
  if (!when || !time) return;
  const at = new Date(time.dateTime);
  if (Number.isNaN(at.getTime())) return;
  time.textContent = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const today = at.toDateString() === new Date().toDateString();
  when.replaceChildren(today ? "at " : `on ${at.toLocaleDateString([], { month: "short", day: "numeric" })} at `, time);
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
  void checkLink();
  window.addEventListener("hashchange", () => void checkLink());
}
