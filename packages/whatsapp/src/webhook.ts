/**
 * Webhook helpers. From wapi-cloud we use only signature verification and `parse`, never the
 * one-line Express handler (it processes inline; our receiver stores and enqueues).
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Whatsapp, type WhatsappEvent } from 'wapi-cloud';

/** Typed webhook event. contract.test.ts pins its shape so the SDK stays replaceable. */
export type WebhookEvent = WhatsappEvent;

// verifySignature and parse need no credentials; placeholders satisfy the constructor.
const sdk = new Whatsapp({ accessToken: 'unused', phoneNumberId: 'unused' });

/** Check X-Hub-Signature-256 against the exact bytes Meta sent. */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  return sdk.webhooks.verifySignature({ payload: rawBody, signatureHeader, appSecret });
}

export function parseWebhookEvents(payload: unknown): WebhookEvent[] {
  return sdk.webhooks.parse(payload);
}

/** Answer Meta's GET handshake: the challenge to echo back, or null when it must be refused. */
export function verifyWebhookChallenge(params: {
  mode: string | undefined;
  token: string | undefined;
  challenge: string | undefined;
  expectedToken: string;
}): string | null {
  if (params.mode !== 'subscribe' || !params.token || !params.challenge) return null;
  const given = sha256(params.token);
  const expected = sha256(params.expectedToken);
  return timingSafeEqual(given, expected) ? params.challenge : null;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** One stored event per change: a delivery can span several WABAs, hence several tenants. */
export interface SplitWebhookEvent {
  /** A complete single-change webhook body, so `parseWebhookEvents` works on it unchanged. */
  payload: { object: unknown; entry: [Record<string, unknown>] };
  /** sha256 of the payload. Meta redeliveries collapse onto the same row. */
  dedupeKey: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  field: string | null;
}

interface RawEntry {
  id?: unknown;
  changes?: unknown;
  [key: string]: unknown;
}

interface RawChange {
  field?: unknown;
  value?: { metadata?: { phone_number_id?: unknown } };
}

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function splitWebhookPayload(body: unknown): SplitWebhookEvent[] {
  if (!body || typeof body !== 'object') return [];
  const { object, entry } = body as { object?: unknown; entry?: unknown };
  if (!Array.isArray(entry)) return [];

  const events: SplitWebhookEvent[] = [];
  for (const rawEntry of entry as RawEntry[]) {
    const changes = Array.isArray(rawEntry?.changes) ? (rawEntry.changes as RawChange[]) : [];
    for (const change of changes) {
      const payload: SplitWebhookEvent['payload'] = {
        object,
        entry: [{ ...rawEntry, changes: [change] }],
      };
      events.push({
        payload,
        dedupeKey: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
        wabaId: str(rawEntry.id),
        phoneNumberId: str(change?.value?.metadata?.phone_number_id),
        field: str(change?.field),
      });
    }
  }
  return events;
}

export class InvalidSignedRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSignedRequestError';
  }
}

export interface SignedRequestPayload {
  algorithm: string;
  /** App-scoped Facebook user id. */
  user_id?: string;
  issued_at?: number;
  [key: string]: unknown;
}

/**
 * Verify Meta's `signed_request` (deauthorize and data deletion callbacks):
 * `<base64url HMAC-SHA256 of the encoded payload>.<base64url JSON payload>`.
 */
export function parseSignedRequest(signedRequest: string, appSecret: string): SignedRequestPayload {
  const [sig, encoded, extra] = signedRequest.split('.');
  if (!sig || !encoded || extra !== undefined) {
    throw new InvalidSignedRequestError('Malformed signed_request');
  }
  const expected = createHmac('sha256', appSecret).update(encoded).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new InvalidSignedRequestError('Bad signed_request signature');
  }
  let payload: SignedRequestPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw new InvalidSignedRequestError('signed_request payload is not JSON');
  }
  if (payload.algorithm?.toUpperCase() !== 'HMAC-SHA256') {
    throw new InvalidSignedRequestError('Unsupported signed_request algorithm');
  }
  return payload;
}
