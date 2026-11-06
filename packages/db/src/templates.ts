import {
  fromMetaComponents,
  type ParameterFormat,
  sameJsonValue,
  templateDefinitionSchema,
  type TemplateDto,
  type VariableSource,
} from '@wacrm/shared';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

type TemplateRow = Prisma.MessageTemplateGetPayload<object>;

/** Storage keys stay on the server. */
export function templateToDto(t: TemplateRow): TemplateDto {
  const definition = templateDefinitionSchema.safeParse(t.definition);
  return {
    id: t.id,
    wabaAccountId: t.wabaAccountId,
    metaTemplateId: t.metaTemplateId,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    parameterFormat: t.parameterFormat as ParameterFormat,
    definition: definition.success ? definition.data : null,
    samples: t.samples as Record<string, string>,
    variableMapping: t.variableMapping as Record<string, VariableSource>,
    supported: t.supported,
    rejectedReason: t.rejectedReason,
    statusDetail: t.statusDetail,
    qualityScore: t.qualityScore,
    headerMedia: t.headerMediaKey
      ? { mimeType: t.headerMediaMime ?? 'application/octet-stream', filename: t.headerMediaName }
      : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}

export interface MetaTemplateSnapshot {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  components: unknown;
  rejectedReason?: string;
  qualityScore?: string;
  parameterFormat?: string;
}

const statusFromMeta = (status: string) => status.toLowerCase();

/** A template submitted this recently may not be in Meta's list yet. */
const LIST_GRACE_MS = 5 * 60_000;

/**
 * Make the local copy match Meta's full list. Meta is the authority on content and status.
 * What only exists here is kept: the variable mapping and the header file.
 * A template gone from Meta is marked deleted rather than removed, so people can see what happened.
 */
export async function applyTemplateSync(
  tx: TenantTx,
  input: {
    orgId: string;
    wabaAccountId: string;
    templates: MetaTemplateSnapshot[];
    now?: Date;
  },
): Promise<{ changed: number }> {
  const { orgId, wabaAccountId, templates } = input;
  const now = input.now ?? new Date();
  const existing = await tx.messageTemplate.findMany({ where: { wabaAccountId } });
  const byKey = new Map(existing.map((t) => [`${t.name}|${t.language}`, t]));
  let changed = 0;

  for (const meta of templates) {
    const parsed = fromMetaComponents(meta.components, meta.category);
    const status = statusFromMeta(meta.status);
    const parameterFormat =
      meta.parameterFormat?.toLowerCase() === 'named' ? 'named' : 'positional';
    const rejectedReason =
      meta.rejectedReason && meta.rejectedReason !== 'NONE' ? meta.rejectedReason : null;
    const data = {
      metaTemplateId: meta.id,
      category: meta.category,
      status,
      parameterFormat,
      definition: (parsed.definition ?? undefined) as Prisma.InputJsonValue | undefined,
      samples: parsed.samples,
      supported: parsed.supported,
      rejectedReason,
      qualityScore: meta.qualityScore ?? null,
    };
    const local = byKey.get(`${meta.name}|${meta.language}`);
    if (!local) {
      await tx.messageTemplate.create({
        data: { orgId, wabaAccountId, name: meta.name, language: meta.language, ...data },
      });
      changed++;
      continue;
    }
    const same =
      local.metaTemplateId === meta.id &&
      local.status === status &&
      local.category === meta.category &&
      local.rejectedReason === rejectedReason &&
      local.qualityScore === (meta.qualityScore ?? null) &&
      sameJsonValue(local.definition, parsed.definition);
    if (same) continue;
    await tx.messageTemplate.update({
      where: { id: local.id },
      data: {
        ...data,
        // Meta's copy of a sample can be shorter than ours, and ours is what people typed.
        samples: { ...(local.samples as Record<string, string>), ...parsed.samples },
        statusAt: now,
        ...(status === 'rejected' ? {} : { statusDetail: null }),
      },
    });
    changed++;
  }

  const live = new Set(templates.map((t) => t.id));
  const missing = existing.filter(
    (t) =>
      t.metaTemplateId &&
      !live.has(t.metaTemplateId) &&
      t.status !== 'deleted' &&
      now.getTime() - (t.submittedAt?.getTime() ?? 0) > LIST_GRACE_MS,
  );
  for (const t of missing) {
    await tx.messageTemplate.update({
      where: { id: t.id },
      data: { status: 'deleted', statusAt: now, statusDetail: 'No longer on Meta' },
    });
    changed++;
  }

  await tx.wabaAccount.update({
    where: { id: wabaAccountId },
    data: { templatesSyncedAt: now },
  });
  return { changed };
}

/** Webhook events that name a status directly. */
const STATUS_EVENTS: Record<string, string> = {
  APPROVED: 'approved',
  REINSTATED: 'approved',
  REJECTED: 'rejected',
  PENDING: 'pending',
  PAUSED: 'paused',
  DISABLED: 'disabled',
  IN_APPEAL: 'in_appeal',
  PENDING_DELETION: 'pending_deletion',
  DELETED: 'deleted',
  ARCHIVED: 'archived',
  LIMIT_EXCEEDED: 'limit_exceeded',
  LOCKED: 'locked',
};

export const TEMPLATE_WEBHOOK_FIELDS = new Set([
  'message_template_status_update',
  'template_category_update',
  'message_template_quality_update',
  'message_template_components_update',
]);

export type TemplateEventOutcome =
  /** Applied to this local template. */
  | { kind: 'applied'; templateId: string }
  /** Nothing to do, such as an older event arriving late. */
  | { kind: 'ignored' }
  /** Worth a full comparison: an unknown template, or an event that carries no new state. */
  | { kind: 'needs_sync'; wabaAccountId: string };

function detailFrom(value: Record<string, unknown>): string | null {
  const rejection = value.rejection_info as { recommendation?: string } | undefined;
  if (rejection?.recommendation) return rejection.recommendation;
  const other = value.other_info as { description?: string } | undefined;
  if (other?.description) return other.description;
  const disable = value.disable_info as { disable_date?: string | number } | undefined;
  if (disable?.disable_date) return `Disabled by Meta (${String(disable.disable_date)})`;
  return null;
}

/**
 * Apply one template webhook. `at` is when Meta sent it: an event older than the current status,
 * such as a replay or a late delivery, cannot move a template backwards.
 */
export async function applyTemplateEvent(
  tx: TenantTx,
  input: { wabaId: string; field: string; value: Record<string, unknown>; at: Date },
): Promise<TemplateEventOutcome> {
  const { field, value, at } = input;
  const waba = await tx.wabaAccount.findFirst({
    where: { wabaId: input.wabaId, status: 'active' },
    select: { id: true },
  });
  if (!waba) return { kind: 'ignored' };

  const metaId = value.message_template_id;
  if (metaId === undefined || metaId === null) return { kind: 'ignored' };
  const template = await tx.messageTemplate.findFirst({
    where: { wabaAccountId: waba.id, metaTemplateId: String(metaId) },
  });
  if (!template) return { kind: 'needs_sync', wabaAccountId: waba.id };

  if (field === 'message_template_status_update') {
    const event = typeof value.event === 'string' ? value.event : '';
    const status = STATUS_EVENTS[event];
    // UNARCHIVED names no status, and FLAGGED warns without changing one.
    if (event === 'UNARCHIVED') return { kind: 'needs_sync', wabaAccountId: waba.id };
    if (event === 'FLAGGED') {
      await tx.messageTemplate.update({
        where: { id: template.id },
        data: { statusDetail: detailFrom(value) ?? 'Flagged by Meta for low quality' },
      });
      return { kind: 'applied', templateId: template.id };
    }
    if (!status || at < template.statusAt) return { kind: 'ignored' };
    const reason = typeof value.reason === 'string' ? value.reason : null;
    await tx.messageTemplate.update({
      where: { id: template.id },
      data: {
        status,
        statusAt: at,
        rejectedReason: status === 'rejected' ? reason : null,
        statusDetail: detailFrom(value),
        ...(typeof value.message_template_category === 'string'
          ? { category: value.message_template_category }
          : {}),
      },
    });
    return { kind: 'applied', templateId: template.id };
  }

  if (field === 'template_category_update') {
    // Only a completed change has previous_category. A pending one has a date for it instead.
    const next = value.new_category;
    if (typeof value.previous_category === 'string' && typeof next === 'string') {
      await tx.messageTemplate.update({
        where: { id: template.id },
        data: { category: next, statusDetail: `Meta changed the category to ${next}` },
      });
      return { kind: 'applied', templateId: template.id };
    }
    if (typeof value.correct_category === 'string') {
      await tx.messageTemplate.update({
        where: { id: template.id },
        data: {
          statusDetail: `Meta will change the category to ${value.correct_category}`,
        },
      });
      return { kind: 'applied', templateId: template.id };
    }
    return { kind: 'ignored' };
  }

  if (field === 'message_template_quality_update') {
    if (typeof value.new_quality_score !== 'string') return { kind: 'ignored' };
    await tx.messageTemplate.update({
      where: { id: template.id },
      data: { qualityScore: value.new_quality_score },
    });
    return { kind: 'applied', templateId: template.id };
  }

  // message_template_components_update: the payload is partial, so read the template again.
  return { kind: 'needs_sync', wabaAccountId: waba.id };
}
