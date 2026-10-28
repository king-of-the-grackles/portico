// Browser code: shows each <time data-local-time datetime="…"> in the reader's own time zone, as 12-hour time ("5:09 PM").
// The server renders the time in UTC first, so the page reads correctly before this runs.
for (const el of Array.from(document.querySelectorAll<HTMLTimeElement>("time[data-local-time]"))) {
  const at = new Date(el.dateTime);
  if (!Number.isNaN(at.getTime())) {
    el.textContent = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

export {};
