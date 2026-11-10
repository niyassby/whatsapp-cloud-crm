import { Injectable } from '@nestjs/common';
import type { Prisma, TenantTx } from '@wacrm/db';
import {
  AppError,
  type AssignmentRuleDto,
  type AssignmentRuleParsed,
  type AutomationSettingsDto,
  type AutomationSettingsInput,
  type AutoReplyRuleDto,
  type AutoReplyRuleParsed,
  type BusinessHours,
  type CursorPage,
  DEFAULT_AUTOMATION_SETTINGS,
  type DefaultAssignment,
  ErrorCode,
  type ListNotificationsQuery,
  type MarkNotificationsReadInput,
  type NotificationDto,
  type NotificationKind,
} from '@wacrm/shared';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface AutomationActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

type AutoReplyRow = Prisma.AutoReplyRuleGetPayload<object>;
type AssignmentRow = Prisma.AssignmentRuleGetPayload<object>;

const autoReplyToDto = (r: AutoReplyRow): AutoReplyRuleDto => ({
  id: r.id,
  name: r.name,
  active: r.active,
  matchType: r.matchType as AutoReplyRuleDto['matchType'],
  keywords: r.keywords,
  pattern: r.pattern,
  reply: r.reply,
  phoneId: r.phoneId,
  priority: r.priority,
  createdAt: r.createdAt.toISOString(),
});

const assignmentToDto = (r: AssignmentRow): AssignmentRuleDto => ({
  id: r.id,
  name: r.name,
  active: r.active,
  priority: r.priority,
  strategy: r.strategy as AssignmentRuleDto['strategy'],
  tagIds: r.tagIds,
  phoneIds: r.phoneIds,
  keywords: r.keywords,
  agentIds: r.agentIds,
  skill: r.skill,
  createdAt: r.createdAt.toISOString(),
});

@Injectable()
export class AutomationService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // ------------------------------------------------------------------ settings

  async getSettings(actor: AutomationActor): Promise<AutomationSettingsDto> {
    return this.db.run(async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: actor.orgId },
        select: { timezone: true },
      });
      const row = await tx.automationSettings.findUnique({ where: { orgId: actor.orgId } });
      if (!row) return { ...DEFAULT_AUTOMATION_SETTINGS, timezone: org.timezone };
      return {
        welcomeEnabled: row.welcomeEnabled,
        welcomeMessage: row.welcomeMessage,
        awayEnabled: row.awayEnabled,
        awayMessage: row.awayMessage,
        businessHours: row.businessHours as BusinessHours | null,
        awayCooldownMinutes: row.awayCooldownMinutes,
        defaultAssignment: row.defaultAssignment as DefaultAssignment,
        slaEnabled: row.slaEnabled,
        slaFirstResponseMinutes: row.slaFirstResponseMinutes,
        slaEscalateAfterMinutes: row.slaEscalateAfterMinutes,
        slaReassignOnEscalate: row.slaReassignOnEscalate,
        timezone: org.timezone,
      };
    });
  }

  async saveSettings(
    actor: AutomationActor,
    input: AutomationSettingsInput,
  ): Promise<AutomationSettingsDto> {
    await this.db.run(async (tx) => {
      const data = {
        ...input,
        businessHours: (input.businessHours ?? undefined) as Prisma.InputJsonValue | undefined,
      };
      const nullHours = input.businessHours === null ? { businessHours: null as never } : {};
      await tx.automationSettings.upsert({
        where: { orgId: actor.orgId },
        create: { orgId: actor.orgId, ...data, ...nullHours },
        update: { ...data, ...nullHours },
      });
      // Turning the SLA off clears every running clock, so nothing breaches after it is off.
      if (!input.slaEnabled) {
        await tx.conversation.updateMany({
          where: { slaDueAt: { not: null } },
          data: { slaDueAt: null, awaitingReplySince: null, slaStage: 0 },
        });
      }
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'automation_settings',
        meta: actor.meta,
      });
    });
    return this.getSettings(actor);
  }

  // ------------------------------------------------------------------ rules

  async listAutoReplies(): Promise<AutoReplyRuleDto[]> {
    const rows = await this.db.run((tx) =>
      tx.autoReplyRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    );
    return rows.map(autoReplyToDto);
  }

  private async assertPhone(tx: TenantTx, phoneIds: (string | null)[]) {
    const ids = phoneIds.filter((p): p is string => Boolean(p));
    if (ids.length === 0) return;
    const found = await tx.phoneNumber.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size)
      throw new AppError(ErrorCode.NOT_FOUND, 'WhatsApp number not found');
  }

  async createAutoReply(
    actor: AutomationActor,
    input: AutoReplyRuleParsed,
  ): Promise<AutoReplyRuleDto> {
    const row = await this.db.run(async (tx) => {
      await this.assertPhone(tx, [input.phoneId]);
      const created = await tx.autoReplyRule.create({ data: { orgId: actor.orgId, ...input } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'auto_reply_rule',
        targetId: created.id,
        meta: actor.meta,
      });
      return created;
    });
    return autoReplyToDto(row);
  }

  async updateAutoReply(
    actor: AutomationActor,
    id: string,
    input: AutoReplyRuleParsed,
  ): Promise<AutoReplyRuleDto> {
    const row = await this.db.run(async (tx) => {
      const current = await tx.autoReplyRule.findUnique({ where: { id } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Rule not found');
      await this.assertPhone(tx, [input.phoneId]);
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'auto_reply_rule',
        targetId: id,
        meta: actor.meta,
      });
      return tx.autoReplyRule.update({ where: { id }, data: input });
    });
    return autoReplyToDto(row);
  }

  async deleteAutoReply(actor: AutomationActor, id: string): Promise<void> {
    await this.db.run(async (tx) => {
      const res = await tx.autoReplyRule.deleteMany({ where: { id } });
      if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Rule not found');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'auto_reply_rule',
        targetId: id,
        meta: actor.meta,
      });
    });
  }

  async listAssignmentRules(): Promise<AssignmentRuleDto[]> {
    const rows = await this.db.run((tx) =>
      tx.assignmentRule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
    );
    return rows.map(assignmentToDto);
  }

  /** Every agent, tag and number named must be in this workspace. */
  private async assertTargets(tx: TenantTx, input: AssignmentRuleParsed) {
    await this.assertPhone(tx, input.phoneIds);
    if (input.agentIds.length) {
      const members = await tx.membership.count({
        where: { userId: { in: input.agentIds }, status: 'active' },
      });
      if (members !== new Set(input.agentIds).size) {
        throw new AppError(ErrorCode.VALIDATION_FAILED, 'Every agent must be an active member');
      }
    }
    if (input.tagIds.length) {
      const tags = await tx.tag.count({ where: { id: { in: input.tagIds } } });
      if (tags !== new Set(input.tagIds).size) {
        throw new AppError(ErrorCode.NOT_FOUND, 'Tag not found');
      }
    }
  }

  async createAssignmentRule(
    actor: AutomationActor,
    input: AssignmentRuleParsed,
  ): Promise<AssignmentRuleDto> {
    const row = await this.db.run(async (tx) => {
      await this.assertTargets(tx, input);
      const created = await tx.assignmentRule.create({ data: { orgId: actor.orgId, ...input } });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'assignment_rule',
        targetId: created.id,
        meta: actor.meta,
      });
      return created;
    });
    return assignmentToDto(row);
  }

  async updateAssignmentRule(
    actor: AutomationActor,
    id: string,
    input: AssignmentRuleParsed,
  ): Promise<AssignmentRuleDto> {
    const row = await this.db.run(async (tx) => {
      const current = await tx.assignmentRule.findUnique({ where: { id } });
      if (!current) throw new AppError(ErrorCode.NOT_FOUND, 'Rule not found');
      await this.assertTargets(tx, input);
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'assignment_rule',
        targetId: id,
        meta: actor.meta,
      });
      return tx.assignmentRule.update({ where: { id }, data: input });
    });
    return assignmentToDto(row);
  }

  async deleteAssignmentRule(actor: AutomationActor, id: string): Promise<void> {
    await this.db.run(async (tx) => {
      const res = await tx.assignmentRule.deleteMany({ where: { id } });
      if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Rule not found');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'assignment_rule',
        targetId: id,
        meta: actor.meta,
      });
    });
  }

  // ------------------------------------------------------------------ people

  /** Agents set their own. Unavailable people are skipped by assignment, and keep what they have. */
  async setAvailability(
    actor: AutomationActor,
    available: boolean,
  ): Promise<{ available: boolean }> {
    await this.db.run((tx) =>
      tx.membership.update({
        where: { orgId_userId: { orgId: actor.orgId, userId: actor.userId } },
        data: { available },
      }),
    );
    return { available };
  }

  async setSkills(
    actor: AutomationActor,
    membershipId: string,
    skills: string[],
  ): Promise<{ skills: string[] }> {
    const unique = [...new Set(skills)];
    await this.db.run(async (tx) => {
      const res = await tx.membership.updateMany({
        where: { id: membershipId, orgId: actor.orgId },
        data: { skills: unique },
      });
      if (res.count === 0) throw new AppError(ErrorCode.NOT_FOUND, 'Member not found');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.AUTOMATION_CHANGED,
        actorUserId: actor.userId,
        targetType: 'membership',
        targetId: membershipId,
        metadata: { skills: unique },
        meta: actor.meta,
      });
    });
    return { skills: unique };
  }

  // ------------------------------------------------------------------ notifications

  /** RLS shows a person only their own, in this workspace. */
  async listNotifications(
    q: ListNotificationsQuery,
  ): Promise<CursorPage<NotificationDto> & { unread: number }> {
    const { rows, unread } = await this.db.run(async (tx) => ({
      rows: await tx.notification.findMany({
        where: {
          ...(q.unread ? { readAt: null } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      }),
      unread: await tx.notification.count({ where: { readAt: null } }),
    }));
    const page = rows.slice(0, q.limit);
    return {
      items: page.map((n) => ({
        id: n.id,
        kind: n.kind as NotificationKind,
        title: n.title,
        body: n.body,
        conversationId: n.conversationId,
        readAt: n.readAt?.toISOString() ?? null,
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit ? (page.at(-1)?.id ?? null) : null,
      unread,
    };
  }

  async markRead(input: MarkNotificationsReadInput): Promise<{ marked: number }> {
    const res = await this.db.run((tx) =>
      tx.notification.updateMany({
        where: { readAt: null, ...('ids' in input ? { id: { in: input.ids } } : {}) },
        data: { readAt: new Date() },
      }),
    );
    return { marked: res.count };
  }
}
