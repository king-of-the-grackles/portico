// A test person: a real Descope user of the dev project, signed in to Portico without the Descope screen.
import { type APIRequestContext, type BrowserContext, request } from "@playwright/test";
import { BASE_URL } from "./env";
import { sessionJwt } from "./descope";

/** The person API refuses changes from other sites, so every call names Portico's own origin. */
export const ORIGIN = { Origin: BASE_URL };

/**
 * Signs the browser context in as the Descope user: POST /api/session with a real session JWT, as the sign-in page
 * does once Descope's component finishes. Returns where Portico sends the person next.
 */
export async function signIn(context: BrowserContext, email: string, next?: string): Promise<string> {
  const res = await context.request.post("/api/session", { headers: ORIGIN, data: { token: await sessionJwt(email), ...(next ? { next } : {}) } });
  if (!res.ok()) throw new Error(`POST /api/session answered ${res.status()}: ${await res.text()}`);
  return (await res.json()).next;
}

/** The person API with a stored session: for arranging things a scenario isn't about, and for checking refusals. */
export async function personApi(storage: any): Promise<APIRequestContext> {
  return request.newContext({ baseURL: BASE_URL, storageState: storage, extraHTTPHeaders: ORIGIN });
}

/** Signs in with no browser and returns the session as Playwright storage state, with where Portico sends the person. */
export async function newSession(email: string): Promise<{ storage: any; next: string }> {
  const api = await request.newContext({ baseURL: BASE_URL, extraHTTPHeaders: ORIGIN });
  try {
    const res = await api.post("/api/session", { data: { token: await sessionJwt(email) } });
    if (!res.ok()) throw new Error(`POST /api/session answered ${res.status()}: ${await res.text()}`);
    return { storage: await api.storageState(), next: (await res.json()).next };
  } finally {
    await api.dispose();
  }
}
