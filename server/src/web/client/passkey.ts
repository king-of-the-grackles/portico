// Browser code for passkeys (WebAuthn). The server sends options as JSON with base64url bytes; the browser API wants
// ArrayBuffers, and its answers go back as JSON again. Settings can import addPasskey; the sign-in page's
// [data-passkey-sign-in] button is wired up here.
import { api, ApiError } from "./api.js";

type Json = Record<string, unknown>;
interface PasskeyView {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function toBytes(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function fromBytes(buffer: ArrayBuffer): string {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function credentialList(list: unknown): PublicKeyCredentialDescriptor[] {
  return ((list as { id: string; type: string; transports?: string[] }[] | undefined) ?? []).map((item) => ({
    id: toBytes(item.id),
    type: "public-key",
    transports: item.transports as AuthenticatorTransport[] | undefined,
  }));
}

/** Whether this browser can use passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.get === "function";
}

/** Signs in with a passkey the browser picks. Resolves to the page to open next. */
export async function signInWithPasskey(next: string): Promise<string> {
  const { options } = await api<{ options: Json }>("POST", "/api/session/passkey/options");
  const credential = (await navigator.credentials.get({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialRequestOptions),
      challenge: toBytes(options.challenge as string),
      allowCredentials: credentialList(options.allowCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no credential");
  const response = credential.response as AuthenticatorAssertionResponse;
  const answer = await api<{ next: string }>("POST", "/api/session/passkey", {
    next,
    credential: {
      id: credential.id,
      rawId: fromBytes(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: fromBytes(response.clientDataJSON),
        authenticatorData: fromBytes(response.authenticatorData),
        signature: fromBytes(response.signature),
        userHandle: response.userHandle ? fromBytes(response.userHandle) : undefined,
      },
    },
  });
  return answer.next;
}

/** Adds a passkey for the signed-in person, labeled with name (e.g. "MacBook Touch ID"). Needs the current password. */
export async function addPasskey(name: string, current: string): Promise<PasskeyView> {
  const { options } = await api<{ options: Json }>("POST", "/api/passkeys/options", { current });
  const user = options.user as { id: string; name: string; displayName: string };
  const credential = (await navigator.credentials.create({
    publicKey: {
      ...(options as unknown as PublicKeyCredentialCreationOptions),
      challenge: toBytes(options.challenge as string),
      user: { ...user, id: toBytes(user.id) },
      excludeCredentials: credentialList(options.excludeCredentials),
    },
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error("no credential");
  const response = credential.response as AuthenticatorAttestationResponse;
  const { passkey } = await api<{ passkey: PasskeyView }>("POST", "/api/passkeys", {
    name,
    credential: {
      id: credential.id,
      rawId: fromBytes(credential.rawId),
      type: credential.type,
      authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
      clientExtensionResults: credential.getClientExtensionResults(),
      response: {
        clientDataJSON: fromBytes(response.clientDataJSON),
        attestationObject: fromBytes(response.attestationObject),
        transports: typeof response.getTransports === "function" ? response.getTransports() : [],
      },
    },
  });
  return passkey;
}

/** A plain sentence for a passkey attempt that failed. */
export function passkeyProblem(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof DOMException && err.name === "NotAllowedError") return "The passkey prompt was closed or timed out.";
  if (err instanceof DOMException && err.name === "InvalidStateError") return "This passkey is already added.";
  return "The passkey didn't work. Try again, or sign in with a name and password.";
}

// The sign-in page: show the passkey option where the browser supports passkeys.
for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-passkey-sign-in]"))) {
  const option = button.closest<HTMLElement>("[data-passkey-option]");
  const error = option?.querySelector<HTMLElement>("[data-passkey-error]") ?? null;
  if (!passkeysSupported()) continue;
  if (option) option.hidden = false;
  button.addEventListener("click", () => {
    if (error) error.hidden = true;
    button.disabled = true;
    signInWithPasskey(button.dataset.next ?? "/")
      .then((next) => location.assign(next))
      .catch((err: unknown) => {
        if (error) {
          error.textContent = passkeyProblem(err);
          error.hidden = false;
        }
        button.disabled = false;
      });
  });
}
