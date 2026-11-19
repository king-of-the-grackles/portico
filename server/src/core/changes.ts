import { errorName, log } from "../log";

/** What changed, for people's pages: each page fetches again whatever it shows for these topics. */
export const TOPICS = ["agents", "approvals", "threads", "people", "computers", "me", "activity", "workspaces"] as const;
export type Topic = (typeof TOPICS)[number];

/** Whom a change concerns: named by whatever the writer has at hand. The listener works out the people. */
export interface About {
  people?: (string | null | undefined)[];
  agents?: (string | null | undefined)[];
  workspaces?: (string | null | undefined)[];
}

/** One batch: the topics, and for each whom it concerns. `null` means everyone (a change with no narrower audience). */
export type Batch = Map<Topic, { people: string[]; agents: string[]; workspaces: string[] } | null>;

/**
 * An in-process feed of what changed. Modules emit topics as they write; listeners hear each batch once, in a
 * microtask after the write, so a burst of writes becomes one update. `about` says whom a change concerns, so a
 * person's page hears only of changes that could show on it; `emit` is for the few changes everyone may see.
 */
export class Changes {
  private pending: Batch = new Map();
  private scheduled = false;
  private readonly listeners = new Set<(topics: Topic[], batch: Batch) => void>();

  emit(...topics: Topic[]): void {
    for (const topic of topics) this.pending.set(topic, null);
    this.schedule();
  }

  /** The topics changed for the people named, the people who manage the agents, and the people in the workspaces. */
  about(whom: About, ...topics: Topic[]): void {
    const clean = (ids: (string | null | undefined)[] | undefined) => (ids ?? []).filter((id): id is string => typeof id === "string" && id !== "");
    for (const topic of topics) {
      if (this.pending.has(topic) && this.pending.get(topic) === null) continue;
      const now = this.pending.get(topic) ?? { people: [], agents: [], workspaces: [] };
      now.people.push(...clean(whom.people));
      now.agents.push(...clean(whom.agents));
      now.workspaces.push(...clean(whom.workspaces));
      this.pending.set(topic, now);
    }
    this.schedule();
  }

  /** Returns a function that stops listening. */
  on(listener: (topics: Topic[], batch: Batch) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  private flush(): void {
    this.scheduled = false;
    const batch = this.pending;
    const topics = TOPICS.filter((topic) => batch.has(topic));
    this.pending = new Map();
    if (topics.length === 0) return;
    for (const listener of this.listeners) {
      try {
        listener(topics, batch);
      } catch (err) {
        log("error", "change_listener_failed", { error: errorName(err) });
      }
    }
  }
}
