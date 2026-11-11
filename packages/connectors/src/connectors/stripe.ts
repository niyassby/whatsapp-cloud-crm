/**
 * Stripe payments on the business's own Stripe account (not the platform's billing). A payment
 * link here is a one-time Checkout Session, so each customer gets their own link and its payment
 * can be matched. Connects with a secret or restricted key (Checkout Sessions and Webhook
 * Endpoints: write). Setup registers the webhook endpoint through the API, and Stripe's signing
 * secret for it is kept with the connection.
 */
import { safeEqual, hmacSha256 } from '../signing';
import {
  fromMinorUnits,
  type Payment,
  PAYMENT_LINK_INPUT,
  PAYMENT_LINK_OUTPUT,
  PAYMENT_TRIGGERS,
  paymentContact,
  paymentCorrelation,
  paymentReference,
  toMinorUnits,
} from '../payments';
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorDefinition,
  type MappedEvent,
} from '../types';

export const STRIPE_API = 'https://api.stripe.com/v1';
/** Pinned, as for platform billing. */
export const STRIPE_CONNECTOR_API_VERSION = '2026-10-28.endive';
export const STRIPE_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
] as const;
const SIGNATURE_TOLERANCE_SECONDS = 300;

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Stripe's form encoding, with nested keys as a[b][c]. */
export function formEncode(value: Json, prefix = ''): string[] {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === 'object')
          parts.push(...formEncode(item as Json, `${key}[${i}]`));
        else parts.push(`${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`);
      });
    } else if (typeof v === 'object') {
      parts.push(...formEncode(v as Json, key));
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts;
}

async function call(
  ctx: ConnectorContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Json,
  idempotencyKey?: string,
) {
  const res = await ctx.http({
    method,
    url: `${STRIPE_API}${path}`,
    headers: {
      authorization: `Bearer ${ctx.credentials.secretKey ?? ''}`,
      'stripe-version': STRIPE_CONNECTOR_API_VERSION,
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body ? formEncode(body).join('&') : undefined,
  });
  if (res.status === 401) {
    throw new ConnectorError('Stripe refused the API key', { reconnect: true });
  }
  if (res.status === 403) {
    throw new ConnectorError('The Stripe key is not allowed to do this; check its permissions', {
      reconnect: true,
    });
  }
  if (res.status >= 500 || res.status === 429) {
    throw new ConnectorError(`Stripe answered ${res.status}`, { retryable: true });
  }
  return res;
}

const errorText = (json: unknown) =>
  str(obj(obj(json).error).message) ?? 'Stripe refused the request';

/** A Checkout Session in our shape. */
export function stripeSession(s: Json): Payment {
  const meta = obj(s.metadata);
  const details = obj(s.customer_details);
  const currency = (str(s.currency) ?? 'usd').toUpperCase();
  const status =
    s.payment_status === 'paid'
      ? 'paid'
      : s.status === 'expired'
        ? 'expired'
        : (str(s.status) ?? 'open');
  return {
    id: str(s.payment_intent),
    linkId: str(s.id),
    reference: str(s.client_reference_id) ?? str(meta.wacrm_ref),
    amount: fromMinorUnits(Number(s.amount_total ?? 0), currency),
    currency,
    status,
    url: str(s.url),
    description: str(meta.description),
    method: Array.isArray(s.payment_method_types) ? String(s.payment_method_types[0]) : null,
    error: null,
    customer: {
      name: str(details.name) ?? str(meta.name),
      phone: str(meta.phone) ?? str(details.phone),
      email: str(details.email) ?? str(s.customer_email),
    },
  };
}

/** Stripe-Signature: t=<seconds>,v1=<hex HMAC of "<t>.<body>">, within five minutes. */
export function verifyStripeSignature(
  rawBody: Buffer,
  secret: string,
  header: string | undefined,
  now = Date.now(),
): boolean {
  if (!header || !secret) return false;
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(t)) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = hmacSha256(secret, Buffer.concat([Buffer.from(`${t}.`), rawBody]), 'hex');
  return signatures.some((s) => safeEqual(s, expected));
}

export function mapStripe(body: unknown): MappedEvent[] {
  const b = obj(body);
  const type = str(b.type) ?? '';
  const session = obj(obj(b.data).object);
  if (!session.id || session.object !== 'checkout.session') return [];
  // Payments only; subscriptions and setups made elsewhere on the account are not ours to answer.
  if (session.mode && session.mode !== 'payment') return [];
  const payment = stripeSession(session);
  const id = String(session.id);
  const contact = paymentContact(payment.customer);
  const cancels = [paymentCorrelation('stripe', id)];

  if (
    (type === 'checkout.session.completed' && session.payment_status === 'paid') ||
    type === 'checkout.session.async_payment_succeeded'
  ) {
    payment.status = 'paid';
    // One id for both events, so a delayed method that reports twice counts once.
    return [
      { trigger: 'payment.paid', externalId: `paid:${id}`, contact, data: { payment }, cancels },
    ];
  }
  if (type === 'checkout.session.async_payment_failed') {
    payment.status = 'failed';
    payment.error = 'The payment failed';
    return [{ trigger: 'payment.failed', externalId: `failed:${id}`, contact, data: { payment } }];
  }
  if (type === 'checkout.session.expired') {
    payment.status = 'expired';
    return [
      {
        trigger: 'payment.expired',
        externalId: `closed:${id}`,
        contact,
        data: { payment },
        cancels,
      },
    ];
  }
  return [];
}

export const stripe: ConnectorDefinition = {
  key: 'stripe',
  name: 'Stripe',
  description: 'Send Stripe checkout links in flows, remind until paid, and react to payments.',
  category: 'payments',
  website: 'https://stripe.com',
  auth: {
    type: 'api_key',
    fields: [
      {
        key: 'secretKey',
        label: 'Secret key',
        type: 'secret',
        placeholder: 'sk_live_... or rk_live_...',
        help: 'A restricted key needs Checkout Sessions and Webhook Endpoints: write.',
      },
    ],
  },
  settings: [
    {
      key: 'returnUrl',
      label: 'After paying, send people to',
      type: 'url',
      placeholder: 'https://example.com/thank-you',
    },
    { key: 'defaultCurrency', label: 'Default currency', required: false, placeholder: 'USD' },
  ],
  normalizeSettings(settings) {
    const url = (settings.returnUrl ?? '').trim();
    if (!/^https:\/\/\S+$/i.test(url)) return 'The page after paying must be an https address';
    const currency = (settings.defaultCurrency ?? '').trim().toUpperCase() || 'USD';
    if (!/^[A-Z]{3}$/.test(currency)) return 'The currency is three letters, such as USD';
    return { ...settings, returnUrl: url, defaultCurrency: currency };
  },
  triggers: PAYMENT_TRIGGERS,
  actions: [
    {
      key: 'create_payment_link',
      name: 'Create a payment link',
      description: 'A Stripe checkout link for an amount, to send in the next step',
      input: PAYMENT_LINK_INPUT,
      output: PAYMENT_LINK_OUTPUT,
      async run(ctx, input) {
        const currency = (input.currency || ctx.settings.defaultCurrency || 'USD').toUpperCase();
        const amount = toMinorUnits(input.amount ?? '', currency);
        if (!amount) throw new ConnectorError(`"${input.amount ?? ''}" is not an amount`);
        const reference = paymentReference(ctx.idempotencyKey);
        const description = (input.description ?? '').trim() || 'Payment';
        // Stripe allows 30 minutes to 24 hours. Counted from the start of a 10-minute slot, so a
        // repeat of the step soon after sends the same parameters, as Stripe's idempotency needs.
        const minutes = Math.min(1440, Math.max(41, Number(input.expiresInMinutes || 1440)));
        const slot = Math.floor(Date.now() / 600_000) * 600;
        const res = await call(
          ctx,
          'POST',
          '/checkout/sessions',
          {
            mode: 'payment',
            success_url: ctx.settings.returnUrl,
            client_reference_id: reference,
            expires_at: slot + minutes * 60,
            ...(input.email ? { customer_email: input.email } : {}),
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: currency.toLowerCase(),
                  unit_amount: amount,
                  product_data: { name: description.slice(0, 250) },
                },
              },
            ],
            metadata: {
              wacrm_ref: reference,
              description: description.slice(0, 450),
              ...(input.phone ? { phone: input.phone } : {}),
              ...(input.name ? { name: input.name.slice(0, 450) } : {}),
            },
          },
          // Stripe returns the same session for a repeat of the same flow step.
          ctx.idempotencyKey ? reference : undefined,
        );
        if (!res.ok) throw new ConnectorError(errorText(res.json));
        const p = stripeSession(obj(res.json));
        return {
          linkId: p.linkId,
          url: p.url,
          amount: p.amount,
          currency: p.currency,
          status: p.status,
          reference: p.reference,
        };
      },
      correlation: (out) =>
        typeof out.linkId === 'string' ? paymentCorrelation('stripe', out.linkId) : null,
    },
    {
      key: 'check_payment_link',
      name: 'Check a payment link',
      description: 'Whether a checkout link has been paid',
      input: [{ key: 'linkId', label: 'Link id', placeholder: '{{vars.link_id}}' }],
      output: ['status', 'amount', 'paid', 'url'],
      async run(ctx, input) {
        const id = (input.linkId ?? '').trim();
        const res = await call(ctx, 'GET', `/checkout/sessions/${encodeURIComponent(id)}`);
        if (res.status === 404) throw new ConnectorError(`No link ${id}`);
        if (!res.ok) throw new ConnectorError(errorText(res.json));
        const p = stripeSession(obj(res.json));
        return { status: p.status, amount: p.amount, paid: p.status === 'paid', url: p.url };
      },
    },
  ],
  webhook: {
    secretField: 'webhookSecret',
    secretBySetup: true,
    verify: (req, secret) =>
      verifyStripeSignature(req.rawBody, secret, req.headers['stripe-signature']),
    deliveryId: (req) => {
      try {
        return str(obj(JSON.parse(req.rawBody.toString('utf8'))).id);
      } catch {
        return null;
      }
    },
    map: (body) => mapStripe(body),
  },
  async healthCheck(ctx) {
    const res = await call(ctx, 'GET', '/checkout/sessions?limit=1');
    if (!res.ok) throw new ConnectorError(errorText(res.json));
  },
  /**
   * Register the webhook endpoint once. Stripe shows its signing secret only when it is made, so
   * an endpoint whose secret was lost is replaced.
   */
  async setup(ctx, { webhookUrl }) {
    if (!webhookUrl) return;
    const listed = await call(ctx, 'GET', '/webhook_endpoints?limit=100');
    if (!listed.ok) throw new ConnectorError(errorText(listed.json));
    const mine = ((obj(listed.json).data as unknown[] | undefined) ?? [])
      .map(obj)
      .filter((e) => e.url === webhookUrl);
    if (mine.length && ctx.credentials.webhookSecret) return;
    for (const e of mine) await call(ctx, 'DELETE', `/webhook_endpoints/${String(e.id)}`);
    const made = await call(ctx, 'POST', '/webhook_endpoints', {
      url: webhookUrl,
      enabled_events: [...STRIPE_EVENTS],
      api_version: STRIPE_CONNECTOR_API_VERSION,
      description: 'WhatsApp CRM payment links',
    });
    const secret = str(obj(made.json).secret);
    if (!made.ok || !secret) throw new ConnectorError(errorText(made.json));
    return { credentials: { webhookSecret: secret } };
  },
};
