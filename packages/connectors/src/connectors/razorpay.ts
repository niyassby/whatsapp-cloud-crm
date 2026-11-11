/**
 * Razorpay payment links on the business's own Razorpay account (not the platform's billing).
 * Connects with an API key pair. Razorpay has no API to register webhooks, so the person adds the
 * connection's webhook address and secret in Dashboard > Accounts & Settings > Webhooks, with the
 * events payment_link.paid, payment_link.expired, payment_link.cancelled and payment.failed.
 * Signature: hex HMAC-SHA256 of the raw body in X-Razorpay-Signature.
 */
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
import { verifyHmacSha256 } from '../signing';
import {
  ConnectorError,
  type ConnectorContext,
  type ConnectorDefinition,
  type MappedEvent,
} from '../types';

export const RAZORPAY_API = 'https://api.razorpay.com/v1';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' ? (v as Json) : {});
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;

const auth = (ctx: ConnectorContext) => ({
  authorization: `Basic ${Buffer.from(`${ctx.credentials.keyId ?? ''}:${ctx.credentials.keySecret ?? ''}`).toString('base64')}`,
});

/** Razorpay wants a phone with its country code; contacts are stored as digits. */
const asPhone = (v: string | undefined) => {
  const p = (v ?? '').replace(/[^\d+]/g, '');
  if (!p) return undefined;
  return p.startsWith('+') ? p : `+${p}`;
};

function errorText(json: unknown): string {
  const e = obj(obj(json).error);
  return str(e.description) ?? str(e.code) ?? 'Razorpay refused the request';
}

async function call(ctx: ConnectorContext, method: 'GET' | 'POST', path: string, body?: Json) {
  const res = await ctx.http({ method, url: `${RAZORPAY_API}${path}`, headers: auth(ctx), body });
  if (res.status === 401) {
    throw new ConnectorError('Razorpay refused the API key', { reconnect: true });
  }
  if (res.status >= 500 || res.status === 429) {
    throw new ConnectorError(`Razorpay answered ${res.status}`, { retryable: true });
  }
  return res;
}

/** A payment link entity in our shape. */
export function razorpayLink(link: Json, payment: Json | null = null): Payment {
  const customer = obj(link.customer);
  const currency = str(link.currency) ?? str(payment?.currency) ?? 'INR';
  const minor = Number(link.amount ?? payment?.amount ?? 0);
  return {
    id: str(payment?.id),
    linkId: str(link.id),
    reference: str(link.reference_id),
    amount: fromMinorUnits(minor, currency),
    currency,
    status: str(link.status) ?? str(payment?.status) ?? 'created',
    url: str(link.short_url),
    description: str(link.description),
    method: str(payment?.method),
    error: str(payment?.error_description),
    customer: {
      name: str(customer.name),
      phone: str(customer.contact) ?? str(payment?.contact),
      email: str(customer.email) ?? str(payment?.email),
    },
  };
}

export function mapRazorpay(body: unknown): MappedEvent[] {
  const b = obj(body);
  const event = str(b.event) ?? '';
  const payload = obj(b.payload);
  const link = obj(obj(payload.payment_link).entity);
  const pay = obj(obj(payload.payment).entity);

  if (
    event === 'payment_link.paid' ||
    event === 'payment_link.expired' ||
    event === 'payment_link.cancelled'
  ) {
    if (!link.id) return [];
    const payment = razorpayLink(link, pay.id ? pay : null);
    const paid = event === 'payment_link.paid';
    if (!paid) payment.status = event === 'payment_link.expired' ? 'expired' : 'cancelled';
    const linkId = String(link.id);
    return [
      {
        trigger: paid ? 'payment.paid' : 'payment.expired',
        externalId: `${paid ? 'paid' : 'closed'}:${linkId}`,
        contact: paymentContact(payment.customer),
        data: { payment },
        // Paid or closed, reminders about this link are over.
        cancels: [paymentCorrelation('razorpay', linkId)],
      },
    ];
  }
  if (event === 'payment.failed') {
    // Only payments for links this app made: the link's notes travel with its payments.
    const notes = obj(pay.notes);
    if (!pay.id || !str(notes.wacrm_ref)) return [];
    const currency = str(pay.currency) ?? 'INR';
    const payment: Payment = {
      id: String(pay.id),
      linkId: str(notes.wacrm_link),
      reference: str(notes.wacrm_ref),
      amount: fromMinorUnits(Number(pay.amount ?? 0), currency),
      currency,
      status: 'failed',
      url: null,
      description: str(pay.description),
      method: str(pay.method),
      error: str(pay.error_description) ?? 'The payment failed',
      customer: { name: null, phone: str(pay.contact), email: str(pay.email) },
    };
    return [
      {
        trigger: 'payment.failed',
        externalId: `failed:${String(pay.id)}`,
        contact: paymentContact(payment.customer),
        data: { payment },
      },
    ];
  }
  return [];
}

export const razorpay: ConnectorDefinition = {
  key: 'razorpay',
  name: 'Razorpay',
  description: 'Send Razorpay payment links in flows, remind until paid, and react to payments.',
  category: 'payments',
  website: 'https://razorpay.com',
  auth: {
    type: 'api_key',
    fields: [
      { key: 'keyId', label: 'Key id', placeholder: 'rzp_live_...' },
      { key: 'keySecret', label: 'Key secret', type: 'secret' },
    ],
  },
  settings: [
    {
      key: 'defaultCurrency',
      label: 'Default currency',
      required: false,
      placeholder: 'INR',
    },
  ],
  normalizeSettings(settings) {
    const currency = (settings.defaultCurrency ?? '').trim().toUpperCase() || 'INR';
    if (!/^[A-Z]{3}$/.test(currency)) return 'The currency is three letters, such as INR';
    return { ...settings, defaultCurrency: currency };
  },
  triggers: PAYMENT_TRIGGERS,
  actions: [
    {
      key: 'create_payment_link',
      name: 'Create a payment link',
      description: 'A Razorpay link for an amount, to send in the next step',
      input: PAYMENT_LINK_INPUT,
      output: PAYMENT_LINK_OUTPUT,
      async run(ctx, input) {
        const currency = (input.currency || ctx.settings.defaultCurrency || 'INR').toUpperCase();
        const amount = toMinorUnits(input.amount ?? '', currency);
        if (!amount) throw new ConnectorError(`"${input.amount ?? ''}" is not an amount`);
        const reference = paymentReference(ctx.idempotencyKey);
        const minutes = Number(input.expiresInMinutes || 0);
        const body: Json = {
          amount,
          currency,
          description: (input.description ?? '').slice(0, 2048),
          reference_id: reference,
          customer: {
            ...(input.name ? { name: input.name } : {}),
            ...(asPhone(input.phone) ? { contact: asPhone(input.phone) } : {}),
            ...(input.email ? { email: input.email } : {}),
          },
          // The flow sends the link and the reminders on WhatsApp.
          notify: { sms: false, email: false },
          reminder_enable: false,
          notes: { wacrm_ref: reference },
          // Razorpay needs at least 15 minutes.
          ...(minutes > 0
            ? { expire_by: Math.floor(Date.now() / 1000) + Math.max(16, minutes) * 60 }
            : {}),
        };
        const res = await call(ctx, 'POST', '/payment_links', body);
        if (res.ok) return { ...linkOutput(razorpayLink(obj(res.json))) };
        // A repeat of the same flow step: the link exists already, so hand that one back.
        if (res.status === 400 && /reference/i.test(errorText(res.json))) {
          const found = await call(
            ctx,
            'GET',
            `/payment_links?reference_id=${encodeURIComponent(reference)}`,
          );
          const first = obj((obj(found.json).payment_links as unknown[] | undefined)?.[0]);
          if (found.ok && first.id) return { ...linkOutput(razorpayLink(first)) };
        }
        throw new ConnectorError(errorText(res.json));
      },
      correlation: (out) =>
        typeof out.linkId === 'string' ? paymentCorrelation('razorpay', out.linkId) : null,
    },
    {
      key: 'check_payment_link',
      name: 'Check a payment link',
      description: 'Whether a link has been paid',
      input: [{ key: 'linkId', label: 'Link id', placeholder: '{{vars.link_id}}' }],
      output: ['status', 'amount', 'paid', 'url'],
      async run(ctx, input) {
        const id = (input.linkId ?? '').trim();
        const res = await call(ctx, 'GET', `/payment_links/${encodeURIComponent(id)}`);
        if (res.status === 404 || res.status === 400) throw new ConnectorError(`No link ${id}`);
        if (!res.ok) throw new ConnectorError(errorText(res.json));
        const link = razorpayLink(obj(res.json));
        return {
          status: link.status,
          amount: link.amount,
          paid: link.status === 'paid',
          url: link.url,
        };
      },
    },
  ],
  webhook: {
    verify: (req, secret) =>
      verifyHmacSha256(req.rawBody, secret, req.headers['x-razorpay-signature']),
    deliveryId: (req) => req.headers['x-razorpay-event-id'] ?? null,
    map: (body) => mapRazorpay(body),
  },
  async healthCheck(ctx) {
    const res = await call(ctx, 'GET', '/payment_links?count=1');
    if (!res.ok) throw new ConnectorError(errorText(res.json));
  },
};

function linkOutput(p: Payment) {
  return {
    linkId: p.linkId,
    url: p.url,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    reference: p.reference,
  };
}
