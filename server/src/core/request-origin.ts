import { AsyncLocalStorage } from "node:async_hooks";

const store = new AsyncLocalStorage<string>();

/**
 * Runs a request as arriving at `origin`. A hosted Portico answers at more than one address (the base domain, and each
 * address an agent joined at before the databases became one), and every link, cookie and OAuth document a request
 * produces names the address the request came to.
 */
export function withOrigin<T>(origin: string, fn: () => T): T {
  return store.run(origin, fn);
}

/** The address the request being answered came to, or null when Portico has one address. */
export function requestOrigin(): string | null {
  return store.getStore() ?? null;
}
