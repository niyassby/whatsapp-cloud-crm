import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type TenantTx } from '@wacrm/db';
import {
  ACTIVE_FLOW_RUN_STATUSES,
  AppError,
  type CreateFlowInput,
  type CursorPage,
  EMPTY_FLOW_DEFINITION,
  ErrorCode,
  type FlowDefinition,
  flowDefinitionSchema,
  type FlowDto,
  type FlowIssue,
  flowIssues,
  type FlowRunDto,
  type FlowRunStatus,
  type FlowRunStepDto,
  type FlowTriggerType,
  type FlowVersionDto,
  hasFlowErrors,
  type ListFlowRunsQuery,
  mediaRuleFor,
  sameJsonValue,
  type UpdateFlowInput,
  UNSET_ID,
} from '@wacrm/shared';
import type { ObjectStorage } from '@wacrm/shared/server';
import { AuditAction, AuditService } from '../audit/audit.service';
import type { RequestMeta } from '../common/request-meta';
import { OBJECT_STORAGE } from '../infra/infra.tokens';
import { QueuesService } from '../infra/queues.service';
import { TenantPrismaService } from '../tenancy/tenant-prisma.service';

export interface FlowActor {
  userId: string;
  orgId: string;
  meta?: RequestMeta;
}

type FlowRow = Prisma.FlowGetPayload<{ include: { publishedVersion: true } }>;

const flowInclude = { publishedVersion: true } as const;

/** A stored draft that no longer parses (an older shape) opens as an empty flow, never a 500. */
function parseDraft(raw: unknown): FlowDefinition {
  const parsed = flowDefinitionSchema.safeParse(raw);
  return parsed.success ? parsed.data : EMPTY_FLOW_DEFINITION;
}

function toDto(row: FlowRow, activeRuns: number, issues?: FlowIssue[]): FlowDto {
  const draft = parseDraft(row.draft);
  return {
    id: row.id,
    name: row.name,
    active: row.active,
    triggerType: (row.publishedVersion ? row.triggerType : draft.trigger.type) as FlowTriggerType,
    draft,
    issues: issues ?? flowIssues(draft),
    hasUnpublishedChanges:
      !row.publishedVersion || !sameJsonValue(row.publishedVersion.definition, draft),
    publishedVersion: row.publishedVersion?.version ?? null,
    publishedAt: row.publishedVersion?.publishedAt.toISOString() ?? null,
    activeRuns,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

type RunRow = Prisma.FlowRunGetPayload<{
  include: {
    version: { select: { version: true } };
    contact: { select: { id: true; name: true; waId: true } };
  };
}>;

const runInclude = {
  version: { select: { version: true } },
  contact: { select: { id: true, name: true, waId: true } },
} as const;

function runToDto(r: RunRow): FlowRunDto {
  return {
    id: r.id,
    flowId: r.flowId,
    version: r.version.version,
    status: r.status as FlowRunStatus,
    contact: r.contact,
    conversationId: r.conversationId,
    currentNodeId: r.currentNodeId,
    variables: (r.variables ?? {}) as Record<string, unknown>,
    steps: r.steps,
    waitingUntil: r.status === 'waiting' ? (r.wakeAt?.toISOString() ?? null) : null,
    endReason: r.endReason,
    error: r.error,
    startedAt: r.startedAt.toISOString(),
    endedAt: r.endedAt?.toISOString() ?? null,
  };
}

const stepToDto = (s: Prisma.FlowRunStepGetPayload<object>): FlowRunStepDto => ({
  id: s.id,
  nodeId: s.nodeId,
  nodeType: s.nodeType,
  outcome: s.outcome,
  detail: (s.detail ?? null) as Record<string, unknown> | null,
  createdAt: s.createdAt.toISOString(),
});

const MAX_FLOW_MEDIA_BYTES = 16 * 1024 * 1024;

@Injectable()
export class FlowsService {
  constructor(
    private readonly db: TenantPrismaService,
    private readonly audit: AuditService,
    private readonly queues: QueuesService,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  // ------------------------------------------------------------------ flows

  private async activeRunCounts(tx: TenantTx, flowIds: string[]): Promise<Map<string, number>> {
    if (flowIds.length === 0) return new Map();
    const rows = await tx.flowRun.groupBy({
      by: ['flowId'],
      where: { flowId: { in: flowIds }, status: { in: ACTIVE_FLOW_RUN_STATUSES } },
      _count: { _all: true },
    });
    return new Map(rows.map((r) => [r.flowId, r._count._all]));
  }

  private async load(tx: TenantTx, id: string): Promise<FlowRow> {
    const row = await tx.flow.findFirst({ where: { id, deletedAt: null }, include: flowInclude });
    if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Flow not found');
    return row;
  }

  private async dto(tx: TenantTx, row: FlowRow, issues?: FlowIssue[]): Promise<FlowDto> {
    const counts = await this.activeRunCounts(tx, [row.id]);
    return toDto(row, counts.get(row.id) ?? 0, issues);
  }

  list(): Promise<FlowDto[]> {
    return this.db.run(async (tx) => {
      const rows = await tx.flow.findMany({
        where: { deletedAt: null },
        include: flowInclude,
        orderBy: { createdAt: 'desc' },
      });
      const counts = await this.activeRunCounts(
        tx,
        rows.map((r) => r.id),
      );
      return rows.map((r) => toDto(r, counts.get(r.id) ?? 0));
    });
  }

  get(id: string): Promise<FlowDto> {
    return this.db.run(async (tx) => this.dto(tx, await this.load(tx, id)));
  }

  create(actor: FlowActor, input: CreateFlowInput): Promise<FlowDto> {
    const draft = input.definition
      ? flowDefinitionSchema.parse(input.definition)
      : EMPTY_FLOW_DEFINITION;
    return this.db.run(async (tx) => {
      const row = await tx.flow.create({
        data: {
          orgId: actor.orgId,
          name: input.name.trim(),
          draft: draft as unknown as Prisma.InputJsonValue,
          triggerType: draft.trigger.type,
          createdById: actor.userId,
        },
        include: flowInclude,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.FLOW_CHANGED,
        actorUserId: actor.userId,
        targetType: 'flow',
        targetId: row.id,
        metadata: { change: 'created', name: row.name },
        meta: actor.meta,
      });
      return this.dto(tx, row);
    });
  }

  /** Saves the draft, issues and all. What runs only changes on publish. */
  update(actor: FlowActor, id: string, input: UpdateFlowInput): Promise<FlowDto> {
    const draft = input.definition ? flowDefinitionSchema.parse(input.definition) : undefined;
    return this.db.run(async (tx) => {
      await this.load(tx, id);
      const row = await tx.flow.update({
        where: { id },
        data: {
          ...(input.name ? { name: input.name.trim() } : {}),
          ...(draft ? { draft: draft as unknown as Prisma.InputJsonValue } : {}),
        },
        include: flowInclude,
      });
      return this.dto(tx, row);
    });
  }

  /**
   * What a definition points at must exist in this workspace: templates on a connected account,
   * tags, members, custom fields and files. Checked at publish, since a draft may be unfinished.
   */
  private async referenceIssues(
    tx: TenantTx,
    orgId: string,
    def: FlowDefinition,
  ): Promise<FlowIssue[]> {
    const issues: FlowIssue[] = [];
    const error = (nodeId: string | null, message: string) =>
      issues.push({ nodeId, message, level: 'error' });

    const templateIds = new Set<string>();
    const tagIds = new Set<string>();
    const userIds = new Set<string>();
    const fieldKeys = new Set<string>();
    if (def.trigger.type === 'tag_added') tagIds.add(def.trigger.tagId);
    if (def.trigger.type === 'template_button' && def.trigger.templateId) {
      templateIds.add(def.trigger.templateId);
    }
    for (const node of def.nodes) {
      // Unchosen ids are reported by flowIssues already.
      if (node.type === 'send_template' && node.data.templateId !== UNSET_ID) {
        templateIds.add(node.data.templateId);
      }
      if (node.type === 'tag' && node.data.tagId !== UNSET_ID) tagIds.add(node.data.tagId);
      if ((node.type === 'assign_agent' || node.type === 'human_handoff') && node.data.userId) {
        userIds.add(node.data.userId);
      }
      if (node.type === 'ask_question' && node.data.contactField) {
        fieldKeys.add(node.data.contactField);
      }
      if (node.type === 'media' && !node.data.mediaKey.startsWith(`orgs/${orgId}/flows/`)) {
        error(node.id, 'Upload this file again');
      }
      for (const c of node.type === 'condition'
        ? node.data.branches.flatMap((b) => b.conditions)
        : []) {
        if (c.kind === 'tag') tagIds.add(c.tagId);
      }
    }
    const [templates, tags, members, fields, phone] = await Promise.all([
      tx.messageTemplate.findMany({
        where: { id: { in: [...templateIds] } },
        select: { id: true, status: true, supported: true },
      }),
      tx.tag.findMany({ where: { id: { in: [...tagIds] } }, select: { id: true } }),
      tx.membership.findMany({
        where: { orgId, userId: { in: [...userIds] }, status: 'active' },
        select: { userId: true },
      }),
      tx.contactField.findMany({ where: { key: { in: [...fieldKeys] } }, select: { key: true } }),
      def.settings.phoneId
        ? tx.phoneNumber.findUnique({ where: { id: def.settings.phoneId }, select: { id: true } })
        : Promise.resolve(null),
    ]);
    const has = <T>(rows: T[], pick: (r: T) => string) => new Set(rows.map(pick));
    const foundTemplates = new Map(templates.map((t) => [t.id, t]));
    const foundTags = has(tags, (t) => t.id);
    const foundMembers = has(members, (m) => m.userId);
    const foundFields = has(fields, (f) => f.key);

    if (def.trigger.type === 'tag_added' && !foundTags.has(def.trigger.tagId)) {
      error(null, 'Trigger: the tag no longer exists');
    }
    if (
      def.trigger.type === 'template_button' &&
      def.trigger.templateId &&
      !foundTemplates.has(def.trigger.templateId)
    ) {
      error(null, 'Trigger: the template no longer exists');
    }
    if (def.settings.phoneId && !phone) error(null, 'The chosen number no longer exists');
    for (const node of def.nodes) {
      if (node.type === 'send_template' && node.data.templateId !== UNSET_ID) {
        const t = foundTemplates.get(node.data.templateId);
        if (!t) error(node.id, 'The template no longer exists');
        else if (!t.supported) error(node.id, 'This template cannot be sent from the app');
        else if (t.status !== 'approved') {
          issues.push({
            nodeId: node.id,
            message: 'The template is not approved yet',
            level: 'warning',
          });
        }
      }
      if (node.type === 'tag' && node.data.tagId !== UNSET_ID && !foundTags.has(node.data.tagId)) {
        error(node.id, 'The tag no longer exists');
      }
      if (
        (node.type === 'assign_agent' || node.type === 'human_handoff') &&
        node.data.userId &&
        !foundMembers.has(node.data.userId)
      ) {
        error(node.id, 'This person is no longer in the workspace');
      }
      if (
        node.type === 'ask_question' &&
        node.data.contactField &&
        !foundFields.has(node.data.contactField)
      ) {
        error(node.id, `There is no contact field called ${node.data.contactField}`);
      }
      if (node.type === 'condition') {
        for (const c of node.data.branches.flatMap((b) => b.conditions)) {
          if (c.kind === 'tag' && !foundTags.has(c.tagId))
            error(node.id, 'A tag in a condition no longer exists');
        }
      }
    }
    return issues;
  }

  /** A new flow with this one's draft, off and unpublished, for trying a variation. */
  duplicate(actor: FlowActor, id: string): Promise<FlowDto> {
    return this.db.run(async (tx) => {
      const row = await this.load(tx, id);
      const copy = await tx.flow.create({
        data: {
          orgId: actor.orgId,
          name: `${row.name} (copy)`.slice(0, 100),
          draft: parseDraft(row.draft) as unknown as Prisma.InputJsonValue,
          triggerType: parseDraft(row.draft).trigger.type,
          createdById: actor.userId,
        },
        include: flowInclude,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.FLOW_CHANGED,
        actorUserId: actor.userId,
        targetType: 'flow',
        targetId: copy.id,
        metadata: { change: 'duplicated', from: id },
        meta: actor.meta,
      });
      return this.dto(tx, copy);
    });
  }

  /** Throw away draft changes: the draft becomes the published version again. */
  revert(actor: FlowActor, id: string): Promise<FlowDto> {
    return this.db.run(async (tx) => {
      const row = await this.load(tx, id);
      if (!row.publishedVersion) {
        throw new AppError(ErrorCode.FLOW_INVALID, 'This flow has never been published');
      }
      const updated = await tx.flow.update({
        where: { id },
        data: { draft: row.publishedVersion.definition as Prisma.InputJsonValue },
        include: flowInclude,
      });
      return this.dto(tx, updated);
    });
  }

  /** Freeze the draft as a new version. New runs use it; runs already going keep theirs. */
  publish(actor: FlowActor, id: string): Promise<FlowDto> {
    return this.db.run(async (tx) => {
      // Reviewed raw SQL: a row lock under RLS, so two publishes cannot take one version number.
      await tx.$queryRaw`SELECT 1 FROM flows WHERE id = ${id}::uuid FOR UPDATE`;
      const row = await this.load(tx, id);
      const draft = parseDraft(row.draft);
      const issues = [
        ...flowIssues(draft),
        ...(await this.referenceIssues(tx, actor.orgId, draft)),
      ];
      if (hasFlowErrors(issues)) {
        throw new AppError(ErrorCode.FLOW_INVALID, 'Fix the problems in this flow first', {
          issues,
        });
      }
      if (row.publishedVersion && sameJsonValue(row.publishedVersion.definition, draft)) {
        return this.dto(tx, row, issues);
      }
      const last = await tx.flowVersion.findFirst({
        where: { flowId: id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = await tx.flowVersion.create({
        data: {
          id: randomUUID(),
          orgId: actor.orgId,
          flowId: id,
          version: (last?.version ?? 0) + 1,
          definition: draft as unknown as Prisma.InputJsonValue,
          publishedById: actor.userId,
        },
      });
      const updated = await tx.flow.update({
        where: { id },
        data: {
          publishedVersionId: version.id,
          triggerType: draft.trigger.type,
          trigger: draft.trigger as unknown as Prisma.InputJsonValue,
        },
        include: flowInclude,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.FLOW_CHANGED,
        actorUserId: actor.userId,
        targetType: 'flow',
        targetId: id,
        metadata: { change: 'published', version: version.version },
        meta: actor.meta,
      });
      return this.dto(tx, updated, issues);
    });
  }

  setActive(actor: FlowActor, id: string, active: boolean): Promise<FlowDto> {
    return this.db.run(async (tx) => {
      const row = await this.load(tx, id);
      if (active && !row.publishedVersionId) {
        throw new AppError(ErrorCode.FLOW_INVALID, 'Publish this flow before turning it on');
      }
      const updated = await tx.flow.update({
        where: { id },
        data: { active },
        include: flowInclude,
      });
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.FLOW_CHANGED,
        actorUserId: actor.userId,
        targetType: 'flow',
        targetId: id,
        metadata: { change: active ? 'activated' : 'deactivated' },
        meta: actor.meta,
      });
      return this.dto(tx, updated);
    });
  }

  /** Hidden, not deleted: runs and their history stay. Runs under way are cancelled. */
  remove(actor: FlowActor, id: string): Promise<void> {
    return this.db.run(async (tx) => {
      const row = await this.load(tx, id);
      await tx.flow.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
      await this.cancelRuns(tx, actor.orgId, { flowId: id }, 'flow_removed');
      await this.audit.record(tx, actor.orgId, {
        action: AuditAction.FLOW_CHANGED,
        actorUserId: actor.userId,
        targetType: 'flow',
        targetId: id,
        metadata: { change: 'removed', name: row.name },
        meta: actor.meta,
      });
    });
  }

  private async cancelRuns(
    tx: TenantTx,
    orgId: string,
    where: Prisma.FlowRunWhereInput,
    reason: string,
  ): Promise<number> {
    const runs = await tx.flowRun.findMany({
      where: { ...where, status: { in: ACTIVE_FLOW_RUN_STATUSES } },
      select: { id: true, currentNodeId: true },
    });
    for (const run of runs) {
      // Reviewed raw SQL: the engine holds this lock while it runs a step.
      await tx.$queryRaw`SELECT 1 FROM flow_runs WHERE id = ${run.id}::uuid FOR UPDATE`;
      await tx.flowRun.updateMany({
        where: { id: run.id, status: { in: ACTIVE_FLOW_RUN_STATUSES } },
        data: {
          status: 'cancelled',
          endReason: reason,
          endedAt: new Date(),
          wakeAt: null,
          awaiting: Prisma.DbNull,
          input: Prisma.DbNull,
        },
      });
      await tx.flowRunStep.create({
        data: {
          orgId,
          runId: run.id,
          nodeId: run.currentNodeId ?? '',
          nodeType: 'run',
          outcome: 'cancelled',
          detail: { reason },
        },
      });
    }
    return runs.length;
  }

  versions(id: string): Promise<FlowVersionDto[]> {
    return this.db.run(async (tx) => {
      await this.load(tx, id);
      const rows = await tx.flowVersion.findMany({
        where: { flowId: id },
        orderBy: { version: 'desc' },
        select: { id: true, version: true, publishedAt: true, publishedById: true },
      });
      const people = await tx.user.findMany({
        where: { id: { in: rows.flatMap((r) => (r.publishedById ? [r.publishedById] : [])) } },
        select: { id: true, name: true },
      });
      const names = new Map(people.map((p) => [p.id, p.name]));
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        publishedAt: r.publishedAt.toISOString(),
        publishedByName: r.publishedById ? (names.get(r.publishedById) ?? null) : null,
      }));
    });
  }

  // ------------------------------------------------------------------ runs

  runs(flowId: string, q: ListFlowRunsQuery): Promise<CursorPage<FlowRunDto>> {
    return this.db.run(async (tx) => {
      await this.load(tx, flowId);
      const rows = await tx.flowRun.findMany({
        where: {
          flowId,
          ...(q.status !== 'any' ? { status: q.status } : {}),
          ...(q.cursor ? { id: { lt: q.cursor } } : {}),
        },
        include: runInclude,
        orderBy: { id: 'desc' },
        take: q.limit + 1,
      });
      const more = rows.length > q.limit;
      const items = rows.slice(0, q.limit).map(runToDto);
      return { items, nextCursor: more ? (items.at(-1)?.id ?? null) : null };
    });
  }

  run(runId: string): Promise<FlowRunDto & { history: FlowRunStepDto[] }> {
    return this.db.run(async (tx) => {
      const row = await tx.flowRun.findUnique({ where: { id: runId }, include: runInclude });
      if (!row) throw new AppError(ErrorCode.NOT_FOUND, 'Run not found');
      const history = await tx.flowRunStep.findMany({
        where: { runId },
        orderBy: { id: 'asc' },
        take: 1000,
      });
      return { ...runToDto(row), history: history.map(stepToDto) };
    });
  }

  cancelRun(actor: FlowActor, runId: string): Promise<FlowRunDto> {
    return this.db.run(async (tx) => {
      const exists = await tx.flowRun.findUnique({ where: { id: runId }, select: { id: true } });
      if (!exists) throw new AppError(ErrorCode.NOT_FOUND, 'Run not found');
      await this.cancelRuns(tx, actor.orgId, { id: runId }, 'cancelled_by_user');
      return runToDto(
        await tx.flowRun.findUniqueOrThrow({ where: { id: runId }, include: runInclude }),
      );
    });
  }

  /** Start a flow for one contact, as if its trigger fired. The worker decides if it can. */
  async start(actor: FlowActor, flowId: string, contactId: string): Promise<void> {
    await this.db.run(async (tx) => {
      const row = await this.load(tx, flowId);
      if (!row.active || !row.publishedVersionId) {
        throw new AppError(ErrorCode.FLOW_INVALID, 'Turn this flow on first');
      }
      const contact = await tx.contact.findFirst({
        where: { id: contactId, deletedAt: null },
        select: { id: true },
      });
      if (!contact) throw new AppError(ErrorCode.NOT_FOUND, 'Contact not found');
    });
    await this.queues.enqueueFlowJob({
      kind: 'event',
      orgId: actor.orgId,
      event: { type: 'manual', flowId, contactId },
    });
  }

  // ------------------------------------------------------------------ files

  async uploadMedia(
    actor: FlowActor,
    file: { bytes: Buffer; mimeType: string; filename: string | null },
  ): Promise<{ mediaKey: string; mimeType: string; kind: string; filename: string | null }> {
    const rule = mediaRuleFor(file.mimeType);
    if (!rule)
      throw new AppError(ErrorCode.MEDIA_NOT_ALLOWED, 'WhatsApp does not accept this file type');
    const limit = Math.min(rule.maxBytes, MAX_FLOW_MEDIA_BYTES);
    if (file.bytes.length > limit) {
      throw new AppError(
        ErrorCode.MEDIA_NOT_ALLOWED,
        `This file is over the ${Math.round(limit / (1024 * 1024))} MB limit`,
      );
    }
    const mediaKey = `orgs/${actor.orgId}/flows/${randomUUID()}`;
    await this.storage.put(mediaKey, file.bytes, rule.mimeType);
    return {
      mediaKey,
      mimeType: rule.mimeType,
      kind: rule.kind,
      filename: file.filename?.slice(0, 200) ?? null,
    };
  }
}
