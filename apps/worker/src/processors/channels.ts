import { randomUUID } from 'node:crypto';
import {
  callBody,
  callInclude,
  callToDto,
  conversationInclude,
  conversationToDto,
  type InboundResult,
  messageInclude,
  messageToDto,
  type Prisma,
  recordInbound,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import { CALL_LABELS, type CallStatus } from '@wacrm/shared';
import { channelCredentialsAad } from '@wacrm/shared/server';
import { parseInstagramWebhook, parseWebhookEvents, type WebhookEvent } from '@wacrm/whatsapp';
import type { WorkerDeps } from '../deps';
import { afterInbound } from './inbound';

type CallEvent = Extract<WebhookEvent, { type: 'call' }>;

// ------------------------------------------------------------------ Instagram

/** Attachments become their own message types; the widget-free inbox shows a link for now. */
const ATTACHMENT_TYPES: Record<string, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
  file: 'document',
  share: 'text',
  story_mention: 'text',
};

/**
 * Customer messages from an Instagram webhook entry. Echoes (what the business sent, from this
 * app or the Instagram app) are skipped: ours are already saved when we send them.
 */
export async function processInstagramEvent(
  deps: WorkerDeps,
  orgId: string,
  channelId: string,
  payload: unknown,
): Promise<void> {
  for (const ev of parseInstagramWebhook(payload)) {
    if (ev.isEcho) continue;
    // The name is fetched once, outside any transaction, for someone new.
    const known = await withTenant(deps.db, { orgId }, (tx) =>
      tx.contactIdentity.findUnique({
        where: { channelId_externalId: { channelId, externalId: ev.senderId } },
        select: { id: true },
      }),
    );
    const profile = known ? null : await instagramProfile(deps, orgId, channelId, ev.senderId);

    const attachment = ev.attachments[0];
    const type = ev.quickReply
      ? 'interactive'
      : attachment
        ? (ATTACHMENT_TYPES[attachment.type] ?? 'unsupported')
        : 'text';
    const content: Prisma.InputJsonValue | undefined = ev.quickReply
      ? { reply: { kind: 'button_reply', id: ev.quickReply, title: ev.text ?? '' } }
      : attachment
        ? { attachments: ev.attachments }
        : undefined;
    const messageId = randomUUID();
    const saved: InboundResult | null = await withTenant(deps.db, { orgId }, (tx) =>
      recordInbound(tx, {
        orgId,
        channel: { id: channelId, kind: 'instagram', phoneId: null },
        sender: {
          externalId: ev.senderId,
          name: profile?.name ?? (profile?.username ? `@${profile.username}` : null),
          handle: profile?.username ?? null,
        },
        ref: { kind: 'igmid', id: ev.mid },
        sentAt: ev.timestamp,
        messageId,
        createdAt: new Date(),
        type,
        body: ev.text ?? (attachment?.url ? attachment.url : null),
        content,
        referral: ev.referral,
      }),
    );
    if (saved) await afterInbound(deps, orgId, saved);
  }
}

async function instagramProfile(
  deps: WorkerDeps,
  orgId: string,
  channelId: string,
  igsid: string,
): Promise<{ name: string | null; username: string | null } | null> {
  if (!deps.instagram) return null;
  const channel = await withTenant(deps.db, { orgId }, (tx) =>
    tx.channel.findUnique({ where: { id: channelId }, select: { credentialsEnc: true } }),
  );
  if (!channel?.credentialsEnc) return null;
  try {
    const { accessToken } = JSON.parse(
      deps.secrets.decrypt(channel.credentialsEnc, channelCredentialsAad(channelId)),
    ) as { accessToken: string };
    return await deps.instagram.profile(accessToken, igsid);
  } catch {
    // A name is nice to have. The message is saved without one.
    return null;
  }
}

/** Instagram tokens last 60 days; refresh the ones ending within 10 days. */
export async function refreshInstagramTokens(deps: WorkerDeps): Promise<number> {
  if (!deps.instagram) return 0;
  const before = new Date(Date.now() + 10 * 86_400_000);
  const due = await deps.db.$queryRaw<{ id: string; org_id: string }[]>`
    SELECT id, org_id FROM channel_tokens_due(${before})`;
  let refreshed = 0;
  for (const { id, org_id: orgId } of due) {
    const channel = await withTenant(deps.db, { orgId }, (tx) =>
      tx.channel.findUnique({ where: { id }, select: { credentialsEnc: true } }),
    );
    if (!channel?.credentialsEnc) continue;
    const aad = channelCredentialsAad(id);
    const { accessToken } = JSON.parse(deps.secrets.decrypt(channel.credentialsEnc, aad)) as {
      accessToken: string;
    };
    try {
      const next = await deps.instagram.refreshToken(accessToken);
      await withTenant(deps.db, { orgId }, (tx) =>
        tx.channel.update({
          where: { id },
          data: {
            credentialsEnc: deps.secrets.encrypt(
              JSON.stringify({ accessToken: next.accessToken }),
              aad,
            ),
            tokenExpiresAt: next.expiresAt,
          },
        }),
      );
      refreshed++;
    } catch {
      // Tried again tomorrow. A token that has already expired shows on the channel's page.
    }
  }
  return refreshed;
}

// ------------------------------------------------------------------ QR codes

/**
 * A WhatsApp text that is exactly a QR code's prefilled message came from that code. Recorded
 * like an ad referral, so the code's count and the attribution report read the same table.
 */
export async function qrReferralFor(
  tx: TenantTx,
  phoneId: string,
  body: string | null,
): Promise<Record<string, unknown> | null> {
  const text = body?.trim();
  if (!text) return null;
  const qr = await tx.qrCode.findFirst({
    where: { phoneId, prefilledMessage: text, deletedAt: null },
    select: { id: true, name: true, deepLinkUrl: true },
  });
  return qr
    ? { source_type: 'qr', source_id: qr.id, headline: qr.name, source_url: qr.deepLinkUrl }
    : null;
}

// ------------------------------------------------------------------ calls

const at = (ts: string | undefined) =>
  ts && Number.isFinite(Number(ts)) ? new Date(Number(ts) * 1000) : new Date();

/** Meta's terminate and status words, as our statuses. */
function endStatus(
  ev: CallEvent,
  current: { status: string; direction: string; connectedAt: Date | null },
): CallStatus {
  if (current.status === 'rejected') return 'rejected';
  if (current.connectedAt) return 'ended';
  // Never answered: for a customer's call that is a missed call, whatever word Meta uses.
  if (current.direction === 'inbound') return 'missed';
  return (ev.status ?? '').toUpperCase() === 'FAILED' ? 'failed' : 'missed';
}

/** Apply one call event. Each one is idempotent: the call row is keyed by Meta's call id. */
async function applyCallEvent(deps: WorkerDeps, orgId: string, ev: CallEvent): Promise<void> {
  const raw = (ev.raw ?? {}) as Record<string, unknown>;
  const inboundStart = ev.event === 'connect' && ev.direction === 'USER_INITIATED';

  if (inboundStart) {
    // A customer is calling: a timeline entry, a call row, and a ring for the team.
    const messageId = randomUUID();
    const createdAt = new Date();
    const result = await withTenant(deps.db, { orgId }, async (tx) => {
      const channel = await tx.channel.findFirst({
        where: { kind: 'whatsapp', status: 'active', phone: { phoneNumberId: ev.phoneNumberId } },
        select: { id: true, phoneId: true },
      });
      if (!channel || !ev.from) return null;
      const saved = await recordInbound(tx, {
        orgId,
        channel: { id: channel.id, kind: 'whatsapp', phoneId: channel.phoneId },
        sender: { waId: ev.from },
        ref: { kind: 'call', id: ev.callId },
        sentAt: at(ev.timestamp),
        messageId,
        createdAt,
        type: 'call',
        body: CALL_LABELS.ringing,
        content: { callId: ev.callId, direction: 'inbound', status: 'ringing' },
      });
      if (saved?.kind !== 'saved') return { saved, call: null };
      const call = await tx.call.create({
        data: {
          orgId,
          conversationId: saved.conversation.id,
          contactId: saved.contactId,
          metaCallId: ev.callId,
          direction: 'inbound',
          status: 'ringing',
          startedAt: at(ev.timestamp),
          messageId,
          messageCreatedAt: createdAt,
        },
        include: callInclude,
      });
      return { saved, call };
    });
    if (!result?.saved) return;
    // Calls do not run auto-replies or flows: there is no message to answer.
    if (result.saved.kind === 'saved') {
      deps.publisher.emit(orgId, 'message:new', { message: messageToDto(result.saved.message) });
      deps.publisher.emit(orgId, 'conversation:updated', {
        conversation: conversationToDto(result.saved.conversation),
      });
    }
    if (result.call) {
      deps.publisher.emit(orgId, 'call:updated', {
        call: callToDto(result.call),
        offer: ev.session?.sdp,
      });
    }
    return;
  }

  const updated = await withTenant(deps.db, { orgId }, async (tx) => {
    const call = await tx.call.findUnique({
      where: { orgId_metaCallId: { orgId, metaCallId: ev.callId } },
    });
    if (!call) return null;
    const final = new Set(['ended', 'missed', 'rejected', 'failed']);
    if (final.has(call.status)) return null;

    let data: Prisma.CallUpdateInput;
    const status = (ev.status ?? '').toUpperCase();
    if (ev.event === 'terminate') {
      const endedAt = at(ev.timestamp);
      const next = endStatus(ev, call);
      const reported = Number(raw.duration);
      const durationSec =
        next === 'ended'
          ? Number.isFinite(reported) && reported >= 0
            ? Math.round(reported)
            : Math.max(
                0,
                Math.round((endedAt.getTime() - (call.connectedAt ?? endedAt).getTime()) / 1000),
              )
          : null;
      data = { status: next, endedAt, durationSec };
    } else if (ev.event === 'connect' || status === 'ACCEPTED') {
      // Our call was answered (Meta's SDP answer comes with connect).
      data = { status: 'connected', connectedAt: call.connectedAt ?? at(ev.timestamp) };
    } else if (status === 'REJECTED') {
      data = { status: 'rejected', endedAt: at(ev.timestamp) };
    } else {
      return null;
    }
    const row = await tx.call.update({ where: { id: call.id }, data, include: callInclude });
    const message = await tx.message.update({
      where: { id_createdAt: { id: call.messageId, createdAt: call.messageCreatedAt } },
      data: {
        body: callBody(row.status as CallStatus, row.durationSec),
        content: {
          callId: row.metaCallId,
          direction: row.direction,
          status: row.status,
          durationSec: row.durationSec,
        },
      },
      include: messageInclude,
    });
    const conversation = await tx.conversation.update({
      where: { id: call.conversationId },
      data: { lastMessagePreview: callBody(row.status as CallStatus, row.durationSec) },
      include: conversationInclude,
    });
    return { row, message, conversation };
  });
  if (!updated) return;
  deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(updated.message) });
  deps.publisher.emit(orgId, 'conversation:updated', {
    conversation: conversationToDto(updated.conversation),
  });
  deps.publisher.emit(orgId, 'call:updated', {
    call: callToDto(updated.row),
    answer: ev.event === 'connect' ? ev.session?.sdp : undefined,
  });
}

export async function processCallsChange(
  deps: WorkerDeps,
  orgId: string,
  payload: unknown,
): Promise<void> {
  for (const ev of parseWebhookEvents(payload)) {
    if (ev.type === 'call') await applyCallEvent(deps, orgId, ev);
  }
}

// ------------------------------------------------------------------ groups

/** Every object with a group_id inside a group webhook value, whatever its nesting. */
function groupObjects(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const v of value) groupObjects(v, out);
  } else if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.group_id === 'string') out.push(o);
    for (const v of Object.values(o)) if (v && typeof v === 'object') groupObjects(v, out);
  }
  return out;
}

/**
 * Group webhooks: a created group gets its id and invite link, a deleted one is marked, and a
 * participant change clears the stored count (the screen reads the live one from Meta).
 * Meta's payloads for these are not fully documented, so this reads them defensively.
 */
export async function processGroupChange(
  deps: WorkerDeps,
  orgId: string,
  field: string,
  payload: unknown,
): Promise<void> {
  for (const ev of parseWebhookEvents(payload)) {
    if (ev.type !== 'group_update') continue;
    for (const g of groupObjects(ev.value)) {
      const groupId = g.group_id as string;
      const type = String(g.type ?? '').toLowerCase();
      await withTenant(deps.db, { orgId }, async (tx) => {
        const existing = await tx.waGroup.findUnique({
          where: { orgId_groupId: { orgId, groupId } },
        });
        if (!existing && typeof g.subject === 'string') {
          // A group we created, whose id Meta only now reports: match it by subject.
          const pending = await tx.waGroup.findFirst({
            where: { status: 'pending', groupId: null, subject: g.subject },
            orderBy: { createdAt: 'desc' },
          });
          if (pending) {
            await tx.waGroup.update({
              where: { id: pending.id },
              data: {
                groupId,
                status: 'active',
                inviteLink: typeof g.invite_link === 'string' ? g.invite_link : null,
              },
            });
          }
          return;
        }
        if (!existing) return;
        if (type.includes('delete')) {
          await tx.waGroup.update({
            where: { id: existing.id },
            data: { status: 'deleted', deletedAt: new Date() },
          });
        } else if (field === 'group_participants_update') {
          await tx.waGroup.update({ where: { id: existing.id }, data: { participantCount: null } });
        } else if (typeof g.invite_link === 'string') {
          await tx.waGroup.update({
            where: { id: existing.id },
            data: { inviteLink: g.invite_link, status: 'active' },
          });
        }
      });
    }
  }
  deps.publisher.emit(orgId, 'channel:updated', { channelId: 'groups' });
}
