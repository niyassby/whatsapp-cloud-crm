import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { emitWebhookEvent } from '../src/webhooks';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let endpointB: string;
let keyPrefixB: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

const endpoint = (orgId: string, events: string[]) => ({
  orgId,
  url: 'https://example.com/hook',
  events,
  secretEnc: 'v1.fake',
});

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  keyPrefixB = randomUUID().replaceAll('-', '').slice(0, 16);
  await asB(async (tx) => {
    endpointB = (await tx.webhookEndpoint.create({ data: endpoint(b.orgId, ['message.received']) }))
      .id;
    await tx.apiKey.create({
      data: {
        orgId: b.orgId,
        name: 'Theirs',
        prefix: keyPrefixB,
        keyHash: `hash-${keyPrefixB}`,
        scopes: ['contacts:read'],
        createdById: b.userId,
      },
    });
    await emitWebhookEvent(tx, b.orgId, 'message.received', { secret: 'their data' });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('tenant isolation', () => {
  it('another org sees none of it', async () => {
    const seen = await asA(async (tx) => ({
      endpoints: await tx.webhookEndpoint.count(),
      deliveries: await tx.webhookDelivery.count(),
      keys: await tx.apiKey.count({ where: { prefix: keyPrefixB } }),
      byId: await tx.webhookEndpoint.findUnique({ where: { id: endpointB } }),
    }));
    expect(seen).toEqual({ endpoints: 0, deliveries: 0, keys: 0, byId: null });
  });

  it('another org cannot change or delete it', async () => {
    const results = await asA(async (tx) => [
      await tx.webhookEndpoint.updateMany({
        where: { id: endpointB },
        data: { url: 'https://evil.example' },
      }),
      await tx.webhookEndpoint.deleteMany({ where: { id: endpointB } }),
      await tx.webhookDelivery.updateMany({
        where: { endpointId: endpointB },
        data: { status: 'failed' },
      }),
      await tx.apiKey.updateMany({
        where: { prefix: keyPrefixB },
        data: { revokedAt: new Date() },
      }),
    ]);
    expect(results.map((r) => r.count)).toEqual([0, 0, 0, 0]);
  });

  it('another org cannot write into it', async () => {
    await expect(
      asA((tx) => tx.webhookEndpoint.create({ data: endpoint(b.orgId, ['message.received']) })),
    ).rejects.toThrow();
  });

  it('with no context, nothing is visible', async () => {
    expect(await app.webhookEndpoint.count()).toBe(0);
    expect(await app.webhookDelivery.count()).toBe(0);
  });
});

describe('what the app role may not do', () => {
  it('cannot delete from the delivery log, even its own', async () => {
    await expect(asB((tx) => tx.webhookDelivery.deleteMany())).rejects.toThrow();
  });
});

describe('definer functions', () => {
  it('finds a key by its prefix, and nothing for an unknown one', async () => {
    const found = await app.$queryRaw<{ org_id: string; key_hash: string }[]>`
      SELECT org_id, key_hash FROM api_key_lookup(${keyPrefixB})`;
    expect(found).toEqual([{ org_id: b.orgId, key_hash: `hash-${keyPrefixB}` }]);
    const none = await app.$queryRaw`SELECT * FROM api_key_lookup('0000000000000000')`;
    expect(none).toEqual([]);
  });

  it('due deliveries are ids only: no payload, URL or secret', async () => {
    const due = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM webhook_due_deliveries(100)`;
    const mine = due.find((d) => d.org_id === b.orgId);
    expect(Object.keys(mine ?? {}).sort()).toEqual(['id', 'next_attempt_at', 'org_id']);
  });

  it('the key rotation list gives ids only', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM secrets_list_webhook_endpoints()`;
    const mine = rows.find((r) => r.org_id === b.orgId);
    expect(Object.keys(mine ?? {}).sort()).toEqual(['id', 'org_id']);
  });

  it('retention skips pending and recent deliveries, and removes the old', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    const endpointId = await withTenant(app, scope, async (tx) => {
      const e = await tx.webhookEndpoint.create({ data: endpoint(t.orgId, ['contact.created']) });
      return e.id;
    });
    const make = (status: 'pending' | 'delivered', ageDays: number) =>
      owner.webhookDelivery.create({
        data: {
          orgId: t.orgId,
          endpointId,
          eventId: randomUUID(),
          eventType: 'contact.created',
          payload: {},
          status,
          createdAt: new Date(Date.now() - ageDays * 86_400_000),
        },
      });
    const old = await make('delivered', 40);
    const stuck = await make('pending', 40);
    const recent = await make('delivered', 0);
    const before = new Date(Date.now() - 30 * 86_400_000);
    await app.$queryRaw`SELECT webhook_deliveries_purge(${before})`;
    const left = await owner.webhookDelivery.findMany({ where: { endpointId } });
    expect(left.map((d) => d.id).sort()).toEqual([stuck.id, recent.id].sort());
    expect(left.map((d) => d.id)).not.toContain(old.id);
  });
});

describe('emitting events', () => {
  it('reaches only active endpoints subscribed to that event', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    const count = await withTenant(app, scope, async (tx) => {
      await tx.webhookEndpoint.create({ data: endpoint(t.orgId, ['contact.created']) });
      await tx.webhookEndpoint.create({ data: endpoint(t.orgId, ['message.status']) });
      await tx.webhookEndpoint.create({
        data: { ...endpoint(t.orgId, ['contact.created']), active: false },
      });
      return emitWebhookEvent(tx, t.orgId, 'contact.created', { id: 'x' });
    });
    expect(count).toBe(1);
  });

  it('rolls back with the change it reports', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    await withTenant(app, scope, (tx) =>
      tx.webhookEndpoint.create({ data: endpoint(t.orgId, ['contact.created']) }),
    );
    await expect(
      withTenant(app, scope, async (tx) => {
        await emitWebhookEvent(tx, t.orgId, 'contact.created', { id: 'x' });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await withTenant(app, scope, (tx) => tx.webhookDelivery.count())).toBe(0);
  });

  it('with no endpoints, writes nothing', async () => {
    const t = await createTenant(owner);
    const scope = { orgId: t.orgId, userId: t.userId };
    const count = await withTenant(app, scope, (tx) =>
      emitWebhookEvent(tx, t.orgId, 'contact.created', { id: 'x' }),
    );
    expect(count).toBe(0);
  });
});
