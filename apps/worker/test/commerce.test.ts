/**
 * Phase 3.5 on real Postgres. The acceptance: a Shopify order sends a WhatsApp order confirmation,
 * and later its shipment sends a shipping update. Also abandoned carts (a reminder the order
 * cancels), consent from checkout, Shopify's privacy webhooks, webhook registration, and
 * WooCommerce. Shopify is played by the injected HTTP client; payloads follow Shopify's docs.
 */
import { randomUUID } from 'node:crypto';
import { creditWallet, type DbClient, ensureWallet, type Prisma, withTenant } from '@wacrm/db';
import { flowDefinitionSchema, type FlowDefinitionInput, type FlowJob } from '@wacrm/shared';
import { integrationCredentialsAad } from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processFlowJob, wakeRun } from '../src/processors/flows';
import { processIntegrationEvent, setupConnection } from '../src/processors/integrations';
import { buildDeps, connectNumber, createOrg, db, metaId, ownerDb } from './support';

let client: DbClient;
let owner: DbClient;
const SHOP = 'chai-house.myshopify.com';

beforeAll(async () => {
  client = db();
  owner = ownerDb();
  await owner.rateCard.createMany({
    data: ['marketing', 'utility'].map((category) => ({
      country: '*',
      category,
      currency: 'XCM',
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

const order = (over: Record<string, unknown> = {}) => ({
  id: 5550001,
  name: '#1001',
  order_number: 1001,
  email: 'asha@example.com',
  currency: 'INR',
  total_price: '1499.00',
  financial_status: 'paid',
  checkout_token: 'cart-1',
  line_items: [{ title: 'Masala chai', quantity: 2, price: '499.00' }],
  customer: {
    id: 77,
    first_name: 'Asha',
    last_name: 'Rao',
    phone: '+91 98000 70001',
    sms_marketing_consent: { state: 'subscribed', consent_updated_at: '2026-11-11T09:00:00Z' },
  },
  ...over,
});

async function setup() {
  const orgId = await createOrg(client);
  const number = await connectNumber(client, orgId);
  const built = buildDeps(client);
  built.deps.env = { SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 'app-secret' };
  const httpCalls: { method: string; url: string; body?: string }[] = [];
  built.deps.httpRequest = async (req) => {
    httpCalls.push({ method: req.method, url: req.url, body: req.body });
    if (req.url.includes('/orders/5550001.json')) {
      return {
        status: 200,
        body: JSON.stringify({ order: order() }),
        contentType: 'application/json',
      };
    }
    return { status: 201, body: '{}', contentType: 'application/json' };
  };

  const templates = await withTenant(client, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, 'XCM');
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
      confirmation: await make(
        'order_confirmation',
        'Hi {{1}}, your order {{2}} is confirmed. Total {{3}}.',
      ),
      shipping: await make('shipping_update', 'Your order {{1}} is on its way: {{2}}'),
      cart: await make('cart_reminder', 'You left something in your cart: {{1}}'),
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

  /** What the API stores for a webhook: the body and the headers it keeps. */
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
    for (let i = 0; i < 50 && built.flowJobs.length; i++) {
      const { job } = built.flowJobs.shift() as { job: FlowJob };
      await processFlowJob(built.deps, job);
    }
    return { eventId, outcome };
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
  };

  return { orgId, number, built, templates, connect, deliver, flow, sent, httpCalls, passTime };
}

const onEvent = (
  connector: string,
  event: string,
  templateId: string,
  variables: Record<string, string>,
) => ({
  trigger: { type: 'integration_event' as const, connector, event },
  startNodeId: 'send',
  nodes: [{ id: 'send', type: 'send_template' as const, data: { templateId, variables } }],
});

describe('Shopify: an order confirmation, then a shipping update', () => {
  it('sends both, from the order and shipment data, to the contact the order made', async () => {
    const t = await setup();
    await t.flow(
      onEvent('shopify', 'order.created', t.templates.confirmation.id, {
        'body.1': '{{trigger.data.order.customer.firstName}}',
        'body.2': '{{trigger.data.order.name}}',
        'body.3': '{{trigger.data.order.total}} {{trigger.data.order.currency}}',
      }),
    );
    await t.flow(
      onEvent('shopify', 'shipment.updated', t.templates.shipping.id, {
        'body.1': '{{trigger.data.order.name}}',
        'body.2': '{{trigger.data.shipment.tracking.url}}',
      }),
    );
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });

    await t.deliver(conn, { 'x-shopify-topic': 'orders/create' }, order());
    expect(await t.sent()).toEqual(['Hi Asha, your order #1001 is confirmed. Total 1499.00 INR.']);

    // Consent given at checkout was recorded, with Shopify's details as proof.
    const contact = await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.contact.findFirstOrThrow({ include: { consentEvents: true } }),
    );
    expect(contact).toMatchObject({
      waId: '919800070001',
      name: 'Asha Rao',
      optInStatus: 'opted_in',
      optInSource: 'shopify_checkout',
    });
    expect(contact.consentEvents).toHaveLength(1);

    await t.deliver(
      conn,
      { 'x-shopify-topic': 'fulfillments/create' },
      {
        id: 901,
        order_id: 5550001,
        status: 'success',
        tracking_number: 'BD1',
        tracking_url: 'https://track.example/BD1',
      },
    );
    expect(await t.sent()).toEqual([
      'Hi Asha, your order #1001 is confirmed. Total 1499.00 INR.',
      'Your order #1001 is on its way: https://track.example/BD1',
    ]);
    expect(
      t.httpCalls.some((c) => c.url === `https://${SHOP}/admin/api/2026-07/orders/5550001.json`),
    ).toBe(true);

    // The same order arriving again (a redelivery under another id) sends nothing more.
    await t.deliver(conn, { 'x-shopify-topic': 'orders/create' }, order());
    expect(await t.sent()).toHaveLength(2);
  });

  it('a consent the customer did not give is not invented, and an opt-out stands', async () => {
    const t = await setup();
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });
    await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.contact.create({
        data: { orgId: t.orgId, waId: '919800070001', optInStatus: 'opted_out' },
      }),
    );
    await t.deliver(conn, { 'x-shopify-topic': 'orders/create' }, order());
    const c = await withTenant(client, { orgId: t.orgId }, (tx) => tx.contact.findFirstOrThrow());
    expect(c.optInStatus).toBe('opted_out');
  });
});

describe('abandoned carts', () => {
  it('a reminder waits, the order cancels it, and a cart left alone gets its reminder', async () => {
    const t = await setup();
    await t.flow({
      trigger: { type: 'integration_event', connector: 'shopify', event: 'checkout.started' },
      startNodeId: 'wait',
      nodes: [
        { id: 'wait', type: 'delay', data: { amount: 1, unit: 'hours' } },
        {
          id: 'remind',
          type: 'send_template',
          data: {
            templateId: t.templates.cart.id,
            variables: { 'body.1': '{{trigger.data.checkout.recoveryUrl}}' },
          },
        },
      ],
      edges: [{ id: 'e', source: 'wait', sourceHandle: 'next', target: 'remind' }],
    });
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });
    const checkout = (token: string, phone: string) => ({
      id: 1,
      token,
      phone,
      total_price: '1499.00',
      currency: 'INR',
      abandoned_checkout_url: `https://chai-house.example/checkouts/${token}/recover`,
      line_items: [{ title: 'Masala chai', quantity: 1, price: '499' }],
    });

    // Bought: the order for cart-1 cancels its reminder.
    await t.deliver(
      conn,
      { 'x-shopify-topic': 'checkouts/update' },
      checkout('cart-1', '+919800070001'),
    );
    await t.deliver(conn, { 'x-shopify-topic': 'orders/create' }, order());
    // Left alone: cart-2's reminder goes out after the delay.
    await t.deliver(
      conn,
      { 'x-shopify-topic': 'checkouts/update' },
      checkout('cart-2', '+919800070002'),
    );
    await t.passTime();

    expect(await t.sent()).toEqual([
      'You left something in your cart: https://chai-house.example/checkouts/cart-2/recover',
    ]);
    const runs = await withTenant(client, { orgId: t.orgId }, (tx) =>
      tx.flowRun.findMany({
        orderBy: { startedAt: 'asc' },
        select: { status: true, endReason: true },
      }),
    );
    expect(runs).toEqual([
      { status: 'cancelled', endReason: 'cancelled_by_event' },
      { status: 'completed', endReason: 'end' },
    ]);
  });

  it('a checkout before the phone is given waits for the update that has it', async () => {
    const t = await setup();
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });
    const first = await t.deliver(
      conn,
      { 'x-shopify-topic': 'checkouts/create' },
      { id: 1, token: 'cart-9' },
    );
    expect(first.outcome).toBe('ignored');
    const later = await t.deliver(
      conn,
      { 'x-shopify-topic': 'checkouts/update' },
      {
        id: 1,
        token: 'cart-9',
        phone: '+919800070009',
        total_price: '1',
      },
    );
    expect(later.outcome).toBe('processed');
  });
});

describe('Shopify privacy and lifecycle', () => {
  it('uninstalling disconnects; a shop erase blanks the log; a customer request notifies owners', async () => {
    const t = await setup();
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });
    const user = await owner.user.create({
      data: { email: `${randomUUID()}@c.test`, name: 'O', passwordHash: 'x' },
    });
    await owner.membership.create({ data: { orgId: t.orgId, userId: user.id, role: 'owner' } });

    const kept = await t.deliver(conn, { 'x-shopify-topic': 'orders/create' }, order());
    await t.deliver(
      conn,
      { 'x-shopify-topic': 'customers/redact' },
      {
        shop_domain: SHOP,
        customer: { id: 77, email: 'asha@example.com', phone: '+919800070001' },
      },
    );
    const notes = await owner.notification.findMany({ where: { orgId: t.orgId, userId: user.id } });
    expect(notes).toMatchObject([{ kind: 'integration_request' }]);
    expect(notes[0]!.body).toContain('asha@example.com');

    await t.deliver(conn, { 'x-shopify-topic': 'app/uninstalled' }, { id: 1, domain: SHOP });
    const row = await owner.integrationConnection.findUniqueOrThrow({ where: { id: conn } });
    expect(row).toMatchObject({ status: 'disconnected', credentialsEnc: null, webhookToken: null });

    await t.deliver(conn, { 'x-shopify-topic': 'shop/redact' }, { shop_id: 1, shop_domain: SHOP });
    const erased = await owner.integrationEvent.findUniqueOrThrow({ where: { id: kept.eventId } });
    expect(erased.payload).toEqual({});
  });

  it('setup registers the webhooks on the shop at the connection’s address', async () => {
    const t = await setup();
    const conn = await t.connect('shopify', { shop: SHOP }, { accessToken: 'shpat_x' });
    expect(await setupConnection(t.built.deps, t.orgId, conn)).toBe('done');
    const registered = t.httpCalls.filter((c) => c.url.endsWith('/webhooks.json'));
    expect(registered).toHaveLength(10);
    const token = (await owner.integrationConnection.findUniqueOrThrow({ where: { id: conn } }))
      .webhookToken;
    expect(JSON.parse(registered[0]!.body!)).toMatchObject({
      webhook: {
        topic: 'orders/create',
        address: `https://api.crm.test/integrations/hooks/${token}`,
      },
    });
  });
});

describe('WooCommerce', () => {
  it('a paid order sends the confirmation once, and completing it sends the update', async () => {
    const t = await setup();
    await t.flow(
      onEvent('woocommerce', 'order.created', t.templates.confirmation.id, {
        'body.1': '{{trigger.data.order.customer.firstName}}',
        'body.2': '{{trigger.data.order.name}}',
        'body.3': '{{trigger.data.order.total}}',
      }),
    );
    await t.flow(
      onEvent('woocommerce', 'order.fulfilled', t.templates.shipping.id, {
        'body.1': '{{trigger.data.order.name}}',
        'body.2': 'see your email',
      }),
    );
    const conn = await t.connect(
      'woocommerce',
      { storeUrl: 'https://woo.example.com' },
      { consumerKey: 'ck', consumerSecret: 'cs', webhookSecret: 'w' },
    );
    const woo = {
      id: 727,
      number: '727',
      status: 'processing',
      total: '899.00',
      currency: 'INR',
      date_paid: 'x',
      billing: { first_name: 'Ravi', phone: '+91 98111 70727' },
    };
    await t.deliver(conn, { 'x-wc-webhook-topic': 'order.created' }, woo);
    await t.deliver(conn, { 'x-wc-webhook-topic': 'order.updated' }, woo);
    await t.deliver(
      conn,
      { 'x-wc-webhook-topic': 'order.updated' },
      { ...woo, status: 'completed' },
    );
    expect(await t.sent()).toEqual([
      'Hi Ravi, your order #727 is confirmed. Total 899.00.',
      'Your order #727 is on its way: see your email',
    ]);
    // The paid order is one sale in the reports, however many deliveries mention it.
    const sales = await withTenant(client, { orgId: t.orgId }, (tx) => tx.conversion.findMany());
    expect(sales).toEqual([
      expect.objectContaining({
        source: 'store_order',
        reference: 'woocommerce:727',
        amountMicros: 899_000_000n,
        currency: 'INR',
      }),
    ]);
  });
});
