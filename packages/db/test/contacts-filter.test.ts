import { randomUUID } from 'node:crypto';
import { type SegmentFilter, segmentFilterSchema } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { contactListWhere } from '../src/contacts';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

const DAY = 86_400_000;
const NOW = Date.now();

let owner: DbClient;
let app: DbClient;
let t: TenantFixture;
let vip: string;
let lead: string;
const ids: Record<string, string> = {};

const names = async (filter: Partial<SegmentFilter>) => {
  const where = contactListWhere({ segment: segmentFilterSchema.parse(filter) });
  const rows = await withTenant(app, { orgId: t.orgId, userId: t.userId }, (tx) =>
    tx.contact.findMany({ where, select: { name: true } }),
  );
  return rows.map((r) => r.name).sort();
};

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  t = await createTenant(owner);
  vip = randomUUID();
  lead = randomUUID();
  await withTenant(app, { orgId: t.orgId, userId: t.userId }, async (tx) => {
    await tx.tag.createMany({
      data: [
        { id: vip, orgId: t.orgId, name: 'vip' },
        { id: lead, orgId: t.orgId, name: 'lead' },
      ],
    });
    const people = [
      {
        name: 'ana',
        optInStatus: 'opted_in' as const,
        lastActivityAt: new Date(NOW - 2 * DAY),
        customFields: { plan: 'gold', score: 90, joined: '2026-01-15', active: true },
        tags: [vip, lead],
      },
      {
        name: 'ben',
        optInStatus: 'opted_out' as const,
        lastActivityAt: new Date(NOW - 40 * DAY),
        customFields: { plan: 'silver', score: 40, joined: '2025-06-01', active: false },
        tags: [lead],
      },
      {
        name: 'cam',
        optInStatus: 'unknown' as const,
        lastActivityAt: null,
        customFields: {},
        tags: [],
      },
      {
        name: 'dee',
        optInStatus: 'opted_in' as const,
        lastActivityAt: new Date(NOW - 10 * DAY),
        customFields: { plan: 'Gold Plus', score: 70 },
        tags: [vip],
      },
    ];
    for (const [i, p] of people.entries()) {
      const id = randomUUID();
      ids[p.name] = id;
      await tx.contact.create({
        data: {
          id,
          orgId: t.orgId,
          waId: `91980000000${i}`,
          name: p.name,
          optInStatus: p.optInStatus,
          lastActivityAt: p.lastActivityAt,
          customFields: p.customFields,
        },
      });
      for (const tagId of p.tags) {
        await tx.contactTag.create({ data: { orgId: t.orgId, contactId: id, tagId } });
      }
    }
    // Neither of these may ever be counted.
    await tx.contact.create({
      data: {
        orgId: t.orgId,
        waId: '919800000091',
        name: 'deleted',
        optInStatus: 'opted_in',
        deletedAt: new Date(),
      },
    });
    await tx.contact.create({
      data: {
        orgId: t.orgId,
        waId: '919800000092',
        name: 'merged',
        optInStatus: 'opted_in',
        mergedIntoId: ids.ana,
      },
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('segment filters', () => {
  it('an empty filter matches every live contact, not deleted or merged ones', async () => {
    expect(await names({})).toEqual(['ana', 'ben', 'cam', 'dee']);
  });

  it('tags', async () => {
    expect(await names({ rules: [{ field: 'tag', op: 'has', tagId: vip }] })).toEqual([
      'ana',
      'dee',
    ]);
    expect(await names({ rules: [{ field: 'tag', op: 'not_has', tagId: vip }] })).toEqual([
      'ben',
      'cam',
    ]);
  });

  it('opt-in status', async () => {
    expect(await names({ rules: [{ field: 'opt_in', op: 'is', value: 'opted_in' }] })).toEqual([
      'ana',
      'dee',
    ]);
    expect(await names({ rules: [{ field: 'opt_in', op: 'is_not', value: 'opted_in' }] })).toEqual([
      'ben',
      'cam',
    ]);
  });

  it('last activity', async () => {
    expect(
      await names({ rules: [{ field: 'last_activity', op: 'within_days', days: 30 }] }),
    ).toEqual(['ana', 'dee']);
    expect(
      await names({ rules: [{ field: 'last_activity', op: 'older_than_days', days: 30 }] }),
    ).toEqual(['ben']);
    expect(await names({ rules: [{ field: 'last_activity', op: 'never' }] })).toEqual(['cam']);
  });

  it('custom fields: equality', async () => {
    expect(
      await names({ rules: [{ field: 'custom', key: 'plan', op: 'eq', value: 'gold' }] }),
    ).toEqual(['ana']);
    expect(
      await names({ rules: [{ field: 'custom', key: 'active', op: 'eq', value: true }] }),
    ).toEqual(['ana']);
  });

  it('custom fields: not equal includes contacts with no value', async () => {
    expect(
      await names({ rules: [{ field: 'custom', key: 'plan', op: 'neq', value: 'gold' }] }),
    ).toEqual(['ben', 'cam', 'dee']);
  });

  it('custom fields: contains ignores case', async () => {
    expect(
      await names({ rules: [{ field: 'custom', key: 'plan', op: 'contains', value: 'GOLD' }] }),
    ).toEqual(['ana', 'dee']);
  });

  it('custom fields: compares numbers and dates', async () => {
    expect(
      await names({ rules: [{ field: 'custom', key: 'score', op: 'gt', value: 50 }] }),
    ).toEqual(['ana', 'dee']);
    expect(
      await names({ rules: [{ field: 'custom', key: 'score', op: 'lt', value: 50 }] }),
    ).toEqual(['ben']);
    expect(
      await names({ rules: [{ field: 'custom', key: 'joined', op: 'gt', value: '2026-01-01' }] }),
    ).toEqual(['ana']);
  });

  it('custom fields: set and not set', async () => {
    expect(await names({ rules: [{ field: 'custom', key: 'joined', op: 'is_set' }] })).toEqual([
      'ana',
      'ben',
    ]);
    expect(await names({ rules: [{ field: 'custom', key: 'joined', op: 'not_set' }] })).toEqual([
      'cam',
      'dee',
    ]);
  });

  it('match all and match any', async () => {
    const rules = [
      { field: 'tag', op: 'has', tagId: lead },
      { field: 'opt_in', op: 'is', value: 'opted_in' },
    ] as const;
    expect(await names({ match: 'all', rules: [...rules] })).toEqual(['ana']);
    expect(await names({ match: 'any', rules: [...rules] })).toEqual(['ana', 'ben', 'dee']);
  });
});
