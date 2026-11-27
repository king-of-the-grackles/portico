// The visit ID's rule, apart from the browser so it can be tested: which ID a page load uses, and what is kept.

export const VISIT_ID = /^[A-Za-z0-9_.:-]{8,128}$/;
/** A kept ID is used for this long after it was first kept, and never longer: using it again doesn't renew it. */
export const VISIT_KEPT_MS = 30 * 60_000;

export interface KeptVisit {
  id: string;
  /** When the ID was first kept, in milliseconds. */
  at: number;
}

/** What was kept, if it is a visit ID first kept less than 30 minutes ago. */
export function readKept(raw: string | null, now: number): KeptVisit | null {
  try {
    const value = JSON.parse(raw ?? "null") as { id?: unknown; at?: unknown } | null;
    if (value && typeof value.id === "string" && VISIT_ID.test(value.id) && typeof value.at === "number" && now >= value.at && now - value.at < VISIT_KEPT_MS) {
      return { id: value.id, at: value.at };
    }
  } catch {
    // Nothing kept, or nothing readable.
  }
  return null;
}

/**
 * The visit for this page load: the ID a link carries (`ph_id`), else the one kept, else a new one. A kept ID keeps
 * the time it was first kept, so it ends 30 minutes after that however often the page is opened. An ID from a link,
 * or a new one, starts its own 30 minutes; the same ID carried again doesn't start them over.
 */
export function resolveVisit(carried: string | null, kept: KeptVisit | null, now: number, newId: () => string): KeptVisit {
  if (carried !== null && VISIT_ID.test(carried)) return kept?.id === carried ? kept : { id: carried, at: now };
  return kept ?? { id: newId(), at: now };
}
