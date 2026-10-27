// Browser code. Every page acts only through the person API, with this helper.

/** An error answer from the person API: `{ error, message }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Calls the person API with JSON. Resolves to the parsed body (null for 204); rejects with ApiError. */
export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "offline", "Portico can't be reached. Check the connection and try again.");
  }
  if (res.status === 204) return null as T;
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // An empty or non-JSON body: fall through to the status check.
  }
  if (!res.ok) {
    const err = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(res.status, err.error ?? "error", err.message ?? "Something went wrong. Try again.");
  }
  return data as T;
}

/** The page's first data, embedded by the server as JSON. */
export function firstData<T>(): T | null {
  const el = document.getElementById("first-data");
  if (!el?.textContent) return null;
  try {
    return JSON.parse(el.textContent) as T;
  } catch {
    return null;
  }
}
