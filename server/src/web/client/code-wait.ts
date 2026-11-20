// Browser code for the page that shows a join code (/c/<id>): asks every few seconds whether the join finished, and
// shows the page again once the request is no longer waiting for the code, so "Nothing has joined yet" never stays up
// after the agent joined. Stops when the tab is hidden, and for good when the request can't be read.
const id = location.pathname.split("/").filter(Boolean)[1];

async function check(): Promise<void> {
  if (document.hidden) return void setTimeout(() => void check(), 3000);
  try {
    const res = await fetch(`/api/consents/${id}`, { headers: { accept: "application/json" } });
    if (!res.ok) return;
    const { status } = (await res.json()) as { status: string };
    if (status !== "allowed") return location.reload();
  } catch {
    // Offline for a moment: ask again.
  }
  setTimeout(() => void check(), 3000);
}

if (id) setTimeout(() => void check(), 3000);

// One click copies the code. The button says so for a moment, then goes back.
for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-copy]")) {
  const label = button.textContent ?? "";
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy ?? "");
      button.textContent = button.dataset.copied ?? "Copied";
    } catch {
      button.textContent = "Select the code to copy";
    }
    setTimeout(() => (button.textContent = label), 2000);
  });
}

export {};
