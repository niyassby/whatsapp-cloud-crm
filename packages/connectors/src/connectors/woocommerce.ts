/**
 * WooCommerce. Connects with a REST API key pair (WooCommerce > Settings > Advanced > REST API,
 * read/write, so the app can register its webhooks). Webhooks are signed per connection with the
 * secret the app makes (base64 HMAC-SHA256 of the body in X-WC-Webhook-Signature).
 */
import {
  asText,
  type CommerceCustomer,
  type CommerceItem,
  type CommerceOrder,
  type CommerceTracking,
  commerceTriggers,
  fullName,
  summarizeItems,
} from '../commerce';
import { verifyHmacSha256 } from '../signing';
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorDefinition,
  type MappedEvent,
} from '../types';

export const WOO_TOPICS = ['order.created', 'order.updated', 'customer.created'] as const;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

const api = (ctx: ConnectorContext, path: string) =>
  `${ctx.settings.storeUrl}/wp-json/wc/v3${path}`;

const auth = (ctx: ConnectorContext) => ({
  authorization: `Basic ${Buffer.from(`${ctx.credentials.consumerKey ?? ''}:${ctx.credentials.consumerSecret ?? ''}`).toString('base64')}`,
});

/** Tracking from the common Shipment Tracking extension, when a store uses it. */
function trackingOf(o: Json): CommerceTracking | null {
  const meta = arr(o.meta_data).find((m) => m.key === '_wc_shipment_tracking_items');
  const first = arr(meta?.value)[0];
  if (!first) return null;
  return {
    number: asText(first.tracking_number),
    url: asText(first.custom_tracking_link) ?? asText(first.tracking_link),
    company: asText(first.tracking_provider) ?? asText(first.custom_tracking_provider),
  };
}

export function wooOrder(o: Json): CommerceOrder {
  const billing = obj(o.billing);
  const shipping = obj(o.shipping);
  const first = asText(billing.first_name) ?? asText(shipping.first_name);
  const last = asText(billing.last_name) ?? asText(shipping.last_name);
  const customer: CommerceCustomer = {
    firstName: first,
    lastName: last,
    name: fullName(first, last),
    email: asText(billing.email),
    phone: asText(billing.phone) ?? asText(shipping.phone),
  };
  const items: CommerceItem[] = arr(o.line_items).map((i) => ({
    name: asText(i.name) ?? 'Item',
    quantity: Number(i.quantity ?? 1),
    price: asText(i.price) ?? asText(i.total),
  }));
  const status = asText(o.status);
  return {
    id: String(o.id ?? ''),
    name: `#${asText(o.number) ?? String(o.id ?? '')}`,
    number: asText(o.number) ?? String(o.id ?? ''),
    status,
    financialStatus: asText(o.date_paid) ? 'paid' : 'pending',
    fulfillmentStatus: status === 'completed' ? 'fulfilled' : null,
    total: asText(o.total) ?? '0',
    currency: asText(o.currency) ?? '',
    createdAt: asText(o.date_created_gmt) ?? asText(o.date_created),
    customer,
    items,
    itemsSummary: summarizeItems(items),
    statusUrl: null,
    shippingAddress:
      [shipping.address_1, shipping.address_2, shipping.city, shipping.state, shipping.country]
        .map(asText)
        .filter(Boolean)
        .join(', ') || null,
    tracking: trackingOf(o),
  };
}

/** Order statuses that mean something to a customer. Others (on-hold, refunded...) map to none. */
const STATUS_TRIGGERS: Record<string, string> = {
  processing: 'order.paid',
  completed: 'order.fulfilled',
  cancelled: 'order.cancelled',
};

export function mapWoo(body: unknown, headers: Record<string, string>): MappedEvent[] {
  const topic = headers['x-wc-webhook-topic'] ?? '';
  const b = obj(body);
  if (topic === 'order.created' || topic === 'order.updated') {
    if (!b.id) return [];
    const order = wooOrder(b);
    const contact = {
      phone: order.customer.phone,
      email: order.customer.email,
      name: order.customer.name,
    };
    const events: MappedEvent[] = [];
    if (topic === 'order.created') {
      events.push({
        trigger: 'order.created',
        externalId: `order.created:${order.id}`,
        contact,
        data: { order },
      });
    }
    // Each status is acted on once per order, however many updates repeat it.
    const trigger = order.status ? STATUS_TRIGGERS[order.status] : undefined;
    if (trigger) {
      events.push({ trigger, externalId: `${trigger}:${order.id}`, contact, data: { order } });
    }
    return events;
  }
  if (topic === 'customer.created') {
    const billing = obj(b.billing);
    const first = asText(b.first_name) ?? asText(billing.first_name);
    const last = asText(b.last_name) ?? asText(billing.last_name);
    const customer: CommerceCustomer = {
      firstName: first,
      lastName: last,
      name: fullName(first, last),
      email: asText(b.email),
      phone: asText(billing.phone),
    };
    return [
      {
        trigger: 'customer.created',
        externalId: `customer:${String(b.id ?? '')}`,
        contact: { phone: customer.phone, email: customer.email, name: customer.name },
        data: { customer },
      },
    ];
  }
  // WooCommerce pings a new webhook with a form body; nothing to do.
  return [];
}

export const woocommerce: ConnectorDefinition = {
  key: 'woocommerce',
  name: 'WooCommerce',
  description: 'Order confirmations and status updates from your WooCommerce store.',
  category: 'commerce',
  website: 'https://woocommerce.com',
  auth: {
    type: 'api_key',
    fields: [
      { key: 'consumerKey', label: 'Consumer key', type: 'secret', placeholder: 'ck_...' },
      { key: 'consumerSecret', label: 'Consumer secret', type: 'secret', placeholder: 'cs_...' },
    ],
  },
  settings: [
    {
      key: 'storeUrl',
      label: 'Store address',
      type: 'url',
      placeholder: 'https://shop.example.com',
      help: 'WooCommerce > Settings > Advanced > REST API: make a key with read/write access.',
    },
  ],
  normalizeSettings(settings) {
    const url = (settings.storeUrl ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/wp-json.*$/, '');
    return url ? { ...settings, storeUrl: url } : 'Enter the store address';
  },
  triggers: commerceTriggers(
    'order.created',
    'order.paid',
    'order.fulfilled',
    'order.cancelled',
    'customer.created',
  ),
  actions: [
    {
      key: 'lookup_order',
      name: 'Look up an order',
      description: 'Status, total and tracking for an order number',
      input: [{ key: 'order', label: 'Order number' }],
      output: ['name', 'status', 'total', 'trackingUrl'],
      async run(ctx, input) {
        const id = (input.order ?? '').replace(/^#/, '').trim();
        const res = await ctx.http({
          method: 'GET',
          url: api(ctx, `/orders/${encodeURIComponent(id)}`),
          headers: auth(ctx),
        });
        if (res.status === 401)
          throw new ConnectorError('WooCommerce refused the API key', { reconnect: true });
        if (res.status === 404) throw new ConnectorError(`No order #${id}`);
        if (!res.ok)
          throw new ConnectorError(`WooCommerce answered ${res.status}`, { retryable: true });
        const order = wooOrder(obj(res.json));
        return {
          name: order.name,
          status: order.status,
          total: `${order.total} ${order.currency}`.trim(),
          trackingUrl: order.tracking?.url ?? null,
        };
      },
    },
  ],
  webhook: {
    verify: (req, secret) =>
      verifyHmacSha256(req.rawBody, secret, req.headers['x-wc-webhook-signature'], {
        encoding: 'base64',
      }),
    deliveryId: (req) => req.headers['x-wc-webhook-delivery-id'] ?? null,
    map: mapWoo,
  },
  async healthCheck(ctx) {
    const res = await ctx.http({
      method: 'GET',
      url: api(ctx, '/orders?per_page=1'),
      headers: auth(ctx),
    });
    if (res.status === 401 || res.status === 403) {
      throw new ConnectorError('WooCommerce refused the API key', { reconnect: true });
    }
    if (!res.ok) throw new ConnectorError(`WooCommerce answered ${res.status}`);
  },
  /** Register the webhooks, skipping any this address already has. */
  async setup(ctx, { webhookUrl }) {
    if (!webhookUrl) return;
    const listed = await ctx.http({
      method: 'GET',
      url: api(ctx, '/webhooks?per_page=100'),
      headers: auth(ctx),
    });
    if (listed.status === 401)
      throw new ConnectorError('WooCommerce refused the API key', { reconnect: true });
    if (!listed.ok)
      throw new ConnectorError(`WooCommerce answered ${listed.status}`, { retryable: true });
    const existing = new Set(
      arr(listed.json)
        .filter((w) => w.delivery_url === webhookUrl && w.status !== 'disabled')
        .map((w) => String(w.topic)),
    );
    for (const topic of WOO_TOPICS) {
      if (existing.has(topic)) continue;
      const res = await ctx.http({
        method: 'POST',
        url: api(ctx, '/webhooks'),
        headers: auth(ctx),
        body: {
          name: `WhatsApp CRM: ${topic}`,
          topic,
          delivery_url: webhookUrl,
          secret: ctx.credentials.webhookSecret,
          status: 'active',
        },
      });
      if (!res.ok)
        throw new ConnectorError(`WooCommerce would not register ${topic}: ${res.status}`, {
          retryable: true,
        });
    }
  },
};
