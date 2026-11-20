// Descope's management API, for test people in the dev project: make a user, get a real session JWT without the
// sign-in screen, delete the user. https://docs.descope.com/api/management/users
import { descopeCredentials } from "./env";

const API = "https://api.descope.com";
// Descope's edge turns away some default client names, so the suite names itself like a command-line client.
const USER_AGENT = "curl/8.5.0";

async function post(path: string, auth: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auth}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Descope ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const management = (path: string, body: unknown) => {
  const { projectId, managementKey } = descopeCredentials();
  return post(path, `${projectId}:${managementKey}`, body);
};

/** A user whose login ID is the email, with the email verified. */
export async function createUser(email: string, name: string): Promise<void> {
  await management("/v1/mgmt/user/create", { loginId: email, email, verifiedEmail: true, name });
}

/** A session JWT for the user, as Descope's sign-in would hand the browser: an embedded link's token, then verified. */
export async function sessionJwt(loginId: string): Promise<string> {
  const { token } = await management("/v1/mgmt/user/signin/embeddedlink", { loginId });
  if (!token) throw new Error(`Descope gave no embedded link token for ${loginId}.`);
  const { sessionJwt: jwt } = await post("/v1/auth/magiclink/verify", descopeCredentials().projectId, { token });
  if (!jwt) throw new Error(`Descope gave no session JWT for ${loginId}.`);
  return jwt;
}

/** Deleting a user that is already gone is fine. */
export async function deleteUser(loginId: string): Promise<void> {
  await management("/v1/mgmt/user/delete", { loginId });
}
