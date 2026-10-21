import { AGENT_NAME } from "../config";
import type { NetworkStore } from "../network-store";
import { addressOf } from "./directory";
import { BridgeError } from "./errors";
import { hashSecret, newJoinCode, newToken } from "./tokens";
import { ASSISTANT_KINDS, OWNER } from "./types";
import type { Assistant, AssistantKind, BridgeConfig, Machine } from "./types";

export const JOIN_CODE_HOURS = 24;

/** Used when an assistant is connected without a description. */
export const ASSISTANT_DESCRIPTIONS: Record<AssistantKind, string> = {
  muse: "Meta's Muse assistant",
  "grok-bot": "Grok, xAI's assistant",
  chatgpt: "ChatGPT, OpenAI's assistant",
  codex: "Codex, OpenAI's coding agent",
  other: "An assistant connected on the hub page",
};

const HOUR_MS = 3_600_000;
const JOIN_CODE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_DESCRIPTION = 500;
/** The longest assistant name, the same cap slugify puts on machine and session names. */
export const MAX_NAME_LENGTH = 40;
const MAX_DEDUPE = 99;
const INVALID_CODE = "The join code is invalid, expired or already used. Ask for a new join line.";

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

/** The paste-ready line that carries a join code to a new machine. The code is in the fragment, which browsers never send. */
export function joinLine(publicUrl: string, code: string): string {
  return `Join my agent bridge: ${publicUrl}/join#${code}`;
}

/** A joining machine's proposed name (usually its hostname) as a machine name: slugged, without `.local`. */
export function machineSlug(raw: string): string {
  return slugify(raw.trim().replace(/\.local$/i, ""), "machine");
}

export interface NetworkServiceDeps {
  store: NetworkStore;
  config: BridgeConfig;
  now?: () => Date;
  newId?: () => string;
  log?: (msg: string, fields: Record<string, unknown>) => void;
}

/** Join codes, the machines they create, and the assistants connected on the hub page. */
export class NetworkService {
  private readonly store: NetworkStore;
  private readonly config: BridgeConfig;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly log: (msg: string, fields: Record<string, unknown>) => void;

  constructor(deps: NetworkServiceDeps) {
    this.store = deps.store;
    this.config = deps.config;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.log = deps.log ?? (() => {});
  }

  /** A one-time code, valid JOIN_CODE_HOURS. Only its hash is stored, so this is the only time it's seen. */
  createJoinCode(): { code: string; expiresAt: string } {
    const code = newJoinCode();
    const id = this.newId();
    const expiresAt = this.iso(JOIN_CODE_HOURS * HOUR_MS);
    this.store.insertJoinCode({ id, owner: OWNER, createdAt: this.iso(), expiresAt, usedAt: null }, hashSecret(code));
    this.log("join_code_created", { join_code_id: id });
    return { code, expiresAt };
  }

  /** Uses the code and creates the machine. The token is returned once and stored only as a hash. */
  redeemJoinCode(code: unknown, machineName: unknown): { machine: Machine; token: string } {
    if (typeof code !== "string" || !JOIN_CODE.test(code)) throw new BridgeError("bad_request", "code must be a join code.");
    if (typeof machineName !== "string") throw new BridgeError("bad_request", "machine must be a string.");
    const at = this.iso();
    const joined = this.store.transaction(() => {
      const found = this.store.joinCodeByHash(hashSecret(code));
      // markJoinCodeUsed is guarded by used_at IS NULL, so of two racing redemptions only one gets here.
      if (!found || found.expiresAt <= at || !this.store.markJoinCodeUsed(found.id, at)) {
        throw new BridgeError("not_found", INVALID_CODE);
      }
      const token = newToken("bm_");
      const machine: Machine = {
        id: this.newId(),
        owner: OWNER,
        name: this.freeMachineName(machineSlug(machineName)),
        createdAt: at,
        lastSeenAt: null,
      };
      this.store.insertMachine(machine, hashSecret(token));
      return { machine, token };
    });
    this.log("machine_joined", { machine: joined.machine.name });
    return joined;
  }

  /** Mints the assistant's token, returned once and stored only as a hash. */
  createAssistant(input: { name: unknown; kind: unknown; description?: unknown }): { assistant: Assistant; token: string } {
    const { name, kind } = input;
    if (typeof name !== "string" || !AGENT_NAME.test(name)) {
      throw new BridgeError("bad_request", "name must be lowercase letters, digits and hyphens.");
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new BridgeError("bad_request", `name must be at most ${MAX_NAME_LENGTH} characters.`);
    }
    if (!ASSISTANT_KINDS.some((known) => known === kind)) {
      throw new BridgeError("bad_request", `kind must be one of: ${ASSISTANT_KINDS.join(", ")}.`);
    }
    const assistantKind = kind as AssistantKind;
    if (this.config.agents.some((agent) => agent.name === name)) {
      throw new BridgeError("bad_request", `"${name}" is already an agent in bridge.yaml. Choose another name.`);
    }
    if (this.store.assistantByName(name)) {
      throw new BridgeError("bad_request", `An assistant named "${name}" already exists. Choose another name.`);
    }
    const description = this.description(input.description) ?? ASSISTANT_DESCRIPTIONS[assistantKind];
    const token = newToken("ba_");
    const assistant: Assistant = {
      id: this.newId(),
      owner: OWNER,
      name,
      kind: assistantKind,
      description,
      createdAt: this.iso(),
    };
    this.store.insertAssistant(assistant, hashSecret(token));
    this.log("assistant_created", { assistant: name, kind: assistantKind });
    return { assistant, token };
  }

  /** Deletes the assistant, so its token fails at once. False when there's none by that name. */
  removeAssistant(name: string): boolean {
    const assistant = this.store.assistantByName(name);
    if (!assistant) return false;
    this.store.deleteAssistant(assistant.id);
    this.log("assistant_removed", { assistant: name });
    return true;
  }

  /** Deletes the machine and its sessions, so its token fails at once. Returns the removed sessions' addresses. */
  removeMachine(name: string): { removed: boolean; sessionAddresses: string[] } {
    const machine = this.store.machineByName(name);
    if (!machine) return { removed: false, sessionAddresses: [] };
    const sessions = this.store.deleteMachine(machine.id);
    this.log("machine_removed", { machine: name, sessions: sessions.length });
    return { removed: true, sessionAddresses: sessions.map((session) => addressOf(session.name, machine.name)) };
  }

  listMachines(): (Machine & { sessions: number })[] {
    return this.store.listMachines();
  }

  listAssistants(): Assistant[] {
    return this.store.listAssistants();
  }

  // ---- helpers ----

  private iso(offsetMs = 0): string {
    return new Date(this.now().getTime() + offsetMs).toISOString();
  }

  /** The base name, or the first free `<base>-2` … `<base>-99`. */
  private freeMachineName(base: string): string {
    let name = base;
    for (let n = 2; this.store.machineByName(name); n++) {
      if (n > MAX_DEDUPE) throw new BridgeError("rate_limited", `Too many machines named ${base}. Remove some first.`);
      name = `${base}-${n}`;
    }
    return name;
  }

  /** The trimmed description, or null when none was given. */
  private description(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new BridgeError("bad_request", "description must be a string.");
    const trimmed = value.trim();
    if (trimmed.length > MAX_DESCRIPTION) {
      throw new BridgeError("bad_request", `description must be at most ${MAX_DESCRIPTION} characters.`);
    }
    return trimmed || null;
  }
}
