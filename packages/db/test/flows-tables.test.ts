import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import {
  appClient,
  createTenant,
  ownerClient,
  type TenantFixture,
  whatsappChannelId,
} from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let runId: string;
let flowId: string;
let conversationId: string;
let contactId: string;
let versionId: string;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  flowId = randomUUID();
  versionId = randomUUID();
  runId = randomUUID();
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: b.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: b.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        status: 'connected',
        credentialSource: 'manual',
      },
    });
    const contact = await tx.contact.create({ data: { orgId: b.orgId, waId: '919800011122' } });
    contactId = contact.id;
    const conversation = await tx.conversation.create({
      data: {
        orgId: b.orgId,
        phoneId: phone.id,
        channelId: await whatsappChannelId(tx, phone.id),
        contactId: contact.id,
      },
    });
    conversationId = conversation.id;
    await tx.flow.create({ data: { id: flowId, orgId: b.orgId, name: 'Theirs', draft: {} } });
    await tx.flowVersion.create({
      data: { id: versionId, orgId: b.orgId, flowId, version: 1, definition: {} },
    });
    await tx.flowRun.create({
      data: {
        id: runId,
        orgId: b.orgId,
        flowId,
        versionId,
        contactId: contact.id,
        conversationId,
        status: 'waiting',
        wakeAt: new Date(Date.now() - 1000),
      },
    });
    await tx.flowRunStep.create({
      data: { orgId: b.orgId, runId, nodeId: 'n', nodeType: 'delay', outcome: 'delayed' },
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
  it('another org sees none of it', async () => {
    const seen = await asA(async (tx) => [
      await tx.flow.count(),
      await tx.flowVersion.count(),
      await tx.flowRun.count(),
      await tx.flowRunStep.count(),
    ]);
    expect(seen).toEqual([0, 0, 0, 0]);
  });

  it('another org cannot change it or write into it', async () => {
    const results = await asA(async (tx) => [
      await tx.flow.updateMany({ data: { name: 'pwned' } }),
      await tx.flowRun.updateMany({ data: { status: 'cancelled' } }),
    ]);
    expect(results.map((r) => r.count)).toEqual([0, 0]);
    await expect(
      asA((tx) => tx.flow.create({ data: { orgId: b.orgId, name: 'planted', draft: {} } })),
    ).rejects.toThrow();
    await expect(
      asA((tx) =>
        tx.flowRunStep.create({
          data: { orgId: b.orgId, runId, nodeId: 'x', nodeType: 'x', outcome: 'planted' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('history cannot be rewritten', () => {
  it('published versions and run steps are append-only', async () => {
    await expect(
      asB((tx) => tx.flowVersion.updateMany({ data: { definition: { changed: true } } })),
    ).rejects.toThrow();
    await expect(asB((tx) => tx.flowVersion.deleteMany())).rejects.toThrow();
    await expect(
      asB((tx) => tx.flowRunStep.updateMany({ data: { outcome: 'rewritten' } })),
    ).rejects.toThrow();
    await expect(asB((tx) => tx.flowRunStep.deleteMany())).rejects.toThrow();
  });

  it('flows and runs are not deleted by the app', async () => {
    await expect(asB((tx) => tx.flowRun.deleteMany())).rejects.toThrow();
    await expect(asB((tx) => tx.flow.deleteMany())).rejects.toThrow();
  });
});

describe('runs', () => {
  it('one run under way per conversation', async () => {
    await expect(
      asB((tx) =>
        tx.flowRun.create({
          data: { orgId: b.orgId, flowId, versionId, contactId, conversationId, status: 'running' },
        }),
      ),
    ).rejects.toThrow();
    // A finished run is no obstacle.
    await asB((tx) =>
      tx.flowRun.create({
        data: { orgId: b.orgId, flowId, versionId, contactId, conversationId, status: 'completed' },
      }),
    );
  });

  it('refuses an unknown status', async () => {
    await expect(
      asB((tx) =>
        tx.flowRun.create({
          data: { orgId: b.orgId, flowId, versionId, contactId, status: 'paused' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the scheduler function answers ids only, and finds due runs', async () => {
    const rows = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM flow_due_runs(${new Date(Date.now() - 60_000)}, 1000)`;
    for (const row of rows) expect(Object.keys(row).sort()).toEqual(['id', 'org_id', 'status']);
    expect(rows.some((r) => r.id === runId)).toBe(true);
  });
});
