export interface ApiError {
  code: string;
  message: string;
  fieldErrors?: Record<string, string[]>;
}

/** One page of a server-paginated list (page is 1-based; total counts every matching row). */
export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Every ApplyWise JSON endpoint returns this envelope. */
export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  requestId: string;
}

export const ERROR_CODES = {
  VALIDATION: "VALIDATION_ERROR",
  UNAUTHENTICATED: "UNAUTHENTICATED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  CONFLICT: "CONFLICT",
  RATE_LIMITED: "RATE_LIMITED",
  CONSENT_REQUIRED: "CONSENT_REQUIRED",
  CONFIRMATION_REQUIRED: "CONFIRMATION_REQUIRED",
  EMAIL_NOT_VERIFIED: "EMAIL_NOT_VERIFIED",
  INVALID_STATE: "INVALID_STATE",
  UNSUPPORTED_FILE: "UNSUPPORTED_FILE",
  PROVIDER_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  PROVIDER_UNAVAILABLE: "PROVIDER_UNAVAILABLE",
  INTERNAL: "INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
