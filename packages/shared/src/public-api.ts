/**
 * The public contract: API key scopes, webhook events, and what /v1 and webhooks return. These
 * shapes are their own, mapped from internal DTOs, so an internal change cannot break an integration.
 */
import { z } from 'zod';
import type { CampaignCounts, CampaignDto } from './campaigns';
import type { ContactDto } from './contacts';
import type { ConversationDto, MessageDto } from './inbox';
import { templateVariables, type TemplateDto } from './templates';

export const API_SCOPES = [
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'messages:send',
  'templates:read',
  'campaigns:read',
  'campaigns:write',
  'tags:read',
  'tags:write',
  'hooks:manage',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export const API_SCOPE_LABELS: Record<ApiScope, string> = {
  'contacts:read': 'Read contacts',
  'contacts:write': 'Create and change contacts',
  'conversations:read': 'Read conversations and messages',
  'messages:send': 'Send messages',
  'templates:read': 'Read templates',
  'campaigns:read': 'Read campaigns and reports',
  'campaigns:write': 'Create and control campaigns',
  'tags:read': 'Read tags',
  'tags:write': 'Create tags',
  'hooks:manage': 'Subscribe to events (Zapier, Make)',
};

export const WEBHOOK_EVENTS = [
  'message.received',
  'message.status',
  'contact.created',
  'contact.opted_out',
  'campaign.completed',
  'campaign.paused',
  'template.status_changed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEventType, string> = {
  'message.received': 'A customer sent a message',
  'message.status': 'A sent message changed status',
  'contact.created': 'A contact was created',
  'contact.opted_out': 'A contact opted out',
  'campaign.completed': 'A campaign finished',
  'campaign.paused': 'A campaign paused',
  'template.status_changed': 'A template was approved, rejected or paused',
};

/** Only sent by the Send test button, so it cannot be subscribed to. */
export const WEBHOOK_TEST_EVENT = 'webhook.test';

/** After the first try: 30 s, 2 min, 10 min, 30 min, 2 h, 6 h, 12 h, 24 h. Then it is failed. */
export const WEBHOOK_RETRY_DELAYS_SECONDS = [30, 120, 600, 1800, 7200, 21600, 43200, 86400];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

export const MAX_WEBHOOK_ENDPOINTS = 10;
/** Subscriptions made through the API (one per Zap or scenario), counted apart from the above. */
export const MAX_API_HOOKS = 100;

// ------------------------------------------------------------------ dashboard input

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1, 'Give the key a name').max(80),
  scopes: z.array(z.enum(API_SCOPES)).min(1, 'Choose at least one permission'),
  /** Null means the key does not expire. */
  expiresInDays: z.coerce.number().int().min(1).max(3650).nullable().default(null),
});
export type CreateApiKeyInput = z.input<typeof createApiKeySchema>;
export type CreateApiKeyParsed = z.infer<typeof createApiKeySchema>;

const webhookUrl = z
  .url('Enter a full URL')
  .max(2000)
  .refine((v) => /^https?:\/\//i.test(v), 'Use an https:// address');

export const createWebhookEndpointSchema = z.object({
  url: webhookUrl,
  description: z.string().trim().max(200).nullable().default(null),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event'),
});
export type CreateWebhookEndpointInput = z.input<typeof createWebhookEndpointSchema>;
export type CreateWebhookEndpointParsed = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z.object({
  url: webhookUrl.optional(),
  description: z.string().trim().max(200).nullable().optional(),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1, 'Choose at least one event').optional(),
  active: z.boolean().optional(),
});
export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export const WEBHOOK_DELIVERY_STATUSES = ['pending', 'delivered', 'failed'] as const;
export type WebhookDeliveryStatus = (typeof WEBHOOK_DELIVERY_STATUSES)[number];

export const listWebhookDeliveriesSchema = z.object({
  status: z.enum(WEBHOOK_DELIVERY_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListWebhookDeliveriesQuery = z.infer<typeof listWebhookDeliveriesSchema>;

// ------------------------------------------------------------------ dashboard DTOs

export interface ApiKeyDto {
  id: string;
  name: string;
  /** Enough to recognise a key. The secret part is never shown again. */
  prefix: string;
  scopes: ApiScope[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKeyDto extends ApiKeyDto {
  /** Shown once, at creation. */
  key: string;
}

export interface WebhookEndpointDto {
  id: string;
  url: string;
  description: string | null;
  events: WebhookEventType[];
  active: boolean;
  /** Set when an integration (Zapier, Make) subscribed with this API key. */
  apiKeyId: string | null;
  createdAt: string;
}

export interface CreatedWebhookEndpointDto extends WebhookEndpointDto {
  /** Shown once, at creation or rotation. */
  secret: string;
}

export interface WebhookDeliveryDto {
  id: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  responseStatus: number | null;
  responseBody: string | null;
  error: string | null;
  durationMs: number | null;
  deliveredAt: string | null;
  replayOfId: string | null;
  createdAt: string;
}

// ------------------------------------------------------------------ what /v1 returns

export const publicContactSchema = z.object({
  id: z.uuid(),
  waId: z
    .string()
    .nullable()
    .describe(
      'The number in E.164 digits, with no plus. Null for someone known only on Instagram or website chat',
    ),
  name: z.string().nullable(),
  email: z.string().nullable(),
  customFields: z.record(z.string(), z.unknown()),
  tags: z.array(z.object({ id: z.uuid(), name: z.string() })),
  optInStatus: z.enum(['unknown', 'opted_in', 'opted_out']),
  lastActivityAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicContact = z.infer<typeof publicContactSchema>;

export const publicTagSchema = z.object({ id: z.uuid(), name: z.string(), color: z.string() });

export const publicMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  direction: z.string().describe('inbound or outbound'),
  type: z.string(),
  status: z.string().describe('queued, sending, sent, delivered, read, failed or received'),
  body: z.string().nullable(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicMessage = z.infer<typeof publicMessageSchema>;

export const publicConversationSchema = z.object({
  id: z.uuid(),
  status: z.string(),
  contact: z.object({ id: z.uuid(), name: z.string().nullable(), waId: z.string().nullable() }),
  channel: z.enum(['whatsapp', 'instagram', 'webchat']),
  phoneNumberId: z.uuid().nullable().describe('WhatsApp conversations only'),
  lastMessageAt: z.string().nullable(),
  windowExpiresAt: z
    .string()
    .nullable()
    .describe('Free-form text is allowed until this time. Templates are allowed at any time.'),
  unreadCount: z.number(),
});
export type PublicConversation = z.infer<typeof publicConversationSchema>;

export const publicTemplateSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  language: z.string(),
  category: z.string(),
  status: z.string(),
  sendable: z.boolean(),
  body: z.string().nullable(),
  variables: z.array(z.string()).describe('Keys to fill in `variables` when sending'),
});
export type PublicTemplate = z.infer<typeof publicTemplateSchema>;

export const publicCampaignSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.string(),
  phoneNumberId: z.uuid(),
  templateId: z.uuid(),
  scheduledAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  pauseReason: z.string().nullable(),
  createdAt: z.string(),
});
export type PublicCampaign = z.infer<typeof publicCampaignSchema>;

export const publicCampaignReportSchema = publicCampaignSchema.extend({
  counts: z.object({
    total: z.number(),
    pending: z.number(),
    sent: z.number(),
    delivered: z.number(),
    read: z.number(),
    replied: z.number(),
    failed: z.number(),
    skipped: z.number(),
    cancelled: z.number(),
  }),
  costMicros: z.number().describe('Whole micro-units: 1 unit of currency is 1,000,000'),
  currency: z.string(),
});
export type PublicCampaignReport = z.infer<typeof publicCampaignReportSchema>;

export const publicPage = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const publicErrorSchema = z.object({
  code: z.string().describe('A stable error code'),
  message: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
});

// ------------------------------------------------------------------ /v1 input

/** Sent as a template, or as text inside the 24-hour window. */
export const publicSendMessageSchema = z
  .object({
    to: z.string().trim().min(5).max(32).describe('The phone number, with its country code'),
    defaultCountry: z
      .string()
      .regex(/^[A-Z]{2}$/)
      .optional()
      .describe('Country for a number with no plus, such as IN'),
    phoneNumberId: z
      .uuid()
      .optional()
      .describe('Which of your WhatsApp numbers to send from. Needed if you have more than one.'),
    idempotencyKey: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe('Sending the same key again returns the first message rather than a second send.'),
    type: z.enum(['text', 'template']),
    body: z.string().trim().min(1).max(4096).optional().describe('For type text'),
    templateId: z.uuid().optional().describe('For type template'),
    templateName: z.string().max(512).optional().describe('For type template, instead of its id'),
    language: z.string().max(20).optional().describe('Needed with templateName, such as en_US'),
    variables: z
      .record(z.string().max(100), z.string().max(1024))
      .default({})
      .describe('Values by variable key, as listed on the template'),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'text' && !v.body) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'A text message needs a body' });
    }
    if (v.type === 'template' && !v.templateId && !(v.templateName && v.language)) {
      ctx.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'Give templateId, or templateName with language',
      });
    }
  });
export type PublicSendMessageInput = z.input<typeof publicSendMessageSchema>;
export type PublicSendMessageParsed = z.infer<typeof publicSendMessageSchema>;

export const publicListConversationsSchema = z.object({
  status: z.enum(['open', 'closed', 'any']).default('any'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type PublicListConversationsQuery = z.infer<typeof publicListConversationsSchema>;

export const publicListMessagesSchema = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type PublicListMessagesQuery = z.infer<typeof publicListMessagesSchema>;

export const publicListContactsSchema = z.object({
  q: z.string().trim().max(100).optional().describe('Matches name, email or number'),
  tagId: z.uuid().optional(),
  optIn: z.enum(['unknown', 'opted_in', 'opted_out']).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ------------------------------------------------------------------ mapping

export const toPublicContact = (c: ContactDto): PublicContact => ({
  id: c.id,
  waId: c.waId,
  name: c.name,
  email: c.email,
  customFields: c.customFields,
  tags: c.tags.map((t) => ({ id: t.id, name: t.name })),
  optInStatus: c.optInStatus,
  lastActivityAt: c.lastActivityAt,
  createdAt: c.createdAt,
});

export const toPublicMessage = (m: MessageDto): PublicMessage => ({
  id: m.id,
  conversationId: m.conversationId,
  direction: m.direction,
  type: m.type,
  status: m.status,
  body: m.body,
  errorCode: m.errorCode,
  errorMessage: m.errorMessage,
  createdAt: m.createdAt,
});

export const toPublicConversation = (c: ConversationDto): PublicConversation => ({
  id: c.id,
  status: c.status,
  contact: { id: c.contact.id, name: c.contact.name, waId: c.contact.waId },
  channel: c.channel.kind,
  phoneNumberId: c.phoneNumber?.id ?? null,
  lastMessageAt: c.lastMessageAt,
  windowExpiresAt: c.windowExpiresAt,
  unreadCount: c.unreadCount,
});

export const toPublicTemplate = (t: TemplateDto): PublicTemplate => ({
  id: t.id,
  name: t.name,
  language: t.language,
  category: t.category,
  status: t.status,
  sendable: t.supported && t.status === 'approved',
  body: t.definition?.body ?? null,
  variables: t.definition ? templateVariables(t.definition).map((v) => v.key) : [],
});

export const toPublicCampaign = (c: CampaignDto): PublicCampaign => ({
  id: c.id,
  name: c.name,
  status: c.status,
  phoneNumberId: c.phoneId,
  templateId: c.templateId,
  scheduledAt: c.scheduledAt,
  startedAt: c.startedAt,
  finishedAt: c.finishedAt,
  pauseReason: c.pauseReason,
  createdAt: c.createdAt,
});

export const toPublicCampaignCounts = (c: CampaignCounts) => ({
  total: c.total,
  pending: c.pending + c.sending,
  sent: c.sent,
  delivered: c.delivered,
  read: c.read,
  replied: c.replied,
  failed: c.failed,
  skipped: c.skipped,
  cancelled: c.cancelled,
});

// ------------------------------------------------------------------ hooks (Zapier, Make)

/** REST hooks: an integration platform subscribes a URL to one event when a Zap is turned on. */
export const publicHookSubscribeSchema = z.object({
  url: webhookUrl.describe('Where to POST each event (https)'),
  event: z.enum(WEBHOOK_EVENTS),
});
export type PublicHookSubscribeParsed = z.infer<typeof publicHookSubscribeSchema>;

export const publicHookSchema = z.object({
  id: z.uuid(),
  url: z.string(),
  event: z.enum(WEBHOOK_EVENTS),
  createdAt: z.string(),
});
export type PublicHook = z.infer<typeof publicHookSchema>;

export const publicHookSampleParamsSchema = z.object({ event: z.enum(WEBHOOK_EVENTS) });

/** The body an endpoint receives: an envelope around the event's data. */
export const publicHookEventSchema = z.object({
  id: z.uuid().describe('Same across retries and replays: dedupe on it'),
  type: z.enum(WEBHOOK_EVENTS),
  createdAt: z.string(),
  data: z.record(z.string(), z.unknown()),
});

const SAMPLE_CONTACT = { id: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a81', waId: '919800000000' };
const SAMPLE_MESSAGE = {
  id: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a82',
  conversationId: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a83',
  direction: 'inbound',
  type: 'text',
  status: 'received',
  body: 'Hi, is my order on its way?',
  errorCode: null,
  errorMessage: null,
  createdAt: '2026-11-11T10:00:00.000Z',
};

/** What each event's data looks like, for integration platforms to show before one happens. */
export const WEBHOOK_EVENT_SAMPLES: Record<WebhookEventType, Record<string, unknown>> = {
  'message.received': {
    message: SAMPLE_MESSAGE,
    contact: { ...SAMPLE_CONTACT, name: 'Asha Rao' },
    phoneNumberId: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a84',
  },
  'message.status': {
    message: { ...SAMPLE_MESSAGE, direction: 'outbound', status: 'delivered', body: 'On its way!' },
  },
  'contact.created': { ...SAMPLE_CONTACT, name: 'Asha Rao' },
  'contact.opted_out': SAMPLE_CONTACT,
  'campaign.completed': {
    id: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a85',
    counts: {
      total: 120,
      pending: 0,
      sent: 4,
      delivered: 70,
      read: 40,
      replied: 6,
      failed: 2,
      skipped: 4,
      cancelled: 0,
    },
    costMicros: 58_000_000,
  },
  'campaign.paused': {
    id: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a85',
    name: 'Diwali offer',
    code: 'manual',
    reason: 'Paused by a team member.',
  },
  'template.status_changed': {
    id: '0193b3c2-7a1e-7c55-9f0a-3c4d5e6f7a86',
    name: 'order_update',
    language: 'en',
    status: 'approved',
    previousStatus: 'pending',
    reason: null,
  },
};

/** A sample in the envelope endpoints receive. */
export function sampleWebhookEvent(type: WebhookEventType) {
  return {
    id: '0193b3c2-7a1e-7c55-9f0a-000000000000',
    type,
    createdAt: '2026-11-11T10:00:00.000Z',
    data: WEBHOOK_EVENT_SAMPLES[type],
  };
}
