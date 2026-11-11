/**
 * Any store or system that can send a webhook and answer HTTP. It sends signed events in a small
 * documented format (infra/connectors.md, "Custom store"), using the same event names as the
 * other stores so flows can be shared; flows call its API with the token kept encrypted here
 * rather than written into the flow.
 */
import { asText, COMMERCE_TRIGGERS } from '../commerce';
import { verifyHmacSha256 } from '../signing';
import { ConnectorError, type ConnectorDefinition, type MappedEvent } from '../types';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 20) : [];

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

export function mapCustom(body: unknown): MappedEvent[] {
  const b = obj(body);
  const event = asText(b.event);
  const id = asText(b.id);
  if (!event || !id) return [];
  const known = event in COMMERCE_TRIGGERS;
  const c = obj(b.customer);
  const data = obj(b.data);
  const correlation = asText(b.correlation);
  const cancels = strings(b.cancels);
  return [
    {
      trigger: known ? event : 'event.received',
      externalId: `${event}:${id}`.slice(0, 300),
      contact: {
        phone: asText(c.phone),
        email: asText(c.email),
        name: asText(c.name),
        consent:
          c.marketing_consent === true
            ? {
                source: 'custom_store',
                proof: JSON.stringify({ event, id, consent_text: asText(c.consent_text) ?? null }),
              }
            : null,
      },
      data: known ? data : { event, ...data },
      ...(correlation ? { correlation } : {}),
      ...(cancels.length ? { cancels } : {}),
    },
  ];
}

export const customStore: ConnectorDefinition = {
  key: 'custom_store',
  name: 'Custom store',
  description: 'Your own store or system: send signed events, and call its API from flows.',
  category: 'commerce',
  auth: {
    type: 'api_key',
    fields: [
      {
        key: 'apiToken',
        label: 'API token for your store',
        type: 'secret',
        required: false,
        help: 'Sent as a Bearer token when flows call your API. Leave empty if they will not.',
      },
    ],
  },
  settings: [
    {
      key: 'baseUrl',
      label: 'API address',
      type: 'url',
      required: false,
      placeholder: 'https://api.example.com',
      help: 'Where flows send requests. Leave empty if they will not.',
    },
  ],
  triggers: [
    ...[
      'order.created',
      'order.paid',
      'order.fulfilled',
      'order.cancelled',
      'shipment.updated',
      'checkout.started',
      'customer.created',
    ].map((k) => COMMERCE_TRIGGERS[k]!),
    {
      key: 'event.received',
      name: 'Any other event',
      description: 'An event with another name; its name is in {{trigger.data.event}}',
      sample: { event: 'subscription.renewed', plan: 'Gold' },
    },
  ],
  actions: [
    {
      key: 'request',
      name: 'Call your API',
      description: 'Send a request to your store and keep the answer',
      input: [
        { key: 'method', label: 'Method (GET, POST, PUT, PATCH or DELETE)', placeholder: 'GET' },
        { key: 'path', label: 'Path', placeholder: '/orders/{{vars.order}}' },
        { key: 'body', label: 'Body (JSON)', required: false },
      ],
      output: ['status', 'data'],
      async run(ctx, input) {
        if (!ctx.settings.baseUrl)
          throw new ConnectorError('Set the API address on the connection first');
        const method = (input.method ?? 'GET').trim().toUpperCase();
        if (!METHODS.has(method))
          throw new ConnectorError(`${method} is not a method this can send`);
        const path = (input.path ?? '').trim();
        if (!path.startsWith('/')) throw new ConnectorError('The path must start with /');
        let body: unknown;
        if (input.body?.trim() && method !== 'GET' && method !== 'DELETE') {
          try {
            body = JSON.parse(input.body);
          } catch {
            throw new ConnectorError('The body is not valid JSON');
          }
        }
        const res = await ctx.http({
          method: method as 'GET',
          url: `${ctx.settings.baseUrl.replace(/\/+$/, '')}${path}`,
          headers: ctx.credentials.apiToken
            ? { authorization: `Bearer ${ctx.credentials.apiToken}` }
            : {},
          body,
        });
        if (res.status === 401)
          throw new ConnectorError('Your API refused the token', { reconnect: true });
        if (!res.ok) throw new ConnectorError(`Your API answered ${res.status}`);
        return { status: res.status, data: res.json ?? res.body };
      },
    },
  ],
  webhook: {
    verify: (req, secret) =>
      verifyHmacSha256(req.rawBody, secret, req.headers['x-signature'], { prefix: 'sha256=' }),
    deliveryId: (req) => req.headers['x-delivery-id'] ?? null,
    map: mapCustom,
  },
};
