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
import { cleanPersonName, MAX_PERSON_NAME, type People } from "./people";
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

/** Sign in allows this many failures per address and name within the window, */
const SIGN_IN_FAILURES = 10;
/** and this many per name from all addresses together, since a client can choose the address it reports, */
const SIGN_IN_FAILURES_PER_NAME = 30;
/** and this many attempts per address whatever the names, successes included. */
const SIGN_IN_ATTEMPTS_PER_ADDRESS = 30;
const SIGN_IN_WINDOW_MS = 15 * MINUTE_MS;
/** Longer than any IP address written out. Where no proxy adds the address the client chooses it, so keys cut it here. */
const MAX_SIGN_IN_ADDRESS_CHARS = 64;
/** At most this many argon2 password checks (64 MiB each) run at once, */
const MAX_PASSWORD_CHECKS = 2;
/** and this many wait; an attempt beyond that is refused at once. */
const MAX_PASSWORD_CHECKS_WAITING = 8;

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

/** At most `max` password checks run at once and `queue` more wait their turn; beyond that a check is refused. */
class PasswordChecks {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly max: number,
    private readonly queue: number,
  ) {}

  /**
   * Runs `check` once a place comes up. Not async: the place is taken, or rate_limited thrown, before this returns, so
   * a caller can count an attempt only once it has a place.
   */
  run<T>(check: () => Promise<T>): Promise<T> {
    let turn: Promise<void>;
    if (this.running < this.max) {
      this.running++;
      turn = Promise.resolve();
    } else if (this.waiting.length < this.queue) {
      turn = new Promise((resolve) => this.waiting.push(resolve));
    } else {
      throw new PorticoError("rate_limited", "Too many sign in attempts right now. Try again in a minute.");
    }
    return turn.then(check).finally(() => {
      // A finished check hands its place straight to the next one waiting.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    });
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
  private readonly nameFailures: FailureLimiter;
  private readonly addressAttempts: FailureLimiter;
  /** Every sign-in password check, server-wide. */
  private readonly passwordChecks: PasswordChecks;
  /** A hash to verify against when the name is unknown, so a wrong name takes as long as a wrong password. */
  private decoyHash: Promise<string> | null = null;
  readonly passkeys: Passkeys;

  constructor(deps: AccountsDeps) {
    this.db = deps.db;
    this.people = deps.people;
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? (() => crypto.randomUUID());
    this.signInFailures = new FailureLimiter(SIGN_IN_FAILURES, SIGN_IN_WINDOW_MS, this.now);
    this.nameFailures = new FailureLimiter(SIGN_IN_FAILURES_PER_NAME, SIGN_IN_WINDOW_MS, this.now);
    this.addressAttempts = new FailureLimiter(SIGN_IN_ATTEMPTS_PER_ADDRESS, SIGN_IN_WINDOW_MS, this.now);
    this.passwordChecks = new PasswordChecks(MAX_PASSWORD_CHECKS, MAX_PASSWORD_CHECKS_WAITING);
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
   * The person with this name and password. A wrong name and a wrong password get the same answer, and so does a name
   * or password longer than any person's, without being counted or checked. 10 failures in 15 minutes from one address
   * for one name, 30 for one name from anywhere, or 30 attempts of any kind from one address stop further attempts
   * until the oldest leaves the window. Each attempt counts before the slow check, so parallel attempts can't all slip
   * past the limits; a success clears the counts per name, not the one per address. "local" (no proxy reported an
   * address) is every client at once, so it gets no per-address cap: one client could lock out everyone. While every
   * place for a password check is taken, an attempt is refused at once and not counted.
   */
  async signIn(input: { name: unknown; password: unknown; ip: string }): Promise<Person> {
    const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (name === "" || password === "") throw new PorticoError("bad_request", "Enter a name and password.");
    if (Array.from(name).length > MAX_PERSON_NAME || Array.from(password).length > MAX_PASSWORD_CHARS) {
      throw new PorticoError("unauthorized", "Wrong name or password.");
    }
    const address = input.ip.slice(0, MAX_SIGN_IN_ADDRESS_CHARS);
    const addressKey = `sign-in-address\n${address}`;
    const key = `sign-in\n${address}\n${name.toLowerCase()}`;
    const nameKey = `sign-in\n${name.toLowerCase()}`;
    const perAddress = address !== "local";
    if (perAddress) this.addressAttempts.check(addressKey, "sign in");
    this.signInFailures.check(key, "sign in");
    this.nameFailures.check(nameKey, "sign in");
    // A place first, so an attempt refused while every place is taken stores nothing.
    const check = this.passwordChecks.run(async () => {
      const person = this.people.byName(name);
      const hash = person ? this.people.passwordHash(person.id) : null;
      const ok = await verifyPassword(password, hash ?? (await this.decoy()));
      return person && hash && ok ? person : null;
    });
    if (perAddress) this.addressAttempts.fail(addressKey);
    this.signInFailures.fail(key);
    this.nameFailures.fail(nameKey);
    const person = await check;
    if (!person) throw new PorticoError("unauthorized", "Wrong name or password.");
    this.signInFailures.clear(key);
    this.nameFailures.clear(nameKey);
    return person;
  }

  /**
   * Fresh proof for a change to how the person signs in (a new password, a new passkey): the current password. 10
   * wrong answers in 15 minutes per person stop further attempts, across every change that asks.
   */
  async confirmPassword(personId: string, current: unknown): Promise<void> {
    const key = `password\n${personId}`;
    this.signInFailures.check(key, "password");
    const hash = this.people.passwordHash(personId);
    if (!hash) throw new PorticoError("not_found", "No such person.");
    // Counted before the slow check, as in signIn, so parallel attempts can't all slip past the limit.
    this.signInFailures.fail(key);
    if (typeof current !== "string" || !(await verifyPassword(current, hash))) {
      throw new PorticoError("bad_request", "The current password is wrong.");
    }
    this.signInFailures.clear(key);
  }

  /**
   * Sets a new password after checking the current one. A change answers a suspected break-in, so in one go it also
   * removes the person's passkeys and ends every browser session, this one included; the caller signs this browser
   * back in with the session returned.
   */
  async changePassword(personId: string, input: { current: unknown; next: unknown }): Promise<{ token: string; expiresAt: string }> {
    const next = checkNewPassword(input.next);
    await this.confirmPassword(personId, input.current);
    const hash = await hashPassword(next);
    return this.db.transaction(() => {
      this.people.setPasswordHash(personId, hash);
      this.db.query("DELETE FROM passkeys WHERE person_id = $personId").run({ personId });
      this.endSessionsFor(personId);
      return this.startSession(personId);
    })();
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
   * setup (a link from `portico setup --reset`): sets a new owner password, removes the owner's passkeys, signs the
   * owner out everywhere and revokes what the owner account made (revokeOwnerCredentials), so whoever forced the
   * recovery keeps no way back in. Everything is checked before the link is used up.
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
        this.db.query("DELETE FROM passkeys WHERE person_id = $personId").run({ personId: owner.id });
        this.endSessionsFor(owner.id);
        this.revokeOwnerCredentials(owner.id);
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

  /**
   * Recovery's revocations beyond the browser: whatever the owner account made can carry the evicted party's access
   * too. The owner's computers keep their rows but their tokens fail, so each joins again with a new line. Agents the
   * owner manages lose their app, access and refresh tokens. Unused join lines and unexchanged OAuth codes go. Sign-in
   * requests from the owner's lines never hand over a token: pending ones expire, and approved ones count as issued.
   * Call inside the recovery's transaction; the caller closes the agents' open streams once it commits.
   */
  private revokeOwnerCredentials(ownerId: string): void {
    const owner = { personId: ownerId };
    const ownerAgents = "SELECT id FROM agents WHERE owner_id = $personId";
    const ownerLines = "SELECT id FROM join_lines WHERE created_by = $personId";
    this.db.query("UPDATE computers SET token_hash = 'revoked:' || id WHERE owner_id = $personId").run(owner);
    this.db.query(`DELETE FROM agent_tokens WHERE agent_id IN (${ownerAgents})`).run(owner);
    this.db.query(`DELETE FROM oauth_codes WHERE used_at IS NULL AND agent_id IN (${ownerAgents})`).run(owner);
    this.db
      .query(`UPDATE sign_in_requests SET status = 'expired' WHERE status = 'pending' AND join_line_id IN (${ownerLines})`)
      .run(owner);
    this.db
      .query(
        `UPDATE sign_in_requests SET issued_at = $at
         WHERE status = 'approved' AND issued_at IS NULL AND join_line_id IN (${ownerLines})`,
      )
      .run({ ...owner, at: this.now().toISOString() });
    this.db.query("DELETE FROM join_lines WHERE created_by = $personId AND used_at IS NULL").run(owner);
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

  /** Every minute: forgets sign-in limiter keys with nothing left in the window. */
  sweepLimiters(): void {
    this.addressAttempts.sweep();
    this.signInFailures.sweep();
    this.nameFailures.sweep();
  }

  /** Daily: deletes expired browser sessions and setup links, and forgets old sign-in failures. */
  sweep(): number {
    const now = this.now().toISOString();
    this.signInFailures.sweep();
    this.nameFailures.sweep();
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
