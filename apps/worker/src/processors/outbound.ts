import {
  emitWebhookEvent,
  messageInclude,
  messageToDto,
  refundDebit,
  toWebchatMessage,
  withTenant,
} from '@wacrm/db';
import type { OutboundJob } from '@wacrm/shared';
import {
  canReceiveMarketing,
  ErrorCode,
  isMarketingCategory,
  messageDebitKey,
  WhatsAppErrorCode,
  toPublicMessage,
} from '@wacrm/shared';
import { channelCredentialsAad } from '@wacrm/shared/server';
import {
  type GatewayResult,
  InstagramError,
  type MediaKind,
  type SendInteractiveInput,
  type SendProductsGatewayInput,
  type SentMessage,
  type TemplateComponentInput,
  type WhatsAppGateway,
} from '@wacrm/whatsapp';
import { RetryableJobError, type WorkerDeps } from '../deps';
import { callbackData } from './inbound';

export type OutboundOutcome = 'sent' | 'failed' | 'skipped';

/**
 * Outbound messages still queued a minute after they were made, whose job was never queued
 * because a process stopped between commit and enqueue. Across orgs; ids only.
 */
export function stuckOutboundMessages(
  deps: Pick<WorkerDeps, 'db'>,
  before = new Date(Date.now() - 60_000),
  limit = 500,
) {
  return deps.db.$queryRaw<{ org_id: string; id: string; created_at: Date }[]>`
    SELECT org_id, id, created_at FROM outbound_stuck_messages(${before}, ${limit}::int)`;
}

interface TemplateContent {
  templateName: string;
  language: string;
  components: TemplateComponentInput[];
  category?: string;
  /** Set for media headers. The file itself is on the message row. */
  headerKind?: 'image' | 'video' | 'document';
}

export interface OutboundOptions {
  /** True on the job's last attempt: a retryable error now becomes a visible failure. */
  finalAttempt: boolean;
}

/**
 * Send one queued message. At-most-once where it matters: the message is claimed as `sending`
 * before calling Meta, so a worker that crashed mid-send cannot silently deliver twice on retry.
 * The agent sees a failure and decides. Errors Meta marks retryable go back to `queued`.
 */
export async function sendOutboundMessage(
  deps: WorkerDeps,
  job: OutboundJob,
  opts: OutboundOptions,
): Promise<OutboundOutcome> {
  const { orgId, messageId } = job;
  const where = { id_createdAt: { id: messageId, createdAt: new Date(job.createdAt) } };

  const fail = async (code: string, message: string): Promise<OutboundOutcome> => {
    // Together: a failed message and its refund are one change.
    const { row, refund } = await withTenant(deps.db, { orgId }, async (tx) => {
      const refund = await refundDebit(tx, {
        orgId,
        debitKey: messageDebitKey(messageId),
        description: message.slice(0, 200),
      });
      const row = await tx.message.update({
        where,
        data: {
          status: 'failed',
          errorCode: code,
          errorMessage: message.slice(0, 1000),
          failedAt: new Date(),
        },
        include: messageInclude,
      });
      await emitWebhookEvent(tx, orgId, 'message.status', {
        message: toPublicMessage(messageToDto(row)),
      });
      return { row, refund };
    });
    deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(row) });
    if (refund.applied) deps.publisher.emit(orgId, 'wallet:updated', {});
    return 'failed';
  };

  const claimed = await withTenant(deps.db, { orgId }, async (tx) => {
    const current = await tx.message.findUnique({
      where,
      select: {
        status: true,
        type: true,
        body: true,
        content: true,
        mediaKey: true,
        mediaMetaId: true,
        mediaMime: true,
        mediaFilename: true,
        createdAt: true,
        conversation: {
          select: {
            id: true,
            channelId: true,
            channel: {
              select: {
                id: true,
                kind: true,
                status: true,
                externalId: true,
                credentialsEnc: true,
              },
            },
            phone: { select: { phoneNumberId: true, status: true } },
            contact: {
              select: {
                waId: true,
                optInStatus: true,
                identities: { select: { channelId: true, externalId: true } },
              },
            },
          },
        },
      },
    });
    if (!current) return { kind: 'gone' as const };
    if (current.status === 'sending') return { kind: 'interrupted' as const };
    if (current.status !== 'queued') return { kind: 'done' as const };
    await tx.message.update({ where, data: { status: 'sending' } });
    return { kind: 'claimed' as const, message: current };
  });

  if (claimed.kind === 'gone' || claimed.kind === 'done') return 'skipped';
  if (claimed.kind === 'interrupted') {
    return fail(
      WhatsAppErrorCode.UNKNOWN,
      'Sending was interrupted, so this message may or may not have been delivered.',
    );
  }

  const { message } = claimed;
  const { phone, contact, channel } = message.conversation;
  if (channel.status !== 'active') {
    return fail(WhatsAppErrorCode.NOT_REGISTERED, 'This channel is no longer connected.');
  }
  if (channel.kind === 'webchat') {
    return deliverWebchat(deps, job, message.conversation.id);
  }
  if (channel.kind === 'instagram') {
    const recipient = contact.identities.find((i) => i.channelId === channel.id)?.externalId;
    if (!recipient) return fail(ErrorCode.NOT_FOUND, 'This contact has no Instagram account here.');
    return sendInstagram(deps, job, opts, fail, { channel, recipient, message });
  }
  if (!phone || phone.status === 'disconnected') {
    return fail(WhatsAppErrorCode.NOT_REGISTERED, 'This WhatsApp number is no longer connected.');
  }
  if (!contact.waId) {
    return fail(ErrorCode.NOT_FOUND, 'This contact has no WhatsApp number.');
  }
  const to = contact.waId;
  // Checked again here: a contact can opt out while their message waits in the queue.
  if (
    message.type === 'template' &&
    isMarketingCategory((message.content as unknown as TemplateContent).category) &&
    !canReceiveMarketing(contact.optInStatus)
  ) {
    return fail(
      ErrorCode.CONTACT_NOT_OPTED_IN,
      'This contact has not opted in to marketing, so this template was not sent.',
    );
  }

  let gateway: WhatsAppGateway;
  try {
    gateway = await deps.whatsapp.get({ orgId, phoneNumberId: phone.phoneNumberId });
  } catch (err) {
    return fail(
      WhatsAppErrorCode.NOT_REGISTERED,
      err instanceof Error ? err.message : 'Could not load this number',
    );
  }

  const send = async (): Promise<GatewayResult<SentMessage>> => {
    const sendOpts = { callbackData: callbackData(messageId, message.createdAt) };
    if (message.type === 'text') {
      return gateway.sendText(to, { body: message.body ?? '' }, sendOpts);
    }
    if (
      message.type === 'product' ||
      message.type === 'product_list' ||
      message.type === 'catalog'
    ) {
      const products = (message.content as { products?: SendProductsGatewayInput } | null)
        ?.products;
      if (!products) throw new Error('Product message has no content');
      return gateway.sendProducts(to, products, sendOpts);
    }
    if (message.type === 'call_permission_request') {
      return gateway.sendCallPermissionRequest(to, message.body ?? '', sendOpts);
    }
    if (message.type === 'interactive') {
      // Buttons and lists from flows. The whole message is stored on the row.
      const interactive = (message.content as { interactive?: SendInteractiveInput } | null)
        ?.interactive;
      if (!interactive) throw new Error('Interactive message has no content');
      return gateway.sendInteractive(to, interactive, sendOpts);
    }
    // Upload once. A retry reuses the saved Meta id.
    const uploadOnce = async (): Promise<GatewayResult<{ mediaId: string }>> => {
      if (message.mediaMetaId) return { data: { mediaId: message.mediaMetaId }, error: null };
      if (!message.mediaKey) throw new Error('Media message has no stored file');
      const bytes = await deps.storage.get(message.mediaKey);
      const uploaded = await gateway.uploadMedia({
        bytes,
        mimeType: message.mediaMime ?? 'application/octet-stream',
        filename: message.mediaFilename ?? undefined,
      });
      if (uploaded.error) return uploaded;
      await withTenant(deps.db, { orgId }, (tx) =>
        tx.message.update({ where, data: { mediaMetaId: uploaded.data.mediaId } }),
      );
      return uploaded;
    };

    if (message.type === 'template') {
      const t = message.content as unknown as TemplateContent;
      const components = [...t.components];
      if (t.headerKind) {
        const media = await uploadOnce();
        if (media.error) return media;
        components.unshift({
          type: 'header',
          parameters: [
            {
              type: t.headerKind,
              extra: {
                [t.headerKind]: {
                  id: media.data.mediaId,
                  ...(t.headerKind === 'document' && message.mediaFilename
                    ? { filename: message.mediaFilename }
                    : {}),
                },
              },
            },
          ],
        });
      }
      return gateway.sendTemplate(
        to,
        {
          name: t.templateName,
          language: t.language,
          components: components.length ? components : undefined,
        },
        sendOpts,
      );
    }
    const uploaded = await uploadOnce();
    if (uploaded.error) return uploaded;
    const { mediaId } = uploaded.data;
    return gateway.sendMedia(
      to,
      {
        kind: message.type as MediaKind,
        mediaId,
        caption: message.type === 'audio' ? undefined : (message.body ?? undefined),
        filename: message.type === 'document' ? (message.mediaFilename ?? undefined) : undefined,
      },
      sendOpts,
    );
  };

  const res = await send();

  if (res.error) {
    if (res.error.code === WhatsAppErrorCode.TOKEN_INVALID) {
      deps.whatsapp.invalidate(phone.phoneNumberId);
    }
    if (res.error.retryable && !opts.finalAttempt) {
      await withTenant(deps.db, { orgId }, (tx) =>
        tx.message.update({ where, data: { status: 'queued' } }),
      );
      throw new RetryableJobError(res.error.message);
    }
    return fail(res.error.code, res.error.message);
  }

  const updated = await withTenant(deps.db, { orgId }, async (tx) => {
    await tx.messageRef.createMany({
      data: {
        orgId,
        kind: 'wamid',
        ref: res.data.messageId,
        messageId,
        messageCreatedAt: message.createdAt,
      },
      skipDuplicates: true,
    });
    const current = await tx.message.findUniqueOrThrow({ where, select: { status: true } });
    // A status webhook may already have moved this past `sent`. Do not move it back.
    const row = await tx.message.update({
      where,
      data: {
        waMessageId: res.data.messageId,
        ...(current.status === 'sending' ? { status: 'sent' as const, sentAt: new Date() } : {}),
      },
      include: messageInclude,
    });
    if (current.status === 'sending') {
      await emitWebhookEvent(tx, orgId, 'message.status', {
        message: toPublicMessage(messageToDto(row)),
      });
    }
    return row;
  });
  deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(updated) });
  return 'sent';
}

/**
 * Web chat has no provider: the message is the visitor's as soon as it is published to their
 * socket. The widget also fetches history, so a visitor who was offline sees it on return.
 */
async function deliverWebchat(
  deps: WorkerDeps,
  job: OutboundJob,
  conversationId: string,
): Promise<OutboundOutcome> {
  const where = { id_createdAt: { id: job.messageId, createdAt: new Date(job.createdAt) } };
  const row = await withTenant(deps.db, { orgId: job.orgId }, async (tx) => {
    const updated = await tx.message.update({
      where,
      data: { status: 'delivered', sentAt: new Date(), deliveredAt: new Date() },
      include: messageInclude,
    });
    await emitWebhookEvent(tx, job.orgId, 'message.status', {
      message: toPublicMessage(messageToDto(updated)),
    });
    return updated;
  });
  const visitorMessage = toWebchatMessage(row);
  if (visitorMessage) deps.publisher.emitVisitor(conversationId, visitorMessage);
  deps.publisher.emit(job.orgId, 'message:updated', { message: messageToDto(row) });
  return 'sent';
}

/** Lists become numbered text: Instagram has quick replies, but no list menus. */
function instagramText(
  body: string | null,
  interactive: SendInteractiveInput | undefined,
): { text: string; quickReplies?: { id: string; title: string }[] } {
  if (!interactive) return { text: body ?? '' };
  if (interactive.type === 'button') {
    return { text: interactive.body, quickReplies: interactive.buttons };
  }
  if (interactive.type === 'list') {
    const rows = interactive.sections.flatMap((s) => s.rows);
    return {
      text: interactive.body,
      quickReplies: rows.map((r) => ({ id: r.id, title: r.title })),
    };
  }
  return { text: `${interactive.body}\n${interactive.url}` };
}

async function sendInstagram(
  deps: WorkerDeps,
  job: OutboundJob,
  opts: OutboundOptions,
  fail: (code: string, message: string) => Promise<OutboundOutcome>,
  input: {
    channel: { id: string; externalId: string | null; credentialsEnc: string | null };
    recipient: string;
    message: { type: string; body: string | null; content: unknown; createdAt: Date };
  },
): Promise<OutboundOutcome> {
  const { channel, recipient, message } = input;
  if (!deps.instagram) return fail(ErrorCode.INTEGRATION_NOT_AVAILABLE, 'Instagram is not set up.');
  if (message.type !== 'text' && message.type !== 'interactive') {
    return fail(ErrorCode.VALIDATION_FAILED, 'Only text and buttons can be sent on Instagram.');
  }
  if (!channel.credentialsEnc || !channel.externalId) {
    return fail(WhatsAppErrorCode.TOKEN_INVALID, 'Connect this Instagram account again.');
  }
  const token = (
    JSON.parse(deps.secrets.decrypt(channel.credentialsEnc, channelCredentialsAad(channel.id))) as {
      accessToken: string;
    }
  ).accessToken;
  const interactive = (message.content as { interactive?: SendInteractiveInput } | null)
    ?.interactive;
  const { text, quickReplies } = instagramText(message.body, interactive);

  let sent: { messageId: string };
  try {
    sent = await deps.instagram.sendText(token, {
      accountId: channel.externalId,
      recipientId: recipient,
      text,
      quickReplies,
    });
  } catch (err) {
    if (!(err instanceof InstagramError)) throw err;
    const where = { id_createdAt: { id: job.messageId, createdAt: new Date(job.createdAt) } };
    if (err.retryable && !opts.finalAttempt) {
      await withTenant(deps.db, { orgId: job.orgId }, (tx) =>
        tx.message.update({ where, data: { status: 'queued' } }),
      );
      throw new RetryableJobError(err.message);
    }
    return fail(
      err.tokenInvalid ? WhatsAppErrorCode.TOKEN_INVALID : WhatsAppErrorCode.UNKNOWN,
      err.tokenInvalid ? 'Instagram refused the token. Connect the account again.' : err.message,
    );
  }

  const where = { id_createdAt: { id: job.messageId, createdAt: message.createdAt } };
  const row = await withTenant(deps.db, { orgId: job.orgId }, async (tx) => {
    await tx.messageRef.createMany({
      data: {
        orgId: job.orgId,
        kind: 'igmid',
        ref: sent.messageId,
        messageId: job.messageId,
        messageCreatedAt: message.createdAt,
      },
      skipDuplicates: true,
    });
    const updated = await tx.message.update({
      where,
      data: { waMessageId: sent.messageId, status: 'sent', sentAt: new Date() },
      include: messageInclude,
    });
    await emitWebhookEvent(tx, job.orgId, 'message.status', {
      message: toPublicMessage(messageToDto(updated)),
    });
    return updated;
  });
  deps.publisher.emit(job.orgId, 'message:updated', { message: messageToDto(row) });
  return 'sent';
}
