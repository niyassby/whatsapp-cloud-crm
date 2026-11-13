import { randomUUID } from 'node:crypto';
import {
  applyRecipientStatus,
  conversationToDto,
  emitWebhookEvent,
  type InboundResult,
  messageInclude,
  messageToDto,
  type Prisma,
  recordInbound,
  refundDebit,
  withTenant,
} from '@wacrm/db';
import { messageDebitKey, toPublicMessage } from '@wacrm/shared';
import { mapError, parseWebhookEvents, type WebhookEvent } from '@wacrm/whatsapp';
import type { WorkerDeps } from '../deps';
import { qrReferralFor } from './channels';

type InboundEvent = Extract<WebhookEvent, { type: 'message' }>;
type StatusEvent = Extract<WebhookEvent, { type: 'status' }>;

interface Extracted {
  type: string;
  body: string | null;
  content?: Prisma.InputJsonValue;
  media?: { id: string; mime: string; filename?: string };
}

/** Types with no customer content. They do not create or touch a conversation. */
const SKIPPED = new Set(['system', 'request_welcome']);

/**
 * Adds what the message replies to (a quick-reply button names the template message it came from)
 * and a click-to-WhatsApp ad referral. Flows trigger on both.
 */
function withReplyContext(
  content: Prisma.InputJsonValue | undefined,
  ev: InboundEvent,
): Prisma.InputJsonValue | undefined {
  const extra = {
    ...(ev.context?.id ? { context: { id: ev.context.id } } : {}),
    ...(ev.referral ? { referral: ev.referral } : {}),
  };
  if (Object.keys(extra).length === 0) return content;
  const base = content && typeof content === 'object' && !Array.isArray(content) ? content : {};
  return { ...base, ...extra } as Prisma.InputJsonValue;
}

function extract(ev: InboundEvent): Extracted {
  switch (ev.messageType) {
    case 'text':
      return { type: 'text', body: ev.text.body };
    case 'image':
      return {
        type: 'image',
        body: ev.image.caption ?? null,
        media: { id: ev.image.id, mime: ev.image.mimeType },
      };
    case 'video':
      return {
        type: 'video',
        body: ev.video.caption ?? null,
        media: { id: ev.video.id, mime: ev.video.mimeType },
      };
    case 'audio':
      return { type: 'audio', body: null, media: { id: ev.audio.id, mime: ev.audio.mimeType } };
    case 'sticker':
      return {
        type: 'sticker',
        body: null,
        media: { id: ev.sticker.id, mime: ev.sticker.mimeType },
      };
    case 'document':
      return {
        type: 'document',
        body: null,
        media: { id: ev.document.id, mime: ev.document.mimeType, filename: ev.document.filename },
      };
    case 'location': {
      const { latitude, longitude, name, address } = ev.location;
      return {
        type: 'location',
        body: [name, address].filter(Boolean).join(', ') || `${latitude}, ${longitude}`,
        content: { latitude, longitude },
      };
    }
    case 'button':
      return {
        type: 'button',
        body: ev.button.text,
        content: { payload: ev.button.payload ?? null },
      };
    case 'interactive': {
      const reply = ev.reply;
      return {
        type: 'interactive',
        body: reply.kind === 'button_reply' || reply.kind === 'list_reply' ? reply.title : null,
        // reply carries the tapped button or row id, which flows branch on.
        content: { ...(ev.interactive as object), reply: ev.reply } as Prisma.InputJsonValue,
      };
    }
    case 'reaction':
      return { type: 'reaction', body: ev.reaction.emoji };
    case 'contacts':
      return { type: 'contacts', body: null, content: ev.contacts as Prisma.InputJsonValue };
    case 'order':
      // Stored in Meta's documented shape, not the SDK's, so the content outlives the SDK.
      return {
        type: 'order',
        body: ev.order.text ?? null,
        content: {
          catalog_id: ev.order.catalogId,
          ...(ev.order.text ? { text: ev.order.text } : {}),
          product_items: ev.order.productItems.map((i) => ({
            product_retailer_id: i.productRetailerId,
            quantity: i.quantity,
            item_price: i.itemPrice,
            currency: i.currency,
          })),
        },
      };
    default:
      return { type: 'unsupported', body: 'This message type is not supported yet.' };
  }
}

/**
 * Creating next month's message partition takes a lock that can deadlock with an insert, and
 * Postgres then cancels one side. The whole transaction rolled back, the wamid claim with it, so
 * running it again is safe. A couple of quick tries saves a job retry with backoff.
 */
async function retryOnDeadlock<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: unknown }).code !== 'P2034' || i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 50 * i));
    }
  }
}

/**
 * Save one inbound message. Safe to run again: the wamid is claimed first, so a Meta redelivery,
 * a job retry or a replay finds the claim and changes nothing (unread counts do not double).
 */
async function applyInbound(deps: WorkerDeps, orgId: string, ev: InboundEvent): Promise<void> {
  if (SKIPPED.has(ev.messageType)) return;
  const data = extract(ev);
  const messageId = randomUUID();
  const createdAt = new Date();

  const saved = await retryOnDeadlock(() =>
    withTenant(deps.db, { orgId }, async (tx) => {
      const channel = await tx.channel.findFirst({
        where: {
          kind: 'whatsapp',
          status: 'active',
          phone: { phoneNumberId: ev.phoneNumberId, status: { not: 'disconnected' } },
        },
        select: { id: true, phoneId: true },
      });
      if (!channel) return null;
      return recordInbound(tx, {
        orgId,
        channel: { id: channel.id, kind: 'whatsapp', phoneId: channel.phoneId },
        sender: { waId: ev.sender, name: ev.profileName ?? null },
        ref: { kind: 'wamid', id: ev.id },
        sentAt: new Date(Number(ev.timestamp) * 1000),
        messageId,
        createdAt,
        type: data.type,
        body: data.body,
        content: withReplyContext(data.content, ev),
        media: data.media,
        // A click-to-WhatsApp ad, or else a QR code whose exact message this is.
        referral:
          ev.referral ??
          (data.type === 'text' && channel.phoneId
            ? await qrReferralFor(tx, channel.phoneId, data.body)
            : null),
      });
    }),
  );
  if (!saved) return;
  await afterInbound(deps, orgId, saved);
  if (saved.kind === 'saved' && data.media) {
    await deps.enqueueMediaDownload({
      orgId,
      messageId,
      createdAt: createdAt.toISOString(),
      metaMediaId: data.media.id,
      phoneNumberId: ev.phoneNumberId,
    });
  }
}

/** Publish and queue the rules after an inbound message on any channel is saved. */
export async function afterInbound(
  deps: WorkerDeps,
  orgId: string,
  saved: InboundResult,
): Promise<void> {
  if (saved.kind === 'duplicate') {
    // Already saved. The rules may not have run if queueing failed last time; a second run is
    // stopped by the claim inside it, so queueing again is safe.
    await deps.enqueueAutomation({
      orgId,
      messageId: saved.messageId,
      createdAt: saved.messageCreatedAt.toISOString(),
    });
    return;
  }
  if (saved.campaignId) {
    deps.publisher.emit(orgId, 'campaign:updated', { campaignId: saved.campaignId });
  }
  if (saved.optedOut) deps.publisher.emit(orgId, 'contact:updated', { contactId: saved.contactId });
  deps.publisher.emit(orgId, 'message:new', { message: messageToDto(saved.message) });
  deps.publisher.emit(orgId, 'conversation:updated', {
    conversation: conversationToDto(saved.conversation),
  });
  await deps.enqueueAutomation({
    orgId,
    messageId: saved.message.id,
    createdAt: saved.message.createdAt.toISOString(),
  });
}

const RANK: Record<string, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
};

/** Outbound sends carry `<messageId>|<createdAt>` so a status can find its message directly. */
export const callbackData = (messageId: string, createdAt: Date) =>
  `${messageId}|${createdAt.toISOString()}`;

function parseCallback(raw: string | undefined) {
  const [messageId, iso] = (raw ?? '').split('|');
  const createdAt = iso ? new Date(iso) : null;
  if (!messageId || !createdAt || Number.isNaN(createdAt.getTime())) return null;
  return { messageId, createdAt };
}

/**
 * Apply a delivery status. Meta can deliver these out of order, and even before our send call
 * returns, so ticks only ever move forward. A failure counts unless the message was already read.
 */
async function applyStatus(deps: WorkerDeps, orgId: string, ev: StatusEvent): Promise<void> {
  if (ev.status === 'deleted' || ev.status === 'warning') return;
  const { status } = ev;
  const at = new Date(Number(ev.timestamp) * 1000);

  let refunded = false;
  let campaignId: string | null = null;
  const updated = await withTenant(deps.db, { orgId }, async (tx) => {
    let target = parseCallback(ev.bizOpaqueCallbackData);
    if (!target) {
      const ref = await tx.messageRef.findUnique({
        where: { orgId_kind_ref: { orgId, kind: 'wamid', ref: ev.messageId } },
      });
      // Not one of ours: sent from another tool on the same number.
      if (!ref) return null;
      target = { messageId: ref.messageId, createdAt: ref.messageCreatedAt };
    }
    const where = { id_createdAt: { id: target.messageId, createdAt: target.createdAt } };
    const message = await tx.message.findUnique({ where, select: { status: true } });
    if (!message) return null;

    // Meta's word on billing beats our estimate. Refunding twice is impossible, so this can run
    // on every status that says so, whatever the order they arrive in.
    if (status === 'failed' || ev.pricing?.billable === false) {
      const refund = await refundDebit(tx, {
        orgId,
        debitKey: messageDebitKey(target.messageId),
        description: status === 'failed' ? 'Delivery failed' : 'Not billed by Meta',
      });
      refunded = refund.applied;
    }

    let data: Prisma.MessageUpdateInput;
    if (status === 'failed') {
      if (message.status === 'read') return null;
      const first = ev.errors?.[0];
      const mapped = mapError({
        message: first?.error_data?.details ?? first?.message ?? first?.title ?? 'Delivery failed',
        code: first?.code,
        httpStatus: 400,
      });
      data = {
        status: 'failed',
        failedAt: at,
        errorCode: mapped.code,
        errorMessage: mapped.message,
        waMessageId: ev.messageId,
      };
    } else {
      if (message.status === 'failed') return null;
      if ((RANK[status] ?? 0) <= (RANK[message.status] ?? 0)) return null;
      data = {
        status,
        waMessageId: ev.messageId,
        ...(status === 'sent' ? { sentAt: at } : {}),
        ...(status === 'delivered' ? { deliveredAt: at } : {}),
        ...(status === 'read' ? { readAt: at } : {}),
      };
    }
    const row = await tx.message.update({ where, data, include: messageInclude });
    await emitWebhookEvent(tx, orgId, 'message.status', {
      message: toPublicMessage(messageToDto(row)),
    });
    if (row.type === 'template') {
      campaignId = await applyRecipientStatus(
        tx,
        target.messageId,
        status,
        status === 'failed'
          ? { code: row.errorCode ?? 'UNKNOWN', message: row.errorMessage ?? 'Delivery failed' }
          : undefined,
      );
    }
    return row;
  });
  if (updated) deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(updated) });
  if (refunded) deps.publisher.emit(orgId, 'wallet:updated', {});
  if (campaignId) deps.publisher.emit(orgId, 'campaign:updated', { campaignId });
}

/** Handle a `messages` webhook change. Each message commits on its own, so retries are cheap. */
export async function processMessagesChange(
  deps: WorkerDeps,
  orgId: string,
  payload: unknown,
): Promise<void> {
  for (const ev of parseWebhookEvents(payload)) {
    if (ev.type === 'message') await applyInbound(deps, orgId, ev);
    else if (ev.type === 'status') await applyStatus(deps, orgId, ev);
  }
}
