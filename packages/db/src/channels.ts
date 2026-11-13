import {
  CALL_LABELS,
  type CallDto,
  type CallStatus,
  CHANNEL_CAPABILITIES,
  type ChannelKind,
  isOptOutMessage,
  messagePreview,
  toPublicMessage,
  type WebchatMessageDto,
} from '@wacrm/shared';
import { applyContactReply, exitDripsOnOptOut } from './campaigns';
import { setContactConsent } from './contacts';
import type { Prisma } from './generated/prisma/client';
import { conversationInclude, messageInclude, messageToDto } from './inbox';
import type { TenantTx } from './tenant';
import { emitWebhookEvent } from './webhooks';

/**
 * Channels (Phase 4.2). Saving an inbound message is the same on every channel: claim the
 * provider's message id, find or create the contact, upsert the conversation, save the message,
 * record an ad referral. Only how the contact is found differs: WhatsApp by wa_id, the others by
 * a contact_identities row.
 */

/** Whether a free-form reply is allowed now on this channel. */
export function replyWindowOpen(
  kind: ChannelKind,
  windowExpiresAt: Date | null,
  now: Date = new Date(),
): boolean {
  if (CHANNEL_CAPABILITIES[kind].replyWindowHours === null) return true;
  return windowExpiresAt !== null && windowExpiresAt > now;
}

export interface InboundSender {
  /** WhatsApp: E.164 digits. */
  waId?: string;
  /** Other channels: the provider's id for this person on this channel. */
  externalId?: string;
  name?: string | null;
  /** Instagram username. */
  handle?: string | null;
  email?: string | null;
}

export interface InboundInput {
  orgId: string;
  channel: { id: string; kind: ChannelKind; phoneId: string | null };
  sender: InboundSender;
  /** The provider's message id, claimed so a redelivery changes nothing. */
  ref: { kind: string; id: string };
  sentAt: Date;
  messageId: string;
  createdAt: Date;
  type: string;
  body: string | null;
  content?: Prisma.InputJsonValue;
  media?: { id: string; mime: string; filename?: string };
  /** Click-to-chat ad data as the provider sent it. */
  referral?: Record<string, unknown> | null;
}

export type InboundResult =
  | { kind: 'duplicate'; messageId: string; messageCreatedAt: Date }
  | {
      kind: 'saved';
      conversation: Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;
      message: Prisma.MessageGetPayload<{ include: typeof messageInclude }>;
      contactId: string;
      newContact: boolean;
      optedOut: boolean;
      campaignId: string | null;
    };

/** Message types the customer writes or taps. A photo captioned "stop" is not an opt-out. */
const CAN_OPT_OUT = new Set(['text', 'button', 'interactive']);

const text = (v: unknown, max = 500): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;

/** The same fields from WhatsApp's and Instagram's referral shapes. */
export function normalizeReferral(kind: ChannelKind, raw: Record<string, unknown>) {
  if (kind === 'instagram') {
    const ctx = (raw.ads_context_data ?? {}) as Record<string, unknown>;
    return {
      sourceType: text(raw.source)?.toLowerCase() ?? 'ad',
      sourceId: text(raw.ad_id, 100),
      sourceUrl: null,
      headline: text(ctx.ad_title, 300),
      body: null,
      mediaType: ctx.photo_url ? 'image' : ctx.video_url ? 'video' : null,
      clickId: text(raw.ref, 200),
    };
  }
  return {
    sourceType: text(raw.source_type, 20),
    sourceId: text(raw.source_id, 100),
    sourceUrl: text(raw.source_url, 1000),
    headline: text(raw.headline, 300),
    body: text(raw.body, 1000),
    mediaType: text(raw.media_type, 20),
    clickId: text(raw.ctwa_clid, 200),
  };
}

async function findContact(
  tx: TenantTx,
  input: InboundInput,
): Promise<{ id: string; created: boolean }> {
  const { orgId, sender, sentAt, channel } = input;
  if (sender.waId) {
    const known = await tx.contact.count({ where: { orgId, waId: sender.waId } });
    const row = await tx.contact.upsert({
      where: { orgId_waId: { orgId, waId: sender.waId } },
      create: { orgId, waId: sender.waId, name: sender.name ?? null, lastActivityAt: sentAt },
      update: {},
      select: { id: true, mergedIntoId: true },
    });
    // A duplicate that was merged: its number now belongs to the primary contact.
    return { id: row.mergedIntoId ?? row.id, created: known === 0 };
  }
  if (!sender.externalId) throw new Error('An inbound message needs a wa_id or an external id');
  const identity = await tx.contactIdentity.findUnique({
    where: { channelId_externalId: { channelId: channel.id, externalId: sender.externalId } },
    select: { contact: { select: { id: true, mergedIntoId: true } } },
  });
  if (identity) {
    return { id: identity.contact.mergedIntoId ?? identity.contact.id, created: false };
  }
  const contact = await tx.contact.create({
    data: {
      orgId,
      name: sender.name ?? null,
      email: sender.email ?? null,
      lastActivityAt: sentAt,
    },
    select: { id: true },
  });
  await tx.contactIdentity.create({
    data: {
      orgId,
      contactId: contact.id,
      channelId: channel.id,
      externalId: sender.externalId,
      handle: sender.handle ?? null,
    },
  });
  return { id: contact.id, created: true };
}

/**
 * Save one inbound message on any channel. Safe to run again: the provider's id is claimed first,
 * so a redelivery, a retry or a replay finds the claim and changes nothing.
 */
export async function recordInbound(
  tx: TenantTx,
  input: InboundInput,
): Promise<InboundResult | null> {
  const { orgId, channel, sender, sentAt, messageId, createdAt } = input;
  const claim = await tx.messageRef.createMany({
    data: {
      orgId,
      kind: input.ref.kind,
      ref: input.ref.id,
      messageId,
      messageCreatedAt: createdAt,
    },
    skipDuplicates: true,
  });
  if (claim.count === 0) {
    const ref = await tx.messageRef.findUnique({
      where: { orgId_kind_ref: { orgId, kind: input.ref.kind, ref: input.ref.id } },
    });
    return ref
      ? { kind: 'duplicate', messageId: ref.messageId, messageCreatedAt: ref.messageCreatedAt }
      : null;
  }

  const contactRef = await findContact(tx, input);
  const current = await tx.contact.findUniqueOrThrow({
    where: { id: contactRef.id },
    select: { name: true, email: true, lastActivityAt: true, waId: true },
  });
  await tx.contact.update({
    where: { id: contactRef.id },
    data: {
      // Writing in brings a deleted contact back, with its consent record intact.
      deletedAt: null,
      // A name someone entered or imported is not replaced by a profile name.
      ...(!current.name && sender.name ? { name: sender.name } : {}),
      ...(!current.email && sender.email ? { email: sender.email } : {}),
      ...(!current.lastActivityAt || current.lastActivityAt < sentAt
        ? { lastActivityAt: sentAt }
        : {}),
    },
  });
  const contactName = current.name ?? sender.name ?? null;
  if (contactRef.created) {
    await emitWebhookEvent(tx, orgId, 'contact.created', {
      id: contactRef.id,
      waId: current.waId,
      name: contactName,
      channel: channel.kind,
    });
  }

  const reply = await applyContactReply(tx, contactRef.id, sentAt);

  // Opt-out keywords are about WhatsApp marketing consent.
  let optedOut = false;
  if (channel.kind === 'whatsapp' && CAN_OPT_OUT.has(input.type)) {
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: orgId },
      select: { optOutKeywords: true },
    });
    if (isOptOutMessage(input.body, org.optOutKeywords)) {
      optedOut = await setContactConsent(tx, {
        orgId,
        contactId: contactRef.id,
        status: 'opted_out',
        source: 'keyword',
        proof: `Message ${input.ref.id}: ${input.body?.slice(0, 200)}`,
      });
      await exitDripsOnOptOut(tx, contactRef.id);
      if (optedOut) {
        await emitWebhookEvent(tx, orgId, 'contact.opted_out', {
          id: contactRef.id,
          waId: current.waId,
        });
      }
    }
  }

  const key = {
    orgId_channelId_contactId: { orgId, channelId: channel.id, contactId: contactRef.id },
  };
  const existing = await tx.conversation.findUnique({
    where: key,
    select: { windowExpiresAt: true, lastMessageAt: true },
  });
  const hours = CHANNEL_CAPABILITIES[channel.kind].replyWindowHours;
  const windowFromThis = hours === null ? null : new Date(sentAt.getTime() + hours * 3600_000);
  // Deliveries can arrive out of order: never move the window or the preview backwards.
  const windowExpiresAt =
    windowFromThis && existing?.windowExpiresAt && existing.windowExpiresAt > windowFromThis
      ? existing.windowExpiresAt
      : windowFromThis;
  const isLatest = !existing?.lastMessageAt || existing.lastMessageAt <= sentAt;
  const preview = messagePreview(input.type, input.body);
  const referral = input.referral ? normalizeReferral(channel.kind, input.referral) : null;
  const ad = referral ? { adSourceId: referral.sourceId, adHeadline: referral.headline } : {};

  const conversation = await tx.conversation.upsert({
    where: key,
    create: {
      orgId,
      channelId: channel.id,
      phoneId: channel.phoneId,
      contactId: contactRef.id,
      windowExpiresAt,
      lastMessageAt: sentAt,
      lastMessagePreview: preview,
      unreadCount: 1,
      ...ad,
    },
    update: {
      // A customer writing back reopens the conversation.
      status: 'open',
      windowExpiresAt,
      unreadCount: { increment: 1 },
      ...(isLatest ? { lastMessageAt: sentAt, lastMessagePreview: preview } : {}),
      ...ad,
    },
    include: conversationInclude,
  });

  const message = await tx.message.create({
    data: {
      id: messageId,
      createdAt,
      orgId,
      conversationId: conversation.id,
      direction: 'inbound',
      type: input.type,
      status: 'received',
      body: input.body,
      content: input.content,
      waMessageId: input.ref.id,
      ...(input.media
        ? {
            mediaMetaId: input.media.id,
            mediaMime: input.media.mime,
            mediaFilename: input.media.filename,
            mediaStatus: 'pending' as const,
          }
        : {}),
    },
    include: messageInclude,
  });

  if (referral) {
    await tx.adReferral.create({
      data: {
        orgId,
        conversationId: conversation.id,
        contactId: contactRef.id,
        channelKind: channel.kind,
        ...referral,
        newContact: contactRef.created,
        messageId,
        messageCreatedAt: createdAt,
      },
    });
  }

  await emitWebhookEvent(tx, orgId, 'message.received', {
    message: toPublicMessage(messageToDto(message)),
    contact: { id: contactRef.id, waId: current.waId, name: contactName },
    phoneNumberId: channel.phoneId,
    channel: channel.kind,
  });
  return {
    kind: 'saved',
    conversation,
    message,
    contactId: contactRef.id,
    newContact: contactRef.created,
    optedOut,
    campaignId: reply.campaignId,
  };
}

/** The WhatsApp channel of a number. Every number has one: a trigger makes it. */
export async function whatsappChannelId(
  tx: Pick<TenantTx, 'channel'>,
  phoneId: string,
): Promise<string> {
  const ch = await tx.channel.findUniqueOrThrow({ where: { phoneId }, select: { id: true } });
  return ch.id;
}

/**
 * What the web chat widget shows for a message. Internal notes and anything else that is not part
 * of the conversation with the visitor return null, and must never be sent to the widget.
 */
export function toWebchatMessage(
  m: Prisma.MessageGetPayload<{ include: typeof messageInclude }>,
): WebchatMessageDto | null {
  if (m.direction === 'internal') return null;
  const interactive = (m.content as { interactive?: Record<string, unknown> } | null)?.interactive;
  const buttons: { id: string; title: string }[] = [];
  if (interactive?.type === 'button' && Array.isArray(interactive.buttons)) {
    for (const b of interactive.buttons as { id: string; title: string }[]) {
      buttons.push({ id: String(b.id), title: String(b.title) });
    }
  }
  if (interactive?.type === 'list' && Array.isArray(interactive.sections)) {
    for (const s of interactive.sections as { rows?: { id: string; title: string }[] }[]) {
      for (const r of s.rows ?? []) buttons.push({ id: String(r.id), title: String(r.title) });
    }
  }
  const body =
    typeof interactive?.body === 'string' && !m.body ? (interactive.body as string) : m.body;
  return {
    id: m.id,
    from: m.direction === 'inbound' ? 'visitor' : 'agent',
    body,
    buttons,
    senderName: m.sender?.name ?? null,
    createdAt: m.createdAt.toISOString(),
  };
}

// ------------------------------------------------------------------ calls

export const callInclude = {
  contact: { select: { name: true, waId: true } },
} satisfies Prisma.CallInclude;

export function callToDto(c: Prisma.CallGetPayload<{ include: typeof callInclude }>): CallDto {
  return {
    id: c.id,
    conversationId: c.conversationId,
    direction: c.direction as CallDto['direction'],
    status: c.status as CallStatus,
    contactName: c.contact.name,
    waId: c.contact.waId,
    answeredById: c.answeredById,
    startedAt: c.startedAt.toISOString(),
    connectedAt: c.connectedAt?.toISOString() ?? null,
    endedAt: c.endedAt?.toISOString() ?? null,
    durationSec: c.durationSec,
  };
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** The text of a call's timeline entry. */
export function callBody(status: CallStatus, durationSec: number | null): string {
  return status === 'ended' && durationSec !== null
    ? `${CALL_LABELS.ended}, ${mmss(durationSec)}`
    : CALL_LABELS[status];
}
