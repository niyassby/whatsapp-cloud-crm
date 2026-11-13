import { z } from 'zod';
import type { ChannelKind } from './channels';
import type { OptInStatus } from './contacts';
import type { WhatsAppErrorCode } from './whatsapp';

export const CONVERSATION_FILTERS = ['all', 'mine', 'unassigned'] as const;
export const CONVERSATION_STATUSES = ['open', 'closed'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const listConversationsSchema = z.object({
  filter: z.enum(CONVERSATION_FILTERS).default('all'),
  status: z.enum([...CONVERSATION_STATUSES, 'any']).default('open'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ListConversationsQuery = z.infer<typeof listConversationsSchema>;

export const updateConversationSchema = z
  .object({
    status: z.enum(CONVERSATION_STATUSES).optional(),
    /** null unassigns. */
    assigneeId: z.uuid().nullable().optional(),
  })
  .refine((v) => v.status !== undefined || v.assigneeId !== undefined, 'Nothing to update');
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const setConversationLabelsSchema = z.object({ labelIds: z.array(z.uuid()).max(20) });
export type SetConversationLabelsInput = z.infer<typeof setConversationLabelsSchema>;

/** Client-generated, so a retried request cannot send the same message twice. */
const clientMessageId = z.uuid();
const MAX_TEXT = 4096;

export const sendMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('text'),
    clientMessageId,
    body: z.string().trim().min(1, 'Message is empty').max(MAX_TEXT),
  }),
  z.object({
    type: z.literal('template'),
    clientMessageId,
    templateId: z.uuid(),
    /** Values by variable key, as listed by templateVariables. */
    variables: z.record(z.string().max(100), z.string().max(1024)).default({}),
  }),
]);
export type SendMessageInput = z.input<typeof sendMessageSchema>;
export type SendMessageParsed = z.infer<typeof sendMessageSchema>;

export const sendNoteSchema = z.object({
  clientMessageId,
  body: z.string().trim().min(1, 'Note is empty').max(MAX_TEXT),
});
export type SendNoteInput = z.infer<typeof sendNoteSchema>;

export const sendMediaFieldsSchema = z.object({
  clientMessageId,
  caption: z.string().trim().max(1024).optional(),
});

export const createLabelSchema = z.object({
  name: z.string().trim().min(1, 'Required').max(40),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a hex colour')
    .default('#64748b'),
});
export type CreateLabelInput = z.input<typeof createLabelSchema>;

export const createCannedReplySchema = z.object({
  shortcut: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_-]{1,32}$/, 'Letters, numbers, - and _ only'),
  body: z.string().trim().min(1, 'Required').max(MAX_TEXT),
});
export type CreateCannedReplyInput = z.input<typeof createCannedReplySchema>;

export type MessageDirection = 'inbound' | 'outbound' | 'internal';
export type MessageStatus =
  'received' | 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
export type MediaStatus = 'pending' | 'stored' | 'failed';

export interface MessageDto {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  type: string;
  status: MessageStatus;
  body: string | null;
  senderUserId: string | null;
  senderName: string | null;
  errorCode: WhatsAppErrorCode | string | null;
  errorMessage: string | null;
  media: {
    status: MediaStatus;
    mimeType: string | null;
    filename: string | null;
    size: number | null;
  } | null;
  /** A few whitelisted facts for calls, orders and product messages. Never the raw content. */
  detail: MessageDetail | null;
  createdAt: string;
}

export type MessageDetail =
  | { kind: 'call'; status: string; direction: string; durationSec: number | null }
  | {
      kind: 'order';
      items: { retailerId: string; quantity: number; price: number; currency: string }[];
      total: number;
      currency: string | null;
    }
  | { kind: 'products'; count: number };

export interface ConversationDto {
  id: string;
  status: ConversationStatus;
  contact: { id: string; name: string | null; waId: string | null; optInStatus: OptInStatus };
  channel: { id: string; kind: ChannelKind; name: string; status: string };
  /** WhatsApp conversations only. */
  phoneNumber: { id: string; display: string | null; status: string } | null;
  /** The click-to-chat ad that last brought this customer in. */
  ad: { sourceId: string | null; headline: string | null } | null;
  assignee: { id: string; name: string } | null;
  labels: LabelDto[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  /** Free-form replies are allowed until this moment; templates only afterwards. */
  windowExpiresAt: string | null;
  /** The first customer message no person has answered yet. */
  awaitingReplySince: string | null;
  /** The SLA was missed. */
  slaBreached: boolean;
}

export interface LabelDto {
  id: string;
  name: string;
  color: string;
}

export interface CannedReplyDto {
  id: string;
  shortcut: string;
  body: string;
}

export interface MediaUrlDto {
  url: string;
  expiresIn: number;
}

/** Meta's per-type limits, enforced before anything is stored. */
const MB = 1024 * 1024;
const MEDIA_RULES: { kind: MediaKindName; types: readonly string[]; maxBytes: number }[] = [
  { kind: 'image', types: ['image/jpeg', 'image/png'], maxBytes: 5 * MB },
  { kind: 'video', types: ['video/mp4', 'video/3gpp'], maxBytes: 16 * MB },
  {
    kind: 'audio',
    types: ['audio/aac', 'audio/mp4', 'audio/mpeg', 'audio/amr', 'audio/ogg'],
    maxBytes: 16 * MB,
  },
  {
    kind: 'document',
    types: [
      'application/pdf',
      'text/plain',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
    // Meta allows 100 MB; uploads are buffered in the API, so this is capped lower for now.
    maxBytes: 25 * MB,
  },
];
export type MediaKindName = 'image' | 'video' | 'audio' | 'document';

export const MAX_UPLOAD_BYTES = Math.max(...MEDIA_RULES.map((r) => r.maxBytes));
export const ACCEPTED_MEDIA_TYPES = MEDIA_RULES.flatMap((r) => r.types);

/** Which media kind a MIME type is sent as, or null when WhatsApp does not accept it. */
export function mediaRuleFor(mimeType: string) {
  const clean = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  const rule = MEDIA_RULES.find((r) => r.types.includes(clean));
  return rule ? { kind: rule.kind, maxBytes: rule.maxBytes, mimeType: clean } : null;
}

/** Short text for the conversation list. */
export function messagePreview(type: string, body: string | null): string {
  if (body) return body.slice(0, 120);
  const labels: Record<string, string> = {
    image: 'Photo',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
    sticker: 'Sticker',
    location: 'Location',
    contacts: 'Contact',
    reaction: 'Reaction',
    order: 'Order',
    call: 'Call',
    product: 'Product',
    product_list: 'Products',
    catalog: 'Catalog',
    call_permission_request: 'Call permission request',
  };
  return labels[type] ?? 'Message';
}
