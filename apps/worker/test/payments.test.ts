/**
 * Phase 3.6 on real Postgres. The acceptance: a flow sends a payment link and reacts to the paid
 * event. An order makes a Razorpay link and sends it; paying it stops the reminders and starts a
 * thank-you flow; a link left unpaid gets its reminder. Also the repeat-safe reference and Stripe's
 * setup keeping the signing secret it made.
 */
import { randomUUID } from 'node:crypto';
import { paymentReference } from '@wacrm/connectors';
import { creditWallet, type DbClient, ensureWallet, type Prisma, withTenant } from '@wacrm/db';
import { flowDefinitionSchema, type FlowDefinitionInput, type FlowJob } from '@wacrm/shared';
import { integrationCredentialsAad } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFlowJob, wakeRun } from '../src/processors/flows';
import {
  decryptCredentials,
  processIntegrationEvent,
  setupConnection,
} from '../src/processors/integrations';
import { buildDeps, connectNumber, createOrg, db, metaId, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;

beforeAll(async () => {
  client = db();
  owner = ownerDb();
  await owner.rateCard.createMany({
    data: ['marketing', 'utility'].map((category) => ({
      country: '*',
      category,
      currency: 'XCP',
      rateMicros: BigInt(500_000),
      validFrom: new Date('2026-01-01'),
    })),
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await client.$disconnect();
  await owner.$disconnect();
});

const LINK = {
  id: 'plink_77',
  amount: 49900,
  currency: 'INR',
  status: 'created',
  short_url: 'https://rzp.io/i/pay77',
  description: 'Order #1001',
  customer: { contact: '+919800070001' },
};

async function setup() {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  const built = buildDeps(client);
  const http: { method: string; url: string; headers?: Record<string, string>; body?: string }[] =
    [];
  const replies: { match: RegExp; status: number; json: unknown }[] = [];
  built.deps.httpRequest = async (req) => {
    http.push({ method: req.method, url: req.url, headers: req.headers, body: req.body });
    const r = replies.find((x) => x.match.test(`${req.method} ${req.url}`));
    return {
      status: r?.status ?? 200,
      body: JSON.stringify(r?.json ?? {}),
      contentType: 'application/json',
    };
  };

  const templates = await withTenant(client, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, 'XCP');
    await creditWallet(tx, { orgId, amountMicros: 100_000_000, idempotencyKey: 'seed' });
    const phone = await tx.phoneNumber.findUniqueOrThrow({ where: { id: number.id } });
    const make = (name: string, body: string) =>
      tx.messageTemplate.create({
        data: {
          orgId,
          wabaAccountId: phone.wabaAccountId,
          name,
          language: 'en',
          category: 'UTILITY',
          status: 'approved',
          metaTemplateId: metaId(),
          definition: { header: null, body, footer: null, buttons: [] },
        },
      });
    return {
      link: await make('payment_link', 'Pay {{1}} for {{2}} here: {{3}}'),
      reminder: await make('payment_reminder', 'Reminder: your link {{1}} is waiting'),
      thanks: await make('payment_thanks', 'Thank you, we received {{1}} {{2}}'),
      text: await make('note_text', '{{1}}'),
    };
  });

  const connect = async (
    connectorKey: string,
    settings: Record<string, string>,
    credentials: Record<string, string>,
  ) => {
    const id = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.integrationConnection.create({
        data: {
          id,
          orgId,
          connectorKey,
          name: connectorKey,
          settings,
          webhookToken: randomUUID().replace(/-/g, ''),
          credentialsEnc: built.deps.secrets.encrypt(
            JSON.stringify(credentials),
            integrationCredentialsAad(id),
          ),
        },
      }),
    );
    return id;
  };

  const drain = async () => {
    for (let i = 0; i < 50 && built.flowJobs.length; i++) {
      const { job } = built.flowJobs.shift() as { job: FlowJob };
      await processFlowJob(built.deps, job);
    }
  };

  const deliver = async (connectionId: string, headers: Record<string, string>, body: unknown) => {
    const eventId = randomUUID();
    await withTenant(client, { orgId }, (tx) =>
      tx.integrationEvent.create({
        data: {
          id: eventId,
          orgId,
          connectionId,
          direction: 'inbound',
          dedupeKey: randomUUID(),
          status: 'received',
          payload: { body, headers, via: 'webhook' } as Prisma.InputJsonValue,
        },
      }),
    );
    const outcome = await processIntegrationEvent(built.deps, orgId, eventId);
    await drain();
    return outcome;
  };

  const flow = async (def: FlowDefinitionInput) => {
    const definition = flowDefinitionSchema.parse(def);
    const flowId = randomUUID();
    const versionId = randomUUID();
    await withTenant(client, { orgId }, async (tx) => {
      await tx.flow.create({
        data: {
          id: flowId,
          orgId,
          name: 'f',
          draft: definition as object,
          active: true,
          triggerType: definition.trigger.type,
          trigger: definition.trigger as object,
        },
      });
      await tx.flowVersion.create({
        data: { id: versionId, orgId, flowId, version: 1, definition: definition as object },
      });
      await tx.flow.update({ where: { id: flowId }, data: { publishedVersionId: versionId } });
    });
    return flowId;
  };

  const sent = async () =>
    (
      await withTenant(client, { orgId }, (tx) =>
        tx.message.findMany({
          where: { direction: 'outbound', type: 'template' },
          orderBy: { createdAt: 'asc' },
          select: { body: true },
        }),
      )
    ).map((m) => m.body);

  const passTime = async () => {
    await owner.flowRun.updateMany({
      where: { orgId, status: 'waiting' },
      data: { wakeAt: new Date(Date.now() - 1000) },
    });
    const runs = await withTenant(client, { orgId }, (tx) =>
      tx.flowRun.findMany({ where: { status: 'waiting' }, select: { id: true } }),
    );
    for (const r of runs) await wakeRun(built.deps, orgId, r.id);
    await drain();
  };

  const runs = () =>
    withTenant(client, { orgId }, (tx) =>
      tx.flowRun.findMany({
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          flowId: true,
          status: true,
          endReason: true,
          trigger: true,
          variables: true,
        },
      }),
    );

  return { orgId, built, templates, connect, deliver, flow, sent, passTime, runs, http, replies };
}

type T = Awaited<ReturnType<typeof setup>>;

/** An order arrives from the store; the flow makes a link, sends it, waits, and reminds once. */
async function paymentFlows(t: T) {
  const send = (templateId: string, variables: Record<string, string>) => ({
    type: 'send_template' as const,
    data: { templateId, variables },
  });
  const linkFlow = await t.flow({
    trigger: { type: 'integration_event', connector: 'custom_store', event: 'order.created' },
    startNodeId: 'pay',
    nodes: [
      {
        id: 'pay',
        type: 'integration_action',
        data: {
          connector: 'razorpay',
          action: 'create_payment_link',
          input: {
            amount: '{{trigger.data.order.total}}',
            description: 'Order {{trigger.data.order.name}}',
            phone: '{{contact.phone}}',
          },
          saveResponse: { link: 'url', link_id: 'linkId' },
        },
      },
      {
        id: 'send',
        ...send(t.templates.link.id, {
          'body.1': '{{trigger.data.order.total}}',
          'body.2': '{{trigger.data.order.name}}',
          'body.3': '{{vars.link}}',
        }),
      },
      { id: 'wait', type: 'delay', data: { amount: 2, unit: 'hours' } },
      { id: 'remind', ...send(t.templates.reminder.id, { 'body.1': '{{vars.link}}' }) },
      {
        id: 'failed',
        ...send(t.templates.text.id, { 'body.1': 'We could not make a payment link' }),
      },
    ],
    edges: [
      { id: 'e1', source: 'pay', sourceHandle: 'success', target: 'send' },
      { id: 'e2', source: 'pay', sourceHandle: 'failure', target: 'failed' },
      { id: 'e3', source: 'send', sourceHandle: 'next', target: 'wait' },
      { id: 'e4', source: 'wait', sourceHandle: 'next', target: 'remind' },
    ],
  });
  const thanksFlow = await t.flow({
    trigger: { type: 'integration_event', connector: 'razorpay', event: 'payment.paid' },
    startNodeId: 'thanks',
    nodes: [
      {
        id: 'thanks',
        ...send(t.templates.thanks.id, {
          'body.1': '{{trigger.data.payment.currency}}',
          'body.2': '{{trigger.data.payment.amount}}',
        }),
      },
    ],
  });
  const store = await t.connect('custom_store', {}, { webhookSecret: 's' });
  const rzp = await t.connect(
    'razorpay',
    { defaultCurrency: 'INR' },
    {
      keyId: 'rzp_test_1',
      keySecret: 'k',
      webhookSecret: 'w',
    },
  );
  const order = (id: string, phone: string) => ({
    event: 'order.created',
    id,
    customer: { phone, name: 'Asha' },
    data: { order: { name: '#1001', total: '499.00' } },
  });
  return { linkFlow, thanksFlow, store, rzp, order };
}

const paidWebhook = (link: typeof LINK) => ({
  event: 'payment_link.paid',
  payload: {
    payment_link: { entity: { ...link, status: 'paid' } },
    payment: { entity: { id: 'pay_1', amount: link.amount, currency: 'INR', method: 'upi' } },
  },
});

describe('payment links in a flow', () => {
  it('sends the link, and paying it stops the reminders and starts the thank-you', async () => {
    const t = await setup();
    t.replies.push({
      match: /POST https:\/\/api\.razorpay\.com\/v1\/payment_links$/,
      status: 200,
      json: LINK,
    });
    const p = await paymentFlows(t);

    await t.deliver(p.store, {}, p.order('o-1', '+919800070001'));
    expect(await t.sent()).toEqual(['Pay 499.00 for #1001 here: https://rzp.io/i/pay77']);
    const [run] = await t.runs();
    expect(run).toMatchObject({
      status: 'waiting',
      variables: { link: 'https://rzp.io/i/pay77', link_id: 'plink_77' },
    });
    expect((run!.trigger as { correlations: string[] }).correlations).toEqual([
      'payment:razorpay:plink_77',
    ]);

    // The link was made once, for the contact, with a reference tied to this step of this run.
    const made = t.http.filter((h) => h.method === 'POST');
    expect(made).toHaveLength(1);
    const body = JSON.parse(made[0]!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      amount: 49900,
      currency: 'INR',
      customer: { contact: '+919800070001' },
    });
    expect(body.reference_id).toBe(paymentReference(`flow:${run!.id}:pay:0`));

    // Razorpay reports the payment.
    await t.deliver(p.rzp, { 'x-razorpay-event-id': 'evt_1' }, paidWebhook(LINK));
    await t.passTime();
    expect(await t.sent()).toEqual([
      'Pay 499.00 for #1001 here: https://rzp.io/i/pay77',
      'Thank you, we received INR 499.00',
    ]);
    const after = await t.runs();
    expect(after.map((r) => [r.flowId, r.status, r.endReason])).toEqual([
      [p.linkFlow, 'cancelled', 'cancelled_by_event'],
      [p.thanksFlow, 'completed', 'end'],
    ]);

    // The same payment reported again changes nothing.
    await t.deliver(p.rzp, { 'x-razorpay-event-id': 'evt_2' }, paidWebhook(LINK));
    expect(await t.sent()).toHaveLength(2);
  });

  it('a link left unpaid gets its reminder; a failed link takes the failure exit', async () => {
    const t = await setup();
    t.replies.push({ match: /POST https:\/\/api\.razorpay\.com/, status: 200, json: LINK });
    const p = await paymentFlows(t);
    await t.deliver(p.store, {}, p.order('o-2', '+919800070001'));
    await t.passTime();
    expect(await t.sent()).toEqual([
      'Pay 499.00 for #1001 here: https://rzp.io/i/pay77',
      'Reminder: your link https://rzp.io/i/pay77 is waiting',
    ]);

    const t2 = await setup();
    t2.replies.push({
      match: /POST https:\/\/api\.razorpay\.com/,
      status: 400,
      json: { error: { description: 'The amount must be at least INR 1.00' } },
    });
    const p2 = await paymentFlows(t2);
    await t2.deliver(p2.store, {}, p2.order('o-3', '+919800070002'));
    expect(await t2.sent()).toEqual(['We could not make a payment link']);
    const log = await withTenant(client, { orgId: t2.orgId }, (tx) =>
      tx.integrationEvent.findFirstOrThrow({ where: { direction: 'outbound' } }),
    );
    expect(log).toMatchObject({ status: 'failed', error: 'The amount must be at least INR 1.00' });
  });
});

describe('Stripe setup', () => {
  it('registers the webhook and keeps the signing secret Stripe made, encrypted', async () => {
    const t = await setup();
    t.replies.push(
      {
        match: /GET https:\/\/api\.stripe\.com\/v1\/webhook_endpoints/,
        status: 200,
        json: { data: [] },
      },
      {
        match: /POST https:\/\/api\.stripe\.com\/v1\/webhook_endpoints/,
        status: 200,
        json: { id: 'we_1', secret: 'whsec_made' },
      },
    );
    const conn = await t.connect(
      'stripe',
      { returnUrl: 'https://shop.example/ok' },
      { secretKey: 'sk_test' },
    );
    expect(await setupConnection(t.built.deps, t.orgId, conn)).toBe('done');
    const row = await owner.integrationConnection.findUniqueOrThrow({ where: { id: conn } });
    expect(row.credentialsEnc).not.toContain('whsec_made');
    expect(decryptCredentials(t.built.deps, conn, row.credentialsEnc)).toEqual({
      secretKey: 'sk_test',
      webhookSecret: 'whsec_made',
    });
    const form = new URLSearchParams(t.http.at(-1)!.body!);
    expect(form.get('url')).toBe(`https://api.crm.test/integrations/hooks/${row.webhookToken}`);
  });
});
