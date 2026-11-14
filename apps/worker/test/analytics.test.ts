/**
 * Phase 4.3 in the worker: the rollup tick, catalog orders as conversions, and scheduled report
 * emails (claimed once, members only, failures recorded rather than resent). Real Postgres.
 */
import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant } from '@wacrm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ReportMail, runReportSchedule, runRollup } from '../src/processors/analytics';
import { processMessagesChange } from '../src/processors/inbound';
import { buildDeps, connectNumber, createOrg, db, inboundPayload, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;
beforeAll(() => {
  client = db();
  owner = ownerDb();
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

async function member(orgId: string, role: 'owner' | 'admin' | 'agent') {
  const userId = randomUUID();
  const email = `${role}-${userId.slice(0, 8)}@worker.test`;
  await owner.user.create({
    data: { id: userId, email, name: role, passwordHash: 'x', emailVerifiedAt: new Date() },
  });
  await owner.membership.create({ data: { orgId, userId, role } });
  return { userId, email };
}

describe('rollup and conversions', () => {
  it('a catalog order is a sale, and the tick rolls up the workspace that had messages', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    const payload = inboundPayload(phone.phoneNumberId, {
      type: 'order',
      text: undefined,
      order: {
        catalog_id: 'cat-1',
        product_items: [
          { product_retailer_id: 'CAKE-1', quantity: 2, item_price: 650, currency: 'INR' },
        ],
      },
    });
    await processMessagesChange(ctx.deps, orgId, payload);
    // Meta redelivers: still one sale.
    await processMessagesChange(ctx.deps, orgId, payload);
    const sales = await withTenant(client, { orgId }, (tx) => tx.conversion.findMany());
    expect(sales).toEqual([
      expect.objectContaining({ source: 'whatsapp_order', amountMicros: 1_300_000_000n }),
    ]);

    const result = await runRollup(ctx.deps, 3 * 3_600_000);
    expect(result.failed).toEqual([]);
    const hours = await withTenant(client, { orgId }, (tx) => tx.analyticsHourly.findMany());
    expect(hours.reduce((s, h) => s + h.inbound, 0)).toBe(1);
    expect(hours.reduce((s, h) => s + h.newConversations, 0)).toBe(1);
  });
});

describe('scheduled reports', () => {
  async function scheduled(recipients: string[], orgId: string) {
    const id = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.reportSchedule.create({
        data: {
          id,
          orgId,
          name: 'Daily',
          report: 'conversations',
          frequency: 'daily',
          format: 'pdf',
          recipientIds: recipients,
          hour: 8,
          nextRunAt: new Date(Date.now() - 60_000),
        },
      }),
    );
    return id;
  }
  const load = (orgId: string, id: string) =>
    withTenant(client, { orgId }, (tx) => tx.reportSchedule.findUniqueOrThrow({ where: { id } }));

  it('sends once to owners and admins, with the report attached, then moves to the next day', async () => {
    const orgId = await createOrg(client);
    const admin = await member(orgId, 'admin');
    const agent = await member(orgId, 'agent');
    const id = await scheduled([admin.userId, agent.userId], orgId);
    const mails: ReportMail[] = [];
    const ctx = buildDeps(client);
    const deps = { ...ctx.deps, sendMail: async (m: ReportMail) => void mails.push(m) };

    expect(await runReportSchedule(deps, orgId, id)).toBe('sent');
    // A second worker, or a retry, finds it already claimed.
    expect(await runReportSchedule(deps, orgId, id)).toBe('skipped');
    expect(mails).toHaveLength(1);
    // The agent may not read reports, so only the admin gets it.
    expect(mails[0]!.to).toEqual([admin.email]);
    expect(mails[0]!.subject).toMatch(/^Conversations, \d{4}-\d{2}-\d{2} · Org$/);
    expect(mails[0]!.attachment.content.subarray(0, 4).toString()).toBe('%PDF');
    expect(mails[0]!.text).toContain('Messages from customers: 0');

    const after = await load(orgId, id);
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.nextRunAt.getTime() - Date.now()).toBeLessThanOrEqual(86_400_000);
    expect(after.lastError).toBeNull();
  });

  it('skips a schedule nobody may receive, and records why', async () => {
    const orgId = await createOrg(client);
    const agent = await member(orgId, 'agent');
    const id = await scheduled([agent.userId], orgId);
    const mails: ReportMail[] = [];
    const deps = {
      ...buildDeps(client).deps,
      sendMail: async (m: ReportMail) => void mails.push(m),
    };
    expect(await runReportSchedule(deps, orgId, id)).toBe('skipped');
    expect(mails).toHaveLength(0);
    expect((await load(orgId, id)).lastError).toMatch(/recipients/);
  });

  it('a failed send is recorded and not repeated for the same period', async () => {
    const orgId = await createOrg(client);
    const admin = await member(orgId, 'owner');
    const id = await scheduled([admin.userId], orgId);
    const deps = {
      ...buildDeps(client).deps,
      sendMail: async () => {
        throw new Error('SMTP down');
      },
    };
    expect(await runReportSchedule(deps, orgId, id)).toBe('failed');
    const after = await load(orgId, id);
    expect(after.lastError).toContain('SMTP down');
    expect(after.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });
});
