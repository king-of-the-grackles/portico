import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { SESSION_COOKIE } from "../core/accounts";
import type { Topic } from "../core/changes";
import type { Core } from "../core/core";
import { errorName, log } from "../log";
import { type PersonEnv, currentPerson } from "./context";

export interface PersonConnection {
  /** Throws if the stream has closed. */
  send(event: "hello" | "changed", data: Record<string, unknown>): void;
  close(): void;
  /** Whether the sign-in session the page opened the stream with still stands. */
  live?(): boolean;
}

/**
 * People's open pages, by person: any number of tabs each. A change goes out as topics only, never data, so a page
 * fetches again through the person API, which applies what that person may see. Each person hears only the topics
 * that concern that person, and a page whose sign-in session has ended hears nothing more: its stream is closed.
 */
export class PersonStreams {
  private readonly open = new Map<string, Set<PersonConnection>>();

  connect(personId: string, conn: PersonConnection): () => void {
    const set = this.open.get(personId) ?? new Set();
    set.add(conn);
    this.open.set(personId, set);
    return () => {
      set.delete(conn);
      if (set.size === 0 && this.open.get(personId) === set) this.open.delete(personId);
    };
  }

  /** Sends `changed` to each person's open pages, with the topics `topicsFor` gives that person. */
  broadcast(topics: Topic[], topicsFor: (personId: string) => Topic[] = () => topics): void {
    for (const [personId, set] of this.open) {
      const mine = topicsFor(personId);
      for (const conn of [...set]) {
        if (conn.live && !conn.live()) {
          set.delete(conn);
          conn.close();
          continue;
        }
        if (mine.length === 0) continue;
        try {
          conn.send("changed", { topics: mine });
        } catch {
          set.delete(conn);
        }
      }
    }
  }

  /** Closes every stream whose sign-in session has ended: called when someone signs out. */
  closeEnded(): void {
    for (const set of this.open.values()) {
      for (const conn of [...set]) {
        if (conn.live && !conn.live()) {
          set.delete(conn);
          conn.close();
        }
      }
    }
  }

  /** Closes the person's pages' streams, e.g. once the person is removed or signs out everywhere. */
  closeFor(personId: string): void {
    for (const conn of this.open.get(personId) ?? []) conn.close();
    this.open.delete(personId);
  }

  count(): number {
    let n = 0;
    for (const set of this.open.values()) n += set.size;
    return n;
  }
}

/** Below the server's 60-second idle timeout, so quiet streams stay open through proxies. */
export const PERSON_HEARTBEAT_MS = 25_000;

/** GET /api/events: a signed-in page's live updates. A claimed invite's waiting page may listen too. */
export function eventRoutes(core: Core, opts: { heartbeatMs?: number } = {}): Hono<PersonEnv> {
  const heartbeatMs = opts.heartbeatMs ?? PERSON_HEARTBEAT_MS;
  const route = new Hono<PersonEnv>();
  route.get("/", (c) => {
    const person = currentPerson(c, { pending: true });
    const session = getCookie(c, SESSION_COOKIE);
    return streamSSE(c, async (stream) => {
      let open = true;
      let end!: () => void;
      const ended = new Promise<void>((resolve) => {
        end = () => {
          open = false;
          resolve();
        };
      });
      const conn: PersonConnection = {
        send: (event, data) => {
          if (!open) throw new Error("stream closed");
          stream.writeSSE({ event, data: JSON.stringify(data) }).catch(() => end());
        },
        close: () => end(),
        live: () => core.accounts.sessionLive(session, person.id),
      };
      stream.onAbort(() => end());
      const disconnect = core.personStreams.connect(person.id, conn);
      try {
        await stream.write(": connected\n\n");
        conn.send("hello", { personId: person.id });
        while (open) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([new Promise<void>((resolve) => (timer = setTimeout(resolve, heartbeatMs))), ended]);
          clearTimeout(timer);
          // A session that ended while the page stayed open (signed out elsewhere, run out, the person removed) ends the stream.
          if (open && !conn.live!()) end();
          if (open) await stream.write(": ping\n\n").catch(() => end());
        }
      } catch (err) {
        log("error", "person_stream_failed", { error: errorName(err) });
      } finally {
        disconnect();
      }
    });
  });
  return route;
}
