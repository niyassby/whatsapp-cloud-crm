import { Injectable } from '@nestjs/common';
import {
  contactInclude,
  contactListWhere,
  type ContactListFilter,
  contactToDto,
  liveContactWhere,
  type Prisma,
  segmentFilterToWhere,
  setContactConsent,
  type TenantTx,
  assertWithinLimit,
  emitWebhookEvent,
} from '@wacrm/db';
import {
  AppError,
  type BulkContactsInput,
  coerceFieldValue,
  type ConsentEventDto,
  type ContactConversationDto,
  type ContactDto,
  type ContactFieldDto,
  type ContactNoteDto,
  createContactFieldSchema,
  type createContactSchema,
  createTagSchema,
  type CursorPage,
  DEFAULT_OPT_OUT_KEYWORDS,
  ErrorCode,
  type FieldValue,
  type ListContactsQuery,
  type MergeContactsInput,
  type OptInStatus,
  type SegmentDto,
  segmentFilterSchema,
  type SegmentFilter,
  type SetConsentInput,
  type TagDto,
  type UpdateContactInput,
  toPublicContact,
} from '@wacrm/shared';
import { normalizePhone } from '@wacrm/shared/server';
import type { z } from 'zod';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface ContactActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

const SEGMENT_SELECT = {
  id: true,
  name: true,
  filter: true,
  createdAt: true,
  updatedAt: true,
} as const;

function segmentToDto(s: Prisma.SegmentGetPayload<{ select: typeof SEGMENT_SELECT }>): SegmentDto {
  return {
    id: s.id,
    name: s.name,
    filter: segmentFilterSchema.parse(s.filter),
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

const later = (a: Date | null, b: Date | null) => (a && b ? (a > b ? a : b) : (a ?? b));

@Injectable()
export class ContactsService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ------------------------------------------------------------------ list and read

  /** Turns the query's segment id into its saved filter. Used by lists, counts and exports. */
  async resolveFilter(q: {
    q?: string;
    tagId?: string;
    optIn?: OptInStatus;
    segmentId?: string;
  }): Promise<ContactListFilter> {
    const { segmentId, ...rest } = q;
    if (!segmentId) return rest;
    const segment = await this.db.run((tx) =>
      tx.segment.findUnique({ where: { id: segmentId }, select: { filter: true } }),
    );
    if (!segment) throw new AppError(ErrorCode.NOT_FOUND, 'Segment not found');
    return { ...rest, segment: segmentFilterSchema.parse(segment.filter) };
  }

  async list(q: ListContactsQuery): Promise<CursorPage<ContactDto>> {
    const where = contactListWhere(await this.resolveFilter(q));
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.contact.findMany({
        where: cursor
          ? {
              AND: [
                where,
                {
                  OR: [
                    { createdAt: { lt: cursor.createdAt } },
                    { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                  ],
                },
              ],
            }
          : where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        include: contactInclude,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(contactToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  async count(q: Omit<ListContactsQuery, 'cursor' | 'limit'>): Promise<{ count: number }> {
    const where = contactListWhere(await this.resolveFilter(q));
    return { count: await this.db.run((tx) => tx.contact.count({ where })) };
  }

  private async loadLive(tx: TenantTx, id: string) {
    const row = await tx.contact.findFirst({
      where: { id, ...liveContactWhere },
      include: contactInclude,
    });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Contact not found');
    return row;
  }

  async get(id: string): Promise<ContactDto> {
    return contactToDto(await this.db.run((tx) => this.loadLive(tx, id)));
  }

  async conversations(id: string): Promise<ContactConversationDto[]> {
    return this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      const rows = await tx.conversation.findMany({
        where: { contactId: id },
        orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
        take: 50,
        select: {
          id: true,
          status: true,
          lastMessageAt: true,
          lastMessagePreview: true,
          phone: { select: { displayPhoneNumber: true } },
        },
      });
      return rows.map((c) => ({
        id: c.id,
        status: c.status,
        phoneDisplay: c.phone.displayPhoneNumber,
        lastMessageAt: c.lastMessageAt?.toISOString() ?? null,
        lastMessagePreview: c.lastMessagePreview,
      }));
    });
  }

  // ------------------------------------------------------------------ create and update

  /** Check values against the workspace's definitions. Null removes a value. */
  private async validateFields(
    tx: TenantTx,
    input: Record<string, unknown>,
  ): Promise<Record<string, FieldValue | null>> {
    const keys = Object.keys(input);
    if (keys.length === 0) return {};
    const defs = await tx.contactField.findMany({ where: { key: { in: keys } } });
    const out: Record<string, FieldValue | null> = {};
    for (const key of keys) {
      const def = defs.find((d) => d.key === key);
      if (!def) throw new AppError(ErrorCode.VALIDATION_FAILED, `Unknown field: ${key}`);
      const raw = input[key];
      if (raw === null || raw === '') {
        out[key] = null;
        continue;
      }
      const res = coerceFieldValue(def, raw);
      if (!res.ok) throw new AppError(ErrorCode.VALIDATION_FAILED, res.error);
      out[key] = res.value;
    }
    return out;
  }

  private applyFields(
    current: unknown,
    changes: Record<string, FieldValue | null>,
  ): Record<string, FieldValue> {
    const next = { ...((current ?? {}) as Record<string, FieldValue>) };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    return next;
  }

  private async assertTags(tx: TenantTx, tagIds: string[]): Promise<void> {
    // Under RLS, so another org's tag ids simply do not match.
    const found = await tx.tag.count({ where: { id: { in: tagIds } } });
    if (found !== new Set(tagIds).size) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown tag');
    }
  }

  async create(
    actor: ContactActor,
    input: z.infer<typeof createContactSchema>,
  ): Promise<ContactDto> {
    const waId = normalizePhone(input.phone, input.defaultCountry);
    if (!waId) {
      throw new AppError(
        ErrorCode.INVALID_PHONE,
        'Enter a valid phone number, with its country code',
      );
    }
    const row = await this.db.run(async (tx) => {
      const fields = this.applyFields({}, await this.validateFields(tx, input.customFields ?? {}));
      if (input.tagIds?.length) await this.assertTags(tx, input.tagIds);

      const existing = await tx.contact.findUnique({
        where: { orgId_waId: { orgId: actor.orgId, waId } },
        select: { id: true, deletedAt: true, mergedIntoId: true },
      });
      if (existing && (!existing.deletedAt || existing.mergedIntoId)) {
        throw new AppError(ErrorCode.CONTACT_EXISTS, 'A contact with this number already exists', {
          contactId: existing.mergedIntoId ?? existing.id,
        });
      }
      await assertWithinLimit(tx, actor.orgId, 'contacts');
      // Re-adding a deleted contact restores the row, which keeps its consent history.
      const contact = existing
        ? await tx.contact.update({
            where: { id: existing.id },
            data: {
              deletedAt: null,
              name: input.name ?? null,
              email: input.email ?? null,
              customFields: fields,
            },
            select: { id: true },
          })
        : await tx.contact.create({
            data: {
              orgId: actor.orgId,
              waId,
              name: input.name || null,
              email: input.email ?? null,
              customFields: fields,
            },
            select: { id: true },
          });
      if (input.tagIds?.length) {
        await tx.contactTag.createMany({
          data: input.tagIds.map((tagId) => ({
            orgId: actor.orgId,
            contactId: contact.id,
            tagId,
          })),
          skipDuplicates: true,
        });
      }
      const created = await this.loadLive(tx, contact.id);
      await emitWebhookEvent(
        tx,
        actor.orgId,
        'contact.created',
        toPublicContact(contactToDto(created)) as Prisma.InputJsonValue,
      );
      return created;
    });
    return contactToDto(row);
  }

  async update(actor: ContactActor, id: string, input: UpdateContactInput): Promise<ContactDto> {
    const row = await this.db.run(async (tx) => {
      const current = await this.loadLive(tx, id);
      const data: Prisma.ContactUpdateInput = {};
      if (input.name !== undefined) data.name = input.name || null;
      if (input.email !== undefined) data.email = input.email;
      if (input.customFields) {
        data.customFields = this.applyFields(
          current.customFields,
          await this.validateFields(tx, input.customFields),
        );
      }
      return tx.contact.update({ where: { id }, data, include: contactInclude });
    });
    this.realtime.emit(actor.orgId, 'contact:updated', { contactId: id });
    return contactToDto(row);
  }

  /** Soft delete: the number and consent record stay, so an opt-out survives a re-import. */
  async remove(actor: ContactActor, id: string): Promise<void> {
    await this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      await tx.contact.update({ where: { id }, data: { deletedAt: new Date() } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CONTACT_DELETED,
        actorUserId: actor.userId,
        targetType: 'contact',
        targetId: id,
        meta: actor.meta,
      });
    });
    this.realtime.emit(actor.orgId, 'contact:updated', { contactId: id });
  }

  async setTags(actor: ContactActor, id: string, tagIds: string[]): Promise<ContactDto> {
    const row = await this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      await this.assertTags(tx, tagIds);
      await tx.contactTag.deleteMany({ where: { contactId: id } });
      await tx.contactTag.createMany({
        data: [...new Set(tagIds)].map((tagId) => ({
          orgId: actor.orgId,
          contactId: id,
          tagId,
        })),
      });
      return this.loadLive(tx, id);
    });
    return contactToDto(row);
  }

  // ------------------------------------------------------------------ consent

  async setConsent(actor: ContactActor, id: string, input: SetConsentInput): Promise<ContactDto> {
    const row = await this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      const changed = await setContactConsent(tx, {
        orgId: actor.orgId,
        contactId: id,
        status: input.status,
        source: input.source ?? 'manual',
        proof: input.proof ?? null,
        actorUserId: actor.userId,
      });
      if (changed) {
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CONTACT_CONSENT_CHANGED,
          actorUserId: actor.userId,
          targetType: 'contact',
          targetId: id,
          metadata: { status: input.status },
          meta: actor.meta,
        });
      }
      return this.loadLive(tx, id);
    });
    this.realtime.emit(actor.orgId, 'contact:updated', { contactId: id });
    return contactToDto(row);
  }

  /** Includes the history of contacts merged into this one, so no proof is lost. */
  async consentHistory(id: string): Promise<ConsentEventDto[]> {
    return this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      const rows = await tx.contactConsentEvent.findMany({
        where: { OR: [{ contactId: id }, { contact: { mergedIntoId: id } }] },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
        include: { actor: { select: { name: true } } },
      });
      return rows.map((e) => ({
        id: e.id,
        status: e.status,
        source: e.source,
        proof: e.proof,
        actorName: e.actor?.name ?? null,
        createdAt: e.createdAt.toISOString(),
      }));
    });
  }

  async getOptOutKeywords(
    actor: ContactActor,
  ): Promise<{ keywords: string[]; isDefault: boolean }> {
    const org = await this.db.run((tx) =>
      tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { optOutKeywords: true },
      }),
    );
    return org.optOutKeywords.length
      ? { keywords: org.optOutKeywords, isDefault: false }
      : { keywords: [...DEFAULT_OPT_OUT_KEYWORDS], isDefault: true };
  }

  async setOptOutKeywords(actor: ContactActor, keywords: string[]) {
    await this.db.run(async (tx) => {
      await tx.organization.update({
        where: { id: actor.orgId },
        data: { optOutKeywords: [...new Set(keywords.map((k) => k.toLowerCase()))] },
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.OPT_OUT_KEYWORDS_CHANGED,
        actorUserId: actor.userId,
        metadata: { count: keywords.length },
        meta: actor.meta,
      });
    });
    return this.getOptOutKeywords(actor);
  }

  // ------------------------------------------------------------------ notes

  async listNotes(id: string): Promise<ContactNoteDto[]> {
    return this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      const rows = await tx.contactNote.findMany({
        where: { contactId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 200,
        include: { author: { select: { name: true } } },
      });
      return rows.map((n) => ({
        id: n.id,
        body: n.body,
        authorId: n.authorId,
        authorName: n.author?.name ?? null,
        createdAt: n.createdAt.toISOString(),
      }));
    });
  }

  async addNote(actor: ContactActor, id: string, body: string): Promise<ContactNoteDto> {
    const note = await this.db.run(async (tx) => {
      await this.loadLive(tx, id);
      return tx.contactNote.create({
        data: { orgId: actor.orgId, contactId: id, authorId: actor.userId, body },
        include: { author: { select: { name: true } } },
      });
    });
    return {
      id: note.id,
      body: note.body,
      authorId: note.authorId,
      authorName: note.author?.name ?? null,
      createdAt: note.createdAt.toISOString(),
    };
  }

  /** Authors can delete their own notes. Others need the manage permission. */
  async deleteNote(
    actor: ContactActor,
    contactId: string,
    noteId: string,
    canManage: boolean,
  ): Promise<void> {
    await this.db.run(async (tx) => {
      const note = await tx.contactNote.findFirst({
        where: { id: noteId, contactId },
        select: { authorId: true },
      });
      if (!note) throw new AppError(ErrorCode.NOT_FOUND, 'Note not found');
      if (note.authorId !== actor.userId && !canManage) {
        throw new AppError(ErrorCode.FORBIDDEN, 'You can only delete your own notes');
      }
      await tx.contactNote.delete({ where: { id: noteId } });
    });
  }

  // ------------------------------------------------------------------ bulk and merge

  async bulk(actor: ContactActor, input: BulkContactsInput): Promise<{ affected: number }> {
    const { action } = input;
    const ids = [...new Set(input.ids)];
    const affected = await this.db.run(
      async (tx) => {
        const live = await tx.contact.findMany({
          where: { id: { in: ids }, ...liveContactWhere },
          select: { id: true, optInStatus: true },
        });
        const liveIds = live.map((c) => c.id);
        let count: number;
        if (action.type === 'add_tag') {
          await this.assertTags(tx, [action.tagId]);
          const res = await tx.contactTag.createMany({
            data: liveIds.map((contactId) => ({
              orgId: actor.orgId,
              contactId,
              tagId: action.tagId,
            })),
            skipDuplicates: true,
          });
          count = res.count;
        } else if (action.type === 'remove_tag') {
          const res = await tx.contactTag.deleteMany({
            where: { tagId: action.tagId, contactId: { in: liveIds } },
          });
          count = res.count;
        } else if (action.type === 'opt_out') {
          const targets = live.filter((c) => c.optInStatus !== 'opted_out').map((c) => c.id);
          const now = new Date();
          await tx.contact.updateMany({
            where: { id: { in: targets } },
            data: { optInStatus: 'opted_out', optOutAt: now },
          });
          await tx.contactConsentEvent.createMany({
            data: targets.map((contactId) => ({
              orgId: actor.orgId,
              contactId,
              status: 'opted_out' as const,
              source: 'bulk',
              actorUserId: actor.userId,
            })),
          });
          count = targets.length;
        } else {
          const res = await tx.contact.updateMany({
            where: { id: { in: liveIds } },
            data: { deletedAt: new Date() },
          });
          count = res.count;
        }
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CONTACTS_BULK_CHANGED,
          actorUserId: actor.userId,
          metadata: { action: action.type, selected: ids.length, affected: count },
          meta: actor.meta,
        });
        return count;
      },
      { timeout: 30_000 },
    );
    return { affected };
  }

  /**
   * Merge duplicates into the primary. The primary's values win and gaps are filled from the
   * duplicates. An opt-out on any of them applies to the result, since the person said no on at
   * least one number. Duplicates keep their rows: messages from their numbers go to the primary.
   */
  async merge(actor: ContactActor, input: MergeContactsInput): Promise<ContactDto> {
    const duplicateIds = [...new Set(input.duplicateIds)];
    if (duplicateIds.includes(input.primaryId)) {
      throw new AppError(ErrorCode.VALIDATION_FAILED, 'A contact cannot be merged into itself');
    }
    const row = await this.db.run(
      async (tx) => {
        const ids = [input.primaryId, ...duplicateIds];
        // Consistent order, so two overlapping merges cannot deadlock.
        await tx.$queryRaw`SELECT id FROM contacts WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
        const primary = await this.loadLive(tx, input.primaryId);
        const duplicates = await tx.contact.findMany({
          where: { id: { in: duplicateIds }, ...liveContactWhere },
        });
        if (duplicates.length !== duplicateIds.length) {
          throw new AppError(ErrorCode.NOT_FOUND, 'Contact not found');
        }

        const data: Prisma.ContactUpdateInput = {};
        let name = primary.name;
        let email = primary.email;
        let fields = primary.customFields as Record<string, FieldValue>;
        let lastActivityAt = primary.lastActivityAt;
        let duplicateConsent: { source: string | null } | null = null;
        let optedOutAt = primary.optInStatus === 'opted_out' ? primary.optOutAt : null;
        let anyOptOut = primary.optInStatus === 'opted_out';

        for (const dup of duplicates) {
          name ??= dup.name;
          email ??= dup.email;
          fields = { ...(dup.customFields as Record<string, FieldValue>), ...fields };
          lastActivityAt = later(lastActivityAt, dup.lastActivityAt);
          if (dup.optInStatus === 'opted_in') duplicateConsent ??= { source: dup.optInSource };
          if (dup.optInStatus === 'opted_out') {
            anyOptOut = true;
            optedOutAt = later(optedOutAt, dup.optOutAt);
          }
          await this.moveConversations(tx, dup.id, input.primaryId);

          const tags = await tx.contactTag.findMany({
            where: { contactId: dup.id },
            select: { tagId: true },
          });
          await tx.contactTag.createMany({
            data: tags.map((t) => ({
              orgId: actor.orgId,
              contactId: input.primaryId,
              tagId: t.tagId,
            })),
            skipDuplicates: true,
          });
          await tx.contactNote.updateMany({
            where: { contactId: dup.id },
            data: { contactId: input.primaryId },
          });
          // Anything already merged into this duplicate now points at the primary.
          await tx.contact.updateMany({
            where: { mergedIntoId: dup.id },
            data: { mergedIntoId: input.primaryId },
          });
          await tx.contact.update({
            where: { id: dup.id },
            data: { mergedIntoId: input.primaryId },
          });
        }

        Object.assign(data, { name, email, customFields: fields, lastActivityAt });
        await tx.contact.update({ where: { id: input.primaryId }, data });

        if (anyOptOut && primary.optInStatus !== 'opted_out') {
          await setContactConsent(tx, {
            orgId: actor.orgId,
            contactId: input.primaryId,
            status: 'opted_out',
            source: 'merge',
            proof: 'A merged contact had opted out',
            actorUserId: actor.userId,
          });
        } else if (!anyOptOut && duplicateConsent && primary.optInStatus !== 'opted_in') {
          await setContactConsent(tx, {
            orgId: actor.orgId,
            contactId: input.primaryId,
            status: 'opted_in',
            source: 'merge',
            proof: `Consent carried over from a merged contact (${duplicateConsent.source ?? 'unknown source'})`,
            actorUserId: actor.userId,
          });
        } else if (anyOptOut && optedOutAt) {
          await tx.contact.update({
            where: { id: input.primaryId },
            data: { optOutAt: optedOutAt },
          });
        }

        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CONTACTS_MERGED,
          actorUserId: actor.userId,
          targetType: 'contact',
          targetId: input.primaryId,
          metadata: { duplicateIds },
          meta: actor.meta,
        });
        return this.loadLive(tx, input.primaryId);
      },
      { timeout: 60_000 },
    );
    this.realtime.emit(actor.orgId, 'contact:updated', { contactId: input.primaryId });
    return contactToDto(row);
  }

  /**
   * One conversation per (number, contact). If the primary already talks to this number, the
   * messages join that thread; the emptied thread stays, hidden with its merged contact.
   * The 24-hour window belongs to the number that wrote in, so a moved thread loses it: replies
   * go to the primary's number, which must have an open window of its own.
   */
  private async moveConversations(tx: TenantTx, fromId: string, toId: string): Promise<void> {
    const moving = await tx.conversation.findMany({ where: { contactId: fromId } });
    for (const source of moving) {
      const target = await tx.conversation.findUnique({
        where: {
          orgId_phoneId_contactId: {
            orgId: source.orgId,
            phoneId: source.phoneId,
            contactId: toId,
          },
        },
      });
      if (!target) {
        await tx.conversation.update({
          where: { id: source.id },
          data: { contactId: toId, windowExpiresAt: null },
        });
        continue;
      }
      await tx.message.updateMany({
        where: { conversationId: source.id },
        data: { conversationId: target.id },
      });
      const sourceIsNewer =
        source.lastMessageAt &&
        (!target.lastMessageAt || source.lastMessageAt > target.lastMessageAt);
      await tx.conversation.update({
        where: { id: target.id },
        data: {
          unreadCount: { increment: source.unreadCount },
          ...(sourceIsNewer
            ? {
                lastMessageAt: source.lastMessageAt,
                lastMessagePreview: source.lastMessagePreview,
              }
            : {}),
        },
      });
      await tx.conversation.update({
        where: { id: source.id },
        data: {
          status: 'closed',
          unreadCount: 0,
          lastMessagePreview: null,
          windowExpiresAt: null,
        },
      });
    }
  }

  // ------------------------------------------------------------------ tags

  async listTags(): Promise<TagDto[]> {
    return this.db.run((tx) =>
      tx.tag.findMany({
        orderBy: { name: 'asc' },
        select: { id: true, name: true, color: true },
      }),
    );
  }

  async createTag(actor: ContactActor, input: z.infer<typeof createTagSchema>): Promise<TagDto> {
    return this.uniqueGuard('A tag with this name already exists', () =>
      this.db.run((tx) =>
        tx.tag.create({
          data: { orgId: actor.orgId, name: input.name, color: input.color },
          select: { id: true, name: true, color: true },
        }),
      ),
    );
  }

  async deleteTag(id: string): Promise<void> {
    const res = await this.db.run((tx) => tx.tag.deleteMany({ where: { id } }));
    if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Tag not found');
  }

  // ------------------------------------------------------------------ custom fields

  async listFields(): Promise<ContactFieldDto[]> {
    return this.db.run((tx) =>
      tx.contactField.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, key: true, label: true, type: true, options: true },
      }),
    );
  }

  async createField(
    actor: ContactActor,
    input: z.infer<typeof createContactFieldSchema>,
  ): Promise<ContactFieldDto> {
    return this.uniqueGuard('A field with this key already exists', () =>
      this.db.run((tx) =>
        tx.contactField.create({
          data: { orgId: actor.orgId, ...input },
          select: { id: true, key: true, label: true, type: true, options: true },
        }),
      ),
    );
  }

  /** Stored values stay in place, so adding the same key back restores them. */
  async deleteField(id: string): Promise<void> {
    const res = await this.db.run((tx) => tx.contactField.deleteMany({ where: { id } }));
    if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Field not found');
  }

  // ------------------------------------------------------------------ segments

  async listSegments(): Promise<SegmentDto[]> {
    const rows = await this.db.run((tx) =>
      tx.segment.findMany({ orderBy: { name: 'asc' }, select: SEGMENT_SELECT }),
    );
    return rows.map(segmentToDto);
  }

  async getSegment(id: string): Promise<SegmentDto> {
    const row = await this.db.run((tx) =>
      tx.segment.findUnique({ where: { id }, select: SEGMENT_SELECT }),
    );
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Segment not found');
    return segmentToDto(row);
  }

  async createSegment(
    actor: ContactActor,
    input: { name: string; filter: SegmentFilter },
  ): Promise<SegmentDto> {
    const row = await this.uniqueGuard('A segment with this name already exists', () =>
      this.db.run((tx) =>
        tx.segment.create({
          data: {
            orgId: actor.orgId,
            name: input.name,
            filter: input.filter,
            createdById: actor.userId,
          },
          select: SEGMENT_SELECT,
        }),
      ),
    );
    return segmentToDto(row);
  }

  async updateSegment(
    id: string,
    input: { name?: string; filter?: SegmentFilter },
  ): Promise<SegmentDto> {
    const row = await this.uniqueGuard('A segment with this name already exists', () =>
      this.db.run(async (tx) => {
        const found = await tx.segment.count({ where: { id } });
        if (!found) throw new AppError(ErrorCode.NOT_FOUND, 'Segment not found');
        return tx.segment.update({ where: { id }, data: input, select: SEGMENT_SELECT });
      }),
    );
    return segmentToDto(row);
  }

  async deleteSegment(id: string): Promise<void> {
    const res = await this.db.run((tx) => tx.segment.deleteMany({ where: { id } }));
    if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Segment not found');
  }

  async segmentCount(filter: SegmentFilter): Promise<{ count: number }> {
    const where: Prisma.ContactWhereInput = {
      AND: [liveContactWhere, segmentFilterToWhere(filter)],
    };
    return { count: await this.db.run((tx) => tx.contact.count({ where })) };
  }

  private async uniqueGuard<T>(message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppError(ErrorCode.CONFLICT, message);
      }
      throw err;
    }
  }
}
