/**
 * A pretend online store, used to exercise the framework in tests and local demos. It is only
 * registered when INTEGRATIONS_DEMO is on. It uses every part of the interface: an API key,
 * signed webhooks, triggers, actions, a health check and a sync.
 */
import { verifyHmacSha256 } from '../signing';
import { ConnectorError, type ConnectorDefinition, type MappedEvent } from '../types';

interface DemoOrder {
  id: string;
  status?: string;
  total?: string;
  customer?: { phone?: string; name?: string; email?: string };
}

const orderEvent = (trigger: string, order: DemoOrder): MappedEvent => ({
  trigger,
  externalId: `${trigger}:${order.id}`,
  contact: order.customer
    ? {
        phone: order.customer.phone ?? null,
        name: order.customer.name ?? null,
        email: order.customer.email ?? null,
      }
    : null,
  data: { order },
});

export const demoStore: ConnectorDefinition = {
  key: 'demo_store',
  name: 'Demo Store',
  description: 'A pretend shop for trying integrations: orders, shipping updates and lookups.',
  category: 'commerce',
  auth: {
    type: 'api_key',
    fields: [{ key: 'apiKey', label: 'API key', type: 'secret' }],
  },
  settings: [
    {
      key: 'baseUrl',
      label: 'Store API address',
      type: 'url',
      placeholder: 'https://demo-store.example.com/api',
    },
  ],
  triggers: [
    {
      key: 'order.created',
      name: 'Order placed',
      description: 'A customer placed an order',
      sample: { order: { id: '1001', total: '499.00', status: 'paid' } },
    },
    {
      key: 'order.shipped',
      name: 'Order shipped',
      description: 'An order left the warehouse',
      sample: { order: { id: '1001', status: 'shipped' } },
    },
  ],
  actions: [
    {
      key: 'lookup_order',
      name: 'Look up an order',
      description: 'Fetch an order’s status and total',
      input: [{ key: 'orderId', label: 'Order number' }],
      output: ['status', 'total'],
      async run(ctx, input) {
        const res = await ctx.http({
          method: 'GET',
          url: `${ctx.settings.baseUrl}/orders/${encodeURIComponent(input.orderId ?? '')}`,
          headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
        });
        if (res.status === 404) throw new ConnectorError('No such order');
        if (res.status === 401)
          throw new ConnectorError('The API key was refused', { reconnect: true });
        if (!res.ok)
          throw new ConnectorError(`The store answered ${res.status}`, { retryable: true });
        const order = res.json as DemoOrder;
        return { status: order.status ?? null, total: order.total ?? null };
      },
    },
  ],
  webhook: {
    verify: (req, secret) =>
      verifyHmacSha256(req.rawBody, secret, req.headers['x-demo-signature'], { prefix: 'sha256=' }),
    deliveryId: (req) => req.headers['x-demo-delivery'] ?? null,
    map(body) {
      const b = body as { type?: string; order?: DemoOrder };
      if (!b.order?.id || (b.type !== 'order.created' && b.type !== 'order.shipped')) return [];
      return [orderEvent(b.type, b.order)];
    },
  },
  async healthCheck(ctx) {
    const res = await ctx.http({
      method: 'GET',
      url: `${ctx.settings.baseUrl}/health`,
      headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
    });
    if (res.status === 401)
      throw new ConnectorError('The API key was refused', { reconnect: true });
    if (!res.ok) throw new ConnectorError(`The store answered ${res.status}`);
  },
  sync: {
    everyMinutes: 15,
    async run(ctx, cursor) {
      const since = typeof cursor === 'string' ? cursor : '';
      const res = await ctx.http({
        method: 'GET',
        url: `${ctx.settings.baseUrl}/orders?shipped_since=${encodeURIComponent(since)}`,
        headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
      });
      if (!res.ok)
        throw new ConnectorError(`The store answered ${res.status}`, { retryable: true });
      const { orders = [], next = since } = (res.json ?? {}) as {
        orders?: DemoOrder[];
        next?: string;
      };
      return { events: orders.map((o) => orderEvent('order.shipped', o)), cursor: next };
    },
  },
};
