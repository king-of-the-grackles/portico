import type { Database } from "bun:sqlite";
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { PorticoError } from "./errors";
import { DAY_MS, HOUR_MS, LIMITS, MINUTE_MS } from "./limits";
import { cleanPersonName, type People } from "./people";
import { cleanPublicUrl, type Settings } from "./settings";
import { hashSecret, LINK_SECRET, newLinkSecret, newToken } from "./tokens";
import type { Person } from "./types";

/** Passwords are stored only as argon2id hashes. */
export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return Bun.password.verify(password, hash).catch(() => false);
}

const MAX_PASSWORD_CHARS = 1000;

/** A new password as typed: 12 characters or more. Returned unchanged; spaces count. */
export function checkNewPassword(value: unknown): string {
  if (typeof value !== "string" || Array.from(value).length < LIMITS.minPasswordChars) {
    throw new PorticoError("bad_request", `A password needs ${LIMITS.minPasswordChars} characters or more.`);
  }
  if (Array.from(value).length > MAX_PASSWORD_CHARS) {
    throw new PorticoError("bad_request", `A password can be at most ${MAX_PASSWORD_CHARS} characters.`);
  }
  return value;
}

/** The browser sign-in cookie. */
export const SESSION_COOKIE = "portico_session";

/** A web session's last_used_at is written at most this often. */
const TOUCH_INTERVAL_MS = 60_000;

/** Sign in allows this many failures per address and name within the window. */
const SIGN_IN_FAILURES = 10;
const SIGN_IN_WINDOW_MS = 15 * MINUTE_MS;

interface WebSessionRow {
  id: string;
  person_id: string;
  expires_at: string;
  last_used_at: string;
}

interface SetupLinkRow {
  id: string;
  expires_at: string;
  used_at: string | null;
}

export interface SetupInput {
  token?: unknown;
  /** Setup only: the owner's name. */
  name?: unknown;
  password?: unknown;
  /** Setup only: the address people and agents reach Portico at. */
  publicUrl?: unknown;
}

/**
 * Failed attempts per key within a sliding window, in memory. A restart forgets them, which only ever lets more
 * attempts through, never fewer.
 */
class FailureLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => Date,
  ) {}

  /** Throws rate_limited once the key has `max` failures within the window. */
  check(key: string, what: string): void {
    const recent = this.recent(key);
    if (recent.length < this.max) return;
    const minutes = Math.max(1, Math.ceil((recent[0]! + this.windowMs - this.now().getTime()) / MINUTE_MS));
    throw new PorticoError("rate_limited", `Too many failed ${what} attempts. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`);
  }

  fail(key: string): void {
    this.failures.set(key, [...this.recent(key), this.now().getTime()]);
  }

  clear(key: string): void {
    this.failures.delete(key);
  }

  /** Forgets keys with no failures left in the window. */
  sweep(): void {
    for (const key of [...this.failures.keys()]) this.recent(key);
  }

  private recent(key: string): number[] {
    const since = this.now().getTime() - this.windowMs;
    const recent = (this.failures.get(key) ?? []).filter((at) => at > since);
    if (recent.length === 0) this.failures.delete(key);
    else this.failures.set(key, recent);
    return recent;
  }
}

export interface AccountsDeps {
  db: Database;
  people: People;
  now?: () => Date;
  newId?: () => string;
}

/**
 * How people sign in: browser sessions stored by token hash (so signing out or removing a person ends them at once),
 * passwords, one-time setup links, the sign-in limiter and passkeys.
 */
export class Accounts {
  private readonly db: Database;
  private readonly people: People;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly signInFailures: FailureLimiter;
  /** A hash to verify against when the name is unknown, so a wrong name takes as long as a wrong password. */
  private decoyHash: Promise<string> | null = null;
  readonly passkeys: Passkeys;

  constructor(deps: AccountsDeps) {
    this.db = deps.db;
    this.people = deps.people;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.signInFailures = new FailureLimiter(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS, this.now);
    this.passkeys = new Passkeys({ db: this.db, people: this.people, now: this.now, newId: this.newId });
  }

  // ---- browser sessions ----

  /** A new browser session for the person. The token goes in the cookie and is stored only as a hash. */
  startSession(personId: string): { token: string; expiresAt: string } {
    const token = newToken("pw_");
    const at = this.now();
    const expiresAt = new Date(at.getTime() + LIMITS.webSessionDays * DAY_MS).toISOString();
    this.db
      .query(
        `INSERT INTO web_sessions (id, token_hash, person_id, created_at, expires_at, last_used_at)
         VALUES ($id, $hash, $personId, $at, $expiresAt, $at)`,
      )
      .run({ id: this.newId(), hash: hashSecret(token), personId, at: at.toISOString(), expiresAt });
    return { token, expiresAt };
  }

  /** The person signed in with this cookie token, or null when it's unknown or expired. */
  personForSession(token: string | undefined): Person | null {
    if (!token) return null;
    const row = this.db
      .query("SELECT id, person_id, expires_at, last_used_at FROM web_sessions WHERE token_hash = $hash")
      .get({ hash: hashSecret(token) }) as WebSessionRow | null;
    const now = this.now();
    if (!row || Date.parse(row.expires_at) <= now.getTime()) return null;
    if (now.getTime() - Date.parse(row.last_used_at) >= TOUCH_INTERVAL_MS) {
      this.db.query("UPDATE web_sessions SET last_used_at = $at WHERE id = $id").run({ id: row.id, at: now.toISOString() });
    }
    return this.people.get(row.person_id);
  }

  endSession(token: string | undefined): void {
    if (!token) return;
    this.db.query("DELETE FROM web_sessions WHERE token_hash = $hash").run({ hash: hashSecret(token) });
  }

  /** Signs the person out everywhere, except the session with `keepToken`. */
  endSessionsFor(personId: string, keepToken?: string): void {
    this.db
      .query("DELETE FROM web_sessions WHERE person_id = $personId AND token_hash != $keep")
      .run({ personId, keep: keepToken ? hashSecret(keepToken) : "" });
  }

  // ---- sign in and passwords ----

  /**
   * The person with this name and password. A wrong name and a wrong password get the same answer. 10 failures in 15
   * minutes from one address for one name stop further attempts until the oldest leaves the window.
   */
  async signIn(input: { name: unknown; password: unknown; ip: string }): Promise<Person> {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (name === "" || password === "") throw new PorticoError("bad_request", "Enter a name and password.");
    const key = `sign-in\n${input.ip}\n${name.toLowerCase()}`;
    this.signInFailures.check(key, "sign in");
    const person = this.people.byName(name);
    const hash = person ? this.people.passwordHash(person.id) : null;
    const ok = await verifyPassword(password, hash ?? (await this.decoy()));
    if (!person || !hash || !ok) {
      this.signInFailures.fail(key);
      throw new PorticoError("unauthorized", "Wrong name or password.");
    }
    this.signInFailures.clear(key);
    return person;
  }

  /** Sets a new password after checking the current one, and signs the person out everywhere but `keepToken`. */
  async changePassword(personId: string, input: { current: unknown; next: unknown; keepToken?: string }): Promise<void> {
    const key = `password\n${personId}`;
    this.signInFailures.check(key, "password");
    const next = checkNewPassword(input.next);
    const hash = this.people.passwordHash(personId);
    if (!hash) throw new PorticoError("not_found", "No such person.");
    if (typeof input.current !== "string" || !(await verifyPassword(input.current, hash))) {
      this.signInFailures.fail(key);
      throw new PorticoError("bad_request", "The current password is wrong.");
    }
    this.signInFailures.clear(key);
    this.people.setPasswordHash(personId, await hashPassword(next));
    this.endSessionsFor(personId, input.keepToken);
  }

  private decoy(): Promise<string> {
    this.decoyHash ??= hashPassword(newLinkSecret());
    return this.decoyHash;
  }

  // ---- setup links ----

  /**
   * A one-time setup link's secret, valid for 1 hour and stored only as a hash. With `reset`, unused links stop
   * working first. Before setup the link creates the owner; after setup it sets a new owner password.
   */
  createSetupLink(opts: { reset?: boolean } = {}): { token: string; expiresAt: string } {
    const token = newLinkSecret();
    const at = this.now();
    const expiresAt = new Date(at.getTime() + LIMITS.setupLinkHours * HOUR_MS).toISOString();
    this.db.transaction(() => {
      if (opts.reset) this.db.query("DELETE FROM setup_links WHERE used_at IS NULL").run();
      this.db
        .query("INSERT INTO setup_links (id, token_hash, created_at, expires_at) VALUES ($id, $hash, $at, $expiresAt)")
        .run({ id: this.newId(), hash: hashSecret(token), at: at.toISOString(), expiresAt });
    })();
    return { token, expiresAt };
  }

  /**
   * Uses a setup link. Before setup: creates the owner with the name and password, and confirms the public URL. After
   * setup (a link from `portico setup --reset`): sets a new owner password and signs the owner out everywhere.
   * Everything is checked before the link is used up.
   */
  async setUp(settings: Settings, input: SetupInput): Promise<{ person: Person; recovered: boolean }> {
    const token = typeof input.token === "string" ? input.token : "";
    this.setupLink(token);
    const password = checkNewPassword(input.password);
    if (settings.setupDone()) {
      const owner = this.people.owner();
      if (!owner) throw new PorticoError("not_found", "Portico has no owner yet.");
      const hash = await hashPassword(password);
      this.db.transaction(() => {
        this.useSetupLink(token);
        this.people.setPasswordHash(owner.id, hash);
        this.endSessionsFor(owner.id);
      })();
      return { person: owner, recovered: true };
    }
    const publicUrl = typeof input.publicUrl === "string" ? cleanPublicUrl(input.publicUrl) : null;
    if (!publicUrl) {
      throw new PorticoError(
        "bad_request",
        "Enter the public URL as an https:// address. http:// works only for localhost and 127.0.0.1.",
      );
    }
    const name = cleanPersonName(input.name);
    const hash = await hashPassword(password);
    const person = this.db.transaction(() => {
      this.useSetupLink(token);
      const owner = this.people.create({ name, role: "owner", status: "active", passwordHash: hash });
      settings.set("public_url", publicUrl);
      settings.set("setup_done_at", this.now().toISOString());
      return owner;
    })();
    return { person, recovered: false };
  }

  /** The usable link with this secret. Throws not_found for an unknown one, wrong_status for one used or expired. */
  private setupLink(token: string): SetupLinkRow {
    const row = LINK_SECRET.test(token)
      ? (this.db
          .query("SELECT id, expires_at, used_at FROM setup_links WHERE token_hash = $hash")
          .get({ hash: hashSecret(token) }) as SetupLinkRow | null)
      : null;
    if (!row) {
      throw new PorticoError("not_found", "This setup link doesn't work. Run portico setup on the host for a new link.");
    }
    if (row.used_at !== null) {
      throw new PorticoError("wrong_status", "This setup link was already used. Run portico setup --reset on the host for a new link.");
    }
    if (Date.parse(row.expires_at) <= this.now().getTime()) {
      throw new PorticoError("wrong_status", "This setup link has expired. Run portico setup on the host for a new link.");
    }
    return row;
  }

  /** Marks the link used; call inside the transaction that acts on it, so two tabs can't both use it. */
  private useSetupLink(token: string): void {
    const row = this.setupLink(token);
    this.db.query("UPDATE setup_links SET used_at = $at WHERE id = $id").run({ id: row.id, at: this.now().toISOString() });
  }

  /** Daily: deletes expired browser sessions and setup links, and forgets old sign-in failures. */
  sweep(): number {
    const now = this.now().toISOString();
    this.signInFailures.sweep();
    this.passkeys.sweep();
    const sessions = this.db.query("DELETE FROM web_sessions WHERE expires_at <= $now").run({ now }).changes;
    const links = this.db.query("DELETE FROM setup_links WHERE expires_at <= $now").run({ now }).changes;
    return sessions + links;
  }
}

// ---- passkeys ----

/** The relying party a passkey belongs to: the public URL's host name, and its origin. */
export interface PasskeyRp {
  id: string;
  origin: string;
}

/** The relying party for Portico's passkeys, from its public URL. */
export function passkeyRp(publicUrl: string): PasskeyRp {
  const url = new URL(publicUrl);
  return { id: url.hostname, origin: url.origin };
}

export interface Passkey {
  id: string;
  personId: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface PasskeyRow {
  id: string;
  person_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

function toPasskey(row: PasskeyRow): Passkey {
  return { id: row.id, personId: row.person_id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at };
}

/** How long a passkey request (its challenge) lasts. */
export const PASSKEY_CHALLENGE_MS = 5 * MINUTE_MS;

const MAX_PASSKEY_NAME = 60;

/** A passkey's label as typed, e.g. "MacBook Touch ID". Empty becomes "Passkey". */
export function cleanPasskeyName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (name === "") return "Passkey";
  if (Array.from(name).length > MAX_PASSKEY_NAME || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new PorticoError("bad_request", `A passkey name can be at most ${MAX_PASSKEY_NAME} characters on one line.`);
  }
  return name;
}

function credentialJson(value: unknown): { id: string } & Record<string, unknown> {
  const ok =
    typeof value === "object" &&
    value !== null &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { response?: unknown }).response === "object";
  if (!ok) throw new PorticoError("bad_request", "credential must be a passkey response.");
  return value as { id: string } & Record<string, unknown>;
}

/**
 * Passkeys (WebAuthn): adding one while signed in, and signing in with one. Options carry a fresh challenge; the
 * caller keeps it (Portico's pages keep it in a short-lived signed cookie) and hands it back with the browser's
 * answer. Each challenge works once.
 */
export class Passkeys {
  private readonly db: Database;
  private readonly people: People;
  private readonly now: () => Date;
  private readonly newId: () => string;
  /** Challenges already answered, until they'd have expired anyway. */
  private readonly usedChallenges = new Map<string, number>();

  constructor(deps: { db: Database; people: People; now: () => Date; newId: () => string }) {
    this.db = deps.db;
    this.people = deps.people;
    this.now = deps.now;
    this.newId = deps.newId;
  }

  list(personId: string): Passkey[] {
    const rows = this.db
      .query("SELECT * FROM passkeys WHERE person_id = $personId ORDER BY created_at, id")
      .all({ personId }) as PasskeyRow[];
    return rows.map(toPasskey);
  }

  /** Options for navigator.credentials.create(): a discoverable credential, so sign in needs no name. */
  registrationOptions(person: Person, rp: PasskeyRp): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const existing = this.db
      .query("SELECT * FROM passkeys WHERE person_id = $personId")
      .all({ personId: person.id }) as PasskeyRow[];
    return generateRegistrationOptions({
      rpName: "Portico",
      rpID: rp.id,
      userName: person.name,
      userDisplayName: person.name,
      userID: new TextEncoder().encode(person.id),
      attestationType: "none",
      timeout: PASSKEY_CHALLENGE_MS,
      excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: JSON.parse(row.transports) as string[] })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
    });
  }

  /** Checks the browser's answer to registrationOptions and stores the passkey. */
  async add(person: Person, rp: PasskeyRp, input: { challenge: string; credential: unknown; name: unknown }): Promise<Passkey> {
    const name = cleanPasskeyName(input.name);
    const credential = credentialJson(input.credential);
    this.useChallenge(input.challenge);
    let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      result = await verifyRegistrationResponse({
        response: credential as unknown as RegistrationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
      });
    } catch {
      throw new PorticoError("bad_request", "The passkey couldn't be added. Try again.");
    }
    if (!result.verified) throw new PorticoError("bad_request", "The passkey couldn't be added. Try again.");
    const verified = result.registrationInfo.credential;
    if (this.db.query("SELECT 1 FROM passkeys WHERE credential_id = $id").get({ id: verified.id })) {
      throw new PorticoError("conflict", "This passkey is already added.");
    }
    const row: PasskeyRow = {
      id: this.newId(),
      person_id: person.id,
      credential_id: verified.id,
      public_key: Buffer.from(verified.publicKey).toString("base64url"),
      counter: verified.counter,
      transports: JSON.stringify(verified.transports ?? []),
      name,
      created_at: this.now().toISOString(),
      last_used_at: null,
    };
    this.db
      .query(
        `INSERT INTO passkeys (id, person_id, credential_id, public_key, counter, transports, name, created_at, last_used_at)
         VALUES ($id, $person_id, $credential_id, $public_key, $counter, $transports, $name, $created_at, $last_used_at)`,
      )
      .run({ ...row });
    return toPasskey(row);
  }

  /** Removes one of the person's own passkeys. */
  remove(personId: string, id: string): void {
    const { changes } = this.db.query("DELETE FROM passkeys WHERE id = $id AND person_id = $personId").run({ id, personId });
    if (changes === 0) throw new PorticoError("not_found", "No such passkey.");
  }

  /** Options for navigator.credentials.get(): any passkey for Portico, picked by the browser. */
  signInOptions(rp: PasskeyRp): Promise<PublicKeyCredentialRequestOptionsJSON> {
    return generateAuthenticationOptions({ rpID: rp.id, userVerification: "required", timeout: PASSKEY_CHALLENGE_MS });
  }

  /** The person whose passkey signed the challenge. */
  async signIn(rp: PasskeyRp, input: { challenge: string; credential: unknown }): Promise<Person> {
    const credential = credentialJson(input.credential);
    const row = this.db.query("SELECT * FROM passkeys WHERE credential_id = $id").get({ id: credential.id }) as PasskeyRow | null;
    if (!row) {
      throw new PorticoError("unauthorized", "This passkey isn't registered with Portico. Sign in with a name and password.");
    }
    this.useChallenge(input.challenge);
    let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      result = await verifyAuthenticationResponse({
        response: credential as unknown as AuthenticationResponseJSON,
        expectedChallenge: input.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: true,
        credential: {
          id: row.credential_id,
          publicKey: new Uint8Array(Buffer.from(row.public_key, "base64url")),
          counter: row.counter,
          transports: JSON.parse(row.transports) as string[],
        },
      });
    } catch {
      throw new PorticoError("unauthorized", "The passkey couldn't be checked. Try again.");
    }
    if (!result.verified) throw new PorticoError("unauthorized", "The passkey couldn't be checked. Try again.");
    this.db
      .query("UPDATE passkeys SET counter = $counter, last_used_at = $at WHERE id = $id")
      .run({ id: row.id, counter: result.authenticationInfo.newCounter, at: this.now().toISOString() });
    return this.people.require(row.person_id);
  }

  /** Forgets used challenges that have expired anyway. */
  sweep(): void {
    const now = this.now().getTime();
    for (const [challenge, until] of this.usedChallenges) if (until <= now) this.usedChallenges.delete(challenge);
  }

  private useChallenge(challenge: string): void {
    this.sweep();
    if (!challenge || this.usedChallenges.has(challenge)) {
      throw new PorticoError("bad_request", "This passkey request was already used. Try again.");
    }
    this.usedChallenges.set(challenge, this.now().getTime() + 2 * PASSKEY_CHALLENGE_MS);
  }
}
