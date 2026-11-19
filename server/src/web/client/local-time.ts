// Browser code: shows each <time data-local-time datetime="…"> in the reader's own time zone, as 12-hour time ("5:09 PM"),
// with the day in front when the time isn't today ("Nov 22, 5:09 PM").
// The server renders the time in UTC first, so the page reads correctly before this runs.
for (const el of Array.from(document.querySelectorAll<HTMLTimeElement>("time[data-local-time]"))) {
  const at = new Date(el.dateTime);
  if (!Number.isNaN(at.getTime())) {
    const time = at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const today = at.toDateString() === new Date().toDateString();
    el.textContent = today ? time : `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
  }
}

export {};
