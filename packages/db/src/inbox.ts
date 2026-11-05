import type { ConversationDto, MessageDto } from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';

/** Everything `conversationToDto` needs. Requires an org context (RLS). */
export const conversationInclude = {
  contact: { select: { id: true, name: true, waId: true } },
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
    phoneNumber: { id: c.phone.id, display: c.phone.displayPhoneNumber, status: c.phone.status },
    assignee: c.assignee,
    labels: c.labels.map((l) => l.label),
    lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
    lastMessagePreview: c.lastMessagePreview,
    unreadCount: c.unreadCount,
    windowExpiresAt: c.windowExpiresAt?.toISOString() ?? null,
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
    createdAt: m.createdAt.toISOString(),
  };
}
