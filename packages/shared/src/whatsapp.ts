import { z } from 'zod';

/**
 * Internal WhatsApp failure codes. Meta's numeric codes are mapped to these in
 * packages/whatsapp, so nothing else in the app depends on Meta's numbering.
 */
export const WhatsAppErrorCode = {
  /** Network failure or timeout before Meta answered. */
  NETWORK: 'WA_NETWORK',
  /** Meta 5xx or a transient platform error. */
  META_UNAVAILABLE: 'WA_META_UNAVAILABLE',
  /** Throughput, pair or app rate limits. Retry later. */
  RATE_LIMITED: 'WA_RATE_LIMITED',
  /** Token expired or revoked. The number must be reconnected. */
  TOKEN_INVALID: 'WA_TOKEN_INVALID',
  /** Token lacks the permission, or the asset is not shared with the app. */
  PERMISSION_DENIED: 'WA_PERMISSION_DENIED',
  /** Outside the 24-hour customer service window: only templates can be sent. */
  WINDOW_CLOSED: 'WA_WINDOW_CLOSED',
  /** Recipient is not on WhatsApp, or cannot receive this message. */
  RECIPIENT_UNAVAILABLE: 'WA_RECIPIENT_UNAVAILABLE',
  /** Test numbers can only message pre-approved recipients. */
  RECIPIENT_NOT_ALLOWED: 'WA_RECIPIENT_NOT_ALLOWED',
  /** Template missing, paused, disabled, or its parameters do not match. */
  TEMPLATE_INVALID: 'WA_TEMPLATE_INVALID',
  /** Meta rejected the media (type, size, or could not fetch it). */
  MEDIA_INVALID: 'WA_MEDIA_INVALID',
  /** Number not registered with the Cloud API, or the PIN is wrong. */
  NOT_REGISTERED: 'WA_NOT_REGISTERED',
  /** WABA or number restricted by Meta (policy, spam, locked account). */
  ACCOUNT_RESTRICTED: 'WA_ACCOUNT_RESTRICTED',
  /** Payment method problem on the WABA. */
  PAYMENT_REQUIRED: 'WA_PAYMENT_REQUIRED',
  /** Request rejected as malformed. */
  INVALID_REQUEST: 'WA_INVALID_REQUEST',
  UNKNOWN: 'WA_UNKNOWN',
} as const;
export type WhatsAppErrorCode = (typeof WhatsAppErrorCode)[keyof typeof WhatsAppErrorCode];

const metaId = z
  .string()
  .trim()
  .regex(/^\d{5,32}$/, 'Must be a numeric Meta ID');
const pinSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Must be 6 digits');

export const embeddedSignupSchema = z.object({
  /** Short-lived code returned by FB.login. */
  code: z.string().min(10).max(4096),
  wabaId: metaId,
  phoneNumberId: metaId,
  /** App-scoped Facebook user id, when the JS SDK reports one (matches deletion callbacks). */
  metaUserId: z.string().trim().max(64).optional(),
});
export type EmbeddedSignupInput = z.infer<typeof embeddedSignupSchema>;

export const manualConnectSchema = z.object({
  /** System user token. Encrypted at rest and never returned. */
  accessToken: z.string().trim().min(20).max(4096),
  wabaId: metaId,
  phoneNumberId: metaId,
  /** Register the number with this 2-step PIN. Leave empty for already registered test numbers. */
  pin: pinSchema.optional(),
});
export type ManualConnectInput = z.infer<typeof manualConnectSchema>;

export const registerPhoneSchema = z.object({
  /** Existing 2-step verification PIN. A random one is generated when omitted. */
  pin: pinSchema.optional(),
});
export type RegisterPhoneInput = z.infer<typeof registerPhoneSchema>;

/** Body of Meta's deauthorize and data deletion callbacks. */
export const signedRequestSchema = z.object({ signed_request: z.string().min(10).max(8192) });
export type SignedRequestInput = z.infer<typeof signedRequestSchema>;

export type PhoneNumberStatus = 'pending' | 'connected' | 'registration_failed' | 'disconnected';
export type WebhookEventStatus = 'received' | 'routed' | 'processed' | 'ignored' | 'failed';

/** Never contains tokens or PINs. */
export interface PhoneNumberDto {
  id: string;
  wabaId: string;
  wabaName: string | null;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  qualityRating: string | null;
  messagingTier: string | null;
  nameStatus: string | null;
  codeVerificationStatus: string | null;
  platformType: string | null;
  status: PhoneNumberStatus;
  statusReason: string | null;
  credentialSource: 'embedded_signup' | 'manual';
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface WhatsAppConfigDto {
  /** False until META_APP_ID + META_APP_SECRET + the signup config id are set. */
  embeddedSignupEnabled: boolean;
  manualConnectEnabled: boolean;
  appId: string | null;
  configId: string | null;
  graphApiVersion: string;
}

export interface WebhookEventDto {
  id: string;
  field: string | null;
  phoneNumberId: string | null;
  status: WebhookEventStatus;
  attempts: number;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
}

export interface DataDeletionStatusDto {
  confirmationCode: string;
  status: 'received' | 'completed';
  requestedAt: string;
  completedAt: string | null;
}
