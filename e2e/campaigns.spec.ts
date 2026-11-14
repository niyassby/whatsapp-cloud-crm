/**
 * Phase 2.4 through the real UI and a real worker, against the fake Meta, which sends signed status
 * webhooks back. `order_update` is a utility template: 0.15 per send in the sample prices.
 */
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from './support/config.mjs';
import { createWorkspace, customerSays, logIn } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

const api = async (path: string, init: { method?: string; body?: unknown } = {}) => {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.token}` },
  });
  expect(res.ok, `${path} answered ${res.status}`).toBeTruthy();
  return res.json();
};

const choose = async (page: Page, label: string, option: RegExp | string) => {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option }).click();
};

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);

  // Variables come from the template's mapping, so it needs one to reach anybody.
  await expect
    .poll(async () => {
      const list = await api('/templates?q=order_update');
      if (list.items.length === 0) await api('/templates/sync', { method: 'POST' }).catch(() => 0);
      return list.items.length;
    })
    .toBeGreaterThan(0);
  const { items } = await api('/templates?q=order_update');
  await api(`/templates/${items[0].id}`, {
    method: 'PATCH',
    body: {
      category: items[0].category,
      definition: items[0].definition,
      samples: items[0].samples,
      variableMapping: { 'body.1': { source: 'contact', field: 'first_name' } },
    },
  });

  for (const [phone, name] of [
    ['+919811100001', 'Asha Rao'],
    ['+919811100002', 'Bilal Khan'],
  ]) {
    await api('/contacts', { method: 'POST', body: { phone, name } });
  }
  // Someone who said STOP is skipped, even for a utility template.
  await customerSays(ws, 'STOP', { from: '919811100003', name: 'Chitra Stopped' });
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
});

test('a campaign goes from draft to a live report', async () => {
  await owner.goto('/campaigns');
  await owner.getByRole('link', { name: 'New campaign' }).click();
  await owner.getByLabel('Campaign name').fill('Order notices');
  await choose(owner, 'WhatsApp number', /\+|\d/);
  await choose(owner, 'Approved template', /order_update/);
  await owner.getByRole('button', { name: 'Save and review' }).click();

  // The review shows who it reaches and what it costs, before anything sends.
  await expect(owner.getByTestId('estimate-sendable')).toHaveText('2');
  await expect(owner.getByText('₹0.30')).toBeVisible();
  await expect(owner.getByText('1 skipped: Opted out')).toBeVisible();

  await owner.getByRole('button', { name: 'Start campaign' }).click();
  await expect(owner.getByTestId('campaign-status')).toHaveText('Completed', { timeout: 30_000 });
  await expect(owner.getByTestId('stat-sent')).toHaveText('2');
  await expect(owner.getByTestId('stat-skipped')).toHaveText('1');
  await expect(owner.getByTestId('stat-cost')).toHaveText('₹0.30');

  // Delivery receipts and a reply arrive after it finishes, and the open page follows them.
  await expect(owner.getByTestId('stat-delivered')).toHaveText('2', { timeout: 15_000 });
  await customerSays(ws, 'Thanks!', { from: '919811100001', name: 'Asha Rao' });
  await expect(owner.getByTestId('stat-replied')).toHaveText('1', { timeout: 15_000 });

  await expect(owner.getByRole('table')).toContainText('Opted out');

  await owner.goto('/wallet');
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹999.70');

  // A broadcast does not fill the team's inbox, but a reply does.
  await owner.goto('/inbox');
  await expect(owner.getByRole('button', { name: /Asha Rao/ })).toBeVisible();
  await expect(owner.getByRole('button', { name: /Bilal Khan/ })).toHaveCount(0);
});

test('a scheduled campaign shows its time zone, and can be cancelled', async () => {
  await owner.goto('/campaigns/new');
  await owner.getByLabel('Campaign name').fill('Next year');
  await choose(owner, 'WhatsApp number', /\+|\d/);
  await choose(owner, 'Approved template', /order_update/);
  await owner.getByRole('button', { name: 'Save and review' }).click();

  await choose(owner, 'Start', 'At a date and time');
  await owner.locator('#local-time').fill('2099-01-15T09:00');
  await choose(owner, 'Time zone', 'Asia/Tokyo');
  await owner.getByRole('button', { name: 'Schedule campaign' }).click();

  await expect(owner.getByTestId('campaign-status')).toHaveText('Scheduled');
  await expect(owner.getByText('(Asia/Tokyo)')).toBeVisible();

  owner.once('dialog', (dialog) => void dialog.accept());
  await owner.getByRole('button', { name: 'Cancel campaign' }).click();
  await expect(owner.getByTestId('campaign-status')).toHaveText('Cancelled');
});

test('a drip sequence sends its first step to who was enrolled', async () => {
  await api('/segments', {
    method: 'POST',
    body: { name: 'Everyone', filter: { match: 'all', rules: [] } },
  });
  await owner.goto('/campaigns/drips');
  await owner.getByRole('button', { name: 'New sequence' }).click();
  await owner.getByLabel('Name').fill('Welcome');
  await choose(owner, 'WhatsApp number', /\+|\d/);
  await choose(owner, 'Template for step 1', /order_update/);
  await owner.getByRole('button', { name: 'Create sequence' }).click();

  const card = owner.locator('[data-slot="card"]', { hasText: 'Welcome' });
  await card.getByRole('button', { name: 'Activate' }).click();
  await expect(card.getByRole('button', { name: 'Pause' })).toBeVisible();
  await card.getByRole('button', { name: 'Enroll' }).click();
  await owner.getByLabel('Segment').click();
  await owner.getByRole('option', { name: 'Everyone' }).click();
  await owner.getByRole('dialog').getByRole('button', { name: 'Enroll' }).click();
  await expect(card).toContainText('3 in progress');

  // The scheduler runs every 30 seconds. The opted-out contact leaves instead of completing.
  await expect(async () => {
    await owner.reload();
    await expect(card).toContainText('2 completed');
    await expect(card).toContainText('1 left early');
  }).toPass({ timeout: 60_000, intervals: [3_000] });
});

test('the dashboard reports what happened', async () => {
  await owner.goto('/dashboard');
  await expect(owner.getByText('Messages per day')).toBeVisible();
  // The dashboard reads aggregates the worker refreshes every few seconds in this stack.
  await expect(async () => {
    await owner.reload();
    await expect(owner.getByTestId('tile-Delivery rate')).not.toHaveText('—', { timeout: 2_000 });
  }).toPass({ timeout: 60_000, intervals: [3_000] });
  await expect(owner.getByTestId('tile-Active conversations')).not.toHaveText('0');
  await owner.getByRole('button', { name: 'View as table' }).click();
  await expect(owner.getByRole('table')).toContainText('Received');
});

test('agents do not see campaigns or the dashboard', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  const nav = agent.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: 'Inbox' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Campaigns' })).toHaveCount(0);
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toHaveCount(0);
  await agent.context().close();
});
