/**
 * Stable error codes shared by api, worker and web. Never rename a code once shipped;
 * clients branch on them.
 */
export const ErrorCode = {
  INTERNAL: 'INTERNAL',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  /** A tenant-scoped operation ran without an organization in context. */
  TENANT_CONTEXT_MISSING: 'TENANT_CONTEXT_MISSING',
  /** DB context ids were malformed (not UUIDs). */
  DB_INVALID_CONTEXT: 'DB_INVALID_CONTEXT',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorHttpStatus: Record<ErrorCode, number> = {
  INTERNAL: 500,
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  TENANT_CONTEXT_MISSING: 403,
  DB_INVALID_CONTEXT: 400,
};

/** Typed application error carrying a stable code. */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }

  get httpStatus(): number {
    return errorHttpStatus[this.code];
  }
}

/** Shape of every error response body from the API. */
export interface ErrorResponse {
  code: ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}
