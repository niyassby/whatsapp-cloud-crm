/**
 * One shape for store events, whatever the store. Shopify, WooCommerce and custom stores all map
 * to it, so a flow (and a template's variables) reads {{trigger.data.order.name}} the same way
 * for each, and a flow built for one store works for another.
 */
import type { ConnectorTrigger } from './types';

export interface CommerceCustomer {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface CommerceItem {
  name: string;
  quantity: number;
  price: string | null;
}

export interface CommerceTracking {
  number: string | null;
  url: string | null;
  company: string | null;
}

export interface CommerceOrder {
  id: string;
  /** What the customer sees, such as "#1001". */
  name: string;
  number: string;
  status: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  total: string;
  currency: string;
  createdAt: string | null;
  customer: CommerceCustomer;
  items: CommerceItem[];
  /** "2 × Masala chai, 1 × Mug", for a template line. */
  itemsSummary: string;
  /** The store's order status page, when it has one. */
  statusUrl: string | null;
  shippingAddress: string | null;
  tracking: CommerceTracking | null;
}

export interface CommerceCheckout {
  id: string;
  token: string;
  /** Where the customer finishes paying. */
  recoveryUrl: string | null;
  total: string;
  currency: string;
  customer: CommerceCustomer;
  items: CommerceItem[];
  itemsSummary: string;
}

export interface CommerceShipment {
  id: string;
  /** pending, success, cancelled... */
  status: string | null;
  /** in_transit, out_for_delivery, delivered... when the carrier reports it. */
  shipmentStatus: string | null;
  tracking: CommerceTracking;
}

export const summarizeItems = (items: CommerceItem[], max = 5) => {
  const shown = items.slice(0, max).map((i) => `${i.quantity} × ${i.name}`);
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
};

export const fullName = (first: string | null, last: string | null) =>
  [first, last].filter(Boolean).join(' ') || null;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null;
export { str as asText };

const SAMPLE_CUSTOMER: CommerceCustomer = {
  firstName: 'Asha',
  lastName: 'Rao',
  name: 'Asha Rao',
  email: 'asha@example.com',
  phone: '+919800000001',
};

const SAMPLE_ORDER: CommerceOrder = {
  id: '5551234',
  name: '#1001',
  number: '1001',
  status: 'open',
  financialStatus: 'paid',
  fulfillmentStatus: 'fulfilled',
  total: '1499.00',
  currency: 'INR',
  createdAt: '2026-11-11T10:00:00Z',
  customer: SAMPLE_CUSTOMER,
  items: [{ name: 'Masala chai', quantity: 2, price: '499.00' }],
  itemsSummary: '2 × Masala chai',
  statusUrl: 'https://store.example.com/orders/abc',
  shippingAddress: '12 MG Road, Bengaluru, India',
  tracking: {
    number: 'BD123456789IN',
    url: 'https://track.example.com/BD123456789IN',
    company: 'Blue Dart',
  },
};

/** The store triggers every commerce connector offers (each picks those it supports). */
export const COMMERCE_TRIGGERS: Record<string, ConnectorTrigger> = {
  'order.created': {
    key: 'order.created',
    name: 'Order placed',
    description: 'A customer placed an order. Use it for an order confirmation.',
    sample: { order: SAMPLE_ORDER },
  },
  'order.paid': {
    key: 'order.paid',
    name: 'Order paid',
    description: 'Payment for an order was received',
    sample: { order: SAMPLE_ORDER },
  },
  'order.fulfilled': {
    key: 'order.fulfilled',
    name: 'Order shipped',
    description: 'An order was fulfilled or marked complete. Use it for a shipping update.',
    sample: { order: SAMPLE_ORDER },
  },
  'order.cancelled': {
    key: 'order.cancelled',
    name: 'Order cancelled',
    description: 'An order was cancelled',
    sample: { order: SAMPLE_ORDER },
  },
  'shipment.updated': {
    key: 'shipment.updated',
    name: 'Delivery update',
    description: 'A shipment moved on: in transit, out for delivery, delivered',
    sample: {
      order: SAMPLE_ORDER,
      shipment: {
        id: '777',
        status: 'success',
        shipmentStatus: 'out_for_delivery',
        tracking: SAMPLE_ORDER.tracking!,
      } satisfies CommerceShipment,
    },
  },
  'checkout.started': {
    key: 'checkout.started',
    name: 'Checkout started',
    description:
      'A customer gave their phone at checkout. Add a delay for abandoned-cart recovery; the order cancels the reminder.',
    sample: {
      checkout: {
        id: '9001',
        token: 'c1a2b3',
        recoveryUrl: 'https://store.example.com/checkouts/c1a2b3/recover',
        total: '1499.00',
        currency: 'INR',
        customer: SAMPLE_CUSTOMER,
        items: SAMPLE_ORDER.items,
        itemsSummary: SAMPLE_ORDER.itemsSummary,
      } satisfies CommerceCheckout,
    },
  },
  'customer.created': {
    key: 'customer.created',
    name: 'New customer',
    description: 'A customer account was created',
    sample: { customer: SAMPLE_CUSTOMER },
  },
};

export const commerceTriggers = (...keys: string[]): ConnectorTrigger[] =>
  keys.map((k) => {
    const t = COMMERCE_TRIGGERS[k];
    if (!t) throw new Error(`No commerce trigger ${k}`);
    return t;
  });

/** Correlation for a checkout: the order that completes it cancels its reminder. */
export const checkoutCorrelation = (token: string) => `checkout:${token}`;
