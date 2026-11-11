/**
 * Payment, Sheets and HubSpot connectors. Payloads follow Razorpay's, Stripe's, Google's and
 * HubSpot's documented shapes, trimmed and masked; they have not been checked against live traffic.
 */
import { describe, expect, it } from 'vitest';
import {
  buildRegistry,
  type ConnectorContext,
  fromMinorUnits,
  googleSheets,
  hmacSha256,
  hubspot,
  type HttpRequest,
  type HttpResponse,
  mapRazorpay,
  mapStripe,
  paymentReference,
  razorpay,
  splitValues,
  spreadsheetId,
  stripe,
  STRIPE_EVENTS,
  toMinorUnits,
  verifyStripeSignature,
} from '../src';

type Reply = { status?: number; json?: unknown };
function fakeCtx(
  replies: (req: HttpRequest) => Reply,
  over: Partial<ConnectorContext> = {},
): { ctx: ConnectorContext; calls: HttpRequest[] } {
  const calls: HttpRequest[] = [];
  const ctx: ConnectorContext = {
    connectionId: 'c1',
    credentials: {},
    settings: {},
    http: async (req): Promise<HttpResponse> => {
      calls.push(req);
      const r = replies(req);
      const status = r.status ?? 200;
      const body = JSON.stringify(r.json ?? {});
      return { status, ok: status >= 200 && status < 300, body, json: r.json ?? {} };
    },
    ...over,
  };
  return { ctx, calls };
}

const action = (def: typeof razorpay, key: string) => {
  const a = def.actions?.find((x) => x.key === key);
  if (!a) throw new Error(key);
  return a;
};

describe('amounts', () => {
  it('converts decimal strings exactly, and refuses what is not an amount', () => {
    expect(toMinorUnits('499', 'INR')).toBe(49900);
    expect(toMinorUnits('499.5', 'inr')).toBe(49950);
    expect(toMinorUnits('1,499.99', 'USD')).toBe(149999);
    expect(toMinorUnits('0.29', 'USD')).toBe(29);
    expect(toMinorUnits('500', 'JPY')).toBe(500);
    expect(toMinorUnits('500.5', 'JPY')).toBeNull();
    for (const bad of ['', '0', '-5', '1.234', 'abc', '1e3']) {
      expect(toMinorUnits(bad, 'INR')).toBeNull();
    }
    expect(fromMinorUnits(49950, 'INR')).toBe('499.50');
    expect(fromMinorUnits(500, 'JPY')).toBe('500');
  });

  it('a flow step repeated after a crash gets the same reference', () => {
    expect(paymentReference('flow:r:n:3')).toBe(paymentReference('flow:r:n:3'));
    expect(paymentReference('flow:r:n:3')).not.toBe(paymentReference('flow:r:n:4'));
    expect(paymentReference(undefined).length).toBeLessThanOrEqual(40);
  });
});

describe('Razorpay', () => {
  const creds = { keyId: 'rzp_test_x', keySecret: 's' };
  const link = {
    id: 'plink_1',
    amount: 149900,
    currency: 'INR',
    status: 'created',
    reference_id: 'wacrm_x',
    short_url: 'https://rzp.io/i/abc',
    description: 'Order #1001',
    customer: { contact: '+919800000001', name: 'Asha' },
  };

  it('makes a link with the contact, no Razorpay reminders, and a correlation for the run', async () => {
    const { ctx, calls } = fakeCtx(() => ({ json: link }), {
      credentials: creds,
      settings: { defaultCurrency: 'INR' },
      idempotencyKey: 'flow:run:node:1',
    });
    const a = action(razorpay, 'create_payment_link');
    const out = await a.run(ctx, {
      amount: '1499',
      description: 'Order #1001',
      phone: '919800000001',
      name: 'Asha',
    });
    expect(out).toMatchObject({
      linkId: 'plink_1',
      url: 'https://rzp.io/i/abc',
      amount: '1499.00',
    });
    expect(a.correlation?.(out)).toBe('payment:razorpay:plink_1');
    const sent = calls[0]!;
    expect(sent.url).toBe('https://api.razorpay.com/v1/payment_links');
    expect(sent.headers?.authorization).toBe(
      `Basic ${Buffer.from('rzp_test_x:s').toString('base64')}`,
    );
    expect(sent.body).toMatchObject({
      amount: 149900,
      currency: 'INR',
      reference_id: paymentReference('flow:run:node:1'),
      customer: { contact: '+919800000001', name: 'Asha' },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { wacrm_ref: paymentReference('flow:run:node:1') },
    });
  });

  it('a repeated step finds the link it already made instead of failing', async () => {
    const { ctx, calls } = fakeCtx(
      (req) =>
        req.method === 'POST'
          ? {
              status: 400,
              json: {
                error: { code: 'BAD_REQUEST_ERROR', description: 'reference_id already exists' },
              },
            }
          : { json: { payment_links: [link] } },
      { credentials: creds, idempotencyKey: 'k' },
    );
    const out = await action(razorpay, 'create_payment_link').run(ctx, {
      amount: '1499',
      description: 'x',
    });
    expect(out.linkId).toBe('plink_1');
    expect(calls[1]!.url).toContain(`reference_id=${paymentReference('k')}`);
  });

  it('a refused key asks for a reconnect; a bad amount is refused before calling', async () => {
    const { ctx } = fakeCtx(() => ({ status: 401 }), { credentials: creds });
    await expect(
      action(razorpay, 'create_payment_link').run(ctx, { amount: '10', description: 'x' }),
    ).rejects.toMatchObject({ opts: { reconnect: true } });
    const { ctx: c2, calls } = fakeCtx(() => ({}), { credentials: creds });
    await expect(
      action(razorpay, 'create_payment_link').run(c2, { amount: 'ten', description: 'x' }),
    ).rejects.toThrow('not an amount');
    expect(calls).toHaveLength(0);
  });

  it('maps paid, expired and failed webhooks, and verifies the signature', () => {
    const paid = {
      event: 'payment_link.paid',
      payload: {
        payment_link: { entity: { ...link, status: 'paid' } },
        payment: { entity: { id: 'pay_1', amount: 149900, currency: 'INR', method: 'upi' } },
      },
    };
    const [ev] = mapRazorpay(paid);
    expect(ev).toMatchObject({
      trigger: 'payment.paid',
      externalId: 'paid:plink_1',
      contact: { phone: '+919800000001', name: 'Asha' },
      cancels: ['payment:razorpay:plink_1'],
      data: { payment: { id: 'pay_1', amount: '1499.00', status: 'paid', method: 'upi' } },
    });
    const [expired] = mapRazorpay({
      event: 'payment_link.expired',
      payload: { payment_link: { entity: link } },
    });
    expect(expired).toMatchObject({
      trigger: 'payment.expired',
      cancels: ['payment:razorpay:plink_1'],
    });
    const failed = (notes: object) =>
      mapRazorpay({
        event: 'payment.failed',
        payload: {
          payment: {
            entity: {
              id: 'pay_2',
              amount: 100,
              currency: 'INR',
              contact: '+919800000001',
              error_description: 'Declined',
              notes,
            },
          },
        },
      });
    expect(failed({ wacrm_ref: 'wacrm_x' })[0]).toMatchObject({
      trigger: 'payment.failed',
      data: { payment: { error: 'Declined' } },
    });
    // Other payments on the account are not ours to answer.
    expect(failed({})).toEqual([]);

    const raw = Buffer.from(JSON.stringify(paid));
    const sig = hmacSha256('whs', raw, 'hex');
    expect(
      razorpay.webhook!.verify(
        { rawBody: raw, headers: { 'x-razorpay-signature': sig } },
        'whs',
        {},
      ),
    ).toBe(true);
    expect(
      razorpay.webhook!.verify(
        { rawBody: raw, headers: { 'x-razorpay-signature': sig } },
        'other',
        {},
      ),
    ).toBe(false);
  });
});

describe('Stripe', () => {
  const session = {
    id: 'cs_test_1',
    object: 'checkout.session',
    mode: 'payment',
    url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    amount_total: 2500,
    currency: 'usd',
    status: 'open',
    payment_status: 'unpaid',
    client_reference_id: 'wacrm_x',
    metadata: { wacrm_ref: 'wacrm_x', phone: '14155550100', description: 'Deposit' },
  };

  it('makes a one-time checkout session, idempotent for a repeated step', async () => {
    const { ctx, calls } = fakeCtx(() => ({ json: session }), {
      credentials: { secretKey: 'sk_test_1' },
      settings: { returnUrl: 'https://shop.example/thanks', defaultCurrency: 'USD' },
      idempotencyKey: 'flow:r:n:1',
    });
    const a = action(stripe, 'create_payment_link');
    const out = await a.run(ctx, { amount: '25', description: 'Deposit', phone: '14155550100' });
    expect(out).toMatchObject({ linkId: 'cs_test_1', amount: '25.00', currency: 'USD' });
    expect(a.correlation?.(out)).toBe('payment:stripe:cs_test_1');
    const sent = calls[0]!;
    expect(sent.headers).toMatchObject({
      authorization: 'Bearer sk_test_1',
      'idempotency-key': paymentReference('flow:r:n:1'),
      'content-type': 'application/x-www-form-urlencoded',
    });
    const form = new URLSearchParams(String(sent.body));
    expect(form.get('mode')).toBe('payment');
    expect(form.get('success_url')).toBe('https://shop.example/thanks');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2500');
    expect(form.get('line_items[0][price_data][currency]')).toBe('usd');
    expect(form.get('metadata[phone]')).toBe('14155550100');
    const expires = Number(form.get('expires_at'));
    expect(expires * 1000 - Date.now()).toBeGreaterThan(30 * 60_000);
    expect(expires * 1000 - Date.now()).toBeLessThanOrEqual(24 * 3600_000);
  });

  it('maps paid once for both completion events, failures and expiry', () => {
    const ev = (type: string, over: object = {}) =>
      mapStripe({ id: 'evt', type, data: { object: { ...session, ...over } } });
    expect(ev('checkout.session.completed')).toEqual([]); // not paid yet: a delayed method
    const [paid] = ev('checkout.session.completed', { payment_status: 'paid' });
    const [later] = ev('checkout.session.async_payment_succeeded', { payment_status: 'paid' });
    expect(paid).toMatchObject({
      trigger: 'payment.paid',
      contact: { phone: '14155550100' },
      cancels: ['payment:stripe:cs_test_1'],
      data: { payment: { amount: '25.00', currency: 'USD', status: 'paid', reference: 'wacrm_x' } },
    });
    expect(later!.externalId).toBe(paid!.externalId);
    expect(ev('checkout.session.async_payment_failed')[0]).toMatchObject({
      trigger: 'payment.failed',
    });
    expect(ev('checkout.session.expired')[0]).toMatchObject({ trigger: 'payment.expired' });
    expect(
      ev('checkout.session.completed', { mode: 'subscription', payment_status: 'paid' }),
    ).toEqual([]);
  });

  it('checks the signature with a five-minute tolerance', () => {
    const raw = Buffer.from('{"id":"evt_1"}');
    const now = Date.UTC(2026, 10, 11, 12);
    const t = Math.floor(now / 1000);
    const sig = (secret: string, at = t) =>
      `t=${at},v1=${hmacSha256(secret, Buffer.from(`${at}.${raw.toString()}`), 'hex')}`;
    expect(verifyStripeSignature(raw, 'whsec_1', sig('whsec_1'), now)).toBe(true);
    expect(verifyStripeSignature(raw, 'whsec_1', sig('whsec_2'), now)).toBe(false);
    expect(verifyStripeSignature(raw, 'whsec_1', sig('whsec_1', t - 301), now)).toBe(false);
    expect(verifyStripeSignature(raw, 'whsec_1', 'garbage', now)).toBe(false);
    expect(stripe.webhook!.deliveryId!({ rawBody: raw, headers: {} })).toBe('evt_1');
  });

  it('setup registers the endpoint once and keeps the secret Stripe made', async () => {
    const url = 'https://api.crm.test/integrations/hooks/tok';
    const first = fakeCtx((req) =>
      req.method === 'GET' ? { json: { data: [] } } : { json: { id: 'we_1', secret: 'whsec_new' } },
    );
    first.ctx.credentials = { secretKey: 'sk' };
    expect(await stripe.setup!(first.ctx, { webhookUrl: url })).toEqual({
      credentials: { webhookSecret: 'whsec_new' },
    });
    const form = new URLSearchParams(String(first.calls[1]!.body));
    expect(form.get('url')).toBe(url);
    expect(form.getAll('enabled_events[]')).toEqual([...STRIPE_EVENTS]);

    // Already there, and the secret is kept: nothing to do.
    const again = fakeCtx(() => ({ json: { data: [{ id: 'we_1', url }] } }));
    again.ctx.credentials = { secretKey: 'sk', webhookSecret: 'whsec_new' };
    expect(await stripe.setup!(again.ctx, { webhookUrl: url })).toBeUndefined();
    expect(again.calls).toHaveLength(1);

    // There, but the secret was lost: replaced.
    const lost = fakeCtx((req) =>
      req.method === 'GET'
        ? { json: { data: [{ id: 'we_1', url }] } }
        : { json: { id: 'we_2', secret: 'whsec_2' } },
    );
    lost.ctx.credentials = { secretKey: 'sk' };
    expect(await stripe.setup!(lost.ctx, { webhookUrl: url })).toEqual({
      credentials: { webhookSecret: 'whsec_2' },
    });
    expect(lost.calls.map((c) => c.method)).toEqual(['GET', 'DELETE', 'POST']);
  });

  it('the return page must be https', () => {
    expect(stripe.normalizeSettings!({ returnUrl: 'http://x.example' })).toMatch(/https/);
    expect(stripe.normalizeSettings!({ returnUrl: ' https://x.example/ok ' })).toEqual({
      returnUrl: 'https://x.example/ok',
      defaultCurrency: 'USD',
    });
  });
});

describe('Google Sheets', () => {
  const sheetId = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

  it('reads a spreadsheet from its link and splits values', () => {
    expect(spreadsheetId(`https://docs.google.com/spreadsheets/d/${sheetId}/edit#gid=0`)).toBe(
      sheetId,
    );
    expect(spreadsheetId(sheetId)).toBe(sheetId);
    expect(spreadsheetId('not a sheet')).toBeNull();
    expect(splitValues('Asha | 9198 | a \\| b')).toEqual(['Asha', '9198', 'a | b']);
  });

  it('appends RAW, so a value starting with = is not a formula', async () => {
    const { ctx, calls } = fakeCtx(
      () => ({ json: { updates: { updatedRange: "'Leads'!A7:C7" } } }),
      {
        credentials: { accessToken: 'ya29' },
      },
    );
    const out = await googleSheets.actions![0]!.run(ctx, {
      spreadsheet: sheetId,
      sheet: 'Leads',
      values: '=HYPERLINK("x") | Asha',
    });
    expect(out).toEqual({ updatedRange: "'Leads'!A7:C7", rowNumber: 7 });
    expect(calls[0]!.url).toContain('valueInputOption=RAW');
    expect(calls[0]!.url).toContain(encodeURIComponent("'Leads'!A1"));
    expect(calls[0]!.body).toEqual({ values: [['=HYPERLINK("x")', 'Asha']] });
    expect(calls[0]!.headers?.authorization).toBe('Bearer ya29');
  });

  it('finds a row by its column heading', async () => {
    const values = [
      ['Name', 'Phone', 'Plan'],
      ['Ravi', '919811111111', 'Basic'],
      ['Asha', '919800000001', 'Gold'],
    ];
    const { ctx } = fakeCtx(() => ({ json: { values } }), { credentials: { accessToken: 't' } });
    const lookup = googleSheets.actions![1]!;
    expect(
      await lookup.run(ctx, { spreadsheet: sheetId, column: 'phone', value: '919800000001' }),
    ).toEqual({
      found: true,
      rowNumber: 3,
      row: { Name: 'Asha', Phone: '919800000001', Plan: 'Gold' },
    });
    expect(
      await lookup.run(ctx, { spreadsheet: sheetId, column: 'Phone', value: '1' }),
    ).toMatchObject({
      found: false,
    });
    await expect(
      lookup.run(ctx, { spreadsheet: sheetId, column: 'Email', value: 'x' }),
    ).rejects.toThrow('No column');
  });

  it('asks for offline access so the connection keeps working', () => {
    expect(googleSheets.auth).toMatchObject({
      type: 'oauth2',
      extraAuthorizeParams: { access_type: 'offline', prompt: 'consent' },
    });
  });
});

describe('HubSpot', () => {
  it('updates the contact it finds, and creates one when none matches', async () => {
    let existing: string | null = '501';
    const { ctx, calls } = fakeCtx(
      (req) => {
        if (req.url.endsWith('/search'))
          return { json: { results: existing ? [{ id: existing }] : [] } };
        return { json: { id: existing ?? '777' } };
      },
      { credentials: { accessToken: 'h' } },
    );
    const upsert = hubspot.actions!.find((a) => a.key === 'upsert_contact')!;
    expect(
      await upsert.run(ctx, {
        email: 'Asha@Example.com',
        phone: '919800000001',
        firstName: 'Asha',
        properties: 'company=Chai House | bad name=x',
      }),
    ).toEqual({ contactId: '501', created: false });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://api.hubapi.com/crm/v3/objects/contacts/501');
    expect(patch.body).toEqual({
      properties: {
        email: 'asha@example.com',
        phone: '+919800000001',
        firstname: 'Asha',
        company: 'Chai House',
      },
    });

    existing = null;
    calls.length = 0;
    expect(await upsert.run(ctx, { phone: '919800000001' })).toEqual({
      contactId: '777',
      created: true,
    });
    // Email was not given, so it searched phone and mobile phone before creating.
    expect(calls.filter((c) => c.url.endsWith('/search'))).toHaveLength(2);
    await expect(upsert.run(ctx, {})).rejects.toThrow('email or a phone');
  });

  it('adds a note associated with the contact', async () => {
    const { ctx, calls } = fakeCtx((req) =>
      req.url.endsWith('/search') ? { json: { results: [{ id: '501' }] } } : { json: { id: 'n1' } },
    );
    const note = hubspot.actions!.find((a) => a.key === 'add_note')!;
    expect(await note.run(ctx, { phone: '919800000001', note: 'Asked about #1001' })).toEqual({
      noteId: 'n1',
      contactId: '501',
    });
    expect(calls.at(-1)!.body).toMatchObject({
      properties: { hs_note_body: 'Asked about #1001' },
      associations: [{ to: { id: '501' }, types: [{ associationTypeId: 202 }] }],
    });
  });
});

describe('registry', () => {
  it('accepts every built-in connector', () => {
    const reg = buildRegistry({ env: {} });
    expect(reg.list().map((d) => d.key)).toEqual(
      expect.arrayContaining(['razorpay', 'stripe', 'google_sheets', 'hubspot']),
    );
    // OAuth apps without their environment variables are listed but not available.
    expect(reg.toDto(googleSheets).available).toBe(false);
    expect(reg.toDto(razorpay).available).toBe(true);
  });
});
