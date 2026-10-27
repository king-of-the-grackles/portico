import type { Store } from "../db";
import type { NetworkStore } from "../network-store";
import { addressOf } from "./directory";
import { PorticoError } from "./errors";
import { defang } from "./framing";
import { slugify } from "./network";
import { OWNER } from "./types";
import type { Machine, SessionRecord } from "./types";

const KEY = /^[A-Za-z0-9_-]{8,100}$/;
const FOLDER_ID = /^[a-f0-9]{64}$/;
const MAX_REPO = 200;
const MAX_DEDUPE = 99;
/** A session's last_seen_at is written by its status reports at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** A session's name before deduplication: the slugged repo basename plus `-claude`. */
export function sessionBaseName(repo: string): string {
  return `${slugify(repo, "session")}-claude`;
}

/** What a session's plugin sends when it opens its stream. */
export interface Registration {
  /** The random ID the plugin made when it started. */
  key: string;
  /** The repo basename. */
  repo: string;
  /** HMAC of the full folder path, keyed with the machine token. */
  folderId: string;
}

/** The registration headers and query, checked. The repo defaults to "session". */
export function parseRegistration(key: unknown, folderId: unknown, repo: unknown): Registration {
  if (typeof key !== "string" || !KEY.test(key)) {
    throw new PorticoError("bad_request", "X-Portico-Session must be 8 to 100 letters, digits, hyphens or underscores.");
  }
  if (typeof folderId !== "string" || !FOLDER_ID.test(folderId)) {
    throw new PorticoError("bad_request", "X-Portico-Folder must be 64 lowercase hex characters.");
  }
  if (repo !== undefined && repo !== null && typeof repo !== "string") {
    throw new PorticoError("bad_request", "repo must be a string.");
  }
  if (typeof repo === "string" && repo.length > MAX_REPO) {
    throw new PorticoError("bad_request", `repo must be at most ${MAX_REPO} characters.`);
  }
  // Stored as the session's folder and shown in its directory description, so it gets the same cleaning as status
  // text, and only its last path segment is kept, even if a client sends a path.
  const cleaned = typeof repo === "string" ? defang(repo).replace(/\s+/g, " ").trim() : "";
  const segment = cleaned.split(/[\\/]/).filter(Boolean).pop()?.trim() ?? "";
  return { key, folderId, repo: segment || "session" };
}

export interface SessionRegistryDeps {
  network: NetworkStore;
  store: Store;
  /** Whether the address has an open stream. A session with one is live, so its name can't be inherited. */
  isConnected: (address: string) => boolean;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Turns a machine token plus a session key into a session with a stable address (spec §5.2). */
export class SessionRegistry {
  private readonly network: NetworkStore;
  private readonly store: Store;
  private readonly isConnected: (address: string) => boolean;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: SessionRegistryDeps) {
    this.network = deps.network;
    this.store = deps.store;
    this.isConnected = deps.isConnected;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  /**
   * The same key reconnecting keeps its row. Otherwise a stale session in the same folder is inherited, shortest name
   * first, then most recently seen, and its working tasks go back to queued. Otherwise a new row gets the first free
   * name: `<repo>-claude`, `-2`, `-3`, and so on.
   */
  register(machine: Machine, reg: Registration): { session: SessionRecord; address: string; inherited: boolean } {
    const at = this.iso();
    return this.network.transaction(() => {
      const same = this.network.sessionByKey(machine.id, reg.key);
      if (same) {
        return {
          session: this.network.updateSession(same.id, { lastSeenAt: at }),
          address: addressOf(same.name, machine.name),
          inherited: false,
        };
      }

      const stale = this.network
        .sessionsOnMachine(machine.id)
        .filter((s) => s.folderId === reg.folderId && !this.isConnected(addressOf(s.name, machine.name)))
        .sort((a, b) => a.name.length - b.name.length || b.lastSeenAt.localeCompare(a.lastSeenAt))[0];
      if (stale) {
        const address = addressOf(stale.name, machine.name);
        const session = this.network.updateSession(stale.id, { key: reg.key, lastSeenAt: at });
        for (const task of this.store.requeueWorkingFor(address, at)) {
          this.log("task_requeued", { task_id: task.id, to: address });
        }
        this.log("session_inherited", { address });
        return { session, address, inherited: true };
      }

      const base = sessionBaseName(reg.repo);
      const taken = new Set(this.network.sessionsOnMachine(machine.id).map((s) => s.name));
      let name = base;
      for (let n = 2; taken.has(name); n++) {
        if (n > MAX_DEDUPE) throw new PorticoError("rate_limited", `Too many sessions named ${base} on ${machine.name}.`);
        name = `${base}-${n}`;
      }
      const session: SessionRecord = {
        id: this.newId(),
        owner: OWNER,
        machineId: machine.id,
        machine: machine.name,
        name,
        key: reg.key,
        folder: reg.repo.slice(0, 100),
        folderId: reg.folderId,
        createdAt: at,
        lastSeenAt: at,
      };
      this.network.insertSession(session);
      const address = addressOf(name, machine.name);
      this.log("session_registered", { address });
      return { session, address, inherited: false };
    });
  }

  /** Writes last_seen_at when a session's stream closes. Does nothing when the row is gone, e.g. its machine was removed. */
  seen(sessionId: string): void {
    this.network.touchSession(sessionId, this.iso());
  }

  /** Writes a session's last_seen_at for a status report, at most once a minute. Other addresses are ignored. */
  touch(address: string): void {
    const at = address.indexOf("@");
    if (at < 0) return;
    const session = this.network.sessionByAddress(address.slice(0, at), address.slice(at + 1));
    if (!session) return;
    const now = this.now();
    if (now.getTime() - Date.parse(session.lastSeenAt) < TOUCH_INTERVAL_MS) return;
    this.network.touchSession(session.id, now.toISOString());
  }

  private iso(): string {
    return this.now().toISOString();
  }
}
