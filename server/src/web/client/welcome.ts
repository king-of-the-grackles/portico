// Browser code for the handle field: says, while typing, whether the handle is free.
import { api } from "./api.js";

const field = document.querySelector<HTMLInputElement>("input[data-handle]");
const note = document.querySelector<HTMLElement>("[data-handle-note]");
const rules = note?.textContent ?? "";
let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;

async function check(): Promise<void> {
  if (!field || !note) return;
  const value = field.value.trim().toLowerCase();
  if (value === "") {
    note.textContent = rules;
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

field?.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(() => void check(), 250);
});
void check();
