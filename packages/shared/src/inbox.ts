import { z } from 'zod';
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
    templateName: z.string().min(1).max(512),
    language: z.string().min(2).max(16),
    /** Values for {{1}}, {{2}}, ... in the template body. */
    bodyParams: z.array(z.string().trim().min(1).max(1024)).max(50).default([]),
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
  createdAt: string;
}

export interface ConversationDto {
  id: string;
  status: ConversationStatus;
  contact: { id: string; name: string | null; waId: string; optInStatus: OptInStatus };
  phoneNumber: { id: string; display: string | null; status: string };
  assignee: { id: string; name: string } | null;
  labels: LabelDto[];
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  /** Free-form replies are allowed until this moment; templates only afterwards. */
  windowExpiresAt: string | null;
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

export interface InboxTemplateDto {
  name: string;
  language: string;
  category: string;
  body: string;
  /** Number of {{n}} values to fill in. */
  paramCount: number;
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
  };
  return labels[type] ?? 'Message';
}

/** Replace {{1}} style placeholders. Returns the placeholder count and the rendered text. */
export function renderTemplateBody(body: string, params: readonly string[]) {
  const indexes = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1]));
  const paramCount = indexes.length ? Math.max(...indexes) : 0;
  const text = body.replace(/\{\{(\d+)\}\}/g, (all, n: string) => params[Number(n) - 1] ?? all);
  return { paramCount, text };
}
