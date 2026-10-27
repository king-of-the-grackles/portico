export const ALLOWED_PLACEHOLDERS: readonly string[] = ["event.agent", "event.name", "event.details"];

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

// Matches any {{…}}, so placeholders renderTemplate can't fill (like "{{ x | y }}") are reported, not left in the text.
const ANY_PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

export function unknownPlaceholders(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(ANY_PLACEHOLDER)) {
    const key = match[1]!.trim();
    if (!ALLOWED_PLACEHOLDERS.includes(key)) found.add(key);
  }
  return [...found];
}

export function renderTemplate(
  template: string,
  event: { agent: string; name: string; details: string },
): string {
  // A replacer function (not a string) so "$" in details is never treated as a pattern.
  return template.replace(PLACEHOLDER, (whole: string, key: string) => {
    switch (key) {
      case "event.agent":
        return event.agent;
      case "event.name":
        return event.name;
      case "event.details":
        return event.details;
      default:
        return whole;
    }
  });
}
