// Browser code for standalone pages (setup, sign in, invites, consent). A form with data-api posts its fields as JSON
// to the person API: data-api="POST /api/session". On success the page goes to data-next, or to the answer's `next`,
// or reloads. On failure the message shows in the form's [data-error] element.
import { api, ApiError } from "./api.js";

function fields(form: HTMLFormElement): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const el of Array.from(form.elements)) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)) continue;
    if (!el.name || el.disabled) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") body[el.name] = el.checked;
    else if (el instanceof HTMLInputElement && el.type === "radio") {
      if (el.checked) body[el.name] = el.value;
    } else body[el.name] = el.value;
  }
  // Secrets ride in the link's fragment, which browsers never send: fields marked data-fragment take it from there.
  for (const el of Array.from(form.querySelectorAll<HTMLInputElement>("input[data-fragment]"))) {
    body[el.name] = decodeURIComponent(location.hash.replace(/^#/, ""));
  }
  return body;
}

async function submit(form: HTMLFormElement): Promise<void> {
  const [method, path] = (form.dataset.api ?? "").split(" ");
  if (!method || !path) return;
  const error = form.querySelector<HTMLElement>("[data-error]");
  const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
  if (error) error.hidden = true;
  if (button) button.disabled = true;
  try {
    const answer = (await api<{ next?: unknown } | null>(method, path, fields(form))) ?? {};
    const next = form.dataset.next ?? (typeof answer.next === "string" ? answer.next : null);
    if (next) location.assign(next);
    else location.reload();
  } catch (err) {
    if (error) {
      error.textContent = err instanceof ApiError ? err.message : "Something went wrong. Try again.";
      error.hidden = false;
    }
    if (button) button.disabled = false;
  }
}

document.addEventListener("submit", (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement) || !form.dataset.api) return;
  event.preventDefault();
  void submit(form);
});
