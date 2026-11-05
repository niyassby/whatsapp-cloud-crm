import { WhatsAppErrorCode } from '@wacrm/shared';

/** Provider-neutral failure. Everything outside this package sees only this shape. */
export interface WhatsAppError {
  code: WhatsAppErrorCode;
  message: string;
  /** True: throw inside the BullMQ job so it retries. False: mark the message failed. */
  retryable: boolean;
  /** Meta's numeric code, kept for logs and support. 0 when the request never reached Meta. */
  metaCode: number;
  httpStatus: number;
  fbtraceId?: string;
}

export type GatewayResult<T> = { data: T; error: null } | { data: null; error: WhatsAppError };

const ok = <T>(data: T): GatewayResult<T> => ({ data, error: null });
const fail = <T>(error: WhatsAppError): GatewayResult<T> => ({ data: null, error });
export const result = { ok, fail };

const C = WhatsAppErrorCode;

/** Meta error code -> internal code. Ranges are in `mapMetaCode`. */
const META_CODES: Record<number, WhatsAppErrorCode> = {
  // Auth and permissions
  190: C.TOKEN_INVALID,
  10: C.PERMISSION_DENIED,
  200: C.PERMISSION_DENIED,
  3: C.PERMISSION_DENIED,
  // Rate limits
  4: C.RATE_LIMITED,
  80007: C.RATE_LIMITED,
  130429: C.RATE_LIMITED,
  131048: C.RATE_LIMITED,
  131056: C.RATE_LIMITED,
  133016: C.RATE_LIMITED,
  // Transient platform errors
  1: C.META_UNAVAILABLE,
  2: C.META_UNAVAILABLE,
  131000: C.META_UNAVAILABLE,
  131016: C.META_UNAVAILABLE,
  133004: C.META_UNAVAILABLE,
  // Window and recipients
  131047: C.WINDOW_CLOSED,
  131026: C.RECIPIENT_UNAVAILABLE,
  131021: C.RECIPIENT_UNAVAILABLE,
  131050: C.RECIPIENT_UNAVAILABLE,
  131030: C.RECIPIENT_NOT_ALLOWED,
  // Media
  131051: C.MEDIA_INVALID,
  131052: C.MEDIA_INVALID,
  131053: C.MEDIA_INVALID,
  // Account state
  368: C.ACCOUNT_RESTRICTED,
  131031: C.ACCOUNT_RESTRICTED,
  131042: C.PAYMENT_REQUIRED,
  // Registration
  133010: C.NOT_REGISTERED,
  133005: C.NOT_REGISTERED,
  133006: C.NOT_REGISTERED,
  133008: C.NOT_REGISTERED,
  // Malformed requests
  100: C.INVALID_REQUEST,
  131008: C.INVALID_REQUEST,
  131009: C.INVALID_REQUEST,
};

function mapMetaCode(metaCode: number, httpStatus: number): WhatsAppErrorCode {
  const direct = META_CODES[metaCode];
  if (direct) return direct;
  if (metaCode >= 132000 && metaCode <= 132999) return C.TEMPLATE_INVALID;
  if (httpStatus === 429) return C.RATE_LIMITED;
  if (httpStatus >= 500) return C.META_UNAVAILABLE;
  if (httpStatus === 401) return C.TOKEN_INVALID;
  if (httpStatus === 403) return C.PERMISSION_DENIED;
  return C.UNKNOWN;
}

const RETRYABLE: ReadonlySet<WhatsAppErrorCode> = new Set([
  C.NETWORK,
  C.META_UNAVAILABLE,
  C.RATE_LIMITED,
]);

export interface RawProviderError {
  message: string;
  code?: number;
  httpStatus?: number;
  fbtraceId?: string;
  /** The provider's own retry hint (network failures and timeouts). */
  isRetryable?: boolean;
}

/** Map an SDK or Graph failure to the internal shape. */
export function mapError(raw: RawProviderError): WhatsAppError {
  const metaCode = raw.code ?? 0;
  const httpStatus = raw.httpStatus ?? 0;
  const code = httpStatus === 0 && metaCode === 0 ? C.NETWORK : mapMetaCode(metaCode, httpStatus);
  return {
    code,
    message: raw.message,
    retryable: RETRYABLE.has(code) || (code === C.UNKNOWN && raw.isRetryable === true),
    metaCode,
    httpStatus,
    fbtraceId: raw.fbtraceId,
  };
}
