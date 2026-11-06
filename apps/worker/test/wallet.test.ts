/** Refunds in the send and status paths. */
import { randomUUID } from 'node:crypto';
import { creditWallet, debitWallet, type DbClient, ensureWallet, withTenant } from '@wacrm/db';
import { messageDebitKey } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import { buildDeps, connectNumber, createOrg, db, metaError } from './support';

let client: DbClient;

beforeAll(() => {
  client = db();
});
afterAll(async () => {
  await client.$disconnect();
});

/** A template message already charged for, as the API leaves it. */
async function charged(opts: { status?: 'queued' | 'sending' | 'sent' } = {}) {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  const built = buildDeps(client);
  const messageId = randomUUID();
  const createdAt = new Date();
  await withTenant(client, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, 'XTS');
    await creditWallet(tx, { orgId, amountMicros: 5_000_000, idempotencyKey: 'seed' });
    const contact = await tx.contact.create({
      data: { orgId, waId: '919876543210', optInStatus: 'opted_in' },
    });
    const conversation = await tx.conversation.create({
      data: { orgId, phoneId: number.id, contactId: contact.id },
    });
    await debitWallet(tx, {
      orgId,
      amountMicros: 1_000_000,
      referenceType: 'message',
      referenceId: messageId,
      idempotencyKey: messageDebitKey(messageId),
      rate: { rateCardId: null, rateMicros: 1_000_000, country: 'IN', category: 'marketing' },
    });
    await tx.message.create({
      data: {
        id: messageId,
        createdAt,
        orgId,
        conversationId: conversation.id,
        direction: 'outbound',
        type: 'template',
        status: opts.status ?? 'queued',
        content: {
          templateName: 'promo',
          language: 'en',
          components: [],
          category: 'MARKETING',
        },
      },
    });
  });
  const balance = () =>
    withTenant(client, { orgId }, async (tx) => {
      const w = await tx.wallet.findFirstOrThrow();
      return Number(w.balanceMicros);
    });
  const refunds = () =>
    withTenant(client, { orgId }, (tx) => tx.walletLedger.findMany({ where: { type: 'refund' } }));
  const job = { orgId, messageId, createdAt: createdAt.toISOString() };

  const status = (over: Record<string, unknown>) => ({
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
                  recipient_id: '919876543210',
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
  return { orgId, job, balance, refunds, status, ...built };
}

describe('refunds when sending fails', () => {
  it('refunds an error Meta will not retry', async () => {
    const s = await charged();
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: false }) }));
    expect(await sendOutboundMessage(s.deps, s.job, { finalAttempt: false })).toBe('failed');
    expect(await s.balance()).toBe(5_000_000);
    const [refund] = await s.refunds();
    expect(Number(refund?.amountMicros)).toBe(1_000_000);
    expect(refund).toMatchObject({ category: 'marketing', referenceId: s.job.messageId });
    expect(s.publisher.of('wallet:updated')).toHaveLength(1);
  });

  it('keeps the charge while a retry is still coming, and refunds on the last attempt', async () => {
    const s = await charged();
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: true }) }));
    await expect(sendOutboundMessage(s.deps, s.job, { finalAttempt: false })).rejects.toThrow();
    expect(await s.balance()).toBe(4_000_000);
    await sendOutboundMessage(s.deps, s.job, { finalAttempt: true });
    expect(await s.balance()).toBe(5_000_000);
  });

  it('refunds a send interrupted by a crash, which is marked failed', async () => {
    const s = await charged({ status: 'sending' });
    await sendOutboundMessage(s.deps, s.job, { finalAttempt: false });
    expect(await s.balance()).toBe(5_000_000);
  });

  it('refunds marketing refused at send time, after the contact opted out', async () => {
    const s = await charged();
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.contact.updateMany({ data: { optInStatus: 'opted_out' } }),
    );
    expect(await sendOutboundMessage(s.deps, s.job, { finalAttempt: true })).toBe('failed');
    expect(await s.balance()).toBe(5_000_000);
    expect(s.fake.calls).toEqual([]);
  });

  it('a successful send keeps the charge', async () => {
    const s = await charged();
    expect(await sendOutboundMessage(s.deps, s.job, { finalAttempt: true })).toBe('sent');
    expect(await s.balance()).toBe(4_000_000);
    expect(await s.refunds()).toEqual([]);
  });
});

describe('refunds from status webhooks', () => {
  it('refunds a delivery failure once, even when Meta repeats it', async () => {
    const s = await charged({ status: 'sent' });
    const failed = s.status({
      status: 'failed',
      errors: [{ code: 131026, title: 'Undeliverable' }],
    });
    await processMessagesChange(s.deps, s.orgId, failed);
    await processMessagesChange(s.deps, s.orgId, failed);
    expect(await s.balance()).toBe(5_000_000);
    expect(await s.refunds()).toHaveLength(1);
  });

  it('refunds what Meta says it did not bill', async () => {
    const s = await charged({ status: 'sent' });
    const pricing = { billable: false, category: 'service', type: 'free_customer_service' };
    await processMessagesChange(s.deps, s.orgId, s.status({ status: 'delivered', pricing }));
    await processMessagesChange(s.deps, s.orgId, s.status({ status: 'read', pricing }));
    expect(await s.balance()).toBe(5_000_000);
    expect(await s.refunds()).toHaveLength(1);
    expect((await s.refunds())[0]?.description).toContain('Not billed');
  });

  it('keeps the charge when Meta bills it', async () => {
    const s = await charged({ status: 'sent' });
    const pricing = { billable: true, category: 'marketing', type: 'regular' };
    await processMessagesChange(s.deps, s.orgId, s.status({ status: 'delivered', pricing }));
    expect(await s.balance()).toBe(4_000_000);
  });

  it('applies even if statuses arrive out of order', async () => {
    const s = await charged({ status: 'sent' });
    await processMessagesChange(s.deps, s.orgId, s.status({ status: 'read' }));
    await processMessagesChange(
      s.deps,
      s.orgId,
      s.status({ status: 'delivered', pricing: { billable: false } }),
    );
    expect(await s.balance()).toBe(5_000_000);
  });

  it('a status for a free send changes nothing', async () => {
    const orgId = await createOrg(client);
    const { deps } = buildDeps(client);
    const number = await connectNumber(client, orgId);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: number.wabaId,
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: number.phoneNumberId },
                statuses: [
                  {
                    id: 'wamid.none',
                    status: 'failed',
                    timestamp: '1793800000',
                    recipient_id: '1',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await expect(processMessagesChange(deps, orgId, payload)).resolves.toBeUndefined();
  });
});
