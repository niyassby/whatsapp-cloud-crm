import {
  type ConversationDto,
  type MessageDetail,
  type MessageDto,
  type OrderContent,
  orderItems,
  orderTotal,
} from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';

/** Everything `conversationToDto` needs. Requires an org context (RLS). */
export const conversationInclude = {
  contact: { select: { id: true, name: true, waId: true, optInStatus: true } },
  channel: { select: { id: true, kind: true, name: true, status: true } },
  phone: { select: { id: true, displayPhoneNumber: true, status: true } },
  assignee: { select: { id: true, name: true } },
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
} as const;

export type ConversationWithRelations = Prisma.ConversationGetPayload<{
  include: typeof conversationInclude;
}>;

export function conversationToDto(c: ConversationWithRelations): ConversationDto {
  return {
    id: c.id,
    status: c.status,
    contact: c.contact,
    channel: c.channel,
    phoneNumber: c.phone
      ? { id: c.phone.id, display: c.phone.displayPhoneNumber, status: c.phone.status }
      : null,
    ad: c.adSourceId || c.adHeadline ? { sourceId: c.adSourceId, headline: c.adHeadline } : null,
    assignee: c.assignee,
    labels: c.labels.map((l) => l.label),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    unreadCount: c.unreadCount,
    windowExpiresAt: c.windowExpiresAt?.toISOString() ?? null,
    awaitingReplySince: c.awaitingReplySince?.toISOString() ?? null,
    slaBreached: c.slaStage > 0,
  };
}

export const messageInclude = { sender: { select: { name: true } } } as const;

export type MessageWithRelations = Prisma.MessageGetPayload<{ include: typeof messageInclude }>;

/** Whitelist mapping: storage keys and Meta media ids stay on the server. */
export function messageToDto(m: MessageWithRelations): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    status: m.status,
    body: m.body,
    senderUserId: m.senderUserId,
    senderName: m.sender?.name ?? null,
    errorCode: m.errorCode,
    errorMessage: m.errorMessage,
    media: m.mediaStatus
      ? {
          status: m.mediaStatus,
          mimeType: m.mediaMime,
          filename: m.mediaFilename,
          size: m.mediaSize,
        }
      : null,
    detail: messageDetail(m.type, m.content),
    createdAt: m.createdAt.toISOString(),
  };
}

function messageDetail(type: string, content: unknown): MessageDetail | null {
  const c = (content ?? {}) as Record<string, unknown>;
  if (type === 'call') {
    return {
      kind: 'call',
      status: String(c.status ?? ''),
      direction: String(c.direction ?? ''),
      durationSec: typeof c.durationSec === 'number' ? c.durationSec : null,
    };
  }
  if (type === 'order') {
    const order = c as OrderContent;
    const { total, currency } = orderTotal(order);
    return {
      kind: 'order',
      items: orderItems(order).map((i) => ({
        retailerId: i.product_retailer_id,
        quantity: Number(i.quantity),
        price: Number(i.item_price),
        currency: i.currency,
      })),
      total,
      currency,
    };
  }
  if (type === 'product' || type === 'product_list') {
    const p = (c.products ?? {}) as { sections?: { retailerIds: string[] }[] };
    const count = p.sections ? p.sections.reduce((n, s) => n + s.retailerIds.length, 0) : 1;
    return { kind: 'products', count };
  }
  return null;
}
