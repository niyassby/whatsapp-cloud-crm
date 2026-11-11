/**
 * One shape for payment events, whatever the provider. A flow sends a link made by a payment
 * connector, waits, reminds, and stops when `payment.paid` (or `payment.expired`) arrives for it.
 * Amounts in events and inputs are decimal strings in the currency's main unit ("499.00").
 */
import { createHash, randomUUID } from 'node:crypto';
import type { ConnectorField, ConnectorTrigger, EventContact } from './types';

export interface PaymentCustomer {
  name: string | null;
  phone: string | null;
  email: string | null;
}

export interface Payment {
  /** The payment's own id, once someone has paid or tried to. */
  id: string | null;
  /** The link or checkout session this payment is for. */
  linkId: string | null;
  /** Our reference, set when the link was made from a flow. */
  reference: string | null;
  amount: string;
  currency: string;
  status: string;
  url: string | null;
  description: string | null;
  method: string | null;
  error: string | null;
  customer: PaymentCustomer;
}

/** Currencies with no minor unit (Stripe's list, and Razorpay's subset of it). */
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/** "499.5" INR -> 49950. Exact decimal handling, never floats. Null when it is not an amount. */
export function toMinorUnits(amount: string, currency: string): number | null {
  const clean = amount.replace(/[,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const digits = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
  if (digits === 0 && m[2] && Number(m[2]) !== 0) return null;
  const minor = Number(m[1]) * 10 ** digits + Number((m[2] ?? '').padEnd(digits, '0') || 0);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/** 49950 INR -> "499.50". */
export function fromMinorUnits(minor: number, currency: string): string {
  if (ZERO_DECIMAL.has(currency.toUpperCase())) return String(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A reference the provider can dedupe on: stable for a repeated flow step, else random. */
export function paymentReference(idempotencyKey: string | undefined): string {
  return idempotencyKey
    ? `wacrm_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 30)}`
    : `wacrm_${randomUUID().replace(/-/g, '').slice(0, 30)}`;
}

/** The key a run that made a link answers to; paying or expiring that link stops the run. */
export const paymentCorrelation = (connector: string, linkId: string) =>
  `payment:${connector}:${linkId}`;

export const paymentContact = (c: PaymentCustomer): EventContact | null =>
  c.phone || c.email ? { phone: c.phone, email: c.email, name: c.name } : null;

const SAMPLE_PAYMENT: Payment = {
  id: 'pay_29QQoUBi66xm2f',
  linkId: 'plink_ExjpAUN3gVHrPJ',
  reference: 'wacrm_5f2c1d',
  amount: '1499.00',
  currency: 'INR',
  status: 'paid',
  url: 'https://rzp.io/i/nxrHnLJ',
  description: 'Order #1001',
  method: 'upi',
  error: null,
  customer: { name: 'Asha Rao', phone: '+919800000000', email: 'asha@example.com' },
};

export const PAYMENT_TRIGGERS: ConnectorTrigger[] = [
  {
    key: 'payment.paid',
    name: 'Payment received',
    description: 'A payment link was paid in full',
    sample: { payment: SAMPLE_PAYMENT },
  },
  {
    key: 'payment.failed',
    name: 'Payment failed',
    description: 'Someone tried to pay a link and the payment failed',
    sample: {
      payment: {
        ...SAMPLE_PAYMENT,
        status: 'failed',
        error: 'Payment was declined by the bank',
      },
    },
  },
  {
    key: 'payment.expired',
    name: 'Payment link expired',
    description: 'A link expired or was cancelled before it was paid',
    sample: { payment: { ...SAMPLE_PAYMENT, id: null, status: 'expired', method: null } },
  },
];

/** The inputs every "create a payment link" action takes. */
export const PAYMENT_LINK_INPUT: ConnectorField[] = [
  { key: 'amount', label: 'Amount', placeholder: '499.00' },
  {
    key: 'currency',
    label: 'Currency',
    required: false,
    placeholder: 'INR',
    help: 'Three letters. Empty means the connection’s default currency.',
  },
  { key: 'description', label: 'What it is for', placeholder: 'Order {{trigger.data.order.name}}' },
  {
    key: 'phone',
    label: 'Customer phone',
    required: false,
    placeholder: '{{contact.phone}}',
    help: 'Used to find the contact when the payment arrives.',
  },
  { key: 'name', label: 'Customer name', required: false, placeholder: '{{contact.name}}' },
  { key: 'email', label: 'Customer email', required: false },
  {
    key: 'expiresInMinutes',
    label: 'Expires after (minutes)',
    required: false,
    placeholder: '1440',
  },
];

export const PAYMENT_LINK_OUTPUT = ['linkId', 'url', 'amount', 'currency', 'status', 'reference'];
