/**
 * Store mappings. Payloads follow Shopify's and WooCommerce's documented webhook shapes, trimmed
 * and masked; they have not been checked against a live store yet.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  type ConnectorContext,
  customStore,
  hmacSha256,
  type HttpRequest,
  mapCustom,
  mapShopify,
  mapWoo,
  shopify,
  SHOPIFY_TOPICS,
  woocommerce,
} from '../src';

const SHOP = 'chai-house.myshopify.com';

const shopifyOrderBody = {
  id: 820982911946154500,
  name: '#1001',
  order_number: 1001,
  email: 'asha@example.com',
  phone: null,
  currency: 'INR',
  total_price: '1499.00',
  current_total_price: '1499.00',
  financial_status: 'paid',
  fulfillment_status: null,
  checkout_token: 'cart-token-1',
  order_status_url: 'https://chai-house.example/orders/abc/authenticate?key=x',
  created_at: '2026-11-11T10:00:00+05:30',
  line_items: [
    { title: 'Masala chai', quantity: 2, price: '499.00' },
    { title: 'Clay mug', quantity: 1, price: '501.00' },
  ],
  customer: {
    id: 115310627314723950,
    first_name: 'Asha',
    last_name: 'Rao',
    phone: '+919800000001',
    sms_marketing_consent: {
      state: 'subscribed',
      opt_in_level: 'single_opt_in',
      consent_updated_at: '2026-11-11T09:59:00+05:30',
      consent_collected_from: 'SHOPIFY',
    },
  },
  shipping_address: {
    address1: '12 MG Road',
    city: 'Bengaluru',
    country: 'India',
    phone: '+919800000001',
  },
};

/** A context whose http answers what a test sets, recording requests. */
function fakeCtx(answer: (req: HttpRequest) => { status: number; json?: unknown }) {
  const calls: HttpRequest[] = [];
  const ctx: ConnectorContext = {
    connectionId: 'c',
    credentials: {
      accessToken: 'shpat_x',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      webhookSecret: 'whs',
    },
    settings: { shop: SHOP, storeUrl: 'https://woo.example.com' },
    http: async (req) => {
      calls.push(req);
      const a = answer(req);
      return {
        status: a.status,
        ok: a.status < 300,
        body: JSON.stringify(a.json ?? {}),
        json: a.json ?? {},
      };
    },
  };
  return { ctx, calls };
}

describe('Shopify', () => {
  const none = fakeCtx(() => ({ status: 500 })).ctx;
  const map = (topic: string, body: unknown, ctx = none) =>
    mapShopify(body, { 'x-shopify-topic': topic }, { shop: SHOP }, ctx);

  it('maps a new order to an order confirmation, with consent and the cart it completes', async () => {
    const [ev] = await map('orders/create', shopifyOrderBody);
    expect(ev).toMatchObject({
      trigger: 'order.created',
      externalId: 'order.created:820982911946154500',
      contact: { phone: '+919800000001', email: 'asha@example.com', name: 'Asha Rao' },
      cancels: ['checkout:cart-token-1'],
      data: {
        order: {
          name: '#1001',
          total: '1499.00',
          currency: 'INR',
          itemsSummary: '2 × Masala chai, 1 × Clay mug',
          statusUrl: 'https://chai-house.example/orders/abc/authenticate?key=x',
          shippingAddress: '12 MG Road, Bengaluru, India',
        },
      },
    });
    expect(ev!.contact!.consent!.source).toBe('shopify_checkout');
    expect(JSON.parse(ev!.contact!.consent!.proof)).toMatchObject({
      shop: SHOP,
      sms_marketing_consent: { state: 'subscribed' },
    });
  });

  it('does not take email consent, or no consent, as WhatsApp consent', async () => {
    const body = {
      ...shopifyOrderBody,
      buyer_accepts_marketing: true,
      customer: {
        ...shopifyOrderBody.customer,
        sms_marketing_consent: { state: 'not_subscribed' },
      },
    };
    const [ev] = await map('orders/create', body);
    expect(ev!.contact!.consent).toBeNull();
  });

  it('a fulfillment fetches its order for the customer, and keys on the delivery stage', async () => {
    const { ctx, calls } = fakeCtx(() => ({ status: 200, json: { order: shopifyOrderBody } }));
    const [ev] = await map(
      'fulfillments/update',
      {
        id: 255858046,
        order_id: 820982911946154500,
        status: 'success',
        shipment_status: 'out_for_delivery',
        tracking_number: 'BD1',
        tracking_url: 'https://track.example/BD1',
        tracking_company: 'Blue Dart',
      },
      ctx,
    );
    expect(calls[0]!.url).toBe(`https://${SHOP}/admin/api/2026-07/orders/820982911946154500.json`);
    expect(calls[0]!.headers).toMatchObject({ 'x-shopify-access-token': 'shpat_x' });
    expect(ev).toMatchObject({
      trigger: 'shipment.updated',
      externalId: 'shipment:255858046:out_for_delivery',
      contact: { phone: '+919800000001' },
      data: {
        shipment: {
          shipmentStatus: 'out_for_delivery',
          tracking: { number: 'BD1', company: 'Blue Dart' },
        },
        order: { name: '#1001', tracking: { url: 'https://track.example/BD1' } },
      },
    });
  });

  it('a checkout with a phone starts a cart reminder; without one, or completed, nothing', async () => {
    const checkout = {
      id: 9001,
      token: 'cart-token-1',
      phone: '+919800000001',
      total_price: '1499.00',
      currency: 'INR',
      abandoned_checkout_url: 'https://chai-house.example/checkouts/cart-token-1/recover',
      line_items: shopifyOrderBody.line_items,
    };
    const [ev] = await map('checkouts/update', checkout);
    expect(ev).toMatchObject({
      trigger: 'checkout.started',
      externalId: 'checkout:cart-token-1',
      correlation: 'checkout:cart-token-1',
      data: {
        checkout: { recoveryUrl: 'https://chai-house.example/checkouts/cart-token-1/recover' },
      },
    });
    expect(await map('checkouts/create', { ...checkout, phone: null })).toEqual([]);
    expect(
      await map('checkouts/update', { ...checkout, completed_at: '2026-11-11T10:00:00Z' }),
    ).toEqual([]);
  });

  it('uninstalling disconnects, and privacy requests erase or notify', async () => {
    expect((await map('app/uninstalled', { id: 1, domain: SHOP }))[0]!.effect).toEqual({
      kind: 'disconnect',
      reason: 'The app was uninstalled from the Shopify store',
    });
    expect((await map('shop/redact', { shop_id: 1, shop_domain: SHOP }))[0]!.effect!.kind).toBe(
      'erase',
    );
    const [redact] = await map('customers/redact', {
      shop_domain: SHOP,
      customer: { id: 1, email: 'asha@example.com', phone: '+919800000001' },
    });
    expect(redact!.effect).toMatchObject({ kind: 'notify' });
    expect(redact!.effect!.kind === 'notify' && redact!.effect!.body).toContain('asha@example.com');
  });

  it('checks webhooks with the app secret in base64, and routes privacy requests by shop', () => {
    const rawBody = Buffer.from(JSON.stringify({ shop_domain: SHOP }));
    const good = hmacSha256('app-secret', rawBody, 'base64');
    expect(
      shopify.webhook!.verify(
        { rawBody, headers: { 'x-shopify-hmac-sha256': good } },
        'app-secret',
        {},
      ),
    ).toBe(true);
    expect(
      shopify.webhook!.verify({ rawBody, headers: { 'x-shopify-hmac-sha256': good } }, 'other', {}),
    ).toBe(false);
    expect(shopify.appWebhook!.route({ shop_domain: 'Chai-House.myshopify.com' }, {})).toEqual({
      setting: 'shop',
      value: 'chai-house.myshopify.com',
    });
  });

  it('cleans the shop address', () => {
    const n = shopify.normalizeSettings!;
    expect(n({ shop: 'chai-house' })).toEqual({ shop: SHOP });
    expect(n({ shop: 'https://Chai-House.myshopify.com/admin' })).toEqual({ shop: SHOP });
    expect(n({ shop: 'evil.example.com' })).toBe('Enter the shop’s .myshopify.com address');
  });

  it('registers its webhooks, taking "already registered" as done', async () => {
    const { ctx, calls } = fakeCtx((req) => ({
      status:
        (req.body as { webhook: { topic: string } }).webhook.topic === 'orders/paid' ? 422 : 201,
    }));
    await shopify.setup!(ctx, { webhookUrl: 'https://api.crm.test/integrations/hooks/tok' });
    expect(calls.map((c) => (c.body as { webhook: { topic: string } }).webhook.topic)).toEqual([
      ...SHOPIFY_TOPICS,
    ]);
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `https://${SHOP}/admin/api/2026-07/webhooks.json`,
      body: { webhook: { address: 'https://api.crm.test/integrations/hooks/tok', format: 'json' } },
    });
  });
});

describe('WooCommerce', () => {
  const order = {
    id: 727,
    number: '727',
    status: 'processing',
    currency: 'INR',
    total: '899.00',
    date_paid: '2026-11-11T10:00:00',
    billing: {
      first_name: 'Ravi',
      last_name: 'K',
      email: 'ravi@example.com',
      phone: '+91 98111 22233',
    },
    shipping: { address_1: '4 Park St', city: 'Kolkata', country: 'IN' },
    line_items: [{ name: 'Tea sampler', quantity: 1, price: 899 }],
    meta_data: [
      {
        key: '_wc_shipment_tracking_items',
        value: [
          {
            tracking_provider: 'India Post',
            tracking_number: 'EE1',
            custom_tracking_link: 'https://t.example/EE1',
          },
        ],
      },
    ],
  };

  it('a new paid order is both placed and paid; an update to completed is shipped', () => {
    const created = mapWoo(order, { 'x-wc-webhook-topic': 'order.created' });
    expect(created.map((e) => e.externalId)).toEqual(['order.created:727', 'order.paid:727']);
    expect(created[0]).toMatchObject({
      contact: { phone: '+91 98111 22233', name: 'Ravi K' },
      data: {
        order: {
          name: '#727',
          financialStatus: 'paid',
          tracking: { number: 'EE1', company: 'India Post' },
        },
      },
    });
    const shipped = mapWoo(
      { ...order, status: 'completed' },
      { 'x-wc-webhook-topic': 'order.updated' },
    );
    expect(shipped).toMatchObject([
      { trigger: 'order.fulfilled', externalId: 'order.fulfilled:727' },
    ]);
    expect(
      mapWoo({ ...order, status: 'on-hold' }, { 'x-wc-webhook-topic': 'order.updated' }),
    ).toEqual([]);
    expect(mapWoo({ webhook_id: '5' }, { 'x-wc-webhook-topic': 'order.created' })).toEqual([]);
  });

  it('registers only the webhooks this address does not have', async () => {
    const url = 'https://api.crm.test/integrations/hooks/tok';
    const { ctx, calls } = fakeCtx((req) =>
      req.method === 'GET'
        ? { status: 200, json: [{ topic: 'order.created', delivery_url: url, status: 'active' }] }
        : { status: 201 },
    );
    await woocommerce.setup!(ctx, { webhookUrl: url });
    const posted = calls.filter((c) => c.method === 'POST');
    expect(posted.map((c) => (c.body as { topic: string }).topic)).toEqual([
      'order.updated',
      'customer.created',
    ]);
    expect(posted[0]).toMatchObject({
      url: 'https://woo.example.com/wp-json/wc/v3/webhooks',
      headers: { authorization: `Basic ${Buffer.from('ck:cs').toString('base64')}` },
      body: { delivery_url: url, secret: 'whs', status: 'active' },
    });
  });
});

describe('Custom store', () => {
  it('known event names use the shared triggers; others arrive as "any other event"', () => {
    const [order] = mapCustom({
      event: 'order.created',
      id: '55',
      customer: {
        phone: '+919800000009',
        name: 'Dev',
        marketing_consent: true,
        consent_text: 'Yes, WhatsApp me',
      },
      data: { order: { name: '#55' } },
      cancels: ['checkout:x'],
    });
    expect(order).toMatchObject({
      trigger: 'order.created',
      externalId: 'order.created:55',
      data: { order: { name: '#55' } },
      cancels: ['checkout:x'],
      contact: { consent: { source: 'custom_store' } },
    });
    const [other] = mapCustom({ event: 'subscription.renewed', id: '9', data: { plan: 'Gold' } });
    expect(other).toMatchObject({
      trigger: 'event.received',
      data: { event: 'subscription.renewed', plan: 'Gold' },
    });
    expect(mapCustom({ event: 'x' })).toEqual([]);
  });

  it('calls the store API with its token, refusing bad paths and methods', async () => {
    const { ctx, calls } = fakeCtx(() => ({ status: 200, json: { ok: true } }));
    ctx.settings = { baseUrl: 'https://api.store.test/' };
    ctx.credentials = { apiToken: 'tok' };
    const action = customStore.actions![0]!;
    expect(
      await action.run(ctx, { method: 'post', path: '/orders/1/notes', body: '{"note":"hi"}' }),
    ).toEqual({
      status: 200,
      data: { ok: true },
    });
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://api.store.test/orders/1/notes',
      headers: { authorization: 'Bearer tok' },
      body: { note: 'hi' },
    });
    await expect(action.run(ctx, { method: 'GET', path: 'orders' })).rejects.toThrow(
      'must start with /',
    );
    await expect(action.run(ctx, { method: 'TRACE', path: '/x' })).rejects.toThrow('not a method');
  });
});

describe('registry', () => {
  it('offers the stores, and Shopify only once its app credentials are set', () => {
    const without = buildRegistry({ env: {} });
    expect(without.list().map((c) => c.key)).toEqual(['custom_store', 'shopify', 'woocommerce']);
    expect(without.toDto(shopify).available).toBe(false);
    const withApp = buildRegistry({ env: { SHOPIFY_CLIENT_ID: 'id', SHOPIFY_CLIENT_SECRET: 's' } });
    expect(withApp.toDto(shopify).available).toBe(true);
    expect(withApp.toDto(shopify).triggers.map((t) => t.key)).toContain('checkout.started');
  });
});
