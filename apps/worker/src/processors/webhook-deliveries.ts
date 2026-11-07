import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { withTenant } from '@wacrm/db';
import {
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  type WebhookDeliveryJob,
} from '@wacrm/shared';
import {
  isPrivateAddress,
  signWebhook,
  WEBHOOK_SIGNATURE_HEADER,
  webhookSecretAad,
} from '@wacrm/shared/server';
import type { WorkerDeps } from '../deps';

const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_KEEP_BYTES = 1024;
/** A delivery being worked on is not picked up again until this passes, which covers a crash. */
const LEASE_MS = 120_000;

export interface WebhookResponse {
  status: number;
  body: string;
}
export type WebhookPoster = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<WebhookResponse>;

/**
 * POST to a customer's URL. The address is checked when connecting rather than beforehand, so a
 * name cannot pass a check and then resolve somewhere internal. Redirects are not followed, since
 * one could point anywhere. Only a little of the response is kept.
 */
export function createWebhookPoster(opts: { allowPrivate: boolean }): WebhookPoster {
  const lookup: LookupFunction = (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as { address: string; family: number }[];
      if (!opts.allowPrivate && list.some((a) => isPrivateAddress(a.address))) {
        return callback(new Error('This address is not reachable from the internet'), '', 0);
      }
      if (options.all) return callback(null, list as never, 0);
      const first = list[0];
      return first
        ? callback(null, first.address, first.family)
        : callback(new Error('No address'), '', 0);
    });
  };

  return (rawUrl, headers, body) =>
    new Promise((resolve, reject) => {
      const url = new URL(rawUrl);
      if (!opts.allowPrivate && isPrivateLiteral(url.hostname)) {
        reject(new Error('This address is not reachable from the internet'));
        return;
      }
      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(
        url,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          timeout: REQUEST_TIMEOUT_MS,
          lookup,
        },
        (res) => {
          let kept = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            if (kept.length < RESPONSE_KEEP_BYTES) kept += chunk;
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, body: kept.slice(0, RESPONSE_KEEP_BYTES) }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('Timed out after 10 seconds')));
      req.on('error', reject);
      req.end(body);
    });
}

/** A hostname that is already an address never goes through `lookup`. */
function isPrivateLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return /^[\d.]+$|:/.test(host) && isPrivateAddress(host);
}

/** Pending deliveries that are due, across every org. A definer function returning only ids. */
export function dueWebhookDeliveries(deps: Pick<WorkerDeps, 'db'>, limit = 500) {
  return deps.db.$queryRaw<{ org_id: string; id: string; next_attempt_at: Date }[]>`
    SELECT org_id, id, next_attempt_at FROM webhook_due_deliveries(${limit}::int)`;
}

export function purgeWebhookDeliveries(deps: Pick<WorkerDeps, 'db'>, retentionDays: number) {
  const before = new Date(Date.now() - retentionDays * 86_400_000);
  return deps.db.$queryRaw<{ n: number }[]>`SELECT webhook_deliveries_purge(${before}) AS n`;
}

/**
 * Try one delivery once, and record what happened. Retries are the row's own `next_attempt_at`,
 * which the schedule picks up, so they survive a restart and show in the delivery log. Delivery
 * is at least once: receivers dedupe on the event id, which stays the same across retries.
 */
export async function deliverWebhook(
  deps: WorkerDeps,
  job: WebhookDeliveryJob,
): Promise<'delivered' | 'retrying' | 'failed' | 'skipped'> {
  const { orgId, deliveryId } = job;
  const now = Date.now();
  const claimed = await withTenant(deps.db, { orgId }, async (tx) => {
    const res = await tx.webhookDelivery.updateMany({
      where: { id: deliveryId, status: 'pending', nextAttemptAt: { lte: new Date(now) } },
      data: { nextAttemptAt: new Date(now + LEASE_MS) },
    });
    if (res.count === 0) return null;
    return tx.webhookDelivery.findUniqueOrThrow({
      where: { id: deliveryId },
      include: { endpoint: true },
    });
  });
  if (!claimed) return 'skipped';

  const { endpoint } = claimed;
  const record = (data: {
    status: 'pending' | 'delivered' | 'failed';
    nextAttemptAt: Date | null;
    responseStatus?: number | null;
    responseBody?: string | null;
    error?: string | null;
    durationMs?: number;
    deliveredAt?: Date;
    attempts: number;
  }) =>
    withTenant(deps.db, { orgId }, (tx) =>
      tx.webhookDelivery.update({ where: { id: deliveryId }, data }),
    );

  // Switched off after this was queued. The test button still reaches a switched-off endpoint.
  if (!endpoint.active && claimed.eventType !== 'webhook.test') {
    await record({
      status: 'failed',
      nextAttemptAt: null,
      error: 'The endpoint is switched off',
      attempts: claimed.attempts,
    });
    return 'failed';
  }

  const body = JSON.stringify(claimed.payload);
  const at = Math.floor(now / 1000);
  const secret = deps.secrets.decrypt(endpoint.secretEnc, webhookSecretAad(endpoint.id));
  const attempts = claimed.attempts + 1;
  const started = Date.now();
  let response: WebhookResponse | null = null;
  let error: string | null = null;
  try {
    response = await deps.postWebhook(
      endpoint.url,
      {
        'content-type': 'application/json',
        'user-agent': 'WhatsAppCRM-Webhooks/1',
        [WEBHOOK_SIGNATURE_HEADER]: signWebhook(secret, body, at),
        'x-wacrm-event': claimed.eventType,
        'x-wacrm-event-id': claimed.eventId,
        'x-wacrm-delivery-id': claimed.id,
      },
      body,
    );
  } catch (err) {
    error = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
  const durationMs = Date.now() - started;
  const outcome = {
    attempts,
    durationMs,
    responseStatus: response?.status ?? null,
    responseBody: response?.body ?? null,
  };

  if (response && response.status >= 200 && response.status < 300) {
    await record({
      ...outcome,
      status: 'delivered',
      nextAttemptAt: null,
      deliveredAt: new Date(),
      error: null,
    });
    return 'delivered';
  }
  const problem = error ?? `The endpoint answered ${response?.status}`;
  const delay = WEBHOOK_RETRY_DELAYS_SECONDS[attempts - 1];
  if (attempts >= WEBHOOK_MAX_ATTEMPTS || delay === undefined) {
    await record({ ...outcome, status: 'failed', nextAttemptAt: null, error: problem });
    return 'failed';
  }
  await record({
    ...outcome,
    status: 'pending',
    nextAttemptAt: new Date(Date.now() + delay * 1000),
    error: problem,
  });
  return 'retrying';
}
