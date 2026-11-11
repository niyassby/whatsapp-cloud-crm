/**
 * Shopify. A public app: the merchant signs in with OAuth on their shop, the app registers its
 * webhooks there, and Shopify signs every webhook with the app's client secret (base64
 * HMAC-SHA256 of the body in X-Shopify-Hmac-Sha256). The privacy webhooks Shopify requires go to
 * one address for the whole app and are routed by shop domain.
 *
 * Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET from the app in the Shopify Partner dashboard,
 * with the redirect URL {API_PUBLIC_URL}/integrations/oauth/callback, and the privacy webhooks at
 * {API_PUBLIC_URL}/integrations/apps/shopify/hooks. See infra/connectors.md.
 */
import {
  asText,
  type CommerceCheckout,
  type CommerceCustomer,
  type CommerceItem,
  type CommerceOrder,
  type CommerceShipment,
  type CommerceTracking,
  checkoutCorrelation,
  commerceTriggers,
  fullName,
  summarizeItems,
} from '../commerce';
import { sha256Hex, verifyHmacSha256 } from '../signing';
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorDefinition,
  type EventContact,
  type MappedEvent,
} from '../types';

/** Pinned Admin API version. Shopify supports each for about a year; move it forward yearly. */
export const SHOPIFY_API_VERSION = '2026-07';

/** Topics registered on each shop. app/uninstalled stops the connection. */
export const SHOPIFY_TOPICS = [
  'orders/create',
  'orders/paid',
  'orders/fulfilled',
  'orders/cancelled',
  'fulfillments/create',
  'fulfillments/update',
  'checkouts/create',
  'checkouts/update',
  'customers/create',
  'app/uninstalled',
] as const;

const SHOP = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

function customerOf(order: Json): CommerceCustomer {
  const c = obj(order.customer);
  const billing = obj(order.billing_address);
  const shipping = obj(order.shipping_address);
  const first = asText(c.first_name) ?? asText(billing.first_name) ?? asText(shipping.first_name);
  const last = asText(c.last_name) ?? asText(billing.last_name) ?? asText(shipping.last_name);
  return {
    firstName: first,
    lastName: last,
    name: fullName(first, last),
    email: asText(order.email) ?? asText(c.email),
    phone:
      asText(order.phone) ??
      asText(c.phone) ??
      asText(shipping.phone) ??
      asText(billing.phone) ??
      null,
  };
}

const itemsOf = (o: Json): CommerceItem[] =>
  arr(o.line_items).map((i) => ({
    name: asText(i.title) ?? asText(i.name) ?? 'Item',
    quantity: Number(i.quantity ?? 1),
    price: asText(i.price),
  }));

const trackingOf = (f: Json): CommerceTracking | null => {
  const number = asText(f.tracking_number) ?? asText(arr(f.tracking_numbers)[0]);
  const url = asText(f.tracking_url) ?? asText(arr(f.tracking_urls)[0]);
  const company = asText(f.tracking_company);
  return number || url ? { number, url, company } : null;
};

const addressLine = (a: Json) =>
  [a.address1, a.address2, a.city, a.province, a.country].map(asText).filter(Boolean).join(', ') ||
  null;

export function shopifyOrder(o: Json): CommerceOrder {
  const items = itemsOf(o);
  const fulfillments = arr(o.fulfillments);
  return {
    id: String(o.id ?? ''),
    name: asText(o.name) ?? `#${asText(o.order_number) ?? o.id}`,
    number: asText(o.order_number) ?? String(o.id ?? ''),
    status: asText(o.cancelled_at) ? 'cancelled' : asText(o.closed_at) ? 'closed' : 'open',
    financialStatus: asText(o.financial_status),
    fulfillmentStatus: asText(o.fulfillment_status),
    total: asText(o.current_total_price) ?? asText(o.total_price) ?? '0',
    currency: asText(o.currency) ?? '',
    createdAt: asText(o.created_at),
    customer: customerOf(o),
    items,
    itemsSummary: summarizeItems(items),
    statusUrl: asText(o.order_status_url),
    shippingAddress: addressLine(obj(o.shipping_address)),
    tracking: fulfillments.length ? trackingOf(fulfillments[fulfillments.length - 1]!) : null,
  };
}

/**
 * Phone-channel marketing consent given in Shopify (the "Text me with news and offers" box at
 * checkout, or set on the customer). Email consent is not taken as WhatsApp consent.
 */
function consentOf(shop: string, source: Json, ref: string): EventContact['consent'] {
  const sms = obj(obj(source.customer).sms_marketing_consent ?? source.sms_marketing_consent);
  if (sms.state !== 'subscribed') return null;
  return {
    source: 'shopify_checkout',
    proof: JSON.stringify({
      shop,
      ref,
      sms_marketing_consent: {
        state: sms.state,
        opt_in_level: sms.opt_in_level ?? null,
        consent_updated_at: sms.consent_updated_at ?? null,
        consent_collected_from: sms.consent_collected_from ?? null,
      },
    }),
  };
}

const contactOf = (customer: CommerceCustomer, consent: EventContact['consent']): EventContact => ({
  phone: customer.phone,
  email: customer.email,
  name: customer.name,
  consent,
});

async function fetchOrder(ctx: ConnectorContext, id: string): Promise<Json | null> {
  const res = await ctx.http({
    method: 'GET',
    url: `https://${ctx.settings.shop}/admin/api/${SHOPIFY_API_VERSION}/orders/${encodeURIComponent(id)}.json`,
    headers: { 'x-shopify-access-token': ctx.credentials.accessToken ?? '' },
  });
  if (res.status === 401)
    throw new ConnectorError('Shopify refused the access token', { reconnect: true });
  if (res.status === 404) return null;
  if (!res.ok) throw new ConnectorError(`Shopify answered ${res.status}`, { retryable: true });
  return obj(obj(res.json).order);
}

const verifyShopify = (rawBody: Buffer, secret: string, header: string | undefined) =>
  verifyHmacSha256(rawBody, secret, header, { encoding: 'base64' });

const ORDER_TRIGGERS: Record<string, string> = {
  'orders/create': 'order.created',
  'orders/paid': 'order.paid',
  'orders/fulfilled': 'order.fulfilled',
  'orders/cancelled': 'order.cancelled',
};

export async function mapShopify(
  body: unknown,
  headers: Record<string, string>,
  settings: Record<string, string>,
  ctx: ConnectorContext,
): Promise<MappedEvent[]> {
  const topic = headers['x-shopify-topic'] ?? '';
  const shop = settings.shop ?? headers['x-shopify-shop-domain'] ?? '';
  const b = obj(body);

  if (topic in ORDER_TRIGGERS) {
    const trigger = ORDER_TRIGGERS[topic]!;
    const order = shopifyOrder(b);
    const token = asText(b.checkout_token);
    return [
      {
        trigger,
        externalId: `${trigger}:${order.id}`,
        contact: contactOf(order.customer, consentOf(shop, b, `order:${order.id}`)),
        data: { order },
        // The order for a cart stops that cart's reminder.
        ...(trigger === 'order.created' && token ? { cancels: [checkoutCorrelation(token)] } : {}),
      },
    ];
  }

  if (topic === 'fulfillments/create' || topic === 'fulfillments/update') {
    const shipment: CommerceShipment = {
      id: String(b.id ?? ''),
      status: asText(b.status),
      shipmentStatus: asText(b.shipment_status),
      tracking: trackingOf(b) ?? { number: null, url: null, company: null },
    };
    // A fulfillment names its order but not the customer: fetch the order for both.
    const raw = b.order_id ? await fetchOrder(ctx, String(b.order_id)) : null;
    const order = raw ? { ...shopifyOrder(raw), tracking: shipment.tracking } : null;
    const destination = obj(b.destination);
    const customer = order?.customer ?? {
      firstName: asText(destination.first_name),
      lastName: asText(destination.last_name),
      name: fullName(asText(destination.first_name), asText(destination.last_name)),
      email: asText(b.email),
      phone: asText(destination.phone),
    };
    return [
      {
        trigger: 'shipment.updated',
        externalId: `shipment:${shipment.id}:${shipment.shipmentStatus ?? shipment.status ?? 'created'}`,
        contact: contactOf(customer, null),
        data: { order, shipment },
      },
    ];
  }

  if (topic === 'checkouts/create' || topic === 'checkouts/update') {
    if (asText(b.completed_at)) return [];
    const customer = customerOf(b);
    const token = asText(b.token);
    // Until the customer gives a phone there is nobody to remind.
    if (!token || !customer.phone) return [];
    const items = itemsOf(b);
    const checkout: CommerceCheckout = {
      id: String(b.id ?? ''),
      token,
      recoveryUrl: asText(b.abandoned_checkout_url),
      total: asText(b.total_price) ?? '0',
      currency: asText(b.currency) ?? asText(b.presentment_currency) ?? '',
      customer,
      items,
      itemsSummary: summarizeItems(items),
    };
    return [
      {
        trigger: 'checkout.started',
        externalId: `checkout:${token}`,
        contact: contactOf(customer, consentOf(shop, b, `checkout:${token}`)),
        data: { checkout },
        correlation: checkoutCorrelation(token),
      },
    ];
  }

  if (topic === 'customers/create') {
    const first = asText(b.first_name);
    const last = asText(b.last_name);
    const customer: CommerceCustomer = {
      firstName: first,
      lastName: last,
      name: fullName(first, last),
      email: asText(b.email),
      phone: asText(b.phone) ?? asText(obj(b.default_address).phone),
    };
    return [
      {
        trigger: 'customer.created',
        externalId: `customer:${String(b.id ?? '')}`,
        contact: contactOf(
          customer,
          consentOf(shop, { customer: b }, `customer:${String(b.id ?? '')}`),
        ),
        data: { customer },
      },
    ];
  }

  if (topic === 'app/uninstalled') {
    return [
      {
        trigger: 'app.uninstalled',
        externalId: `uninstalled:${shop}:${asText(b.updated_at) ?? ''}`,
        contact: null,
        data: {},
        effect: { kind: 'disconnect', reason: 'The app was uninstalled from the Shopify store' },
      },
    ];
  }

  // Privacy requests (arrive through the app-wide address).
  if (topic === 'shop/redact') {
    return [
      {
        trigger: 'privacy.shop_redact',
        externalId: `shop_redact:${shop}`,
        contact: null,
        data: {},
        effect: { kind: 'erase', reason: 'Shopify asked for this shop’s data to be erased' },
      },
    ];
  }
  if (topic === 'customers/redact' || topic === 'customers/data_request') {
    const c = obj(b.customer);
    const who =
      [asText(c.email), asText(c.phone)].filter(Boolean).join(', ') ||
      `customer ${String(c.id ?? '')}`;
    const erase = topic === 'customers/redact';
    return [
      {
        trigger: erase ? 'privacy.customer_redact' : 'privacy.customer_data_request',
        externalId: `${topic}:${sha256Hex(JSON.stringify(b))}`,
        contact: null,
        data: {},
        effect: {
          kind: 'notify',
          title: erase
            ? `Shopify: erase a customer’s data (${shop})`
            : `Shopify: a customer asked for their data (${shop})`,
          body: erase
            ? `Erase the contact for ${who} within 30 days, and keep only what the law requires.`
            : `Send ${who} the data held about them within 30 days.`,
        },
      },
    ];
  }
  return [];
}

export const shopify: ConnectorDefinition = {
  key: 'shopify',
  name: 'Shopify',
  description:
    'Order confirmations, shipping updates and abandoned-cart reminders from your Shopify store.',
  category: 'commerce',
  website: 'https://www.shopify.com',
  auth: {
    type: 'oauth2',
    authorizeUrl: 'https://{settings.shop}/admin/oauth/authorize',
    tokenUrl: 'https://{settings.shop}/admin/oauth/access_token',
    scopes: ['read_orders', 'read_customers', 'read_fulfillments'],
    scopeSeparator: ',',
    clientIdEnv: 'SHOPIFY_CLIENT_ID',
    clientSecretEnv: 'SHOPIFY_CLIENT_SECRET',
  },
  settings: [
    {
      key: 'shop',
      label: 'Shop address',
      placeholder: 'your-store.myshopify.com',
      help: 'The .myshopify.com address, even if your store has its own domain.',
    },
  ],
  normalizeSettings(settings) {
    const raw = (settings.shop ?? '').toLowerCase().trim();
    const host = raw.replace(/^https?:\/\//, '').split('/')[0] ?? '';
    const shop = host.includes('.') ? host : `${host}.myshopify.com`;
    if (!SHOP.test(shop)) return 'Enter the shop’s .myshopify.com address';
    return { ...settings, shop };
  },
  triggers: commerceTriggers(
    'order.created',
    'order.paid',
    'order.fulfilled',
    'order.cancelled',
    'shipment.updated',
    'checkout.started',
    'customer.created',
  ),
  actions: [
    {
      key: 'lookup_order',
      name: 'Look up an order',
      description: 'Status, payment, total and tracking for an order number',
      input: [{ key: 'order', label: 'Order number', placeholder: '1001' }],
      output: ['name', 'financialStatus', 'fulfillmentStatus', 'total', 'trackingUrl', 'statusUrl'],
      async run(ctx, input) {
        const name = `#${(input.order ?? '').replace(/^#/, '').trim()}`;
        const res = await ctx.http({
          method: 'GET',
          url: `https://${ctx.settings.shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&limit=1&name=${encodeURIComponent(name)}`,
          headers: { 'x-shopify-access-token': ctx.credentials.accessToken ?? '' },
        });
        if (res.status === 401)
          throw new ConnectorError('Shopify refused the access token', { reconnect: true });
        if (!res.ok)
          throw new ConnectorError(`Shopify answered ${res.status}`, { retryable: true });
        const found = arr(obj(res.json).orders)[0];
        if (!found) throw new ConnectorError(`No order ${name}`);
        const order = shopifyOrder(found);
        return {
          name: order.name,
          financialStatus: order.financialStatus,
          fulfillmentStatus: order.fulfillmentStatus ?? 'unfulfilled',
          total: `${order.total} ${order.currency}`.trim(),
          trackingUrl: order.tracking?.url ?? null,
          statusUrl: order.statusUrl,
        };
      },
    },
  ],
  webhook: {
    secretEnv: 'SHOPIFY_CLIENT_SECRET',
    verify: (req, secret) =>
      verifyShopify(req.rawBody, secret, req.headers['x-shopify-hmac-sha256']),
    deliveryId: (req) =>
      req.headers['x-shopify-webhook-id'] ?? req.headers['x-shopify-event-id'] ?? null,
    map: mapShopify,
  },
  appWebhook: {
    secretEnv: 'SHOPIFY_CLIENT_SECRET',
    verify: (req, secret) =>
      verifyShopify(req.rawBody, secret, req.headers['x-shopify-hmac-sha256']),
    route(body, headers) {
      const shop = asText(obj(body).shop_domain) ?? headers['x-shopify-shop-domain'] ?? null;
      return shop ? { setting: 'shop', value: shop.toLowerCase() } : null;
    },
  },
  async healthCheck(ctx) {
    const res = await ctx.http({
      method: 'GET',
      url: `https://${ctx.settings.shop}/admin/api/${SHOPIFY_API_VERSION}/shop.json`,
      headers: { 'x-shopify-access-token': ctx.credentials.accessToken ?? '' },
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('Shopify refused the access token', { reconnect: true });
    }
    if (!res.ok) throw new ConnectorError(`Shopify answered ${res.status}`);
  },
  /** Register the webhooks on the shop. One that exists already answers 422, which is fine. */
  async setup(ctx, { webhookUrl }) {
    if (!webhookUrl) return;
    for (const topic of SHOPIFY_TOPICS) {
      const res = await ctx.http({
        method: 'POST',
        url: `https://${ctx.settings.shop}/admin/api/${SHOPIFY_API_VERSION}/webhooks.json`,
        headers: { 'x-shopify-access-token': ctx.credentials.accessToken ?? '' },
        body: { webhook: { topic, address: webhookUrl, format: 'json' } },
      });
      if (res.status === 401)
        throw new ConnectorError('Shopify refused the access token', { reconnect: true });
      if (!res.ok && res.status !== 422) {
        throw new ConnectorError(`Shopify would not register ${topic}: ${res.status}`, {
          retryable: true,
        });
      }
    }
  },
};
