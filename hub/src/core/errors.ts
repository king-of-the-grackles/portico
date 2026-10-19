export type ErrorCode =
  | "unauthorized"
  | "not_allowed"
  | "not_found"
  | "unknown_agent"
  | "bad_request"
  | "wrong_status"
  | "too_large"
  | "rate_limited";

export const HTTP_STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_allowed: 403,
  not_found: 404,
  unknown_agent: 400,
  bad_request: 400,
  wrong_status: 409,
  too_large: 413,
  rate_limited: 429,
};

export class BridgeError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BridgeError";
  }
}
