import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  applyTemplateSync,
  type MetaTemplateSnapshot,
  type Prisma,
  templateToDto,
  type TenantTx,
} from '@wacrm/db';
import {
  AppError,
  type ContactForTemplate,
  type CreateTemplateParsed,
  type CursorPage,
  EDITABLE_AT_META,
  ErrorCode,
  type FieldValue,
  HEADER_MEDIA_RULES,
  type InboxTemplateDto,
  type ListTemplatesQuery,
  type MediaHeaderFormat,
  parameterFormatOf,
  resolveVariable,
  sameJsonValue,
  type TemplateDefinition,
  templateDefinitionSchema,
  type TemplateDto,
  templateVariables,
  type TemplateWabaDto,
  toMetaComponents,
  type UpdateTemplateParsed,
  type VariableSource,
} from '@wacrm/shared';
import { type ObjectStorage, templateHeaderKey } from '@wacrm/shared/server';
import {
  type TemplateCategory,
  type WhatsAppError,
  WhatsAppClientFactory,
  type WhatsAppGateway,
} from '@wacrm/whatsapp';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface TemplateActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

type TemplateRow = Prisma.MessageTemplateGetPayload<object>;

const metaFailure = (error: WhatsAppError) =>
  new AppError(ErrorCode.WHATSAPP_META_ERROR, error.message);

@Injectable()
export class TemplatesService {
  private readonly logger = new Logger(TemplatesService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
    private readonly whatsapp: WhatsAppClientFactory,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ------------------------------------------------------------------ read

  async list(q: ListTemplatesQuery): Promise<CursorPage<TemplateDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.messageTemplate.findMany({
        where: {
          ...(q.status ? { status: q.status } : { status: { not: 'deleted' } }),
          ...(q.q ? { name: { contains: q.q.toLowerCase() } } : {}),
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(templateToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  private async load(tx: TenantTx, id: string): Promise<TemplateRow> {
    const row = await tx.messageTemplate.findUnique({ where: { id } });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Template not found');
    return row;
  }

  async get(id: string): Promise<TemplateDto> {
    return templateToDto(await this.db.run((tx) => this.load(tx, id)));
  }

  async listWabas(): Promise<TemplateWabaDto[]> {
    const rows = await this.db.run((tx) =>
      tx.wabaAccount.findMany({
        where: { status: 'active' },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          phoneNumbers: { where: { status: 'connected' }, select: { id: true }, take: 1 },
        },
      }),
    );
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      connected: w.phoneNumbers.length > 0,
    }));
  }

  /** Templates live on a WABA, and any of its connected numbers can reach them. */
  private async gatewayFor(orgId: string, wabaAccountId: string): Promise<WhatsAppGateway> {
    const phone = await this.db.run((tx) =>
      tx.phoneNumber.findFirst({
        where: { wabaAccountId, status: 'connected' },
        select: { phoneNumberId: true },
      }),
    );
    if (!phone) {
      throw new AppError(
        ErrorCode.NUMBER_NOT_CONNECTED,
        'Connect a WhatsApp number on this account first',
      );
    }
    return this.whatsapp.get({ orgId, phoneNumberId: phone.phoneNumberId });
  }

  private publish(orgId: string, templateId: string | null) {
    this.realtime.emit(orgId, 'template:updated', { templateId });
  }

  // ------------------------------------------------------------------ create and edit

  async create(actor: TemplateActor, input: CreateTemplateParsed): Promise<TemplateDto> {
    const row = await this.uniqueGuard(async () => {
      return this.db.run(async (tx) => {
        const waba = input.wabaAccountId
          ? await tx.wabaAccount.findFirst({
              where: { id: input.wabaAccountId, status: 'active' },
              select: { id: true },
            })
          : await tx.wabaAccount.findFirst({
              where: { status: 'active' },
              orderBy: { createdAt: 'asc' },
              select: { id: true },
            });
        if (!waba) {
          throw new AppError(
            ErrorCode.NUMBER_NOT_CONNECTED,
            'Connect a WhatsApp number before creating templates',
          );
        }
        return tx.messageTemplate.create({
          data: {
            orgId: actor.orgId,
            wabaAccountId: waba.id,
            name: input.name,
            language: input.language,
            category: input.category,
            status: 'draft',
            parameterFormat: parameterFormatOf(input.definition),
            definition: input.definition,
            samples: this.keepKnownSamples(input.definition, input.samples),
            variableMapping: this.keepKnownMapping(input.definition, input.variableMapping),
            createdById: actor.userId,
          },
        });
      });
    });
    this.publish(actor.orgId, row.id);
    return templateToDto(row);
  }

  /**
   * A draft changes here only. A submitted template changes at Meta first, and nothing is saved
   * unless Meta accepts it, so the local copy never differs from what Meta reviewed. Editing only
   * the variable mapping stays local, since Meta never sees it.
   */
  async update(
    actor: TemplateActor,
    id: string,
    input: UpdateTemplateParsed,
  ): Promise<TemplateDto> {
    const current = await this.db.run((tx) => this.load(tx, id));
    const samples = this.keepKnownSamples(input.definition, input.samples);
    const variableMapping = this.keepKnownMapping(input.definition, input.variableMapping);

    if (!current.metaTemplateId) {
      const row = await this.uniqueGuard(() =>
        this.db.run((tx) =>
          tx.messageTemplate.update({
            where: { id },
            data: {
              name: input.name ?? current.name,
              language: input.language ?? current.language,
              category: input.category,
              parameterFormat: parameterFormatOf(input.definition),
              definition: input.definition,
              samples,
              variableMapping,
            },
          }),
        ),
      );
      this.publish(actor.orgId, id);
      return templateToDto(row);
    }

    if (
      (input.name && input.name !== current.name) ||
      (input.language && input.language !== current.language)
    ) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_EDITABLE,
        'A submitted template keeps its name and language. Create a new one instead.',
      );
    }

    const contentChanged =
      !sameJsonValue(current.definition, input.definition) ||
      !sameJsonValue(current.samples, samples) ||
      current.category !== input.category;

    if (!contentChanged) {
      const row = await this.db.run((tx) =>
        tx.messageTemplate.update({ where: { id }, data: { variableMapping } }),
      );
      return templateToDto(row);
    }

    if (!current.supported) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_EDITABLE,
        'This template uses parts this app cannot edit. Change it in WhatsApp Manager.',
      );
    }
    if (!EDITABLE_AT_META.includes(current.status)) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_EDITABLE,
        `A template that is ${current.status.replace('_', ' ')} cannot be edited right now.`,
      );
    }
    if (current.status === 'approved' && current.category !== input.category) {
      throw new AppError(
        ErrorCode.TEMPLATE_NOT_EDITABLE,
        'An approved template cannot change category. Create a new one instead.',
      );
    }

    const gateway = await this.gatewayFor(actor.orgId, current.wabaAccountId);
    const handle = await this.headerHandle(gateway, current, input.definition);
    const res = await gateway.updateTemplate(current.metaTemplateId, {
      category: input.category,
      components: toMetaComponents(input.definition, samples, handle),
      parameterFormat: parameterFormatOf(input.definition),
    });
    if (res.error) throw metaFailure(res.error);

    const row = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.TEMPLATE_SUBMITTED,
        actorUserId: actor.userId,
        targetType: 'template',
        targetId: id,
        metadata: { name: current.name, language: current.language, edit: true },
        meta: actor.meta,
      });
      return tx.messageTemplate.update({
        where: { id },
        data: {
          category: input.category,
          parameterFormat: parameterFormatOf(input.definition),
          definition: input.definition,
          samples,
          variableMapping,
          status: 'pending',
          statusAt: new Date(),
          submittedAt: new Date(),
          rejectedReason: null,
          statusDetail: null,
        },
      });
    });
    this.publish(actor.orgId, id);
    return templateToDto(row);
  }

  private keepKnownSamples(
    def: TemplateDefinition,
    samples: Record<string, string>,
  ): Record<string, string> {
    const keys = templateVariables(def)
      .filter((v) => v.subType !== 'copy_code')
      .map((v) => v.key);
    return Object.fromEntries(keys.filter((k) => samples[k]).map((k) => [k, samples[k] ?? '']));
  }

  private keepKnownMapping(
    def: TemplateDefinition,
    mapping: Record<string, VariableSource>,
  ): Record<string, VariableSource> {
    const keys = new Set(templateVariables(def).map((v) => v.key));
    return Object.fromEntries(Object.entries(mapping).filter(([k]) => keys.has(k)));
  }

  // ------------------------------------------------------------------ submit

  /** A media header needs its sample uploaded to Meta each time it is submitted. */
  private async headerHandle(
    gateway: WhatsAppGateway,
    row: TemplateRow,
    def: TemplateDefinition,
  ): Promise<string | null> {
    if (!def.header || def.header.format === 'TEXT') return null;
    if (!row.headerMediaKey) {
      throw new AppError(
        ErrorCode.TEMPLATE_INVALID,
        `Upload a sample ${def.header.format.toLowerCase()} for the header first`,
      );
    }
    const res = await gateway.uploadTemplateSample({
      bytes: await this.storage.get(row.headerMediaKey),
      mimeType: row.headerMediaMime ?? 'application/octet-stream',
      filename: row.headerMediaName ?? undefined,
    });
    if (res.error) throw metaFailure(res.error);
    return res.data.handle;
  }

  async submit(actor: TemplateActor, id: string): Promise<TemplateDto> {
    const row = await this.db.run((tx) => this.load(tx, id));
    if (row.metaTemplateId) {
      throw new AppError(
        ErrorCode.CONFLICT,
        'This template was already submitted. Edit it to send changes to Meta.',
      );
    }
    const def = templateDefinitionSchema.parse(row.definition);
    const samples = row.samples as Record<string, string>;
    const gateway = await this.gatewayFor(actor.orgId, row.wabaAccountId);
    const handle = await this.headerHandle(gateway, row, def);

    const res = await gateway.createTemplate({
      name: row.name,
      language: row.language,
      category: row.category as TemplateCategory,
      components: toMetaComponents(def, samples, handle),
      parameterFormat: parameterFormatOf(def),
    });
    if (res.error) throw metaFailure(res.error);

    // Meta may have approved or re-categorized it already: its answer is the new state.
    const saved = await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.TEMPLATE_SUBMITTED,
        actorUserId: actor.userId,
        targetType: 'template',
        targetId: id,
        metadata: { name: row.name, language: row.language },
        meta: actor.meta,
      });
      return tx.messageTemplate.update({
        where: { id },
        data: {
          metaTemplateId: res.data.id,
          status: res.data.status.toLowerCase(),
          category: res.data.category || row.category,
          submittedAt: new Date(),
          statusAt: new Date(),
          rejectedReason: null,
          statusDetail: null,
        },
      });
    });
    this.publish(actor.orgId, id);
    return templateToDto(saved);
  }

  // ------------------------------------------------------------------ header file

  /**
   * Stored here: it is the sample Meta reviews on the next submit, and what customers receive.
   * Storing a new file changes nothing at Meta, so a template made elsewhere can get its file.
   */
  async setHeaderMedia(
    actor: TemplateActor,
    id: string,
    file: { bytes: Buffer; mimeType: string; filename: string | null },
  ): Promise<TemplateDto> {
    const current = await this.db.run((tx) => this.load(tx, id));
    const def = templateDefinitionSchema.safeParse(current.definition);
    const format = def.success ? def.data.header?.format : undefined;
    if (!format || format === 'TEXT') {
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'This template has no media header');
    }
    const rule = HEADER_MEDIA_RULES[format as MediaHeaderFormat];
    const mime = file.mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
    if (!rule.types.includes(mime)) {
      throw new AppError(
        ErrorCode.MEDIA_NOT_ALLOWED,
        `A ${format.toLowerCase()} header must be: ${rule.types.join(', ')}`,
      );
    }
    if (file.bytes.length > rule.maxBytes) {
      const mb = Math.round(rule.maxBytes / (1024 * 1024));
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, `This file is over the ${mb} MB limit`);
    }
    const key = `${templateHeaderKey(actor.orgId, id)}/${randomUUID()}`;
    await this.storage.put(key, file.bytes, mime);
    const row = await this.db.run((tx) =>
      tx.messageTemplate.update({
        where: { id },
        data: {
          headerMediaKey: key,
          headerMediaMime: mime,
          headerMediaName: file.filename?.slice(0, 200) ?? null,
        },
      }),
    );
    this.publish(actor.orgId, id);
    return templateToDto(row);
  }

  async headerMediaUrl(id: string): Promise<{ url: string; expiresIn: number }> {
    const row = await this.db.run((tx) =>
      tx.messageTemplate.findUnique({
        where: { id },
        select: { headerMediaKey: true, headerMediaMime: true, headerMediaName: true },
      }),
    );
    if (!row?.headerMediaKey) throw new AppError(ErrorCode.NOT_FOUND, 'No header file');
    const expiresIn = 300;
    return {
      url: await this.storage.signedUrl(row.headerMediaKey, {
        expiresIn,
        filename: row.headerMediaName,
        inline: /^(image|video)\//.test(row.headerMediaMime ?? ''),
      }),
      expiresIn,
    };
  }

  // ------------------------------------------------------------------ delete

  async remove(actor: TemplateActor, id: string): Promise<void> {
    const row = await this.db.run((tx) => this.load(tx, id));
    if (row.metaTemplateId && row.status !== 'deleted') {
      const gateway = await this.gatewayFor(actor.orgId, row.wabaAccountId);
      const res = await gateway.deleteTemplate({ name: row.name, templateId: row.metaTemplateId });
      if (res.error) throw metaFailure(res.error);
    }
    await this.db.run(async (tx) => {
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.TEMPLATE_DELETED,
        actorUserId: actor.userId,
        targetType: 'template',
        targetId: id,
        metadata: { name: row.name, language: row.language },
        meta: actor.meta,
      });
      await tx.messageTemplate.delete({ where: { id } });
    });
    this.publish(actor.orgId, id);
  }

  // ------------------------------------------------------------------ sync

  /** Compare every active WABA with Meta. */
  async syncAll(actor: TemplateActor): Promise<{ changed: number }> {
    const wabas = await this.listWabas();
    let changed = 0;
    for (const waba of wabas.filter((w) => w.connected)) {
      changed += (await this.syncWaba(actor.orgId, waba.id)).changed;
    }
    this.publish(actor.orgId, null);
    return { changed };
  }

  async syncWaba(orgId: string, wabaAccountId: string): Promise<{ changed: number }> {
    const gateway = await this.gatewayFor(orgId, wabaAccountId);
    const templates: MetaTemplateSnapshot[] = [];
    let after: string | undefined;
    do {
      const page = await gateway.listTemplates({ limit: 100, after });
      if (page.error) throw metaFailure(page.error);
      templates.push(...page.data.items);
      after = page.data.nextCursor;
    } while (after);
    return this.db.run((tx) => applyTemplateSync(tx, { orgId, wabaAccountId, templates }), {
      timeout: 30_000,
    });
  }

  // ------------------------------------------------------------------ the inbox picker

  /** What this conversation can send, with variables already filled in from the contact. */
  async forConversation(
    orgId: string,
    wabaAccountId: string,
    contact: ContactForTemplate,
  ): Promise<InboxTemplateDto[]> {
    const waba = await this.db.run((tx) =>
      tx.wabaAccount.findUnique({
        where: { id: wabaAccountId },
        select: { templatesSyncedAt: true },
      }),
    );
    // First use on this account: the customer may already have templates at Meta.
    if (!waba?.templatesSyncedAt) {
      await this.syncWaba(orgId, wabaAccountId).catch((err: unknown) => {
        this.logger.warn(`first template sync failed: ${String(err)}`);
      });
    }
    const rows = await this.db.run((tx) =>
      tx.messageTemplate.findMany({
        where: { wabaAccountId, status: 'approved', supported: true },
        orderBy: [{ name: 'asc' }, { language: 'asc' }],
        take: 500,
      }),
    );
    return rows.flatMap((row) => {
      const parsed = templateDefinitionSchema.safeParse(row.definition);
      if (!parsed.success) return [];
      const definition = parsed.data;
      const mapping = row.variableMapping as Record<string, VariableSource>;
      const samples = row.samples as Record<string, string>;
      const mediaHeader = definition.header && definition.header.format !== 'TEXT';
      return [
        {
          id: row.id,
          name: row.name,
          language: row.language,
          category: row.category,
          definition,
          samples,
          variables: templateVariables(definition).map((v) => {
            const copyCode = definition.buttons[v.buttonIndex ?? -1];
            return {
              key: v.key,
              label: v.label,
              value:
                resolveVariable(mapping[v.key], contact) ||
                (copyCode?.type === 'COPY_CODE' ? copyCode.example : ''),
            };
          }),
          sendIssue:
            mediaHeader && !row.headerMediaKey
              ? 'Upload a header file on the template page first'
              : null,
        },
      ];
    });
  }

  private async uniqueGuard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') {
        throw new AppError(
          ErrorCode.CONFLICT,
          'A template with this name and language already exists',
        );
      }
      throw err;
    }
  }
}

export const contactForTemplate = (c: {
  name: string | null;
  waId: string;
  email: string | null;
  customFields: unknown;
}): ContactForTemplate => ({
  name: c.name,
  waId: c.waId,
  email: c.email,
  customFields: (c.customFields ?? {}) as Record<string, FieldValue>,
});
