import { createHash, randomBytes } from "node:crypto";

/** A machine (`bm_`) or assistant (`ba_`) token: the prefix and 32 random bytes, base64url. */
export function newToken(prefix: "bm_" | "ba_"): string {
  return prefix + randomBytes(32).toString("base64url");
}

/** A one-time join code: 16 random bytes, base64url. */
export function newJoinCode(): string {
  return randomBytes(16).toString("base64url");
}

/** SHA-256 hex. Minted tokens and join codes are stored only as this. */
export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
