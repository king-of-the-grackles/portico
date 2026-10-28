import { errorName, log } from "../log";

/** What changed, for people's pages: each page fetches again whatever it shows for these topics. */
export const TOPICS = ["agents", "approvals", "threads", "people", "computers", "join-lines", "me", "activity"] as const;
export type Topic = (typeof TOPICS)[number];

/**
 * An in-process feed of what changed. Modules emit topics as they write; listeners hear each batch once, in a
 * microtask after the write, so a burst of writes becomes one update.
 */
export class Changes {
  private pending = new Set<Topic>();
  private scheduled = false;
  private readonly listeners = new Set<(topics: Topic[]) => void>();

  emit(...topics: Topic[]): void {
    for (const topic of topics) this.pending.add(topic);
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** Returns a function that stops listening. */
  on(listener: (topics: Topic[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private flush(): void {
    this.scheduled = false;
    const topics = TOPICS.filter((topic) => this.pending.has(topic));
    this.pending = new Set();
    if (topics.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(topics);
      } catch (err) {
        log("error", "change_listener_failed", { error: errorName(err) });
      }
    }
  }
}
