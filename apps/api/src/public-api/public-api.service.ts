import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { assertWithinLimit, emitWebhookEvent, type TenantTx, whatsappChannelId } from '@wacrm/db';
import {
  AppError,
  type ConversationDto,
  ErrorCode,
  type MessageDto,
  type PublicSendMessageParsed,
} from '@wacrm/shared';
import { normalizePhone } from '@wacrm/shared/server';
import { InboxService, type InboxActor } from '../inbox/inbox.service';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

/** Same key, same uuid, which is what the inbox uses to refuse a repeated send. */
function clientIdFrom(key: string, orgId: string): string {
  const h = createHash('sha256').update(`${orgId}:${key}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

@Injectable()
export class PublicApiService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly inbox: InboxService,
  ) {}

  private async resolvePhone(tx: TenantTx, requested: string | undefined) {
    const phones = await tx.phoneNumber.findMany({
      where: { status: 'connected', ...(requested ? { id: requested } : {}) },
      select: { id: true, wabaAccountId: true },
      take: 2,
    });
    const first = phones[0];
    if (!first) {
      throw new AppError(
        ErrorCode.NUMBER_NOT_CONNECTED,
        requested ? 'That WhatsApp number is not connected' : 'No WhatsApp number is connected',
      );
    }
    if (phones.length > 1) {
      throw new AppError(
        ErrorCode.VALIDATION_FAILED,
        'This workspace has more than one WhatsApp number, so phoneNumberId is required',
      );
    }
    return first;
  }

  private async resolveTemplate(
    tx: TenantTx,
    wabaAccountId: string,
    input: PublicSendMessageParsed,
  ): Promise<string> {
    const template = await tx.messageTemplate.findFirst({
      where: input.templateId
        ? { id: input.templateId, wabaAccountId }
        : { name: input.templateName, language: input.language, wabaAccountId },
      select: { id: true },
    });
    if (!template) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No such template on this WhatsApp number');
    }
    return template.id;
  }

  /**
   * Send to a phone number. Finds or creates the contact and thread, then goes through the same
   * path as the inbox, so the 24-hour window, consent, wallet and queue rules are all the same.
   */
  async send(actor: InboxActor, input: PublicSendMessageParsed): Promise<MessageDto> {
    const waId = normalizePhone(input.to, input.defaultCountry);
    if (!waId) {
      throw new AppError(
        ErrorCode.INVALID_PHONE,
        'Enter a valid phone number, with its country code',
      );
    }
    const { conversationId, templateId } = await this.db.run(async (tx) => {
      const phone = await this.resolvePhone(tx, input.phoneNumberId);
      const templateId =
        input.type === 'template'
          ? await this.resolveTemplate(tx, phone.wabaAccountId, input)
          : null;

      let contact = await tx.contact.findUnique({
        where: { orgId_waId: { orgId: actor.orgId, waId } },
        select: { id: true, mergedIntoId: true, deletedAt: true },
      });
      if (!contact || contact.deletedAt) await assertWithinLimit(tx, actor.orgId, 'contacts');
      if (!contact) {
        contact = await tx.contact.create({
          data: { orgId: actor.orgId, waId },
          select: { id: true, mergedIntoId: true, deletedAt: true },
        });
        await emitWebhookEvent(tx, actor.orgId, 'contact.created', {
          id: contact.id,
          waId,
          name: null,
        });
      } else if (contact.deletedAt) {
        await tx.contact.update({ where: { id: contact.id }, data: { deletedAt: null } });
      }
      const contactId = contact.mergedIntoId ?? contact.id;

      const channelId = await whatsappChannelId(tx, phone.id);
      const conversation = await tx.conversation.upsert({
        where: {
          orgId_channelId_contactId: { orgId: actor.orgId, channelId, contactId },
        },
        // Closed until they reply, as with a broadcast: this is not yet something for an agent.
        create: { orgId: actor.orgId, channelId, phoneId: phone.id, contactId, status: 'closed' },
        update: {},
        select: { id: true },
      });
      return { conversationId: conversation.id, templateId };
    });

    const clientMessageId = input.idempotencyKey
      ? clientIdFrom(input.idempotencyKey, actor.orgId)
      : randomUUID();
    return this.inbox.sendMessage(
      actor,
      conversationId,
      input.type === 'text'
        ? { type: 'text', clientMessageId, body: input.body ?? '' }
        : {
            type: 'template',
            clientMessageId,
            templateId: templateId ?? '',
            variables: input.variables,
          },
    );
  }

  listConversations(
    actor: InboxActor,
    q: { status: 'open' | 'closed' | 'any'; cursor?: string; limit: number },
  ) {
    return this.inbox.listConversations(actor, { ...q, filter: 'all' });
  }

  getConversation(id: string): Promise<ConversationDto> {
    return this.inbox.getConversation(id);
  }
}
