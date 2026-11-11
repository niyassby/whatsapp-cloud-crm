/**
 * The campaign engine on real Postgres, including the Phase 2.4 acceptance test: a 10k campaign
 * finishes with correct counts and ledger totals while the inbox stays responsive.
 */
import { randomUUID } from 'node:crypto';
import { writeSync } from 'node:fs';
import {
  campaignCostMicros,
  campaignCounts,
  creditWallet,
  type DbClient,
  ensureWallet,
  withTenant,
} from '@wacrm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type CampaignSettings,
  campaignTickTargets,
  dispatchCampaignBatch,
  pause,
  prepareCampaign,
  runCampaignJob,
} from '../src/processors/campaigns';
import { dripTargets, runDripBatch } from '../src/processors/drips';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import { buildDeps, connectNumber, createOrg, db, metaError, metaId, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;

const SETTINGS: CampaignSettings = { mpsPerNumber: 50, maxFailureRate: 0.2 };
const RATE = 1_000_000;

beforeAll(async () => {
  client = db();
  owner = ownerDb();
  await owner.rateCard.createMany({
    data: ['marketing', 'utility'].map((category) => ({
      country: '*',
      category,
      currency: 'XCP',
      rateMicros: BigInt(RATE),
      validFrom: new Date('2026-01-01'),
    })),
    skipDuplicates: true,
  });
  await owner.messagingTierLimit.createMany({
    data: [{ tier: 'TIER_TEST_5', dailyRecipients: 5 }],
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

const waIdFor = (i: number) => String(919_000_000_000 + i);

interface SetupOptions {
  contacts?: number;
  optIn?: 'opted_in' | 'unknown' | 'opted_out';
  balance?: number;
  category?: string;
  tier?: string;
  quality?: string;
  body?: string;
  mapping?: object;
}

async function setup(opts: SetupOptions = {}) {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  const built = buildDeps(client);
  const contacts = opts.contacts ?? 3;
  const { campaignId, templateId } = await withTenant(
    client,
    { orgId },
    async (tx) => {
      const phone = await tx.phoneNumber.update({
        where: { id: number.id },
        data: {
          messagingTier: opts.tier ?? 'TIER_UNLIMITED',
          qualityRating: opts.quality ?? 'GREEN',
        },
      });
      await ensureWallet(tx, orgId, 'XCP');
      if (opts.balance !== 0) {
        await creditWallet(tx, {
          orgId,
          amountMicros: opts.balance ?? 1_000 * RATE,
          idempotencyKey: 'seed',
        });
      }
      for (let start = 0; start < contacts; start += 1000) {
        await tx.contact.createMany({
          data: Array.from({ length: Math.min(1000, contacts - start) }, (_, j) => ({
            orgId,
            waId: waIdFor(start + j),
            name: `Person ${start + j}`,
            optInStatus: opts.optIn ?? ('opted_in' as const),
          })),
        });
      }
      const template = await tx.messageTemplate.create({
        data: {
          orgId,
          wabaAccountId: phone.wabaAccountId,
          name: `t_${metaId()}`,
          language: 'en',
          category: opts.category ?? 'MARKETING',
          status: 'approved',
          metaTemplateId: metaId(),
          definition: {
            header: null,
            body: opts.body ?? 'Hello from the shop today.',
            footer: null,
            buttons: [],
          },
        },
      });
      const campaign = await tx.campaign.create({
        data: {
          orgId,
          name: 'Test',
          status: 'preparing',
          phoneId: number.id,
          templateId: template.id,
          audience: { type: 'segment', filterSnapshot: {} },
          variableMapping: (opts.mapping ?? {}) as object,
        },
      });
      return { campaignId: campaign.id, templateId: template.id };
    },
    { timeout: 120_000 },
  );
  const job = { orgId, campaignId };
  const counts = () => withTenant(client, { orgId }, (tx) => campaignCounts(tx, campaignId));
  const campaign = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
    );
  const wallet = () =>
    withTenant(client, { orgId }, (tx) => tx.wallet.findUniqueOrThrow({ where: { orgId } }));
  const cost = () => withTenant(client, { orgId }, (tx) => campaignCostMicros(tx, campaignId));

  /** Run the job chain to the end, as the queue would. */
  const runAll = async () => {
    await prepareCampaign(built.deps, orgId, campaignId);
    for (let i = 0; i < 2000; i++) {
      const outcome = await dispatchCampaignBatch(built.deps, SETTINGS, orgId, campaignId);
      if (outcome === 'finished' || outcome === 'stopped') return outcome;
      if (typeof outcome === 'object') {
        // A wait: in production the job comes back later. Tests that use retries clear the wait.
        await withTenant(client, { orgId }, (tx) =>
          tx.campaignRecipient.updateMany({
            where: { campaignId, status: 'pending' },
            data: { nextAttemptAt: null },
          }),
        );
        if (outcome.retryInMs > 60_000) return outcome;
      }
    }
    throw new Error('Campaign did not finish');
  };

  /** A status webhook for one recipient's message. */
  const statusFor = (messageId: string, createdAt: Date, over: Record<string, unknown>) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: number.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1', phone_number_id: number.phoneNumberId },
              statuses: [
                {
                  id: `wamid.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: '1',
                  biz_opaque_callback_data: `${messageId}|${createdAt.toISOString()}`,
                  ...over,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const inbound = (from: string, text: string) => ({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: number.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '1', phone_number_id: number.phoneNumberId },
              contacts: [{ profile: { name: 'Someone' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  return {
    orgId,
    number,
    campaignId,
    templateId,
    job,
    counts,
    campaign,
    wallet,
    cost,
    runAll,
    statusFor,
    inbound,
    ...built,
  };
}

describe('a whole campaign', () => {
  it('holds funds, sends to everyone, charges each, and returns what is left', async () => {
    const s = await setup({ contacts: 5, balance: 10 * RATE });
    expect(await s.runAll()).toBe('finished');
    expect(await s.counts()).toMatchObject({ total: 5, sent: 5, failed: 0, pending: 0 });
    expect(await s.cost()).toBe(5 * RATE);
    const wallet = await s.wallet();
    expect(Number(wallet.balanceMicros)).toBe(5 * RATE);
    expect(Number(wallet.reservedMicros)).toBe(0);
    expect((await s.campaign()).status).toBe('completed');
    expect(s.fake.calls.filter((c) => c.method === 'sendTemplate')).toHaveLength(5);
  });

  it('keeps the inbox tidy: new threads stay closed until someone replies', async () => {
    const s = await setup({ contacts: 2 });
    await s.runAll();
    const threads = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.findMany({ select: { status: true, unreadCount: true } }),
    );
    expect(threads).toEqual([
      { status: 'closed', unreadCount: 0 },
      { status: 'closed', unreadCount: 0 },
    ]);
    await processMessagesChange(s.deps, s.orgId, s.inbound(waIdFor(0), 'Thanks'));
    const open = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.conversation.count({ where: { status: 'open' } }),
    );
    expect(open).toBe(1);
  });

  it('running a prepare or a batch again sends nothing twice', async () => {
    const s = await setup({ contacts: 3 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.campaign.update({ where: { id: s.campaignId }, data: { status: 'preparing' } }),
    );
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    expect((await s.counts()).total).toBe(3);
    expect(Number((await s.wallet()).reservedMicros)).toBe(3 * RATE);

    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    expect(s.fake.calls.filter((c) => c.method === 'sendTemplate')).toHaveLength(3);
    expect(await s.cost()).toBe(3 * RATE);
  });

  it('a batch that rolls back hands its recipients back at once', async () => {
    const s = await setup({ contacts: 2 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    const broken = {
      ...s.deps,
      db: new Proxy(s.deps.db, {
        get(target, prop, receiver) {
          if (prop !== '$transaction') return Reflect.get(target, prop, receiver);
          return (...args: Parameters<typeof target.$transaction>) => {
            // State, then the claim, both real. Then the batch transaction loses a deadlock.
            if (++calls === 3) {
              return Promise.reject(Object.assign(new Error('deadlock'), { code: 'P2034' }));
            }
            return (target.$transaction as (...a: unknown[]) => unknown)(...args);
          };
        },
      }),
    };
    let calls = 0;
    const outcome = await dispatchCampaignBatch(broken, SETTINGS, s.orgId, s.campaignId);
    expect(outcome).toEqual({ retryInMs: 2_000 });
    const rows = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.campaignRecipient.findMany({ select: { status: true, attempts: true } }),
    );
    expect(rows).toEqual([
      { status: 'pending', attempts: 0 },
      { status: 'pending', attempts: 0 },
    ]);
    expect(s.fake.calls).toEqual([]);
    // And the next attempt sends them normally. Under load that attempt can lose a real deadlock
    // too, which answers "retry" just like the one above, so allow the chain a few tries.
    for (let i = 0; i < 3 && (await s.counts()).sent < 2; i++) {
      await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    }
    expect((await s.counts()).sent).toBe(2);
  });

  it('two dispatchers at once cannot claim the same recipient', async () => {
    const s = await setup({ contacts: 40 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        dispatchCampaignBatch(s.deps, { ...SETTINGS, mpsPerNumber: 15 }, s.orgId, s.campaignId),
      ),
    );
    const to = s.fake.calls.filter((c) => c.method === 'sendTemplate').map((c) => c.args[0]);
    expect(new Set(to).size).toBe(to.length);
  }, 60_000);
});

describe('who it goes to', () => {
  it('skips contacts with no consent for marketing, and sends none before checking', async () => {
    const s = await setup({ contacts: 2, optIn: 'unknown' });
    await s.runAll();
    expect(await s.counts()).toMatchObject({ total: 2, skipped: 2, sent: 0 });
    expect(s.fake.calls).toEqual([]);
    expect((await s.campaign()).status).toBe('completed');
    expect(Number((await s.wallet()).reservedMicros)).toBe(0);
  });

  it('sends utility to contacts with no choice recorded, but never to someone who opted out', async () => {
    const unknown = await setup({ contacts: 1, optIn: 'unknown', category: 'UTILITY' });
    await unknown.runAll();
    expect((await unknown.counts()).sent).toBe(1);

    const stopped = await setup({ contacts: 1, optIn: 'opted_out', category: 'UTILITY' });
    await stopped.runAll();
    expect(await stopped.counts()).toMatchObject({ sent: 0, skipped: 1 });
  });

  it('skips a contact who opts out after the list was built', async () => {
    const s = await setup({ contacts: 2 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await processMessagesChange(s.deps, s.orgId, s.inbound(waIdFor(0), 'STOP'));
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    expect(await s.counts()).toMatchObject({ sent: 1, skipped: 1 });
    expect(await s.cost()).toBe(RATE);
  });

  it('fills variables from contact fields, and skips who is missing one', async () => {
    const s = await setup({
      contacts: 2,
      body: 'Hi {{1}}, your {{2}} is ready.',
      mapping: {
        'body.1': { source: 'contact', field: 'first_name' },
        'body.2': { source: 'custom', key: 'order' },
      },
    });
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.update({
        where: { orgId_waId: { orgId: s.orgId, waId: waIdFor(0) } },
        data: { customFields: { order: 'cake' } },
      }),
    );
    await s.runAll();
    expect(await s.counts()).toMatchObject({ sent: 1, skipped: 1 });
    const message = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    expect(message.body).toBe('Hi Person, your cake is ready.');
    const skipped = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.campaignRecipient.findFirstOrThrow({ where: { status: 'skipped' } }),
    );
    expect(skipped.skipReason).toBe('missing_variable');
  });

  it('reaches only who the saved filter matches', async () => {
    const s = await setup({ contacts: 3 });
    await withTenant(client, { orgId: s.orgId }, async (tx) => {
      await tx.contact.update({
        where: { orgId_waId: { orgId: s.orgId, waId: waIdFor(1) } },
        data: { optInStatus: 'unknown' },
      });
      await tx.campaign.update({
        where: { id: s.campaignId },
        data: {
          audience: {
            type: 'segment',
            filterSnapshot: {
              segment: {
                match: 'all',
                rules: [{ field: 'opt_in', op: 'is', value: 'opted_in' }],
              },
            },
          },
        },
      });
    });
    await s.runAll();
    // Without the filter, the third contact would count as a skip.
    expect(await s.counts()).toMatchObject({ total: 2, sent: 2, skipped: 0 });
  });

  it('reads an uploaded file, adding new numbers with no consent recorded', async () => {
    const s = await setup({ contacts: 0, category: 'UTILITY' });
    const key = `orgs/${s.orgId}/campaigns/x.csv`;
    await s.storage.put(
      key,
      Buffer.from(
        'Phone,Order\n+919876543210,cake\n+919876543210,again\nnot-a-number,x\n+919876543211,bread\n',
      ),
      'text/csv',
    );
    await withTenant(client, { orgId: s.orgId }, async (tx) => {
      await tx.messageTemplate.update({
        where: { id: s.templateId },
        data: {
          definition: { header: null, body: 'Your {{1}} is ready.', footer: null, buttons: [] },
        },
      });
      await tx.campaign.update({
        where: { id: s.campaignId },
        data: {
          audience: {
            type: 'csv',
            key,
            phoneColumn: 'Phone',
            variableColumns: { 'body.1': 'Order' },
          },
        },
      });
    });
    await s.runAll();
    expect(await s.counts()).toMatchObject({ total: 2, sent: 2 });
    expect((await s.campaign()).invalidRows).toBe(1);
    const bodies = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.message.findMany({ select: { body: true } }),
    );
    expect(bodies.map((b) => b.body).sort()).toEqual([
      'Your bread is ready.',
      'Your cake is ready.',
    ]);
    const contact = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { waId: '919876543210' } }),
    );
    expect(contact.optInStatus).toBe('unknown');
  });
});

describe('money', () => {
  it('pauses before sending anything when the wallet cannot cover it', async () => {
    const s = await setup({ contacts: 5, balance: 3 * RATE });
    expect(await prepareCampaign(s.deps, s.orgId, s.campaignId)).toBe('paused');
    expect(await s.campaign()).toMatchObject({ status: 'paused', pauseCode: 'insufficient_funds' });
    expect(s.fake.calls).toEqual([]);
    expect(await s.counts()).toMatchObject({ pending: 5, sent: 0 });
    expect(Number((await s.wallet()).reservedMicros)).toBe(0);
  });

  it('funds held by a campaign cannot be spent by others', async () => {
    const s = await setup({ contacts: 5, balance: 5 * RATE });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    const w = await s.wallet();
    expect(Number(w.balanceMicros) - Number(w.reservedMicros)).toBe(0);
  });

  it('a failed send is refunded, and the report matches the ledger', async () => {
    const s = await setup({ contacts: 4, balance: 10 * RATE });
    let calls = 0;
    s.fake.respondWith(() =>
      ++calls === 1
        ? { data: null, error: metaError({ retryable: false }) }
        : { data: { messageId: `wamid.${randomUUID()}`, waId: '1' }, error: null },
    );
    await s.runAll();
    expect(await s.counts()).toMatchObject({ sent: 3, failed: 1 });
    expect(await s.cost()).toBe(3 * RATE);
    expect(Number((await s.wallet()).balanceMicros)).toBe(7 * RATE);
  });

  it('a delivery failure reported later is also refunded', async () => {
    const s = await setup({ contacts: 1, balance: 10 * RATE });
    await s.runAll();
    const m = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    await processMessagesChange(
      s.deps,
      s.orgId,
      s.statusFor(m.id, m.createdAt, {
        status: 'failed',
        errors: [{ code: 131026, title: 'Undeliverable' }],
      }),
    );
    expect(await s.counts()).toMatchObject({ failed: 1, sent: 0 });
    expect(await s.cost()).toBe(0);
    expect(Number((await s.wallet()).balanceMicros)).toBe(10 * RATE);
  });

  it('a send that blows up does not sink the batch, and is never sent twice', async () => {
    const s = await setup({ contacts: 3, balance: 10 * RATE });
    let calls = 0;
    s.fake.respondWith(() => {
      if (++calls === 1) throw new Error('connection lost');
      return { data: { messageId: `wamid.${randomUUID()}`, waId: '1' }, error: null };
    });
    expect(await s.runAll()).toBe('finished');
    expect(await s.counts()).toMatchObject({ sent: 2, failed: 1, pending: 0 });
    // Meta may have received the one that blew up, so it fails rather than going out again.
    expect(s.fake.calls.filter((c) => c.method === 'sendTemplate')).toHaveLength(3);
    expect(Number((await s.wallet()).balanceMicros)).toBe(8 * RATE);
  });

  it('retries what Meta says to, then gives up with a refund', async () => {
    const s = await setup({ contacts: 1, balance: 10 * RATE });
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: true }) }));
    await s.runAll();
    expect(await s.counts()).toMatchObject({ failed: 1, pending: 0 });
    expect(s.fake.calls.filter((c) => c.method === 'sendTemplate')).toHaveLength(3);
    expect(Number((await s.wallet()).balanceMicros)).toBe(10 * RATE);
  });
});

describe('statuses and replies', () => {
  it('moves forward only, and a reply is credited to the broadcast', async () => {
    const s = await setup({ contacts: 1 });
    await s.runAll();
    const m = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    await processMessagesChange(
      s.deps,
      s.orgId,
      s.statusFor(m.id, m.createdAt, { status: 'read' }),
    );
    await processMessagesChange(
      s.deps,
      s.orgId,
      s.statusFor(m.id, m.createdAt, { status: 'delivered' }),
    );
    expect(await s.counts()).toMatchObject({ sent: 1, delivered: 1, read: 1, replied: 0 });
    await processMessagesChange(s.deps, s.orgId, s.inbound(waIdFor(0), 'Thanks!'));
    expect(await s.counts()).toMatchObject({ sent: 1, delivered: 1, read: 1, replied: 1 });
    const r = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.campaignRecipient.findFirstOrThrow(),
    );
    expect(r.repliedAt).toBeInstanceOf(Date);
  });

  it('does not credit a reply from someone it never reached', async () => {
    const s = await setup({ contacts: 1 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await processMessagesChange(s.deps, s.orgId, s.inbound(waIdFor(0), 'Hello'));
    expect((await s.counts()).replied).toBe(0);
  });
});

describe('protecting the number', () => {
  it('pauses when quality is low, before sending', async () => {
    const s = await setup({ contacts: 2, quality: 'RED' });
    expect(await s.runAll()).toBe('stopped');
    expect(await s.campaign()).toMatchObject({ status: 'paused', pauseCode: 'low_quality' });
    expect(s.fake.calls).toEqual([]);
  });

  it('pauses when too many sends fail', async () => {
    const s = await setup({ contacts: 120, balance: 200 * RATE });
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: false }) }));
    expect(await s.runAll()).toBe('stopped');
    const c = await s.campaign();
    expect(c).toMatchObject({ status: 'paused', pauseCode: 'high_failure_rate' });
    expect(c.pauseReason).toContain('100%');
    const counts = await s.counts();
    expect(counts.failed).toBeLessThan(120);
    expect(counts.pending).toBeGreaterThan(0);
  }, 60_000);

  it('does not pause for one failure in a small send', async () => {
    const s = await setup({ contacts: 2 });
    let calls = 0;
    s.fake.respondWith(() =>
      ++calls === 1
        ? { data: null, error: metaError({ retryable: false }) }
        : { data: { messageId: `wamid.${randomUUID()}`, waId: '1' }, error: null },
    );
    expect(await s.runAll()).toBe('finished');
  });

  it('stops at the number’s daily limit, and waits rather than failing', async () => {
    const s = await setup({ contacts: 8, tier: 'TIER_TEST_5' });
    const outcome = await s.runAll();
    expect(outcome).toMatchObject({ retryInMs: 900_000 });
    expect(await s.counts()).toMatchObject({ sent: 5, pending: 3 });
    const c = await s.campaign();
    expect(c.status).toBe('running');
    expect(c.waitingUntil).toBeInstanceOf(Date);
  });

  it('treats an unknown tier as the limit a new number starts on', async () => {
    const s = await setup({ contacts: 1, tier: 'NOT_A_TIER' });
    await s.runAll();
    expect((await s.counts()).sent).toBe(1);
  });

  it('pauses if the template stops being approved mid-way', async () => {
    const s = await setup({ contacts: 2 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.messageTemplate.update({ where: { id: s.templateId }, data: { status: 'paused' } }),
    );
    expect(await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId)).toBe('stopped');
    expect((await s.campaign()).pauseCode).toBe('template_not_approved');
  });

  it('a batch sends no more than it was allowed', async () => {
    const s = await setup({ contacts: 120 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    s.deps.acquireCampaignSlots = async () => 7;
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    expect(s.fake.calls.filter((c) => c.method === 'sendTemplate')).toHaveLength(7);
    expect(await s.counts()).toMatchObject({ sent: 7, pending: 113 });
  });

  it('respects the rate given by the shared counter', async () => {
    const s = await setup({ contacts: 10 });
    s.deps.acquireCampaignSlots = async () => 0;
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    const outcome = await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    expect(outcome).toEqual({ retryInMs: 250 });
    expect(s.fake.calls).toEqual([]);
  });
});

describe('controls', () => {
  it('a paused campaign sends nothing more', async () => {
    const s = await setup({ contacts: 3 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await pause(s.deps, s.orgId, s.campaignId, 'manual', 'Paused');
    expect(await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId)).toBe('stopped');
    expect(s.fake.calls).toEqual([]);
  });

  it('runCampaignJob queues the next step of the chain', async () => {
    const s = await setup({ contacts: 2 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    expect(s.campaignJobs.at(-1)?.job).toEqual({ kind: 'dispatch', ...s.job });
    await runCampaignJob(s.deps, SETTINGS, { kind: 'dispatch', ...s.job });
    expect(s.campaignJobs).toHaveLength(2);
    await runCampaignJob(s.deps, SETTINGS, { kind: 'dispatch', ...s.job });
    // The last one finds nothing left and finishes, with nothing more to queue.
    expect(s.campaignJobs).toHaveLength(2);
    expect((await s.campaign()).status).toBe('completed');
  });

  it('recovers a send left behind by a crash, without sending blind', async () => {
    const s = await setup({ contacts: 1 });
    await prepareCampaign(s.deps, s.orgId, s.campaignId);
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    // As a worker that died mid-send leaves it.
    await owner.$executeRaw`
      UPDATE campaign_recipients
         SET status = 'sending', updated_at = now() - interval '10 minutes'
       WHERE campaign_id = ${s.campaignId}::uuid`;
    await owner.$executeRaw`
      UPDATE messages SET status = 'sending' WHERE org_id = ${s.orgId}::uuid`;
    const before = s.fake.calls.length;
    await dispatchCampaignBatch(s.deps, SETTINGS, s.orgId, s.campaignId);
    expect(s.fake.calls.length).toBe(before);
    expect(await s.counts()).toMatchObject({ failed: 1 });
    expect(await s.cost()).toBe(0);
  });
});

describe('the scheduler', () => {
  it('finds campaigns that are due, or that lost their job chain, across every org', async () => {
    const due = await setup({ contacts: 1 });
    const future = await setup({ contacts: 1 });
    await withTenant(client, { orgId: due.orgId }, (tx) =>
      tx.campaign.update({
        where: { id: due.campaignId },
        data: { status: 'scheduled', scheduledAt: new Date(Date.now() - 1000) },
      }),
    );
    await withTenant(client, { orgId: future.orgId }, (tx) =>
      tx.campaign.update({
        where: { id: future.campaignId },
        data: { status: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000) },
      }),
    );
    const targets = await campaignTickTargets({ db: client });
    expect(targets).toContainEqual({
      org_id: due.orgId,
      campaign_id: due.campaignId,
      kind: 'prepare',
    });
    expect(targets.map((t) => t.campaign_id)).not.toContain(future.campaignId);
    expect(Object.keys(targets[0]!).sort()).toEqual(['campaign_id', 'kind', 'org_id']);
  });
});

describe('drip sequences', () => {
  async function drip(
    over: { exitOnReply?: boolean; steps?: number[]; optIn?: 'opted_in' | 'unknown' } = {},
  ) {
    const s = await setup({ contacts: 1, optIn: over.optIn });
    const contact = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ where: { orgId: s.orgId } }),
    );
    const delays = over.steps ?? [0, 60];
    const sequenceId = await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const seq = await tx.dripSequence.create({
        data: {
          orgId: s.orgId,
          name: 'Welcome',
          status: 'active',
          phoneId: s.number.id,
          exitOnReply: over.exitOnReply ?? true,
          steps: {
            create: delays.map((delayMinutes, position) => ({
              orgId: s.orgId,
              position,
              delayMinutes,
              templateId: s.templateId,
            })),
          },
        },
      });
      await tx.dripEnrollment.create({
        data: {
          orgId: s.orgId,
          sequenceId: seq.id,
          contactId: contact.id,
          nextRunAt: new Date(Date.now() - 1000),
          enrolledAt: new Date(Date.now() - 1000),
        },
      });
      return seq.id;
    });
    const enrollment = () =>
      withTenant(client, { orgId: s.orgId }, (tx) => tx.dripEnrollment.findFirstOrThrow());
    const sends = () => s.fake.calls.filter((c) => c.method === 'sendTemplate').length;
    return { ...s, sequenceId, contact, enrollment, sends };
  }

  const due = (s: { orgId: string }) =>
    withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.dripEnrollment.updateMany({ data: { nextRunAt: new Date(Date.now() - 1000) } }),
    );

  it('sends steps in order, waiting between them, and then completes', async () => {
    const s = await drip();
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(1);
    const after = await s.enrollment();
    expect(after).toMatchObject({ status: 'active', nextStep: 1 });
    const wait = after.nextRunAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(59 * 60_000);

    // Not due yet, so nothing happens.
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(1);

    await due(s);
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(2);
    expect(await s.enrollment()).toMatchObject({ status: 'completed', nextRunAt: null });
  });

  it('charges each step', async () => {
    const s = await drip({ steps: [0] });
    const before = Number((await s.wallet()).balanceMicros);
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(Number((await s.wallet()).balanceMicros)).toBe(before - RATE);
  });

  it('stops when the contact replies', async () => {
    const s = await drip();
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    await processMessagesChange(s.deps, s.orgId, s.inbound(s.contact.waId, 'Tell me more'));
    expect(await s.enrollment()).toMatchObject({ status: 'exited', exitReason: 'replied' });
    await due(s);
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(1);
  });

  it('carries on after a reply when told to', async () => {
    const s = await drip({ exitOnReply: false });
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    await processMessagesChange(s.deps, s.orgId, s.inbound(s.contact.waId, 'Thanks'));
    await due(s);
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(2);
  });

  it('always stops on STOP', async () => {
    const s = await drip({ exitOnReply: false });
    await processMessagesChange(s.deps, s.orgId, s.inbound(s.contact.waId, 'STOP'));
    expect(await s.enrollment()).toMatchObject({ status: 'exited', exitReason: 'opted_out' });
  });

  it('stops when the contact has the exit tag', async () => {
    const s = await drip();
    await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const tag = await tx.tag.create({ data: { orgId: s.orgId, name: 'Bought' } });
      await tx.contactTag.create({
        data: { orgId: s.orgId, contactId: s.contact.id, tagId: tag.id },
      });
      await tx.dripSequence.update({ where: { id: s.sequenceId }, data: { exitTagId: tag.id } });
    });
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(0);
    expect(await s.enrollment()).toMatchObject({ status: 'exited', exitReason: 'tagged' });
  });

  it('exits marketing to someone with no consent', async () => {
    const s = await drip({ optIn: 'unknown' });
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(0);
    expect((await s.enrollment()).exitReason).toBe('no_consent');
  });

  it('with too little money, the step waits instead of being lost', async () => {
    const s = await drip();
    await owner.$executeRaw`
      UPDATE wallets SET balance_micros = 0 WHERE org_id = ${s.orgId}::uuid`;
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(0);
    const after = await s.enrollment();
    expect(after).toMatchObject({ status: 'active', nextStep: 0 });
    expect(after.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('two runs at once cannot send one step twice', async () => {
    const s = await drip({ steps: [0] });
    await Promise.all([
      runDripBatch(s.deps, s.orgId, s.sequenceId),
      runDripBatch(s.deps, s.orgId, s.sequenceId),
    ]);
    expect(s.sends()).toBe(1);
  });

  it('a paused sequence sends nothing, and the scheduler ignores it', async () => {
    const s = await drip();
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.dripSequence.update({ where: { id: s.sequenceId }, data: { status: 'paused' } }),
    );
    await runDripBatch(s.deps, s.orgId, s.sequenceId);
    expect(s.sends()).toBe(0);
    const targets = await dripTargets({ db: client });
    expect(targets.map((t) => t.sequence_id)).not.toContain(s.sequenceId);
  });

  it('the scheduler finds what is due', async () => {
    const s = await drip();
    const targets = await dripTargets({ db: client });
    expect(targets).toContainEqual({ org_id: s.orgId, sequence_id: s.sequenceId });
  });
});

describe('acceptance: a 10k campaign', () => {
  it('finishes with correct counts and ledger totals, and the inbox stays responsive', async () => {
    const TOTAL = 10_000;
    const OPTED_OUT = 100;
    const s = await setup({ contacts: TOTAL, balance: 20_000 * RATE });
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.updateMany({
        where: { waId: { in: Array.from({ length: OPTED_OUT }, (_, i) => waIdFor(i)) } },
        data: { optInStatus: 'opted_out' },
      }),
    );

    // Every 100th send fails, so refunds are part of the totals.
    let calls = 0;
    s.fake.respondWith(() =>
      ++calls % 100 === 0
        ? { data: null, error: metaError({ retryable: false }) }
        : { data: { messageId: `wamid.${randomUUID()}`, waId: '1' }, error: null },
    );

    // Inbox traffic on the same number, while the campaign runs. The campaign has its own queue,
    // so what shows here is whether the database work leaves room for it.
    const conversationId = await withTenant(client, { orgId: s.orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId: s.orgId, waId: '14155552671' } });
      const c = await tx.conversation.create({
        data: { orgId: s.orgId, phoneId: s.number.id, contactId: contact.id },
      });
      return c.id;
    });
    const latencies: number[] = [];
    let running = true;
    const inbox = (async () => {
      while (running) {
        const started = Date.now();
        await processMessagesChange(s.deps, s.orgId, s.inbound('14155552671', 'Still there?'));
        const messageId = randomUUID();
        const createdAt = new Date();
        await withTenant(client, { orgId: s.orgId }, (tx) =>
          tx.message.create({
            data: {
              id: messageId,
              createdAt,
              orgId: s.orgId,
              conversationId,
              direction: 'outbound',
              type: 'text',
              status: 'queued',
              body: 'Yes, how can I help?',
            },
          }),
        );
        await sendOutboundMessage(
          s.deps,
          { orgId: s.orgId, messageId, createdAt: createdAt.toISOString() },
          { finalAttempt: true },
        );
        latencies.push(Date.now() - started);
        await new Promise((r) => setTimeout(r, 100));
      }
    })();

    const started = Date.now();
    const outcome = await s.runAll();
    const elapsed = Date.now() - started;
    running = false;
    await inbox;
    // The inbox's own sends are also fake failures sometimes, which is fine here: they are free.

    expect(outcome).toBe('finished');
    const sendable = TOTAL - OPTED_OUT;
    const counts = await s.counts();
    // The inbox probe's contact is in the audience too, with no consent, so it is skipped.
    expect(counts.total).toBe(TOTAL + 1);
    expect(counts.skipped).toBe(OPTED_OUT + 1);
    expect(counts.pending + counts.sending).toBe(0);
    expect(counts.sent + counts.failed).toBe(sendable);
    expect(counts.failed).toBeGreaterThan(0);

    // The money, three ways: the report, the wallet, and the ledger itself.
    const expected = counts.sent * RATE;
    expect(await s.cost()).toBe(expected);
    const wallet = await s.wallet();
    expect(Number(wallet.balanceMicros)).toBe(20_000 * RATE - expected);
    expect(Number(wallet.reservedMicros)).toBe(0);
    const ledger = await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.walletLedger.aggregate({ where: { orgId: s.orgId }, _sum: { amountMicros: true } }),
    );
    expect(Number(ledger._sum.amountMicros)).toBe(Number(wallet.balanceMicros));

    // Nobody got it twice.
    const dupes = await owner.$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM (
        SELECT contact_id FROM campaign_recipients
         WHERE campaign_id = ${s.campaignId}::uuid GROUP BY contact_id HAVING COUNT(*) > 1
      ) d`;
    expect(Number(dupes[0]?.n)).toBe(0);

    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)] ?? 0;
    const worst = latencies.at(-1) ?? 0;
    writeSync(
      2,
      `10k campaign: ${Math.round(elapsed / 1000)} s; ${latencies.length} inbox round trips during it, ` +
        `median ${latencies[latencies.length >> 1]} ms, p95 ${p95} ms, worst ${worst} ms`,
    );
    expect(latencies.length).toBeGreaterThan(20);
    expect(p95).toBeLessThan(5_000);
  }, 1_500_000);
});
