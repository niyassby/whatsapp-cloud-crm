import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let connectionId: string;
let eventId: string;
const webhookToken = randomBytes(24).toString('base64url');

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  connectionId = randomUUID();
  eventId = randomUUID();
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    await tx.integrationConnection.create({
      data: {
        id: connectionId,
        orgId: b.orgId,
        connectorKey: 'demo_store',
        name: 'Theirs',
        credentialsEnc: 'v1.ciphertext',
        webhookToken,
        tokenExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    await tx.integrationEvent.create({
      data: {
        id: eventId,
        orgId: b.orgId,
        connectionId,
        direction: 'inbound',
        dedupeKey: 'd1',
        status: 'received',
        payload: {},
      },
    });
    await tx.integrationEventClaim.create({
      data: { orgId: b.orgId, connectionId, externalId: 'order:1', eventId },
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

describe('tenant isolation', () => {
  it('another org sees none of it, and cannot change or add to it', async () => {
    expect(
      await asA(async (tx) => [
        await tx.integrationConnection.count(),
        await tx.integrationEvent.count(),
        await tx.integrationEventClaim.count(),
      ]),
    ).toEqual([0, 0, 0]);
    const changed = await asA((tx) =>
      tx.integrationConnection.updateMany({ data: { name: 'pwned' } }),
    );
    expect(changed.count).toBe(0);
    await expect(
      asA((tx) =>
        tx.integrationEvent.create({
          data: {
            orgId: b.orgId,
            connectionId,
            direction: 'inbound',
            dedupeKey: 'planted',
            status: 'received',
            payload: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('history', () => {
  it('connections and events are not deleted by the app, and claims never change', async () => {
    await expect(asB((tx) => tx.integrationConnection.deleteMany())).rejects.toThrow();
    await expect(asB((tx) => tx.integrationEvent.deleteMany())).rejects.toThrow();
    await expect(asB((tx) => tx.integrationEventClaim.deleteMany())).rejects.toThrow();
    await expect(
      asB((tx) => tx.integrationEventClaim.updateMany({ data: { externalId: 'other' } })),
    ).rejects.toThrow();
  });

  it('one row per delivery, and one claim per outside event', async () => {
    await expect(
      asB((tx) =>
        tx.integrationEvent.create({
          data: {
            orgId: b.orgId,
            connectionId,
            direction: 'inbound',
            dedupeKey: 'd1',
            status: 'received',
            payload: {},
          },
        }),
      ),
    ).rejects.toThrow();
    const again = await asB((tx) =>
      tx.integrationEventClaim.createMany({
        data: { orgId: b.orgId, connectionId, externalId: 'order:1', eventId },
        skipDuplicates: true,
      }),
    );
    expect(again.count).toBe(0);
  });

  it('refuses an unknown status', async () => {
    await expect(
      asB((tx) =>
        tx.integrationConnection.update({
          where: { id: connectionId },
          data: { status: 'paused' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('pre-tenant functions', () => {
  it('finds a connection by its webhook token, and nothing by a short or wrong one', async () => {
    const found = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM integration_connection_by_token(${webhookToken})`;
    expect(found).toEqual([
      { org_id: b.orgId, id: connectionId, connector_key: 'demo_store', status: 'connected' },
    ]);
    const wrong = await app.$queryRaw<unknown[]>`
      SELECT * FROM integration_connection_by_token(${'x'.repeat(32)})`;
    expect(wrong).toEqual([]);
    const short = await app.$queryRaw<unknown[]>`
      SELECT * FROM integration_connection_by_token(${''})`;
    expect(short).toEqual([]);
  });

  it('lists due work with ids and kinds only', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM integration_due_work(1000)`;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'kind', 'org_id']);
    const mine = rows.filter((r) => r.id === connectionId).map((r) => r.kind);
    expect(mine).toEqual(expect.arrayContaining(['refresh', 'health']));
  });
});
