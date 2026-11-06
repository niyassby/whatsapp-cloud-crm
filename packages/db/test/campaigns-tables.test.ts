import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let campaignB: string;
let recipientB: string;
let sequenceB: string;
let enrollmentB: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  await asB(async (tx) => {
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
    const template = await tx.messageTemplate.create({
      data: {
        orgId: b.orgId,
        wabaAccountId: waba.id,
        name: 'secret',
        language: 'en',
        category: 'UTILITY',
      },
    });
    const contact = await tx.contact.create({ data: { orgId: b.orgId, waId: '919800000001' } });
    const campaign = await tx.campaign.create({
      data: {
        orgId: b.orgId,
        name: 'Theirs',
        phoneId: phone.id,
        templateId: template.id,
        audience: { type: 'segment' },
        // Due now, so the scheduler below has something to find.
        status: 'scheduled',
        scheduledAt: new Date(Date.now() - 1000),
      },
    });
    campaignB = campaign.id;
    recipientB = (
      await tx.campaignRecipient.create({
        data: { orgId: b.orgId, campaignId: campaign.id, contactId: contact.id, phoneId: phone.id },
      })
    ).id;
    const sequence = await tx.dripSequence.create({
      data: {
        orgId: b.orgId,
        name: 'Theirs',
        status: 'active',
        phoneId: phone.id,
        steps: {
          create: { orgId: b.orgId, position: 0, delayMinutes: 0, templateId: template.id },
        },
      },
    });
    sequenceB = sequence.id;
    enrollmentB = (
      await tx.dripEnrollment.create({
        data: {
          orgId: b.orgId,
          sequenceId: sequence.id,
          contactId: contact.id,
          nextRunAt: new Date(Date.now() - 1000),
        },
      })
    ).id;
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('campaign tables: tenant isolation', () => {
  it('another org sees none of it', async () => {
    const seen = await asA(async (tx) => ({
      campaign: await tx.campaign.count(),
      byId: await tx.campaign.findUnique({ where: { id: campaignB } }),
      recipients: await tx.campaignRecipient.count(),
      sequences: await tx.dripSequence.count(),
      steps: await tx.dripStep.count(),
      enrollments: await tx.dripEnrollment.count(),
    }));
    expect(seen).toEqual({
      campaign: 0,
      byId: null,
      recipients: 0,
      sequences: 0,
      steps: 0,
      enrollments: 0,
    });
  });

  it('another org cannot change or delete it', async () => {
    const results = await asA(async (tx) => [
      await tx.campaign.updateMany({ where: { id: campaignB }, data: { name: 'x' } }),
      await tx.campaign.deleteMany({ where: { id: campaignB } }),
      await tx.campaignRecipient.updateMany({
        where: { id: recipientB },
        data: { status: 'failed' },
      }),
      await tx.dripSequence.updateMany({ where: { id: sequenceB }, data: { name: 'x' } }),
      await tx.dripEnrollment.updateMany({ where: { id: enrollmentB }, data: { nextStep: 9 } }),
    ]);
    expect(results.map((r) => r.count)).toEqual([0, 0, 0, 0, 0]);
  });

  it('another org cannot write rows into it', async () => {
    await expect(
      asA((tx) =>
        tx.campaign.create({
          data: {
            orgId: b.orgId,
            name: 'Planted',
            phoneId: randomUUID(),
            templateId: randomUUID(),
            audience: {},
          },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('what the app role may not do', () => {
  it('cannot delete a recipient or an enrollment, even its own', async () => {
    await expect(
      asB((tx) => tx.campaignRecipient.delete({ where: { id: recipientB } })),
    ).rejects.toThrow();
    await expect(
      asB((tx) => tx.dripEnrollment.delete({ where: { id: enrollmentB } })),
    ).rejects.toThrow();
  });

  it('can read tier limits but not change them', async () => {
    const tiers = await asA((tx) => tx.messagingTierLimit.findMany());
    expect(tiers.map((t) => t.tier)).toContain('TIER_1K');
    await expect(
      asA((tx) =>
        tx.messagingTierLimit.update({
          where: { tier: 'TIER_1K' },
          data: { dailyRecipients: 1 },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('the scheduler functions', () => {
  it('return only ids, with no tenant context', async () => {
    const campaigns = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM campaign_tick_targets(now())`;
    const row = campaigns.find((c) => c.campaign_id === campaignB);
    expect(row).toEqual({ org_id: b.orgId, campaign_id: campaignB, kind: 'prepare' });

    const drips = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM drip_due_targets()`;
    expect(drips.find((d) => d.sequence_id === sequenceB)).toEqual({
      org_id: b.orgId,
      sequence_id: sequenceB,
    });
  });

  it('without context, the tables themselves stay closed', async () => {
    expect(await app.campaign.count()).toBe(0);
    expect(await app.campaignRecipient.count()).toBe(0);
  });
});
