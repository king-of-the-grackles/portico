import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Secret prefixes, so a leaked value says what it is: `pc_` a computer, `pa_` an app agent, `pt_` and `pr_` a
 * connector's OAuth access and refresh tokens, `pw_` a browser sign-in, `ps_` a sign-in request's poll secret.
 */
export type TokenPrefix = "pc_" | "pa_" | "pt_" | "pr_" | "pw_" | "ps_";

/** The prefix and 32 random bytes, base64url. */
export function newToken(prefix: TokenPrefix): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** A one-time secret for a link fragment (join lines, invites, setup links): 16 random bytes, base64url. */
export function newLinkSecret(): string {
  return randomBytes(16).toString("base64url");
}

/** Secrets in a link's fragment: what newLinkSecret makes, with room for older or longer ones. */
export const LINK_SECRET = /^[A-Za-z0-9_-]{16,64}$/;

/** SHA-256 hex. Every token, code and secret is stored only as this. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Constant-time string comparison. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `<base64url payload>.<base64url HMAC>`: a short-lived value only Portico can make, e.g. a WebAuthn challenge. */
export function sign(key: string, purpose: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const mac = createHmac("sha256", key).update(`${purpose}:${body}`).digest("base64url");
  return `${body}.${mac}`;
}

/** The payload of a value `sign` made with the same key and purpose, or null. */
export function verifySigned<T>(key: string, purpose: string, value: string): T | null {
  const [body, mac] = value.split(".");
  if (!body || !mac || value.split(".").length !== 2) return null;
  const expected = createHmac("sha256", key).update(`${purpose}:${body}`).digest("base64url");
  if (!sameSecret(mac, expected)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

function sealKey(key: string, purpose: string): Buffer {
  return createHmac("sha256", key).update(`seal:${purpose}`).digest();
}

/**
 * Encrypts a value Portico must show again later, such as an open invite's link, with AES-256-GCM under a key derived
 * from the signing key. `<iv>.<tag>.<ciphertext>`, each base64url.
 */
export function seal(key: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealKey(key, purpose), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((part) => part.toString("base64url")).join(".");
}

/** The plaintext of a value `seal` made with the same key and purpose, or null. */
export function unseal(key: string, purpose: string, sealed: string): string | null {
  const [iv, tag, body] = sealed.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !body) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", sealKey(key, purpose), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
