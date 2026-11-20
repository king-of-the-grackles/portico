import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** How to make a key, said wherever a missing or unusable one is reported. */
export const SECRETS_KEY_HELP =
  "Make a key with `openssl rand -base64 32` (or `portico key`), and set the key as PORTICO_SECRETS_KEY where the server's settings are kept, never in the data folder.";

/** What starting without a key says. */
export const SECRETS_KEY_MISSING = `PORTICO_SECRETS_KEY isn't set. Portico needs that key to encrypt the keys and secrets Portico stores (wake URL keys, event secrets). ${SECRETS_KEY_HELP}`;

/**
 * How a wake or an event delivery went when Portico couldn't read the stored key or secret: encrypted under a key
 * Portico no longer has, or not what Portico wrote. Nothing is sent until the agent registers again.
 */
export const SECRET_UNREADABLE = "secret_unreadable";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const PREFIX = "enc:v1:";

/** A new key, as `portico key` prints it: 32 random bytes, base64. */
export function newSecretsKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

/** The 32 bytes of a key written as base64 or base64url, or null for anything else. */
export function secretsKeyBytes(raw: string): Uint8Array | null {
  const text = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
  const bytes = Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return bytes.length === KEY_BYTES ? new Uint8Array(bytes) : null;
}

/** A key's short name inside each value it encrypted: the first 8 hex characters of its SHA-256. Says which key, never the key. */
export function secretsKeyId(key: Uint8Array): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Where a value lives: its table, column and row. An encrypted value opens only there. */
export interface SecretPlace {
  table: string;
  column: string;
  row: string;
}

/**
 * What reading a stored value gives: the value, or why there is none. `unknown_key`: encrypted under a key Portico
 * wasn't given. `damaged`: not what Portico wrote there (changed, cut, or copied from another row). `plain`: not
 * encrypted at all, once the start's pass over old rows is done.
 */
export type Opened = { ok: true; value: string; current: boolean } | { ok: false; reason: "unknown_key" | "damaged" | "plain" };

interface Held {
  id: string;
  key: Promise<CryptoKey>;
  /** The same key for the synchronous form: code that reads a value while it builds a page can't wait. */
  bytes: Uint8Array;
}

function hold(bytes: Uint8Array): Held {
  return { id: secretsKeyId(bytes), bytes, key: crypto.subtle.importKey("raw", bytes as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]) };
}

const TAG_BYTES = 16;

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/**
 * Encrypts the secrets Portico has to keep in a form it can read again (an app's wake URL key, an event
 * subscription's signing secret) with a key that isn't in the data folder: PORTICO_SECRETS_KEY. AES-256-GCM with a
 * random nonce per value; the value's table, column and row are authenticated with it, so a value copied into another
 * row doesn't open. Stored as `enc:v1:<key id>:<nonce>:<ciphertext>`, base64url. A previous key
 * (PORTICO_SECRETS_KEY_OLD) still opens what it encrypted, so a start can move every value to the new key. Invite
 * and share links' secrets, kept so a link can be shown again, are stored the same way.
 */
export class Secrets {
  private readonly current: Held;
  private readonly old: Held | null;
  /** Until the start's pass over old rows is done, a value that isn't encrypted is read as it is. */
  private plainAllowed = true;

  constructor(key: Uint8Array, old: Uint8Array | null = null) {
    this.current = hold(key);
    this.old = old ? hold(old) : null;
  }

  /** From the settings' own text. Throws for a key that isn't 32 bytes of base64: the config check comes first. */
  static from(key: string, old: string | null = null): Secrets {
    const bytes = secretsKeyBytes(key);
    const oldBytes = old === null ? null : secretsKeyBytes(old);
    if (!bytes || (old !== null && !oldBytes)) throw new Error("Not a secrets key.");
    return new Secrets(bytes, oldBytes);
  }

  get keyId(): string {
    return this.current.id;
  }

  /** Every value in the database is encrypted now: one that isn't no longer counts as a value. */
  plainEnded(): void {
    this.plainAllowed = false;
  }

  private aad(place: SecretPlace): BufferSource {
    return new TextEncoder().encode(JSON.stringify(["portico", place.table, place.column, place.row])) as BufferSource;
  }

  /** Which key a stored value names, or why none: the first step of opening one, either way. */
  private parts(stored: string): { held: Held; nonce: Buffer; sealed: Buffer } | { reason: "unknown_key" | "damaged" } {
    const [id, nonce, sealed, ...rest] = stored.slice(PREFIX.length).split(":");
    if (!id || !nonce || !sealed || rest.length > 0) return { reason: "damaged" };
    const held = id === this.current.id ? this.current : this.old && id === this.old.id ? this.old : null;
    if (!held) return { reason: "unknown_key" };
    return { held, nonce: Buffer.from(nonce, "base64url"), sealed: Buffer.from(sealed, "base64url") };
  }

  /**
   * `seal` without waiting, for values written where nothing can wait (a link's secret, kept so the link can be
   * shown again). The same cipher, key and form: either way of opening reads what either way of sealing wrote.
   */
  sealSync(place: SecretPlace, value: string): string {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.current.bytes, nonce);
    cipher.setAAD(Buffer.from(this.aad(place) as Uint8Array));
    const sealed = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    return `${PREFIX}${this.current.id}:${b64(nonce)}:${b64(sealed)}`;
  }

  /** `open` without waiting. A value that isn't encrypted is never one here: `plain`. */
  openSync(place: SecretPlace, stored: string): Opened {
    if (!Secrets.sealed(stored)) return { ok: false, reason: "plain" };
    const parts = this.parts(stored);
    if ("reason" in parts) return { ok: false, reason: parts.reason };
    if (parts.sealed.length < TAG_BYTES) return { ok: false, reason: "damaged" };
    try {
      const decipher = createDecipheriv("aes-256-gcm", parts.held.bytes, parts.nonce);
      decipher.setAAD(Buffer.from(this.aad(place) as Uint8Array));
      decipher.setAuthTag(parts.sealed.subarray(parts.sealed.length - TAG_BYTES));
      const plain = Buffer.concat([decipher.update(parts.sealed.subarray(0, parts.sealed.length - TAG_BYTES)), decipher.final()]);
      return { ok: true, value: plain.toString("utf8"), current: parts.held === this.current };
    } catch {
      return { ok: false, reason: "damaged" };
    }
  }

  async seal(place: SecretPlace, value: string): Promise<string> {
    const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: this.aad(place) },
      await this.current.key,
      new TextEncoder().encode(value),
    );
    return `${PREFIX}${this.current.id}:${b64(nonce)}:${b64(new Uint8Array(sealed))}`;
  }

  /** Whether the stored text is an encrypted value at all, under any key. */
  static sealed(stored: string): boolean {
    return stored.startsWith(PREFIX);
  }

  async open(place: SecretPlace, stored: string): Promise<Opened> {
    if (!Secrets.sealed(stored)) return this.plainAllowed ? { ok: true, value: stored, current: false } : { ok: false, reason: "plain" };
    const parts = this.parts(stored);
    if ("reason" in parts) return { ok: false, reason: parts.reason };
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: parts.nonce as BufferSource, additionalData: this.aad(place) },
        await parts.held.key,
        parts.sealed as BufferSource,
      );
      return { ok: true, value: new TextDecoder().decode(plain), current: parts.held === this.current };
    } catch {
      return { ok: false, reason: "damaged" };
    }
  }
}
