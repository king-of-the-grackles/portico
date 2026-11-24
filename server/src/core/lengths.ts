import { log } from "../log";
import { PorticoError } from "./errors";

/** A text's length as every limit counts characters: Unicode code points. */
export function charCount(text: string): number {
  return Array.from(text).length;
}

/**
 * The refusal for a field over a limit: the field, the length and the limit in one line. Each one is logged as
 * `limit_hit` with the field, the limit and the length, never the text.
 */
export function tooLong(field: string, limit: number, length: number): PorticoError {
  log("info", "limit_hit", { field, limit, length, action: "refused" });
  return new PorticoError("bad_request", `${field} is ${length} characters; the limit is ${limit}.`);
}

/** Throws `tooLong` when the text is over the limit. */
export function checkLength(field: string, text: string, limit: number): void {
  const length = charCount(text);
  if (length > limit) throw tooLong(field, limit, length);
}

const ELLIPSIS = "…";
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * A one-line text cut to fit a limit, ellipsis included. The cut falls after the last whole word that fits, as long as
 * at least half the room stays filled; with no such word boundary the cut is hard, between two characters as a reader
 * sees them, so no emoji or accented letter is split. `originalLength` is null when the text already fit.
 */
export function trimToLimit(text: string, limit: number): { text: string; originalLength: number | null } {
  const length = charCount(text);
  if (length <= limit) return { text, originalLength: null };
  const room = limit - charCount(ELLIPSIS);
  let head = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    const size = charCount(segment);
    if (used + size > room) break;
    head += segment;
    used += size;
  }
  // When the next character is a space, the head already ends with a whole word.
  if (!/^\s/.test(text.slice(head.length))) {
    const lastSpace = head.search(/\s+\S*$/);
    if (lastSpace >= 0 && charCount(head.slice(0, lastSpace)) >= room / 2) head = head.slice(0, lastSpace);
  }
  return { text: head.trimEnd() + ELLIPSIS, originalLength: length };
}

/**
 * `trimToLimit` for a field of a message: a text over the limit is trimmed, logged as `limit_hit`, and a sentence for
 * the sender, with the original length, is added to `notes`.
 */
export function trimField(field: string, text: string, limit: number, notes?: string[]): string {
  const trimmed = trimToLimit(text, limit);
  if (trimmed.originalLength === null) return text;
  log("info", "limit_hit", { field, limit, length: trimmed.originalLength, action: "trimmed" });
  notes?.push(
    `The ${field} was ${trimmed.originalLength} characters and the limit is ${limit}, so Portico saved the ${field} ` +
      `trimmed to ${charCount(trimmed.text)} characters.`,
  );
  return trimmed.text;
}
