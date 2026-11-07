/** Outgoing webhooks on real Postgres: events, signing, retries, and the safety of the HTTP call. */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type DbClient, emitWebhookEvent, withTenant } from '@wacrm/db';
import { WEBHOOK_MAX_ATTEMPTS, type WebhookEventType } from '@wacrm/shared';
import { verifyWebhookSignature, webhookSecretAad } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import {
  createWebhookPoster,
  deliverWebhook,
  dueWebhookDeliveries,
} from '../src/processors/webhook-deliveries';
import { buildDeps, connectNumber, createOrg, db, metaError } from './support';

let client: DbClient;
const SECRET = 'whsec_test_secret';

beforeAll(() => {
  client = db();
});
afterAll(async () => {
  await client.$disconnect();
});

async function setup(events: WebhookEventType[] = ['message.received']) {
  const orgId = await createOrg(client);
  const built = buildDeps(client);
  const number = await connectNumber(client, orgId);
  const endpointId = randomUUID();
  await withTenant(client, { orgId }, (tx) =>
    tx.webhookEndpoint.create({
      data: {
        id: endpointId,
        orgId,
        url: 'https://example.com/hook',
        events,
        secretEnc: built.deps.secrets.encrypt(SECRET, webhookSecretAad(endpointId)),
      },
    }),
  );
  const deliveries = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.webhookDelivery.findMany({ orderBy: { createdAt: 'asc' } }),
    );
  const deliver = (deliveryId: string) => deliverWebhook(built.deps, { orgId, deliveryId });
  const emit = async () => {
    await withTenant(client, { orgId }, (tx) =>
      emitWebhookEvent(tx, orgId, events[0]!, { hello: 'world' }),
    );
    const [row] = await deliveries();
    return row!;
  };
  /** Makes a pending retry due now, as time passing would. */
  const due = (id: string) =>
    withTenant(client, { orgId }, (tx) =>
      tx.webhookDelivery.update({ where: { id }, data: { nextAttemptAt: new Date() } }),
    );
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
              contacts: [{ profile: { name: 'Priya' }, wa_id: from }],
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
  return { orgId, endpointId, number, deliveries, deliver, emit, due, inbound, ...built };
}

describe('delivering', () => {
  it('posts the event, signed, and records it', async () => {
    const s = await setup();
    const row = await s.emit();
    expect(await s.deliver(row.id)).toBe('delivered');

    const [sent] = s.webhooks;
    expect(sent!.url).toBe('https://example.com/hook');
    expect(JSON.parse(sent!.body)).toMatchObject({
      id: row.eventId,
      type: 'message.received',
      data: { hello: 'world' },
    });
    expect(sent!.headers['x-wacrm-event']).toBe('message.received');
    expect(sent!.headers['x-wacrm-event-id']).toBe(row.eventId);
    expect(verifyWebhookSignature(SECRET, sent!.body, sent!.headers['x-wacrm-signature'])).toBe(
      true,
    );

    const [after] = await s.deliveries();
    expect(after).toMatchObject({
      status: 'delivered',
      attempts: 1,
      responseStatus: 200,
      responseBody: 'ok',
      nextAttemptAt: null,
      error: null,
    });
    expect(after!.deliveredAt).toBeInstanceOf(Date);
  });

  it('is not sent twice when two jobs race', async () => {
    const s = await setup();
    const row = await s.emit();
    const results = await Promise.all([s.deliver(row.id), s.deliver(row.id), s.deliver(row.id)]);
    expect(results.filter((r) => r === 'delivered')).toHaveLength(1);
    expect(s.webhooks).toHaveLength(1);
  });

  it('a finished delivery is left alone', async () => {
    const s = await setup();
    const row = await s.emit();
    await s.deliver(row.id);
    await s.due(row.id);
    expect(await s.deliver(row.id)).toBe('skipped');
    expect(s.webhooks).toHaveLength(1);
  });

  it('shows up as due, and stops being due while it is being worked on', async () => {
    const s = await setup();
    const row = await s.emit();
    const ids = async () => (await dueWebhookDeliveries({ db: client })).map((d) => d.id);
    expect(await ids()).toContain(row.id);
    await s.deliver(row.id);
    expect(await ids()).not.toContain(row.id);
  });
});

describe('retries', () => {
  it('backs off on a bad answer, keeping the event id, then succeeds', async () => {
    const s = await setup();
    const row = await s.emit();
    s.respondToWebhooks(() => ({ status: 500, body: 'oops' }));
    expect(await s.deliver(row.id)).toBe('retrying');
    const [first] = await s.deliveries();
    expect(first).toMatchObject({
      status: 'pending',
      attempts: 1,
      responseStatus: 500,
      responseBody: 'oops',
      error: 'The endpoint answered 500',
    });
    const wait = first!.nextAttemptAt!.getTime() - Date.now();
    expect(wait).toBeGreaterThan(25_000);
    expect(wait).toBeLessThan(31_000);

    // Not due yet, so nothing happens.
    expect(await s.deliver(row.id)).toBe('skipped');

    await s.due(row.id);
    s.respondToWebhooks(() => ({ status: 204, body: '' }));
    expect(await s.deliver(row.id)).toBe('delivered');
    expect(s.webhooks[0]!.headers['x-wacrm-event-id']).toBe(
      s.webhooks[1]!.headers['x-wacrm-event-id'],
    );
    expect((await s.deliveries())[0]).toMatchObject({
      status: 'delivered',
      attempts: 2,
      error: null,
    });
  });

  it('each retry waits longer', async () => {
    const s = await setup();
    const row = await s.emit();
    s.respondToWebhooks(() => ({ status: 503, body: '' }));
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      await s.deliver(row.id);
      waits.push((await s.deliveries())[0]!.nextAttemptAt!.getTime() - Date.now());
      await s.due(row.id);
    }
    expect(waits[1]).toBeGreaterThan(waits[0]!);
    expect(waits[2]).toBeGreaterThan(waits[1]!);
  });

  it('a network error retries too, and records why', async () => {
    const s = await setup();
    const row = await s.emit();
    s.deps.postWebhook = async () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(await s.deliver(row.id)).toBe('retrying');
    expect((await s.deliveries())[0]).toMatchObject({
      status: 'pending',
      responseStatus: null,
      error: 'connect ECONNREFUSED',
    });
  });

  it('a redirect is a failure rather than being followed', async () => {
    const s = await setup();
    const row = await s.emit();
    s.respondToWebhooks(() => ({ status: 302, body: '' }));
    expect(await s.deliver(row.id)).toBe('retrying');
  });

  it('gives up after the last attempt', async () => {
    const s = await setup();
    const row = await s.emit();
    s.respondToWebhooks(() => ({ status: 500, body: '' }));
    let result = '';
    for (let i = 0; i < WEBHOOK_MAX_ATTEMPTS; i++) {
      result = await s.deliver(row.id);
      if (result === 'retrying') await s.due(row.id);
    }
    expect(result).toBe('failed');
    expect(s.webhooks).toHaveLength(WEBHOOK_MAX_ATTEMPTS);
    expect((await s.deliveries())[0]).toMatchObject({
      status: 'failed',
      attempts: WEBHOOK_MAX_ATTEMPTS,
      nextAttemptAt: null,
    });
  });

  it('an endpoint switched off meanwhile does not receive it', async () => {
    const s = await setup();
    const row = await s.emit();
    await withTenant(client, { orgId: s.orgId }, (tx) =>
      tx.webhookEndpoint.update({ where: { id: s.endpointId }, data: { active: false } }),
    );
    expect(await s.deliver(row.id)).toBe('failed');
    expect(s.webhooks).toEqual([]);
  });
});

describe('events come from what really happens', () => {
  it('an inbound message, once, even when Meta redelivers it', async () => {
    const s = await setup(['message.received', 'contact.created']);
    const payload = s.inbound('919876543210', 'Hello there');
    await processMessagesChange(s.deps, s.orgId, payload);
    await processMessagesChange(s.deps, s.orgId, payload);
    const rows = await s.deliveries();
    expect(rows.map((r) => r.eventType).sort()).toEqual(['contact.created', 'message.received']);
    const received = rows.find((r) => r.eventType === 'message.received');
    expect(received!.payload).toMatchObject({
      data: {
        message: { direction: 'inbound', type: 'text', body: 'Hello there' },
        contact: { waId: '919876543210', name: 'Priya' },
      },
    });
  });

  it('a known contact writing again is not created again', async () => {
    const s = await setup(['contact.created']);
    await processMessagesChange(s.deps, s.orgId, s.inbound('919876543210', 'One'));
    await processMessagesChange(s.deps, s.orgId, s.inbound('919876543210', 'Two'));
    expect(await s.deliveries()).toHaveLength(1);
  });

  it('STOP reports the opt-out', async () => {
    const s = await setup(['contact.opted_out']);
    await processMessagesChange(s.deps, s.orgId, s.inbound('919876543210', 'STOP'));
    await processMessagesChange(s.deps, s.orgId, s.inbound('919876543210', 'STOP'));
    expect((await s.deliveries()).map((r) => r.eventType)).toEqual(['contact.opted_out']);
  });

  async function queuedText(s: Awaited<ReturnType<typeof setup>>) {
    const { orgId } = s;
    const messageId = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId }, async (tx) => {
      const contact = await tx.contact.create({ data: { orgId, waId: '14155552671' } });
      const c = await tx.conversation.create({
        data: { orgId, phoneId: s.number.id, contactId: contact.id },
      });
      await tx.message.create({
        data: {
          id: messageId,
          createdAt,
          orgId,
          conversationId: c.id,
          direction: 'outbound',
          type: 'text',
          status: 'queued',
          body: 'Hi',
        },
      });
    });
    return { orgId, messageId, createdAt: createdAt.toISOString() };
  }

  it('a send reports sent', async () => {
    const s = await setup(['message.status']);
    await sendOutboundMessage(s.deps, await queuedText(s), { finalAttempt: true });
    expect((await s.deliveries())[0]!.payload).toMatchObject({
      data: { message: { status: 'sent', direction: 'outbound' } },
    });
  });

  it('a refused send reports failed', async () => {
    const s = await setup(['message.status']);
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: false }) }));
    await sendOutboundMessage(s.deps, await queuedText(s), { finalAttempt: true });
    expect((await s.deliveries())[0]!.payload).toMatchObject({
      data: { message: { status: 'failed' } },
    });
  });

  it('a workspace with no endpoints pays no cost and writes nothing', async () => {
    const orgId = await createOrg(client);
    const built = buildDeps(client);
    const number = await connectNumber(client, orgId);
    await processMessagesChange(built.deps, orgId, {
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
                contacts: [{ profile: { name: 'A' }, wa_id: '14155552671' }],
                messages: [
                  {
                    from: '14155552671',
                    id: `wamid.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Hi' },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const count = await withTenant(client, { orgId }, (tx) => tx.webhookDelivery.count());
    expect(count).toBe(0);
  });
});

describe('the real HTTP call', () => {
  let server: Server;
  let base: string;
  const requests: { headers: Record<string, unknown>; body: string }[] = [];
  let redirect = false;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        requests.push({ headers: req.headers, body });
        if (redirect) {
          res.writeHead(302, { location: `${base}/elsewhere` });
          res.end();
          return;
        }
        res.writeHead(200);
        res.end('x'.repeat(5000));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server.close();
  });

  const allowed = createWebhookPoster({ allowPrivate: true });
  const guarded = createWebhookPoster({ allowPrivate: false });

  it('sends the body and headers, and keeps only a little of the answer', async () => {
    const res = await allowed(`${base}/hook`, { 'x-test': 'yes' }, '{"a":1}');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(1024);
    expect(requests.at(-1)).toMatchObject({ body: '{"a":1}', headers: { 'x-test': 'yes' } });
  });

  it('does not follow a redirect', async () => {
    redirect = true;
    const before = requests.length;
    const res = await allowed(`${base}/hook`, {}, '{}');
    redirect = false;
    expect(res.status).toBe(302);
    expect(requests.length).toBe(before + 1);
  });

  it('refuses an address that is private, as a literal', async () => {
    const before = requests.length;
    await expect(guarded(`${base}/hook`, {}, '{}')).rejects.toThrow('not reachable');
    await expect(guarded('http://169.254.169.254/x', {}, '{}')).rejects.toThrow('not reachable');
    expect(requests.length).toBe(before);
  });

  it('refuses a name that resolves to a private address, when connecting', async () => {
    const port = new URL(base).port;
    const before = requests.length;
    await expect(guarded(`http://localhost:${port}/hook`, {}, '{}')).rejects.toThrow(
      'not reachable',
    );
    expect(requests.length).toBe(before);
  });
});
