import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  campaignCostMicros,
  campaignCounts,
  campaignInclude,
  campaignToDto,
  contactListWhere,
  dailyRemaining,
  findRate,
  holdCampaignFunds,
  type Prisma,
  releaseCampaignFunds,
  type TenantTx,
  emitWebhookEvent,
} from '@wacrm/db';
import {
  AppError,
  broadcastSkipReason,
  type CampaignCsvOptions,
  type CampaignDto,
  type CampaignEstimateDto,
  type CampaignRecipientDto,
  type CampaignReportDto,
  cleanVariableValue,
  type CreateCampaignParsed,
  csvCell,
  type CursorPage,
  ErrorCode,
  type FieldValue,
  type LaunchCampaignInput,
  type ListCampaignsQuery,
  type ListRecipientsQuery,
  parseCsvHeader,
  resolveVariable,
  type SegmentFilter,
  segmentFilterSchema,
  templateDefinitionSchema,
  templateVariables,
  type UpdateCampaignInput,
  type VariableSource,
  zonedTimeToUtc,
} from '@wacrm/shared';
import { countryOfWaId, type ObjectStorage } from '@wacrm/shared/server';
import { WhatsAppClientFactory } from '@wacrm/whatsapp';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { decodeCursor, encodeCursor } from '../orgs/cursor';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import { WalletService } from '../wallet/wallet.service';

export interface CampaignActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

const PAGE = 1000;
const REPORT_PAGE = 2000;
const HEADER_SCAN_BYTES = 64 * 1024;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    private readonly realtime: RealtimeGateway,
    private readonly wallet: WalletService,
    private readonly whatsapp: WhatsAppClientFactory,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ------------------------------------------------------------------ read

  async list(q: ListCampaignsQuery): Promise<CursorPage<CampaignDto>> {
    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await this.db.run((tx) =>
      tx.campaign.findMany({
        where: {
          ...(q.status ? { status: q.status } : {}),
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
        include: campaignInclude,
      }),
    );
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(campaignToDto),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor({ createdAt: last.createdAt, id: last.id })
          : null,
    };
  }

  private async load(tx: TenantTx, id: string) {
    const row = await tx.campaign.findUnique({ where: { id }, include: campaignInclude });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Campaign not found');
    return row;
  }

  async report(actor: CampaignActor, id: string): Promise<CampaignReportDto> {
    const { row, counts, cost, wallet } = await this.db.run(async (tx) => ({
      row: await this.load(tx, id),
      counts: await campaignCounts(tx, id),
      cost: await campaignCostMicros(tx, id),
      wallet: await tx.wallet.findUnique({
        where: { orgId: actor.orgId },
        select: { currency: true },
      }),
    }));
    const attempted = counts.sent + counts.failed;
    return {
      campaign: campaignToDto(row),
      counts,
      costMicros: cost,
      currency: wallet?.currency ?? this.wallet.defaults.currency,
      failureRate: attempted ? counts.failed / attempted : 0,
    };
  }

  async recipients(id: string, q: ListRecipientsQuery): Promise<CursorPage<CampaignRecipientDto>> {
    const rows = await this.db.run(async (tx) => {
      await this.load(tx, id);
      return tx.campaignRecipient.findMany({
        where: {
          campaignId: id,
          ...(q.status ? { status: q.status } : {}),
          ...(q.cursor ? { id: { gt: q.cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: q.limit + 1,
        include: { contact: { select: { name: true, waId: true } } },
      });
    });
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((r) => ({
        id: r.id,
        contactId: r.contactId,
        contactName: r.contact.name,
        waId: r.contact.waId,
        status: r.status,
        skipReason: r.skipReason,
        errorMessage: r.errorMessage,
        sentAt: r.sentAt?.toISOString() ?? null,
        repliedAt: r.repliedAt?.toISOString() ?? null,
      })),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  /** Every recipient and what happened, as CSV. Pages through in short transactions. */
  async reportCsv(id: string): Promise<string> {
    const lines = ['phone,name,status,skip_reason,error,sent_at,replied_at'];
    let after: string | undefined;
    await this.db.run((tx) => this.load(tx, id));
    for (;;) {
      const cursor = after;
      const page = await this.db.run((tx) =>
        tx.campaignRecipient.findMany({
          where: { campaignId: id, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: REPORT_PAGE,
          include: { contact: { select: { name: true, waId: true } } },
        }),
      );
      for (const r of page) {
        lines.push(
          [
            `+${r.contact.waId}`,
            csvCell(r.contact.name),
            r.status,
            csvCell(r.skipReason),
            csvCell(r.errorMessage),
            r.sentAt?.toISOString() ?? '',
            r.repliedAt?.toISOString() ?? '',
          ].join(','),
        );
      }
      const last = page.at(-1);
      if (!last || page.length < REPORT_PAGE) break;
      after = last.id;
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  // ------------------------------------------------------------------ drafts

  private async assertSendable(tx: TenantTx, phoneId: string, templateId: string) {
    const phone = await tx.phoneNumber.findUnique({
      where: { id: phoneId },
      select: { id: true, wabaAccountId: true, status: true },
    });
    if (!phone) throw new AppError(ErrorCode.NOT_FOUND, 'WhatsApp number not found');
    const template = await tx.messageTemplate.findUnique({ where: { id: templateId } });
    if (!template) throw new AppError(ErrorCode.NOT_FOUND, 'Template not found');
    if (template.wabaAccountId !== phone.wabaAccountId) {
      throw new AppError(
        ErrorCode.CAMPAIGN_INVALID,
        'That template belongs to a different WhatsApp account than this number',
      );
    }
    return { phone, template };
  }

  async create(actor: CampaignActor, input: CreateCampaignParsed): Promise<CampaignDto> {
    const row = await this.db.run(async (tx) => {
      const { template } = await this.assertSendable(tx, input.phoneId, input.templateId);
      return tx.campaign.create({
        data: {
          orgId: actor.orgId,
          name: input.name,
          phoneId: input.phoneId,
          templateId: input.templateId,
          audience: input.audience,
          // Starts from the template's mapping, so it does not need setting up twice.
          variableMapping: Object.keys(input.variableMapping).length
            ? input.variableMapping
            : (template.variableMapping as Prisma.InputJsonValue),
          createdById: actor.userId,
        },
        include: campaignInclude,
      });
    });
    return campaignToDto(row);
  }

  private async draft(tx: TenantTx, id: string) {
    const row = await this.load(tx, id);
    if (row.status !== 'draft') {
      throw new AppError(ErrorCode.CAMPAIGN_NOT_EDITABLE, 'Only a draft can be changed');
    }
    return row;
  }

  async update(id: string, input: UpdateCampaignInput): Promise<CampaignDto> {
    const row = await this.db.run(async (tx) => {
      const current = await this.draft(tx, id);
      await this.assertSendable(
        tx,
        input.phoneId ?? current.phoneId,
        input.templateId ?? current.templateId,
      );
      return tx.campaign.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name } : {}),
          ...(input.phoneId ? { phoneId: input.phoneId } : {}),
          ...(input.templateId ? { templateId: input.templateId } : {}),
          ...(input.audience ? { audience: input.audience as Prisma.InputJsonValue } : {}),
          ...(input.variableMapping ? { variableMapping: input.variableMapping } : {}),
        },
        include: campaignInclude,
      });
    });
    return campaignToDto(row);
  }

  async remove(id: string): Promise<void> {
    await this.db.run(async (tx) => {
      await this.draft(tx, id);
      await tx.campaign.delete({ where: { id } });
    });
  }

  /** Store an audience file. The worker reads it when the campaign starts. */
  async setCsvAudience(
    actor: CampaignActor,
    id: string,
    file: { bytes: Buffer; filename: string | null },
    options: CampaignCsvOptions,
  ): Promise<CampaignDto> {
    const headers = parseCsvHeader(file.bytes.subarray(0, HEADER_SCAN_BYTES).toString('utf8'));
    const mapped = [
      options.phoneColumn,
      options.nameColumn,
      ...Object.values(options.variableColumns),
    ].filter((c): c is string => Boolean(c));
    const missing = mapped.filter((c) => !headers.includes(c));
    if (missing.length) {
      throw new AppError(
        ErrorCode.CAMPAIGN_INVALID,
        `These columns are not in the file: ${missing.join(', ')}`,
      );
    }
    await this.db.run((tx) => this.draft(tx, id));
    const key = `orgs/${actor.orgId}/campaigns/${id}/${randomUUID()}.csv`;
    await this.storage.put(key, file.bytes, 'text/csv');
    const row = await this.db.run((tx) =>
      tx.campaign.update({
        where: { id },
        data: {
          audience: {
            type: 'csv',
            key,
            filename: file.filename?.slice(0, 200) ?? null,
            ...options,
          } as Prisma.InputJsonValue,
        },
        include: campaignInclude,
      }),
    );
    return campaignToDto(row);
  }

  // ------------------------------------------------------------------ estimate and launch

  /** The saved segment's filter, or the ad-hoc one, as it stands now. */
  private async audienceFilter(tx: TenantTx, audience: unknown): Promise<SegmentFilter> {
    const a = audience as { segmentId?: string; filter?: unknown };
    if (a.segmentId) {
      const segment = await tx.segment.findUnique({
        where: { id: a.segmentId },
        select: { filter: true },
      });
      if (!segment) throw new AppError(ErrorCode.CAMPAIGN_INVALID, 'That segment no longer exists');
      return segmentFilterSchema.parse(segment.filter);
    }
    return segmentFilterSchema.parse(a.filter ?? {});
  }

  /** Who this would reach and what it would cost, before committing to anything. */
  async estimate(actor: CampaignActor, id: string): Promise<CampaignEstimateDto> {
    const { currency } = this.wallet.defaults;
    const wallet = await this.wallet.get({ userId: actor.userId, orgId: actor.orgId });
    const setup = await this.db.run(async (tx) => {
      const row = await this.load(tx, id);
      const phone = await tx.phoneNumber.findUniqueOrThrow({
        where: { id: row.phoneId },
        select: { messagingTier: true },
      });
      const template = await tx.messageTemplate.findUniqueOrThrow({
        where: { id: row.templateId },
      });
      return {
        row,
        template,
        remaining: await dailyRemaining(tx, row.phoneId, phone.messagingTier),
        filter:
          (row.audience as { type: string }).type === 'csv'
            ? null
            : await this.audienceFilter(tx, row.audience),
      };
    });
    const result: CampaignEstimateDto = {
      total: 0,
      sendable: 0,
      skipped: {},
      estimateMicros: 0,
      currency: wallet.currency ?? currency,
      unpriced: 0,
      dailyRemaining: setup.remaining,
      availableMicros: wallet.availableMicros,
    };
    // A file is only read when the campaign starts, so there is nothing to count yet.
    if (!setup.filter) return result;

    const def = templateDefinitionSchema.safeParse(setup.template.definition);
    const variables = def.success ? templateVariables(def.data) : [];
    const mapping = setup.row.variableMapping as Record<string, VariableSource>;
    const where = contactListWhere({ segment: setup.filter });
    const rates = new Map<string, number | null>();
    let cursor: { createdAt: Date; id: string } | null = null;

    for (;;) {
      const after = cursor as { createdAt: Date; id: string } | null;
      const page = await this.db.run(async (tx) => {
        const rows = await tx.contact.findMany({
          where: after
            ? {
                AND: [
                  where,
                  {
                    OR: [
                      { createdAt: { lt: after.createdAt } },
                      { createdAt: after.createdAt, id: { lt: after.id } },
                    ],
                  },
                ],
              }
            : where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: PAGE,
          select: {
            id: true,
            createdAt: true,
            waId: true,
            name: true,
            email: true,
            customFields: true,
            optInStatus: true,
          },
        });
        for (const c of rows) {
          result.total++;
          const reason = broadcastSkipReason(c.optInStatus, setup.template.category);
          if (reason) {
            result.skipped[reason] = (result.skipped[reason] ?? 0) + 1;
            continue;
          }
          const contact = {
            name: c.name,
            waId: c.waId,
            email: c.email,
            customFields: (c.customFields ?? {}) as Record<string, FieldValue>,
          };
          const missing = variables.some((v) => {
            const button = def.success ? def.data.buttons[v.buttonIndex ?? -1] : undefined;
            return (
              !cleanVariableValue(resolveVariable(mapping[v.key], contact)) &&
              button?.type !== 'COPY_CODE'
            );
          });
          if (missing) {
            result.skipped.missing_variable = (result.skipped.missing_variable ?? 0) + 1;
            continue;
          }
          const country = countryOfWaId(c.waId);
          const key = country ?? '';
          if (!rates.has(key)) {
            const quote = await findRate(tx, {
              currency: result.currency,
              category: setup.template.category,
              country,
            });
            rates.set(key, quote?.rateMicros ?? null);
          }
          const rate = rates.get(key) ?? null;
          if (rate === null) result.unpriced++;
          else result.estimateMicros += rate;
          result.sendable++;
        }
        return rows;
      });
      const last = page.at(-1);
      if (!last || page.length < PAGE) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return result;
  }

  async launch(actor: CampaignActor, id: string, input: LaunchCampaignInput): Promise<CampaignDto> {
    const scheduledAt =
      input.when === 'scheduled' ? zonedTimeToUtc(input.localTime, input.timezone) : null;
    if (scheduledAt && scheduledAt.getTime() < Date.now() - 60_000) {
      throw new AppError(ErrorCode.CAMPAIGN_INVALID, 'Choose a time in the future');
    }

    const row = await this.db.run(async (tx) => {
      const current = await this.draft(tx, id);
      const { phone, template } = await this.assertSendable(
        tx,
        current.phoneId,
        current.templateId,
      );
      if (phone.status !== 'connected') {
        throw new AppError(ErrorCode.NUMBER_NOT_CONNECTED, 'This WhatsApp number is not connected');
      }
      if (template.status !== 'approved' || !template.supported) {
        throw new AppError(ErrorCode.CAMPAIGN_INVALID, 'The template must be approved first');
      }
      const def = templateDefinitionSchema.parse(template.definition);
      if (def.header && def.header.format !== 'TEXT' && !template.headerMediaKey) {
        throw new AppError(
          ErrorCode.CAMPAIGN_INVALID,
          'This template needs a header file. Upload one on the template page.',
        );
      }
      const audience = current.audience as Record<string, unknown>;
      let snapshot: Prisma.InputJsonValue = audience as Prisma.InputJsonValue;
      if (audience.type !== 'csv') {
        // Copied now, so editing the segment later cannot change a running campaign.
        const filter = await this.audienceFilter(tx, audience);
        snapshot = {
          ...audience,
          filterSnapshot: { segment: filter },
        } as Prisma.InputJsonValue;
      }
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CAMPAIGN_LAUNCHED,
        actorUserId: actor.userId,
        targetType: 'campaign',
        targetId: id,
        metadata: { scheduledAt: scheduledAt?.toISOString() ?? null },
        meta: actor.meta,
      });
      return tx.campaign.update({
        where: { id },
        data: {
          audience: snapshot,
          status: scheduledAt ? 'scheduled' : 'preparing',
          scheduledAt,
          timezone: input.when === 'scheduled' ? input.timezone : null,
        },
        include: campaignInclude,
      });
    });

    await this.refreshNumber(actor.orgId, row.phoneId);
    if (!scheduledAt) {
      // If this fails, the scheduler picks the campaign up within a couple of minutes.
      await this.queues
        .enqueueCampaignJob({ kind: 'prepare', orgId: actor.orgId, campaignId: id })
        .catch((err: unknown) => this.logger.warn(`could not queue a campaign: ${String(err)}`));
    }
    this.realtime.emit(actor.orgId, 'campaign:updated', { campaignId: id });
    return campaignToDto(row);
  }

  /** Limits and quality decide how a campaign behaves, so get the latest from Meta if possible. */
  private async refreshNumber(orgId: string, phoneId: string): Promise<void> {
    try {
      const phone = await this.db.run((tx) =>
        tx.phoneNumber.findUniqueOrThrow({
          where: { id: phoneId },
          select: { phoneNumberId: true },
        }),
      );
      const gateway = await this.whatsapp.get({ orgId, phoneNumberId: phone.phoneNumberId });
      const info = await gateway.getPhoneInfo();
      if (info.error) return;
      await this.db.run((tx) =>
        tx.phoneNumber.update({
          where: { id: phoneId },
          data: {
            ...(info.data.messagingTier ? { messagingTier: info.data.messagingTier } : {}),
            ...(info.data.qualityRating ? { qualityRating: info.data.qualityRating } : {}),
          },
        }),
      );
    } catch (err) {
      this.logger.warn(`could not refresh a number before a campaign: ${String(err)}`);
    }
  }

  // ------------------------------------------------------------------ controls

  async pause(actor: CampaignActor, id: string): Promise<CampaignDto> {
    const row = await this.db.run(async (tx) => {
      const current = await this.load(tx, id);
      if (current.status !== 'running') {
        throw new AppError(ErrorCode.CAMPAIGN_NOT_EDITABLE, 'Only a running campaign can pause');
      }
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.CAMPAIGN_PAUSED,
        actorUserId: actor.userId,
        targetType: 'campaign',
        targetId: id,
        meta: actor.meta,
      });
      await emitWebhookEvent(tx, actor.orgId, 'campaign.paused', {
        id,
        name: current.name,
        code: 'manual',
        reason: 'Paused by a team member.',
      });
      return tx.campaign.update({
        where: { id },
        data: {
          status: 'paused',
          pauseCode: 'manual',
          pauseReason: 'Paused by a team member.',
          waitingUntil: null,
        },
        include: campaignInclude,
      });
    });
    this.realtime.emit(actor.orgId, 'campaign:updated', { campaignId: id });
    return campaignToDto(row);
  }

  async resume(actor: CampaignActor, id: string): Promise<CampaignDto> {
    const row = await this.db.run(
      async (tx) => {
        const current = await this.load(tx, id);
        if (current.status !== 'paused') {
          throw new AppError(ErrorCode.CAMPAIGN_NOT_EDITABLE, 'Only a paused campaign can resume');
        }
        const phone = await tx.phoneNumber.findUniqueOrThrow({
          where: { id: current.phoneId },
          select: { status: true },
        });
        if (phone.status !== 'connected') {
          throw new AppError(
            ErrorCode.NUMBER_NOT_CONNECTED,
            'This WhatsApp number is not connected',
          );
        }
        // Refuses here, with the reason, if the wallet still cannot cover what is left.
        await holdCampaignFunds(tx, { orgId: actor.orgId, campaignId: id });
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CAMPAIGN_RESUMED,
          actorUserId: actor.userId,
          targetType: 'campaign',
          targetId: id,
          meta: actor.meta,
        });
        return tx.campaign.update({
          where: { id },
          data: { status: 'running', pauseCode: null, pauseReason: null },
          include: campaignInclude,
        });
      },
      { timeout: 30_000 },
    );
    await this.queues
      .enqueueCampaignJob({ kind: 'dispatch', orgId: actor.orgId, campaignId: id })
      .catch((err: unknown) => this.logger.warn(`could not queue a campaign: ${String(err)}`));
    this.realtime.emit(actor.orgId, 'campaign:updated', { campaignId: id });
    return campaignToDto(row);
  }

  /** Stops whatever has not gone out, and gives back the money held for it. */
  async cancel(actor: CampaignActor, id: string): Promise<CampaignDto> {
    const row = await this.db.run(
      async (tx) => {
        const current = await this.load(tx, id);
        if (!['scheduled', 'preparing', 'running', 'paused'].includes(current.status)) {
          throw new AppError(ErrorCode.CAMPAIGN_NOT_EDITABLE, 'This campaign cannot be cancelled');
        }
        await tx.campaignRecipient.updateMany({
          where: { campaignId: id, status: 'pending' },
          data: { status: 'cancelled' },
        });
        await releaseCampaignFunds(tx, actor.orgId, id);
        await this.audit.record(tx, actor.orgId, {
          action: AuditAction.CAMPAIGN_CANCELLED,
          actorUserId: actor.userId,
          targetType: 'campaign',
          targetId: id,
          meta: actor.meta,
        });
        return tx.campaign.update({
          where: { id },
          data: { status: 'cancelled', finishedAt: new Date(), waitingUntil: null },
          include: campaignInclude,
        });
      },
      { timeout: 30_000 },
    );
    this.wallet.changed(actor.orgId);
    this.realtime.emit(actor.orgId, 'campaign:updated', { campaignId: id });
    return campaignToDto(row);
  }
}
