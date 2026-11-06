/**
 * A fake Stripe for e2e: enough of its API for checkout, subscriptions and the portal, plus a hosted
 * "payment page". Paying sends real signed webhooks to the API, each of them twice, because the
 * acceptance test is that a repeated delivery changes nothing.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { URLSearchParams } from 'node:url';
import { API_URL, PORTS, STRIPE_WEBHOOK_SECRET } from './config.mjs';

const BASE = `http://127.0.0.1:${PORTS.payments}`;
const sessions = new Map();
const subscriptions = new Map();

const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });

async function deliver(type, object) {
  const body = JSON.stringify({ id: `evt_${randomUUID()}`, type, data: { object } });
  const signed = () => {
    const at = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${at}.${body}`).digest('hex');
    return `t=${at},v1=${v1}`;
  };
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${API_URL}/webhooks/stripe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': signed() },
      body,
    });
    if (!res.ok) console.error(`fake payments: webhook answered ${res.status}`);
  }
}

const subscriptionJson = (sub) => ({
  id: sub.id,
  status: sub.status,
  customer: sub.customer,
  cancel_at_period_end: sub.cancelAtPeriodEnd,
  metadata: sub.metadata,
  items: {
    data: [
      {
        id: `si_${sub.id}`,
        price: { id: sub.price },
        current_period_start: sub.start,
        current_period_end: sub.end,
      },
    ],
  },
});

async function pay(session) {
  session.paid = true;
  if (session.mode === 'payment') {
    await deliver('checkout.session.completed', {
      id: session.id,
      mode: 'payment',
      payment_status: 'paid',
      payment_intent: `pi_${session.id}`,
      amount_total: session.amount,
      currency: session.currency,
      metadata: session.metadata,
    });
    return;
  }
  const now = Math.floor(Date.now() / 1000);
  const sub = {
    id: `sub_${randomUUID()}`,
    status: 'active',
    customer: `cus_${randomUUID()}`,
    cancelAtPeriodEnd: false,
    metadata: session.metadata,
    price: session.price,
    start: now,
    end: now + 30 * 86400,
  };
  subscriptions.set(sub.id, sub);
  await deliver('customer.subscription.created', subscriptionJson(sub));
  await deliver('invoice.paid', {
    id: `in_${randomUUID()}`,
    currency: 'inr',
    amount_paid: 749900,
    parent: {
      type: 'subscription_details',
      subscription_details: { subscription: sub.id, metadata: sub.metadata },
    },
    lines: { data: [{ period: { start: sub.start, end: sub.end } }] },
  });
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const url = new URL(req.url, BASE);
  const body = await readBody(req);
  const form = new URLSearchParams(body);

  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    const metadata = {};
    for (const [key, value] of form) {
      const match = key.match(/^metadata\[(.+)\]$/);
      if (match) metadata[match[1]] = value;
    }
    const session = {
      id: `cs_${randomUUID()}`,
      mode: form.get('mode'),
      metadata,
      amount: Number(form.get('line_items[0][price_data][unit_amount]')),
      currency: form.get('line_items[0][price_data][currency]'),
      price: form.get('line_items[0][price]'),
      successUrl: form.get('success_url'),
    };
    sessions.set(session.id, session);
    return json(res, 200, { id: session.id, url: `${BASE}/pay/${session.id}` });
  }

  const payMatch = url.pathname.match(/^\/pay\/(.+)$/);
  if (payMatch) {
    const session = sessions.get(payMatch[1]);
    if (!session) return json(res, 404, {});
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(
        `<!doctype html><title>Fake checkout</title><h1>Fake checkout</h1>
         <form method="post"><button>Pay</button></form>`,
      );
    }
    await pay(session);
    res.writeHead(303, { location: session.successUrl });
    return res.end();
  }

  const subMatch = url.pathname.match(/^\/v1\/subscriptions\/(.+)$/);
  if (subMatch) {
    const sub = subscriptions.get(subMatch[1]);
    if (!sub) return json(res, 404, { error: { message: 'No such subscription' } });
    if (req.method === 'POST') {
      const price = form.get('items[0][price]');
      if (price) sub.price = price;
      if (form.has('cancel_at_period_end')) {
        sub.cancelAtPeriodEnd = form.get('cancel_at_period_end') === 'true';
      }
      await deliver('customer.subscription.updated', subscriptionJson(sub));
    }
    return json(res, 200, subscriptionJson(sub));
  }

  if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') {
    return json(res, 200, { url: `${BASE}/portal` });
  }
  if (url.pathname === '/portal') {
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end('<!doctype html><title>Fake portal</title><h1>Fake portal</h1>');
  }
  return json(res, 404, { error: { message: `No fake for ${url.pathname}` } });
}).listen(PORTS.payments, '127.0.0.1');
