import { PorticoError } from "./errors";

/**
 * A name with look-alikes folded together: hyphens dropped, 0 read as o, 1 and i as l, rn as m, vv as w. Two names
 * with one key read the same at a glance, so only one of them can exist where the two could be confused: handles on a
 * Portico server, agent names and computer names within one person.
 */
export function nameKey(name: string): string {
  return name.replace(/-/g, "").replace(/0/g, "o").replace(/[1i]/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");
}

/**
 * Words an agent or a computer can't be named: they read as Portico itself, as everyone at once, or as a part of an
 * address, so a message "from system" or "to all" would look like something it isn't.
 */
const RESERVED_NAMES = ["admin", "all", "anyone", "everyone", "me", "none", "null", "owner", "portico", "self", "system", "undefined"];
const RESERVED_NAME_KEYS = new Set(RESERVED_NAMES.map(nameKey));

/** Whether the name reads as one of the reserved words. */
export function isReservedName(name: string): boolean {
  return RESERVED_NAME_KEYS.has(nameKey(name));
}

/** Refuses a reserved word as an agent's name. */
export function requireUnreservedName(name: string): void {
  if (isReservedName(name)) throw new PorticoError("conflict", `The name ${name} is reserved: the name reads as Portico's own word. Pick another name.`);
}

/**
 * Cyrillic and Greek letters that are drawn like a Latin one, lowercase: a name written with one reads as the Latin
 * name. Not every confusable there is, only the letters that pass at a glance in an ordinary font.
 */
const LATIN_TWINS: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0443": "y", "\u0445": "x", "\u0456": "i", "\u0458": "j",
  "\u0455": "s", "\u04bb": "h", "\u0501": "d", "\u043a": "k", "\u043c": "m", "\u0442": "t", "\u043d": "h", "\u0432": "b",
  "\u03b1": "a", "\u03bf": "o", "\u03bd": "v", "\u03c1": "p", "\u03b9": "i", "\u03ba": "k", "\u03c4": "t", "\u03c5": "u", "\u03b5": "e", "\u03c7": "x",
};

/**
 * A Portico's name, or a person's, folded for comparing: compatibility forms and accents dropped, case and spacing
 * ignored, typographic apostrophes read as plain ones, Cyrillic and Greek look-alikes read as the Latin letter, then
 * the same look-alike folding as handles.
 */
export function titleKey(name: string): string {
  const plain = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/\p{Cf}/gu, "")
    .toLowerCase()
    .replace(/[\u0400-\u04ff\u0370-\u03ff]/g, (ch) => LATIN_TWINS[ch] ?? ch)
    .replace(/[\u2018\u2019\u02bc`\u00b4]/g, "'")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim()
    .replace(/^the /, "");
  return nameKey(plain.replace(/ /g, ""));
}

/**
 * The names a Portico can't be given, whatever else exists: the forms Portico itself uses for a Portico nobody named.
 * "Chris's Portico" is how everyone reads a person's own, "Personal Portico" how its owner does, "Shared Portico" and
 * "Chris's shared Portico" the shared one every person starts with, and "A Portico" what is
 * left when its owner is gone.
 */
export function posesAsOwnPortico(name: string): boolean {
  const key = titleKey(name);
  const ends = (suffix: string) => key.endsWith(titleKey(suffix));
  return (
    key === titleKey("Your Portico") ||
    key === titleKey("Personal Portico") ||
    key === titleKey("Personal") ||
    key === titleKey("Shared Portico") ||
    key === titleKey("Shared") ||
    key === titleKey("A shared Portico") ||
    key === titleKey("A Portico") ||
    key === titleKey("A new Portico") ||
    key === titleKey("Portico") ||
    key === titleKey("My Portico") ||
    ends("'s Portico") ||
    ends("'s shared Portico") ||
    ends("s' shared Portico") ||
    ends("'s new Portico") ||
    ends("s' Portico")
  );
}
