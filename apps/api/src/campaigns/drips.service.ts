import { Injectable } from '@nestjs/common';
import { contactListWhere, dripInclude, dripToDto, type Prisma, type TenantTx } from '@wacrm/db';
import {
  AppError,
  type DripDto,
  type EnrollDripInput,
  ErrorCode,
  type SaveDripParsed,
  segmentFilterSchema,
} from '@wacrm/shared';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';
import type { CampaignActor } from './campaigns.service';

const PAGE = 1000;
const MINUTE = 60_000;

@Injectable()
export class DripsService {
  constructor(private readonly db: TenantPrismaService) {}

  private async toDto(tx: TenantTx, id: string): Promise<DripDto> {
    const row = await tx.dripSequence.findUnique({ where: { id }, include: dripInclude });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Sequence not found');
    const enrollments = await tx.dripEnrollment.groupBy({
      by: ['status'],
      where: { sequenceId: id },
      _count: { _all: true },
    });
    return dripToDto(row, enrollments);
  }

  async list(): Promise<DripDto[]> {
    return this.db.run(async (tx) => {
      const rows = await tx.dripSequence.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        select: { id: true },
      });
      const out: DripDto[] = [];
      for (const r of rows) out.push(await this.toDto(tx, r.id));
      return out;
    });
  }

  get(id: string): Promise<DripDto> {
    return this.db.run((tx) => this.toDto(tx, id));
  }

  /** Every step's template must be usable from this number. */
  private async stepRows(tx: TenantTx, input: SaveDripParsed & { orgId: string }) {
    const phone = await tx.phoneNumber.findUnique({
      where: { id: input.phoneId },
      select: { wabaAccountId: true },
    });
    if (!phone) throw new AppError(ErrorCode.NOT_FOUND, 'WhatsApp number not found');
    const ids = [...new Set(input.steps.map((s) => s.templateId))];
    const found = await tx.messageTemplate.findMany({
      where: { id: { in: ids }, wabaAccountId: phone.wabaAccountId },
      select: { id: true, variableMapping: true },
    });
    if (found.length !== ids.length) {
      throw new AppError(
        ErrorCode.CAMPAIGN_INVALID,
        'Every step needs a template from this number’s WhatsApp account',
      );
    }
    if (input.exitTagId) {
      const tag = await tx.tag.count({ where: { id: input.exitTagId } });
      if (!tag) throw new AppError(ErrorCode.VALIDATION_FAILED, 'Unknown tag');
    }
    // A step with no mapping of its own uses its template's, as campaigns do.
    const mappings = new Map(found.map((t) => [t.id, t.variableMapping]));
    return input.steps.map((step, position) => ({
      orgId: input.orgId,
      position,
      delayMinutes: step.delayMinutes,
      templateId: step.templateId,
      variableMapping: Object.keys(step.variableMapping).length
        ? step.variableMapping
        : ((mappings.get(step.templateId) ?? {}) as Prisma.InputJsonValue),
    }));
  }

  async create(actor: CampaignActor, input: SaveDripParsed): Promise<DripDto> {
    return this.db.run(async (tx) => {
      const steps = await this.stepRows(tx, { ...input, orgId: actor.orgId });
      const row = await tx.dripSequence.create({
        data: {
          orgId: actor.orgId,
          name: input.name,
          phoneId: input.phoneId,
          exitOnReply: input.exitOnReply,
          exitTagId: input.exitTagId,
          createdById: actor.userId,
          steps: { create: steps },
        },
        select: { id: true },
      });
      return this.toDto(tx, row.id);
    });
  }

  /** Steps are positions people may be partway through, so they only change before enrolling. */
  async update(actor: CampaignActor, id: string, input: SaveDripParsed): Promise<DripDto> {
    return this.db.run(async (tx) => {
      const steps = await this.stepRows(tx, { ...input, orgId: actor.orgId });
      const enrolled = await tx.dripEnrollment.count({ where: { sequenceId: id } });
      const current = await tx.dripSequence.findUnique({ where: { id }, select: { id: true } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Sequence not found');
      if (enrolled > 0) {
        throw new AppError(
          ErrorCode.CAMPAIGN_NOT_EDITABLE,
          'People are enrolled in this sequence, so its steps cannot change. Create a new one.',
        );
      }
      await tx.dripStep.deleteMany({ where: { sequenceId: id } });
      await tx.dripSequence.update({
        where: { id },
        data: {
          name: input.name,
          phoneId: input.phoneId,
          exitOnReply: input.exitOnReply,
          exitTagId: input.exitTagId,
          steps: { create: steps },
        },
      });
      return this.toDto(tx, id);
    });
  }

  async setStatus(id: string, status: 'active' | 'paused'): Promise<DripDto> {
    return this.db.run(async (tx) => {
      await this.toDto(tx, id);
      await tx.dripSequence.update({ where: { id }, data: { status } });
      return this.toDto(tx, id);
    });
  }

  /** Enrolling someone twice does nothing, so a segment can be enrolled again to add new people. */
  async enroll(
    actor: CampaignActor,
    id: string,
    input: EnrollDripInput,
  ): Promise<{ enrolled: number }> {
    const first = await this.db.run(async (tx) => {
      const steps = await tx.dripStep.findFirst({
        where: { sequenceId: id, position: 0 },
        select: { delayMinutes: true },
      });
      if (!steps) throw new AppError(ErrorCode.NOT_FOUND, 'Sequence not found');
      const filter = input.segmentId
        ? await tx.segment.findUnique({
            where: { id: input.segmentId },
            select: { filter: true },
          })
        : null;
      if (input.segmentId && !filter) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Segment not found');
      }
      return { delay: steps.delayMinutes, filter };
    });
    const nextRunAt = new Date(Date.now() + first.delay * MINUTE);
    const write = (contactIds: string[]) =>
      this.db.run(async (tx) => {
        const res = await tx.dripEnrollment.createMany({
          data: contactIds.map((contactId) => ({
            orgId: actor.orgId,
            sequenceId: id,
            contactId,
            nextRunAt,
          })),
          skipDuplicates: true,
        });
        return res.count;
      });

    if (input.contactIds?.length) {
      const known = await this.db.run((tx) =>
        tx.contact.findMany({
          where: { id: { in: input.contactIds }, deletedAt: null, mergedIntoId: null },
          select: { id: true },
        }),
      );
      return { enrolled: await write(known.map((c) => c.id)) };
    }

    const where = contactListWhere({ segment: segmentFilterSchema.parse(first.filter?.filter) });
    let enrolled = 0;
    let cursor: { createdAt: Date; id: string } | null = null;
    for (;;) {
      const after = cursor as { createdAt: Date; id: string } | null;
      const page = await this.db.run((tx) =>
        tx.contact.findMany({
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
          select: { id: true, createdAt: true },
        }),
      );
      if (page.length) enrolled += await write(page.map((c) => c.id));
      const last = page.at(-1);
      if (!last || page.length < PAGE) break;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    return { enrolled };
  }
}
