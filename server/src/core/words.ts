/** Names as prose: "a", "a and b", "a, b and c". */
export function listOf(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Lowercase ASCII letters and digits, with every other run turned into one hyphen and accents dropped, at most 40
 * characters; `fallback` when nothing is left.
 */
export function slugify(raw: string, fallback: string): string {
  const slug = raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return slug || fallback;
}
