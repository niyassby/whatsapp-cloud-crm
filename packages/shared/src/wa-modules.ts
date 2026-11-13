import { z } from 'zod';

/**
 * Extended WhatsApp modules (Phase 4.2): QR codes and short links, catalog and product messages,
 * groups, calling, and click-to-WhatsApp ad attribution. Each is behind its own plan feature.
 */

// ------------------------------------------------------------------ QR codes and short links

export const createQrCodeSchema = z.object({
  phoneId: z.uuid(),
  name: z.string().trim().min(1).max(80),
  /** What the chat opens with. Meta allows 140 characters. */
  prefilledMessage: z.string().trim().min(1).max(140),
});
export type CreateQrCodeInput = z.infer<typeof createQrCodeSchema>;

export const updateQrCodeSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  prefilledMessage: z.string().trim().min(1).max(140).optional(),
});

export interface QrCodeDto {
  id: string;
  phoneId: string;
  name: string;
  prefilledMessage: string;
  /** The short link: wa.me/message/<code>. */
  deepLinkUrl: string;
  /** The QR code for the short link, as an SVG document. */
  svg: string;
  /** Conversations whose first message was exactly the prefilled text. */
  conversationsStarted: number;
  createdAt: string;
}

// ------------------------------------------------------------------ catalog

export interface CatalogProductDto {
  retailerId: string;
  name: string;
  description: string | null;
  price: string | null;
  imageUrl: string | null;
  availability: string | null;
}

export interface CatalogDto {
  /** Null when no catalog is connected to the number's WhatsApp account. */
  catalogId: string | null;
  syncedAt: string | null;
  products: CatalogProductDto[];
}

/** One product, several in sections, or the whole catalog to browse. */
export const sendProductsSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('product'),
    clientMessageId: z.uuid(),
    retailerId: z.string().min(1).max(100),
    body: z.string().trim().max(1024).optional(),
  }),
  z.object({
    kind: z.literal('product_list'),
    clientMessageId: z.uuid(),
    header: z.string().trim().min(1).max(60),
    body: z.string().trim().min(1).max(1024),
    /** Meta allows up to 30 products across up to 10 sections. */
    sections: z
      .array(
        z.object({
          title: z.string().trim().min(1).max(24),
          retailerIds: z.array(z.string().min(1).max(100)).min(1).max(30),
        }),
      )
      .min(1)
      .max(10)
      .refine((s) => s.reduce((n, x) => n + x.retailerIds.length, 0) <= 30, 'At most 30 products'),
  }),
  z.object({
    kind: z.literal('catalog'),
    clientMessageId: z.uuid(),
    body: z.string().trim().min(1).max(1024),
    thumbnailRetailerId: z.string().max(100).optional(),
  }),
]);
export type SendProductsInput = z.infer<typeof sendProductsSchema>;

/** An order a customer placed from the catalog, as stored on the inbound message. */
export interface OrderContent {
  catalog_id?: string;
  text?: string;
  product_items?: {
    product_retailer_id: string;
    quantity: number;
    item_price: number;
    currency: string;
  }[];
}

/**
 * The items of a stored order. Orders saved before 4.2 kept the SDK's camelCase shape, so both
 * are read.
 */
export function orderItems(order: OrderContent): NonNullable<OrderContent['product_items']> {
  if (order.product_items) return order.product_items;
  const legacy = (order as { productItems?: Record<string, unknown>[] }).productItems ?? [];
  return legacy.map((i) => ({
    product_retailer_id: String(i.productRetailerId ?? ''),
    quantity: Number(i.quantity ?? 0),
    item_price: Number(i.itemPrice ?? 0),
    currency: String(i.currency ?? ''),
  }));
}

/** Total of an order message, in the currency's ordinary units. */
export function orderTotal(order: OrderContent): { total: number; currency: string | null } {
  const items = orderItems(order);
  const total = items.reduce((sum, i) => sum + Number(i.item_price) * Number(i.quantity), 0);
  return { total: Math.round(total * 100) / 100, currency: items[0]?.currency ?? null };
}

// ------------------------------------------------------------------ groups

export const createGroupSchema = z.object({
  phoneId: z.uuid(),
  subject: z.string().trim().min(1).max(128),
  description: z.string().trim().max(2048).optional(),
  joinApprovalMode: z.enum(['approval_required', 'auto_approve']).default('approval_required'),
});
export type CreateGroupInput = z.input<typeof createGroupSchema>;

export const groupJoinRequestsSchema = z.object({
  approve: z.array(z.string().min(1).max(100)).max(100).default([]),
  reject: z.array(z.string().min(1).max(100)).max(100).default([]),
});

export const removeParticipantsSchema = z.object({
  /** Meta removes up to 8 at once. */
  users: z.array(z.string().min(1).max(40)).min(1).max(8),
});

export const groupMessageSchema = z.object({
  body: z.string().trim().min(1).max(4096),
});

export interface GroupDto {
  id: string;
  phoneId: string;
  groupId: string | null;
  subject: string;
  description: string | null;
  joinApprovalMode: string;
  inviteLink: string | null;
  participantCount: number | null;
  status: 'pending' | 'active' | 'deleted';
  createdAt: string;
}

export interface GroupJoinRequestDto {
  id: string;
  waId: string | null;
  requestedAt: string;
}

// ------------------------------------------------------------------ calling

export const CALL_STATUSES = [
  'ringing',
  'connected',
  'ended',
  'missed',
  'rejected',
  'failed',
] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];

export const callingSettingsSchema = z.object({
  enabled: z.boolean(),
  /** Show the call button to customers in WhatsApp. */
  iconVisible: z.boolean().default(true),
  /** Let customers allow the business to call them back. */
  callbackPermission: z.boolean().default(true),
});
export type CallingSettingsInput = z.infer<typeof callingSettingsSchema>;

export interface CallingSettingsDto {
  enabled: boolean;
  iconVisible: boolean;
  callbackPermission: boolean;
}

/** WebRTC session description from the agent's browser. */
export const sdpSchema = z.object({
  sdp: z.string().min(10).max(20_000),
});

export interface CallDto {
  id: string;
  conversationId: string;
  direction: 'inbound' | 'outbound';
  status: CallStatus;
  contactName: string | null;
  waId: string | null;
  answeredById: string | null;
  startedAt: string;
  connectedAt: string | null;
  endedAt: string | null;
  durationSec: number | null;
}

export interface CallPermissionDto {
  /** no_permission, temporary or permanent, as Meta reports it. */
  status: string;
  canCall: boolean;
  canRequest: boolean;
}

export const CALL_LABELS: Record<CallStatus, string> = {
  ringing: 'Ringing',
  connected: 'In call',
  ended: 'Call',
  missed: 'Missed call',
  rejected: 'Declined call',
  failed: 'Call failed',
};

// ------------------------------------------------------------------ ad attribution

export const adsReportSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

export interface AdsReportRowDto {
  sourceId: string | null;
  headline: string | null;
  sourceUrl: string | null;
  /** Messages that came from the ad. */
  referrals: number;
  conversations: number;
  /** People who had never written before. */
  newContacts: number;
  /** Conversations where someone from the team replied. */
  replied: number;
  firstAt: string;
  lastAt: string;
}

export interface AdsReportDto {
  days: number;
  rows: AdsReportRowDto[];
}
