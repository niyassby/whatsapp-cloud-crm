/**
 * Phase 4.3: the rollup turns messages into hourly rows and response times, a trigger records
 * every resolution, conversions are recorded once and credited, and reports read only those.
 */
import { randomUUID } from 'node:crypto';
import { histogramBucket } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentsReport,
  campaignsReport,
  conversationsReport,
  recordConversion,
  rollupAnalytics,
  templatesReport,
} from '../src/analytics';
import type { DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let conversationId: string;
let contactId: string;
let templateId: string;
let campaignId: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

// Kolkata is UTC+5:30: local days and hours must not follow UTC.
const TZ = 'Asia/Kolkata';
// 2026-11-14 10:00 local = 04:30 UTC.
const base = new Date(Date.UTC(2026, 10, 14, 4, 30));
const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);
const today = { from: '2026-11-14', to: '2026-11-14' };

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  await owner.organization.update({ where: { id: a.orgId }, data: { timezone: TZ } });

  await asA(async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: a.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: a.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        status: 'connected',
        credentialSource: 'manual',
        verifiedName: 'Spice Shop',
      },
    });
    const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
    const contact = await tx.contact.create({
      data: { orgId: a.orgId, name: 'Meera', waId: `91${Date.now()}`.slice(0, 12) },
    });
    contactId = contact.id;
    const conversation = await tx.conversation.create({
      data: {
        orgId: a.orgId,
        channelId: channel.id,
        phoneId: phone.id,
        contactId: contact.id,
        createdAt: at(0),
        openedAt: at(0),
        lastMessageAt: at(14 * 60 + 2),
      },
    });
    conversationId = conversation.id;
    const template = await tx.messageTemplate.create({
      data: {
        orgId: a.orgId,
        wabaAccountId: waba.id,
        name: 'order_update',
        language: 'en',
        category: 'UTILITY',
        status: 'APPROVED',
        definition: {},
      },
    });
    templateId = template.id;
    const msg = (
      minutes: number,
      direction: 'inbound' | 'outbound' | 'internal',
      extra: Record<string, unknown> = {},
    ) => ({
      id: randomUUID(),
      createdAt: at(minutes),
      orgId: a.orgId,
      conversationId: conversation.id,
      direction,
      type: 'text',
      status: direction === 'inbound' ? ('received' as const) : ('delivered' as const),
      ...extra,
    });
    await tx.message.createMany({
      data: [
        // A template, read, and answered by the customer 30 minutes later.
        msg(0, 'outbound', {
          type: 'template',
          status: 'read',
          content: { templateId: template.id, templateName: 'order_update' },
        }),
        msg(30, 'inbound'),
        msg(31, 'inbound'),
        // An automated reply does not answer anyone.
        msg(32, 'outbound'),
        msg(35, 'internal', { senderUserId: a.userId }),
        // The person answers 10 minutes after the first unanswered message.
        msg(40, 'outbound', { senderUserId: a.userId }),
        // A second reply with nobody waiting is not a response.
        msg(41, 'outbound', { senderUserId: a.userId }),
        // Next local day in Kolkata, still 14 November in UTC.
        msg(14 * 60, 'inbound'),
        msg(14 * 60 + 2, 'outbound', { senderUserId: a.userId, status: 'failed' }),
      ],
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('rollup', () => {
  it('counts messages per local hour, and running it again changes nothing', async () => {
    for (let i = 0; i < 2; i++) {
      await asA((tx) => rollupAnalytics(tx, a.orgId, at(-60), at(24 * 60)));
    }
    const rows = await asA((tx) =>
      tx.analyticsHourly.findMany({ where: { orgId: a.orgId }, orderBy: { hour: 'asc' } }),
    );
    // 10:00 local: the template, two inbound, the automated reply, a note, two replies.
    expect(rows[0]).toMatchObject({
      hour: new Date('2026-11-14T10:00:00Z'),
      inbound: 2,
      outboundHuman: 2,
      outboundAutomated: 2,
      notes: 1,
      read: 1,
      newConversations: 1,
    });
    // 00:30 local on the 15th: one inbound, one failed reply.
    expect(rows.at(-1)).toMatchObject({
      hour: new Date('2026-11-15T00:00:00Z'),
      inbound: 1,
      failed: 1,
    });
  });

  it('measures a response from the first unanswered message to the person’s reply', async () => {
    const responses = await asA((tx) =>
      tx.analyticsResponse.findMany({ orderBy: { respondedAt: 'asc' } }),
    );
    expect(responses.map((r) => r.seconds)).toEqual([600, 120]);
    expect(responses[0]?.userId).toBe(a.userId);
    // The same times, as histogram buckets for long ranges: 600 s and 120 s.
    const hist = await asA((tx) =>
      tx.analyticsResponseHist.findMany({ orderBy: { bucket: 'asc' } }),
    );
    expect(hist.map((h) => [h.bucket, h.n])).toEqual([
      [histogramBucket(120), 1],
      [histogramBucket(600), 1],
    ]);
  });

  it('counts template sends, reads and replies within a day', async () => {
    const report = await asA((tx) => templatesReport(tx, a.orgId, today));
    expect(report.rows).toEqual([
      expect.objectContaining({
        templateId,
        name: 'order_update',
        attempted: 1,
        read: 1,
        replied: 1,
        replyRate: 1,
      }),
    ]);
  });
});

describe('resolutions', () => {
  it('a trigger records each close, and reopening starts the clock again', async () => {
    await asA((tx) =>
      tx.conversation.update({ where: { id: conversationId }, data: { status: 'closed' } }),
    );
    await asA((tx) =>
      tx.conversation.update({ where: { id: conversationId }, data: { status: 'open' } }),
    );
    const reopened = await asA((tx) =>
      tx.conversation.findUniqueOrThrow({ where: { id: conversationId } }),
    );
    expect(reopened.openedAt.getTime()).toBeGreaterThan(base.getTime());
    await asA((tx) =>
      tx.conversation.update({ where: { id: conversationId }, data: { status: 'closed' } }),
    );
    const rows = await asA((tx) =>
      tx.conversationResolution.findMany({ orderBy: { closedAt: 'asc' } }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.openedAt).toEqual(base);
    expect(rows[1]!.seconds).toBeLessThan(60);
  });

  it('resolutions cannot be changed or deleted', async () => {
    await expect(
      asA((tx) => tx.conversationResolution.updateMany({ data: { seconds: 1 } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.conversationResolution.deleteMany())).rejects.toThrow(
      /permission denied/,
    );
  });
});

describe('conversions', () => {
  beforeAll(async () => {
    await asA(async (tx) => {
      const phone = await tx.phoneNumber.findFirstOrThrow();
      const campaign = await tx.campaign.create({
        data: {
          orgId: a.orgId,
          name: 'Diwali sale',
          status: 'completed',
          phoneId: phone.id,
          templateId,
          audience: { type: 'segment', filter: {} },
          startedAt: at(0),
        },
      });
      campaignId = campaign.id;
      await tx.campaignRecipient.create({
        data: {
          orgId: a.orgId,
          campaignId: campaign.id,
          contactId,
          phoneId: phone.id,
          status: 'read',
          sentAt: at(0),
        },
      });
    });
  });

  it('records a sale once and credits the broadcast that reached the contact', async () => {
    const input = {
      orgId: a.orgId,
      contactId,
      source: 'store_order' as const,
      reference: 'order-1001',
      amount: '1,499.50',
      currency: 'inr',
      occurredAt: at(60),
    };
    expect(await asA((tx) => recordConversion(tx, input))).toBe(true);
    expect(await asA((tx) => recordConversion(tx, input))).toBe(false);
    const rows = await asA((tx) => tx.conversion.findMany());
    expect(rows).toEqual([
      expect.objectContaining({ amountMicros: 1_499_500_000n, currency: 'INR', campaignId }),
    ]);
    const report = await asA((tx) => campaignsReport(tx, a.orgId, today));
    expect(report.rows[0]).toMatchObject({
      name: 'Diwali sale',
      read: 1,
      conversions: 1,
      revenueMicros: 1_499_500_000,
    });
  });

  it('refuses an amount that is not a number', async () => {
    expect(
      await asA((tx) =>
        recordConversion(tx, {
          orgId: a.orgId,
          contactId,
          source: 'payment',
          reference: 'pay-x',
          amount: 'free',
          currency: 'INR',
        }),
      ),
    ).toBe(false);
  });
});

describe('reports', () => {
  it('group by local day in the workspace’s time zone', async () => {
    const report = await asA((tx) =>
      conversationsReport(tx, a.orgId, { from: '2026-11-14', to: '2026-11-15' }),
    );
    expect(report.period.timezone).toBe(TZ);
    expect(report.daily.map((d) => [d.day, d.inbound, d.responses])).toEqual([
      ['2026-11-14', 2, 1],
      ['2026-11-15', 1, 1],
    ]);
    expect(report.totals).toMatchObject({
      inbound: 3,
      responses: 2,
      medianResponseSeconds: 360,
      newConversations: 1,
      resolved: 2,
    });
    expect(report.byHour[10]).toMatchObject({ inbound: 2 });
    expect(report.byChannel[0]).toMatchObject({ kind: 'whatsapp', name: 'Spice Shop' });
  });

  it('team performance lists each member with what they did', async () => {
    const report = await asA((tx) =>
      agentsReport(tx, a.orgId, { from: '2026-11-14', to: '2026-11-15' }),
    );
    expect(report.rows.find((r) => r.userId === a.userId)).toMatchObject({
      messages: 3,
      notes: 1,
      responses: 2,
      medianResponseSeconds: 360,
    });
  });
});

describe('isolation', () => {
  it('another workspace sees none of it, and cannot write into it', async () => {
    const seen = await asB(async (tx) => [
      await tx.analyticsHourly.count(),
      await tx.analyticsAgentHourly.count(),
      await tx.analyticsTemplateHourly.count(),
      await tx.analyticsResponse.count(),
      await tx.conversationResolution.count(),
      await tx.conversion.count(),
      await tx.reportSchedule.count(),
    ]);
    expect(seen).toEqual([0, 0, 0, 0, 0, 0, 0]);
    const report = await asB((tx) => conversationsReport(tx, b.orgId, today));
    expect(report.totals.inbound).toBe(0);
    await expect(
      asB((tx) =>
        tx.conversion.create({
          data: {
            orgId: a.orgId,
            contactId,
            source: 'payment',
            reference: 'x',
            amountMicros: 1n,
            currency: 'INR',
            occurredAt: new Date(),
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('the rollup run for one workspace cannot write rows for another', async () => {
    await asB((tx) => rollupAnalytics(tx, a.orgId, at(-60), at(24 * 60)));
    expect(await asB((tx) => tx.analyticsHourly.count())).toBe(0);
    expect(await asA((tx) => tx.analyticsHourly.count())).toBeGreaterThan(0);
  });

  it('the pre-tenant lookups return ids only', async () => {
    const targets = await app.$queryRaw<{ org_id: string }[]>`
      SELECT * FROM analytics_rollup_targets(${new Date(0)}::timestamptz)`;
    expect(targets.length).toBeGreaterThan(0);
    expect(Object.keys(targets[0]!)).toEqual(['org_id']);
    await asA((tx) =>
      tx.reportSchedule.create({
        data: {
          orgId: a.orgId,
          name: 'Weekly',
          report: 'conversations',
          frequency: 'weekly',
          format: 'pdf',
          recipientIds: [a.userId],
          nextRunAt: new Date(0),
        },
      }),
    );
    const due = await app.$queryRaw<Record<string, unknown>[]>`
      SELECT * FROM report_schedules_due(now(), 10)`;
    expect(due.find((d) => d.org_id === a.orgId)).toBeTruthy();
    expect(Object.keys(due[0]!).sort()).toEqual(['id', 'org_id']);
    expect(await withDbContext(app, {}, (tx) => tx.reportSchedule.count())).toBe(0);
  });
});
