import { messageInclude, messageToDto, type Prisma, withTenant } from '@wacrm/db';
import type { OutboundJob } from '@wacrm/shared';
import {
  canReceiveMarketing,
  ErrorCode,
  isMarketingCategory,
  WhatsAppErrorCode,
} from '@wacrm/shared';
import type { GatewayResult, MediaKind, SentMessage, WhatsAppGateway } from '@wacrm/whatsapp';
import { RetryableJobError, type WorkerDeps } from '../deps';
import { callbackData } from './inbound';

export type OutboundOutcome = 'sent' | 'failed' | 'skipped';

interface TemplateContent {
  templateName: string;
  language: string;
  bodyParams: string[];
  category?: string;
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

  const finish = async (data: Prisma.MessageUpdateInput) => {
    const row = await withTenant(deps.db, { orgId }, (tx) =>
      tx.message.update({ where, data, include: messageInclude }),
    );
    deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(row) });
  };
  const fail = async (code: string, message: string): Promise<OutboundOutcome> => {
    await finish({
      status: 'failed',
      errorCode: code,
      errorMessage: message.slice(0, 1000),
      failedAt: new Date(),
    });
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
            phone: { select: { phoneNumberId: true, status: true } },
            contact: { select: { waId: true, optInStatus: true } },
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
  const { phone, contact } = message.conversation;
  if (phone.status === 'disconnected') {
    return fail(WhatsAppErrorCode.NOT_REGISTERED, 'This WhatsApp number is no longer connected.');
  }
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
      return gateway.sendText(contact.waId, { body: message.body ?? '' }, sendOpts);
    }
    if (message.type === 'template') {
      const t = message.content as unknown as TemplateContent;
      return gateway.sendTemplate(
        contact.waId,
        {
          name: t.templateName,
          language: t.language,
          components: t.bodyParams.length
            ? [
                {
                  type: 'body',
                  parameters: t.bodyParams.map((text) => ({ type: 'text' as const, text })),
                },
              ]
            : undefined,
        },
        sendOpts,
      );
    }
    // Media: upload once. A retry reuses the saved Meta id.
    let mediaId = message.mediaMetaId;
    if (!mediaId) {
      if (!message.mediaKey) throw new Error('Media message has no stored file');
      const bytes = await deps.storage.get(message.mediaKey);
      const uploaded = await gateway.uploadMedia({
        bytes,
        mimeType: message.mediaMime ?? 'application/octet-stream',
        filename: message.mediaFilename ?? undefined,
      });
      if (uploaded.error) return uploaded;
      mediaId = uploaded.data.mediaId;
      await withTenant(deps.db, { orgId }, (tx) =>
        tx.message.update({ where, data: { mediaMetaId: mediaId } }),
      );
    }
    return gateway.sendMedia(
      contact.waId,
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
    return tx.message.update({
      where,
      data: {
        waMessageId: res.data.messageId,
        ...(current.status === 'sending' ? { status: 'sent' as const, sentAt: new Date() } : {}),
      },
      include: messageInclude,
    });
  });
  deps.publisher.emit(orgId, 'message:updated', { message: messageToDto(updated) });
  return 'sent';
}
