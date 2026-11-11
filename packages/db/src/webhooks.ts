import { randomUUID } from 'node:crypto';
import type { ApiKeyDto, ApiScope, WebhookDeliveryDto, WebhookEndpointDto } from '@wacrm/shared';
import type { WebhookEventType } from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

/**
 * Record an event for every endpoint subscribed to it, in the transaction of the change itself. If
 * the change rolls back, so does the event, and if it commits the event cannot be lost. The worker
 * picks up pending rows on its own schedule, so nothing here talks to Redis or the network.
 */
export async function emitWebhookEvent(
  tx: TenantTx,
  orgId: string,
  type: WebhookEventType | 'webhook.test',
  data: Prisma.InputJsonValue,
  opts: { endpointId?: string } = {},
): Promise<number> {
  const endpoints = await tx.webhookEndpoint.findMany({
    where: opts.endpointId
      ? { id: opts.endpointId }
      : {
          orgId,
          active: true,
          events: { has: type },
          // A subscription made with an API key lasts only as long as the key.
          OR: [
            { apiKeyId: null },
            {
              apiKey: {
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
              },
            },
          ],
        },
    select: { id: true },
  });
  if (endpoints.length === 0) return 0;
  const eventId = randomUUID();
  const createdAt = new Date();
  await tx.webhookDelivery.createMany({
    data: endpoints.map((e) => ({
      orgId,
      endpointId: e.id,
      eventId,
      eventType: type,
      payload: { id: eventId, type, createdAt: createdAt.toISOString(), data },
      nextAttemptAt: createdAt,
    })),
  });
  return endpoints.length;
}

export function apiKeyToDto(k: Prisma.ApiKeyGetPayload<object>): ApiKeyDto {
  return {
    id: k.id,
    name: k.name,
    prefix: k.prefix,
    scopes: k.scopes as ApiScope[],
    lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
    expiresAt: k.expiresAt?.toISOString() ?? null,
    revokedAt: k.revokedAt?.toISOString() ?? null,
    createdAt: k.createdAt.toISOString(),
  };
}

/** Whitelisted, so the stored secret can never leave through this. */
export function webhookEndpointToDto(
  e: Prisma.WebhookEndpointGetPayload<object>,
): WebhookEndpointDto {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.events as WebhookEventType[],
    active: e.active,
    apiKeyId: e.apiKeyId,
    createdAt: e.createdAt.toISOString(),
  };
}

export function webhookDeliveryToDto(
  d: Prisma.WebhookDeliveryGetPayload<object>,
): WebhookDeliveryDto {
  return {
    id: d.id,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attempts: d.attempts,
    nextAttemptAt: d.nextAttemptAt?.toISOString() ?? null,
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    error: d.error,
    durationMs: d.durationMs,
    deliveredAt: d.deliveredAt?.toISOString() ?? null,
    replayOfId: d.replayOfId,
    createdAt: d.createdAt.toISOString(),
  };
}
