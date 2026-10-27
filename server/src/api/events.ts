import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Topic } from "../core/changes";
import type { Core } from "../core/core";
import { errorName, log } from "../log";
import { type PersonEnv, currentPerson } from "./context";

export interface PersonConnection {
  /** Throws if the stream has closed. */
  send(event: "hello" | "changed", data: Record<string, unknown>): void;
  close(): void;
}

/**
 * People's open pages, by person: any number of tabs each. Every change goes to everyone as topics only, never data,
 * so a page fetches again through the person API, which applies what that person may see.
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

  /** Sends `changed` to every open page. */
  broadcast(topics: Topic[]): void {
    for (const set of this.open.values()) {
      for (const conn of [...set]) {
        try {
          conn.send("changed", { topics });
        } catch {
          set.delete(conn);
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
