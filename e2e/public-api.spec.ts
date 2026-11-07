/**
 * Phase 2.6 acceptance: an external script, knowing only an API key, sends a template message and
 * receives a signed webhook for the reply. The key and endpoint are made in the real UI.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from './support/config.mjs';
import { createWorkspace, customerSays, logIn } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;
let receiver: Server;
let receiverUrl: string;
let apiKey = '';
let signingSecret = '';
let templateId = '';
let answerWith = 200;

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  event: { id: string; type: string; data: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test convenience
}
const received: Received[] = [];

/** What a customer would write in their own language. It does not use this repo's helpers. */
function signatureIsValid(secret: string, body: string, header: string | undefined): boolean {
  const t = header?.match(/t=(\d+)/)?.[1];
  const v1 = header?.match(/v1=([0-9a-f]+)/)?.[1];
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const v1 = async (path: string, body?: object) => {
  const res = await fetch(`${API_URL}/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

const eventsOfType = (type: string) => received.filter((r) => r.event.type === type);

test.beforeAll(async ({ browser }) => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers, body, event: JSON.parse(body) });
      res.writeHead(answerWith);
      res.end('ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;

  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
  receiver?.close();
});

test('a key and an endpoint are made in settings, and their secrets shown once', async () => {
  await owner.goto('/settings/api-keys');
  await owner.getByRole('button', { name: 'New key' }).click();
  await owner.getByLabel('Name').fill('Order system');
  for (const label of ['Send messages', 'Read templates', 'Read contacts']) {
    await owner.getByLabel(label).check();
  }
  await owner.getByRole('button', { name: 'Create key' }).click();
  apiKey = (await owner.getByTestId('shown-once-value').textContent()) ?? '';
  expect(apiKey).toMatch(/^wak_/);
  await owner.getByRole('button', { name: 'Done' }).click();
  await expect(owner.getByTestId('shown-once-value')).toHaveCount(0);
  await expect(owner.getByRole('row', { name: /Order system/ })).toContainText('3 permissions');

  await owner.reload();
  await expect(owner.getByText(apiKey)).toHaveCount(0);

  await owner.goto('/settings/webhooks');
  await owner.getByRole('button', { name: 'New endpoint' }).click();
  await owner.getByLabel('Endpoint URL').fill(receiverUrl);
  await owner.getByLabel('A customer sent a message').check();
  await owner.getByLabel('A sent message changed status').check();
  await owner.getByRole('button', { name: 'Create endpoint' }).click();
  signingSecret = (await owner.getByTestId('shown-once-value').textContent()) ?? '';
  expect(signingSecret).toMatch(/^whsec_/);
});

test('acceptance: a script sends a template and receives a signed webhook for the reply', async () => {
  // Everything in this test uses only the key and the secret, as an external script would.
  await expect
    .poll(async () => {
      const { body } = await v1('/templates?q=order_update');
      templateId = body.items?.[0]?.id ?? '';
      return templateId;
    })
    .not.toBe('');

  const sent = await v1('/messages', {
    to: '+919812300001',
    type: 'template',
    templateId,
    variables: { 'body.1': 'Asha' },
    idempotencyKey: 'order-1042',
  });
  expect(sent.status).toBe(201);
  expect(sent.body).toMatchObject({ status: 'queued', body: 'Hi Asha, your order is ready.' });
  expect(sent.headers.get('x-ratelimit-limit')).toBeTruthy();

  // Sending the same key again is the same message.
  const again = await v1('/messages', {
    to: '+919812300001',
    type: 'template',
    templateId,
    variables: { 'body.1': 'Asha' },
    idempotencyKey: 'order-1042',
  });
  expect(again.body.id).toBe(sent.body.id);

  // The send's own progress arrives by webhook.
  await expect
    .poll(() => eventsOfType('message.status').map((r) => r.event.data.message.status), {
      timeout: 30_000,
    })
    .toContain('sent');
  for (const r of eventsOfType('message.status')) {
    expect(r.event.data.message.id).toBe(sent.body.id);
  }

  // The customer replies, and the script hears about it.
  await customerSays(ws, 'Thank you!', { from: '919812300001', name: 'Asha' });
  await expect.poll(() => eventsOfType('message.received').length, { timeout: 30_000 }).toBe(1);
  const [reply] = eventsOfType('message.received');
  expect(reply!.event.data).toMatchObject({
    message: {
      direction: 'inbound',
      body: 'Thank you!',
      conversationId: sent.body.conversationId,
    },
    contact: { waId: '919812300001' },
  });

  // Signed with the secret from settings, over the exact bytes received.
  expect(
    signatureIsValid(signingSecret, reply!.body, reply!.headers['x-wacrm-signature'] as string),
  ).toBe(true);
  expect(
    signatureIsValid('whsec_wrong', reply!.body, reply!.headers['x-wacrm-signature'] as string),
  ).toBe(false);
  expect(
    signatureIsValid(
      signingSecret,
      `${reply!.body} `,
      reply!.headers['x-wacrm-signature'] as string,
    ),
  ).toBe(false);
  expect(reply!.headers['x-wacrm-event-id']).toBe(reply!.event.id);
});

test('a sent message from the API does not open a thread for the team', async () => {
  await v1('/messages', {
    to: '+919812300002',
    type: 'template',
    templateId,
    variables: { 'body.1': 'Bilal' },
  });
  await owner.goto('/inbox');
  await expect(owner.getByRole('button', { name: /919812300001|Asha/ })).toBeVisible();
  await expect(owner.getByRole('button', { name: /919812300002/ })).toHaveCount(0);
});

test('a failure retries, shows in the log, and can be replayed', async () => {
  answerWith = 500;
  await customerSays(ws, 'Is anyone there?', { from: '919812300001', name: 'Asha' });
  await expect
    .poll(() => received.filter((r) => r.event.data.message?.body === 'Is anyone there?').length, {
      timeout: 30_000,
    })
    .toBe(1);
  answerWith = 200;

  await owner.goto('/settings/webhooks');
  const card = owner.getByTestId('webhook-endpoint');
  await card.getByRole('button', { name: 'Delivery log' }).click();
  await expect(card.getByText(/Answered 500|endpoint answered 500/).first()).toBeVisible();
  await expect(card.getByText('Waiting').first()).toBeVisible();

  // A delivered one can be sent again, keeping its event id so a receiver can tell.
  const before = received.length;
  const delivered = card.getByTestId('delivery-message.received').filter({ hasText: 'Delivered' });
  await delivered.first().getByRole('button', { name: 'Replay' }).click();
  await expect.poll(() => received.length, { timeout: 30_000 }).toBeGreaterThan(before);
  const replayed = received.at(-1)!;
  expect(received.slice(0, before).some((r) => r.event.id === replayed.event.id)).toBe(true);
  await expect(card.getByText('Replay', { exact: true }).first()).toBeVisible();
});

test('revoking a key stops the script at once', async () => {
  await owner.goto('/settings/api-keys');
  owner.once('dialog', (dialog) => void dialog.accept());
  await owner
    .getByRole('row', { name: /Order system/ })
    .getByRole('button', { name: 'Revoke' })
    .click();
  await expect(owner.getByRole('row', { name: /Order system/ })).toContainText('Revoked');
  expect((await v1('/templates')).status).toBe(401);
});

test('the API documentation is published', async ({ page }) => {
  await page.goto(`${API_URL}/v1/docs`);
  await expect(page.getByText('WhatsApp CRM API')).toBeVisible();
  await expect(page.getByText('/v1/messages').first()).toBeVisible();
});

test('agents do not see developer settings', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await agent.goto('/settings/api-keys');
  await expect(agent.getByText('Only owners and admins can manage API keys.')).toBeVisible();
  await agent.context().close();
});
