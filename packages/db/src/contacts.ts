import type {
  ContactDto,
  ContactJobDto,
  FieldValue,
  OptInStatus,
  SegmentFilter,
  SegmentRule,
} from '@wacrm/shared';
import { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';

const DAY_MS = 86_400_000;

/** Contacts that exist as far as users can tell: not deleted, not merged into another. */
export const liveContactWhere = {
  deletedAt: null,
  mergedIntoId: null,
} as const satisfies Prisma.ContactWhereInput;

function ruleToWhere(rule: SegmentRule, now: Date): Prisma.ContactWhereInput {
  switch (rule.field) {
    case 'tag': {
      const has = { tags: { some: { tagId: rule.tagId } } };
      return rule.op === 'has' ? has : { NOT: has };
    }
    case 'opt_in':
      return { optInStatus: rule.op === 'is' ? rule.value : { not: rule.value } };
    case 'last_activity': {
      if (rule.op === 'never') return { lastActivityAt: null };
      const cutoff = new Date(now.getTime() - rule.days * DAY_MS);
      return rule.op === 'within_days'
        ? { lastActivityAt: { gte: cutoff } }
        : { lastActivityAt: { lt: cutoff } };
    }
    case 'custom': {
      const path = [rule.key];
      const missing: Prisma.ContactWhereInput = {
        customFields: { path, equals: Prisma.AnyNull },
      };
      switch (rule.op) {
        case 'eq':
          return { customFields: { path, equals: rule.value } };
        case 'neq':
          // A contact with no value also "is not" that value.
          return { OR: [missing, { NOT: { customFields: { path, equals: rule.value } } }] };
        case 'contains':
          return { customFields: { path, string_contains: rule.value, mode: 'insensitive' } };
        case 'gt':
          return { customFields: { path, gt: rule.value } };
        case 'lt':
          return { customFields: { path, lt: rule.value } };
        case 'is_set':
          return { NOT: missing };
        case 'not_set':
          return missing;
      }
    }
  }
}

/** An empty filter matches every contact. `now` is a parameter so tests can pin it. */
export function segmentFilterToWhere(
  filter: SegmentFilter,
  now = new Date(),
): Prisma.ContactWhereInput {
  if (filter.rules.length === 0) return {};
  const rules = filter.rules.map((r) => ruleToWhere(r, now));
  return filter.match === 'any' ? { OR: rules } : { AND: rules };
}

export interface ContactListFilter {
  q?: string;
  tagId?: string;
  optIn?: OptInStatus;
  segment?: SegmentFilter;
}

/** Shared by the contacts table, counts, and background exports. */
export function contactListWhere(f: ContactListFilter): Prisma.ContactWhereInput {
  const and: Prisma.ContactWhereInput[] = [liveContactWhere];
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    and.push({
      OR: [
        { name: { contains: f.q, mode: 'insensitive' } },
        { email: { contains: f.q, mode: 'insensitive' } },
        ...(digits ? [{ waId: { contains: digits } }] : []),
      ],
    });
  }
  if (f.tagId) and.push({ tags: { some: { tagId: f.tagId } } });
  if (f.optIn) and.push({ optInStatus: f.optIn });
  if (f.segment) and.push(segmentFilterToWhere(f.segment));
  return { AND: and };
}

export const contactInclude = {
  tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
} as const;

export type ContactWithRelations = Prisma.ContactGetPayload<{ include: typeof contactInclude }>;

export function contactToDto(c: ContactWithRelations): ContactDto {
  return {
    id: c.id,
    waId: c.waId,
    name: c.name,
    email: c.email,
    customFields: (c.customFields ?? {}) as Record<string, FieldValue>,
    tags: c.tags.map((t) => t.tag),
    optInStatus: c.optInStatus,
    optInSource: c.optInSource,
    optInProof: c.optInProof,
    optInAt: c.optInAt?.toISOString() ?? null,
    optOutAt: c.optOutAt?.toISOString() ?? null,
    lastActivityAt: c.lastActivityAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

/** Storage keys and import options stay on the server. */
export function contactJobToDto(j: Prisma.ContactJobGetPayload<object>): ContactJobDto {
  return {
    id: j.id,
    kind: j.kind,
    status: j.status,
    filename: j.filename,
    processedRows: j.processedRows,
    createdCount: j.createdCount,
    updatedCount: j.updatedCount,
    errorCount: j.errorCount,
    hasFile: j.resultKey !== null,
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
  };
}

export interface ConsentChange {
  orgId: string;
  contactId: string;
  status: 'opted_in' | 'opted_out';
  source?: string | null;
  proof?: string | null;
  actorUserId?: string | null;
}

/**
 * Change a contact's consent and record the proof, together. Returns false when the contact
 * already has this status, so repeats leave no extra history.
 */
export async function setContactConsent(tx: TenantTx, change: ConsentChange): Promise<boolean> {
  const { orgId, contactId, status, source = null, proof = null } = change;
  const current = await tx.contact.findUniqueOrThrow({
    where: { id: contactId },
    select: { optInStatus: true },
  });
  if (current.optInStatus === status) return false;
  const now = new Date();
  await tx.contact.update({
    where: { id: contactId },
    data:
      status === 'opted_in'
        ? {
            optInStatus: status,
            optInSource: source,
            optInProof: proof,
            optInAt: now,
            optOutAt: null,
          }
        : { optInStatus: status, optOutAt: now },
  });
  await tx.contactConsentEvent.create({
    data: { orgId, contactId, status, source, proof, actorUserId: change.actorUserId ?? null },
  });
  return true;
}
