// Browser code for the name and handle fields a new person fills in: offers a handle from the name as it is typed, until
// the person types a handle of their own, and says whether the handle is free.
import { api } from "./api.js";

const field = document.querySelector<HTMLInputElement>("input[data-handle]");
const nameField = document.querySelector<HTMLInputElement>("input[data-person-name]");
const note = document.querySelector<HTMLElement>("[data-handle-note]");
const rules = note?.textContent ?? "";
let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;
/** The handle is still the one offered (or empty): a new name offers a new one. */
let offered = field ? field.value : "";

async function check(): Promise<void> {
  if (!field || !note) return;
  const value = field.value.trim().toLowerCase();
  if (value === "") {
    note.textContent = rules;
    note.style.color = "";
    return;
  }
  const mine = ++asked;
  try {
    const answer = await api<{ free: boolean; message: string }>("GET", `/api/handles/check?handle=${encodeURIComponent(value)}`);
    // A slower answer to an earlier keystroke never replaces a later one.
    if (mine !== asked || !answer) return;
    note.textContent = answer.message;
    note.style.color = answer.free ? "" : "var(--danger, #a3261f)";
  } catch {
    note.textContent = rules;
  }
}

async function offer(): Promise<void> {
  if (!field || !nameField || field.value !== offered) return;
  const typed = nameField.value;
  try {
    const answer = await api<{ handle: string }>("GET", `/api/handles/suggest?name=${encodeURIComponent(typed)}`);
    if (!answer || nameField.value !== typed || field.value !== offered) return;
    field.value = answer.handle;
    offered = answer.handle;
    void check();
  } catch {
    // No offer this time: the person types a handle.
  }
}

field?.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void check(), 250);
});
let nameTimer: ReturnType<typeof setTimeout> | undefined;
nameField?.addEventListener("input", () => {
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => void offer(), 250);
});
void check();
