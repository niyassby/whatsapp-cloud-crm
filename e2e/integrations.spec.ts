/**
 * Phase 3.4 through the real UI, API and worker, with the Demo Store connector and a fake store
 * this test runs. Connect it, receive a signed order webhook, and watch a flow look the order up.
 */
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, type Page, test } from '@playwright/test';
import { createWorkspace, logIn } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;
let store: Server;
let storeUrl: string;
const storeCalls: string[] = [];

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
  store = createServer((req, res) => {
    storeCalls.push(`${req.method} ${req.url} ${req.headers.authorization ?? ''}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end('{}');
    const order = /^\/orders\/(\w+)$/.exec(req.url ?? '');
    if (order) return res.end(JSON.stringify({ id: order[1], status: 'shipped', total: '499.00' }));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise<void>((r) => store.listen(0, '127.0.0.1', r));
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
  await new Promise((r) => store?.close(r));
});

test('connect a store, receive an order, and a flow looks it up', async () => {
  test.setTimeout(240_000);
  await owner.goto('/integrations');
  await owner.getByRole('button', { name: 'Connect Demo Store' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Main shop');
  await dialog.getByLabel('Store API address').fill(storeUrl);
  await dialog.getByLabel('API key').fill('store-key-1');
  await dialog.getByRole('button', { name: 'Connect' }).click();

  const webhookUrl = (await dialog.getByTestId('webhook-url').textContent())!.trim();
  const secret = (await dialog.getByTestId('shown-once-value').textContent())!.trim();
  expect(webhookUrl).toMatch(/\/integrations\/hooks\//);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(owner.getByRole('heading', { name: 'Main shop' })).toBeVisible();
  // The health check runs straight after connecting, against the fake store.
  await expect.poll(() => storeCalls.some((c) => c.startsWith('GET /health'))).toBe(true);

  // A flow: when an order is placed, look it up and keep its status.
  await owner.goto('/flows');
  await owner.getByRole('button', { name: 'New flow' }).click();
  await owner.getByRole('dialog').getByLabel('Name').fill('Order lookup');
  await owner.getByRole('dialog').getByRole('button', { name: 'Create flow' }).click();
  await expect(owner.getByLabel('Flow name')).toHaveValue('Order lookup');
  await owner.getByTestId('step-trigger').click();
  const trigger = owner.getByLabel('Trigger settings');
  await trigger.getByLabel('Trigger', { exact: true }).click();
  await owner.getByRole('option', { name: 'Integration event' }).click();
  await trigger.getByLabel('App', { exact: true }).click();
  await owner.getByRole('option', { name: 'Demo Store' }).click();
  await expect(trigger.getByLabel('Event', { exact: true })).toContainText('Order placed');

  await owner.getByRole('button', { name: 'Add Integration', exact: true }).click();
  const step = owner.getByLabel('Step settings');
  await step.getByLabel('App', { exact: true }).click();
  await owner.getByRole('option', { name: 'Demo Store' }).click();
  await step.getByLabel('Action', { exact: true }).click();
  await owner.getByRole('option', { name: 'Look up an order' }).click();
  await step.getByRole('button', { name: 'Insert variable into Order number' }).click();
  await owner.getByRole('menuitem', { name: /^order\.id/ }).click();
  await expect(step.getByLabel('Order number', { exact: true })).toHaveValue(
    '{{trigger.data.order.id}}',
  );
  await step.getByLabel('Save status as').fill('state');
  await expect(owner.getByTestId('save-status')).toHaveText('Draft saved', { timeout: 15_000 });
  await owner.getByRole('button', { name: 'Publish' }).click();
  await expect(owner.getByText('v1')).toBeVisible();
  await owner.getByRole('button', { name: 'Turn on' }).click();
  await expect(owner.getByRole('button', { name: 'Turn off' })).toBeVisible();

  // The store sends a signed webhook for a new order.
  const body = JSON.stringify({
    type: 'order.created',
    order: { id: 'A1001', total: '499.00', customer: { phone: '+91 98113 55001', name: 'Farah' } },
  });
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const send = (sig: string) =>
    fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-demo-signature': sig,
        'x-demo-delivery': 'd-1',
      },
      body,
    });
  expect((await send('sha256=forged')).status).toBe(401);
  expect((await send(signature)).status).toBe(200);

  // The flow ran: it called the store for that order and saved its status.
  await expect
    .poll(() => storeCalls.some((c) => c === 'GET /orders/A1001 Bearer store-key-1'), {
      timeout: 60_000,
    })
    .toBe(true);
  await owner.getByRole('tab', { name: /Runs/ }).click();
  await expect(owner.getByText('Completed')).toBeVisible({ timeout: 30_000 });
  await owner.getByRole('button', { name: 'Farah' }).click();
  await expect(owner.getByRole('dialog')).toContainText('"state": "shipped"');
  await owner.keyboard.press('Escape');

  // The connection's log shows both directions.
  await owner.goto('/integrations');
  await owner.getByRole('link', { name: 'Main shop' }).click();
  const events = owner.getByRole('table', { name: 'Events' });
  await expect(events).toContainText('order.created');
  await expect(events).toContainText('lookup_order');
  await expect(events).toContainText('processed');
  await expect(events).toContainText('succeeded');
});

test('agents do not see integrations', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await expect(agent.getByRole('link', { name: 'Integrations' })).toHaveCount(0);
  await agent.context().close();
});
