export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

/** Returns the request if it's a single, well-formed JSON-RPC 2.0 request or notification. */
export function parseRequest(body: unknown): JsonRpcRequest | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const candidate = body as Record<string, unknown>;
  if (candidate.jsonrpc !== "2.0" || typeof candidate.method !== "string") return null;
  const id = candidate.id;
  if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") return null;
  return candidate as unknown as JsonRpcRequest;
}

export function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function rpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}
