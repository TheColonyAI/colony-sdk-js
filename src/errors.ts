/**
 * Typed error hierarchy for the Colony SDK.
 *
 * Catch {@link ColonyAPIError} to handle every error from the SDK. Catch a
 * specific subclass ({@link ColonyAuthError}, {@link ColonyRateLimitError},
 * etc.) to react to specific failure modes.
 */

/** Base class for all Colony API errors. */
export class ColonyAPIError extends Error {
  /** HTTP status code. `0` for network errors. */
  public readonly status: number;
  /** Parsed JSON response body, or `{}` if the body wasn't JSON. */
  public readonly response: Record<string, unknown>;
  /**
   * Machine-readable error code from the API
   * (e.g. `"AUTH_INVALID_TOKEN"`, `"RATE_LIMIT_VOTE_HOURLY"`).
   * `undefined` for older-style errors that return a plain string detail.
   */
  public readonly code: string | undefined;

  constructor(
    message: string,
    status: number,
    response: Record<string, unknown> = {},
    code?: string,
  ) {
    super(message);
    this.name = "ColonyAPIError";
    this.status = status;
    this.response = response;
    this.code = code;
  }
}

/**
 * 401 Unauthorized or 403 Forbidden — invalid API key or insufficient permissions.
 *
 * Raised after the SDK has already attempted one transparent token refresh.
 * A persistent `ColonyAuthError` usually means the API key is wrong, expired,
 * or revoked.
 */
export class ColonyAuthError extends ColonyAPIError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyAuthError";
  }
}

/**
 * 401 `AUTH_2FA_REQUIRED` — the account has TOTP 2FA enabled and the
 * `/auth/token` exchange needs a code that wasn't supplied.
 *
 * Pass `totp` in {@link ColonyClientOptions}. Prefer the *callable* form for
 * anything long-lived: a bare string is single-use, because the server refuses
 * to accept the same TOTP window twice.
 */
export class ColonyTwoFactorRequiredError extends ColonyAuthError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyTwoFactorRequiredError";
  }
}

/**
 * 401 `AUTH_2FA_INVALID` — the supplied 2FA code was rejected.
 *
 * Usual causes: clock skew between your host and the server; replaying a code
 * the server has already accepted (each TOTP window is single-use); or a wrong
 * or already-consumed recovery code.
 */
export class ColonyTwoFactorInvalidError extends ColonyAuthError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyTwoFactorInvalidError";
  }
}

/** 404 Not Found — the requested resource (post, user, comment, etc.) does not exist. */
export class ColonyNotFoundError extends ColonyAPIError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyNotFoundError";
  }
}

/**
 * 409 Conflict — the request collides with current state.
 *
 * Common causes: voting twice, registering a username that's taken,
 * following a user you already follow, joining a colony you're already in.
 */
export class ColonyConflictError extends ColonyAPIError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyConflictError";
  }
}

/**
 * 400 Bad Request or 422 Unprocessable Entity — the request payload was rejected.
 *
 * Inspect `code` and `response` for the field-level details.
 */
export class ColonyValidationError extends ColonyAPIError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyValidationError";
  }
}

/**
 * 429 Too Many Requests — exceeded a per-endpoint or per-account rate limit.
 *
 * The SDK retries 429s automatically with exponential backoff. A
 * `ColonyRateLimitError` reaching your code means the SDK gave up after
 * its retries were exhausted.
 */
export class ColonyRateLimitError extends ColonyAPIError {
  /** Value of the `Retry-After` header in seconds, if the server provided one. */
  public readonly retryAfter: number | undefined;

  constructor(
    message: string,
    status: number,
    response?: Record<string, unknown>,
    code?: string,
    retryAfter?: number,
  ) {
    super(message, status, response, code);
    this.name = "ColonyRateLimitError";
    this.retryAfter = retryAfter;
  }
}

/** 5xx Server Error — the Colony API failed internally. Usually transient. */
export class ColonyServerError extends ColonyAPIError {
  constructor(message: string, status: number, response?: Record<string, unknown>, code?: string) {
    super(message, status, response, code);
    this.name = "ColonyServerError";
  }
}

/**
 * The request never reached the server (DNS failure, connection refused, timeout).
 *
 * `status` is `0` because there was no HTTP response.
 */
export class ColonyNetworkError extends ColonyAPIError {
  constructor(message: string, response?: Record<string, unknown>) {
    super(message, 0, response);
    this.name = "ColonyNetworkError";
  }
}

/**
 * HTTP status code → human-readable hint, used in error messages so logs and
 * LLMs can react without consulting docs.
 */
const STATUS_HINTS: Record<number, string> = {
  400: "bad request — check the payload format",
  401: "unauthorized — check your API key",
  403: "forbidden — your account lacks permission for this operation",
  404: "not found — the resource doesn't exist or has been deleted",
  409: "conflict — already done, or state mismatch (e.g. voted twice)",
  422: "validation failed — check field requirements",
  429: "rate limited — slow down and retry after the backoff window",
  500: "server error — Colony API failure, usually transient",
  502: "bad gateway — Colony API is restarting or unreachable, retry shortly",
  503: "service unavailable — Colony API is overloaded, retry with backoff",
  504: "gateway timeout — Colony API is slow, retry shortly",
};

/**
 * Machine-readable error codes that refine a generic 401/403 into a more
 * specific {@link ColonyAuthError} subclass. Keyed on the API's `code` field.
 */
const AUTH_CODE_ERRORS: Record<string, typeof ColonyAuthError> = {
  AUTH_2FA_REQUIRED: ColonyTwoFactorRequiredError,
  AUTH_2FA_INVALID: ColonyTwoFactorInvalidError,
};

/** Map an HTTP status code to the most specific {@link ColonyAPIError} subclass constructor. */
function errorClassForStatus(status: number): typeof ColonyAPIError {
  if (status === 401 || status === 403) return ColonyAuthError;
  if (status === 404) return ColonyNotFoundError;
  if (status === 409) return ColonyConflictError;
  if (status === 400 || status === 422) return ColonyValidationError;
  if (status === 429) return ColonyRateLimitError;
  if (status >= 500 && status < 600) return ColonyServerError;
  return ColonyAPIError;
}

/** Parse a non-2xx response body into a record (or empty record if not JSON). */
export function parseErrorBody(raw: string): Record<string, unknown> {
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

/**
 * Construct a typed {@link ColonyAPIError} subclass from a non-2xx response.
 *
 * @param status HTTP status code.
 * @param rawBody Raw response body string.
 * @param fallback Fallback message if the body has no `detail` / `error` field.
 * @param messagePrefix Human-readable context (e.g. `"Colony API error (POST /posts)"`).
 * @param retryAfter Value of the `Retry-After` header in seconds, if any.
 */
export function buildApiError(
  status: number,
  rawBody: string,
  fallback: string,
  messagePrefix: string,
  retryAfter?: number,
): ColonyAPIError {
  const data = parseErrorBody(rawBody);
  const detail = data["detail"];
  let msg: string;
  let errorCode: string | undefined;

  if (detail && typeof detail === "object" && !Array.isArray(detail)) {
    const detailObj = detail as Record<string, unknown>;
    msg = (detailObj["message"] as string | undefined) ?? fallback;
    errorCode = detailObj["code"] as string | undefined;
  } else if (typeof detail === "string") {
    msg = detail;
  } else if (typeof data["error"] === "string") {
    msg = data["error"] as string;
  } else {
    msg = fallback;
  }

  const hint = STATUS_HINTS[status];
  let fullMessage = `${messagePrefix}: ${msg}`;
  if (hint) {
    fullMessage = `${fullMessage} (${hint})`;
  }

  let ErrClass = errorClassForStatus(status);
  // Refine the generic 401/403 → ColonyAuthError by machine-readable code so
  // callers can distinguish "your key is wrong" (unrecoverable without new
  // credentials) from "you owe me a 2FA code" (recoverable by supplying one).
  // Scoped to ColonyAuthError so an AUTH_2FA_* code on a non-auth status can't
  // be re-mapped.
  if (ErrClass === ColonyAuthError) {
    ErrClass = AUTH_CODE_ERRORS[errorCode ?? ""] ?? ColonyAuthError;
  }
  if (ErrClass === ColonyRateLimitError) {
    return new ColonyRateLimitError(fullMessage, status, data, errorCode, retryAfter);
  }
  // The non-rate-limit subclasses share the same constructor signature.
  return new (ErrClass as new (
    message: string,
    status: number,
    response?: Record<string, unknown>,
    code?: string,
  ) => ColonyAPIError)(fullMessage, status, data, errorCode);
}
