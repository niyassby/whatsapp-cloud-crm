/**
 * Phase 2.3: the wallet through the real UI. Sample prices from prisma/sample-rate-cards.csv:
 * marketing to India costs 0.90.
 */
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from './support/config.mjs';
import { createWorkspace, customerSays, logIn, openConversation } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ws.token}`,
      ...init.headers,
    },
  });

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
});

test.afterAll(async () => {
  await owner?.context().close();
});

test('the wallet shows the balance and how it got there', async () => {
  await owner.goto('/wallet');
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹1,000.00');
  const ledger = owner.getByRole('table').last();
  await expect(ledger).toContainText('Adjustment');
  await expect(ledger).toContainText('E2E balance');
  await expect(owner.getByText('Current prices')).toBeVisible();
});

test('a template shows its price, charges the wallet, and appears live', async ({ browser }) => {
  await customerSays(ws, 'From last week', {
    from: '919812345678',
    name: 'Paying Priya',
    ageHours: 48,
  });

  // A second session stays on the wallet page, to see the charge arrive.
  const watcher = await logIn(browser, ws.ownerEmail);
  await watcher.goto('/wallet');
  await expect(watcher.getByTestId('wallet-balance')).toHaveText('₹1,000.00');

  await owner.goto('/inbox');
  await openConversation(owner, 'Paying Priya');
  // A window that closed long ago: utility costs money here as well.
  await owner.getByRole('button', { name: 'Send a template' }).click();
  await owner.getByRole('button', { name: /order_update/ }).click();
  await expect(owner.getByText(/This send costs ₹0\.15/)).toBeVisible();
  await owner.getByLabel('Body {{1}}').fill('Priya');
  await owner.getByRole('button', { name: 'Send template' }).click();
  await expect(owner.getByRole('log')).toContainText('Hi Priya, your order is ready.');

  await expect(watcher.getByTestId('wallet-balance')).toHaveText('₹999.85');
  await watcher.context().close();

  await owner.goto('/wallet');
  await expect(owner.getByRole('table').last()).toContainText('Charge');
  await expect(owner.getByRole('table').last()).toContainText('-₹0.15');
  await expect(owner.getByRole('table').first()).toContainText('utility', { ignoreCase: true });
});

test('a failed delivery gives the money back', async () => {
  await customerSays(ws, 'From last week', {
    from: '919800000099',
    name: 'Failing Farah',
    ageHours: 48,
  });
  const before = (await (await api('/wallet')).json()).balanceMicros as number;

  await owner.goto('/inbox');
  await openConversation(owner, 'Failing Farah');
  await owner.getByRole('button', { name: 'Send a template' }).click();
  await owner.getByRole('button', { name: /order_update/ }).click();
  await owner.getByLabel('Body {{1}}').fill('Farah');
  await owner.getByRole('button', { name: 'Send template' }).click();

  await expect
    .poll(async () => {
      const entries = (await (await api('/wallet/ledger?type=refund')).json()).items;
      return entries.length;
    })
    .toBeGreaterThan(0);
  expect((await (await api('/wallet')).json()).balanceMicros).toBe(before);
});

test('the low balance banner and alert setting', async () => {
  const res = await api('/wallet', {
    method: 'PATCH',
    body: JSON.stringify({ lowBalanceThreshold: '5000' }),
  });
  expect(res.status).toBe(200);

  await owner.goto('/wallet');
  await expect(owner.getByText(/Your wallet is low/)).toBeVisible();
  await owner.getByLabel('Alert below (INR)').fill('10');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(owner.getByText(/Your wallet is low/)).toHaveCount(0);
});

test('the ledger exports to a file', async () => {
  await owner.goto('/wallet');
  const [download] = await Promise.all([
    owner.waitForEvent('download'),
    owner.getByRole('button', { name: 'Export CSV' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^wallet-ledger-.*\.csv$/);
});

test('agents have no wallet page, and no wallet in the menu', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await expect(agent.getByRole('link', { name: 'Wallet' })).toHaveCount(0);
  await agent.goto('/wallet');
  await expect(agent.getByText('Only owners and admins can see the wallet.')).toBeVisible();
  await agent.context().close();
});

test('with an empty wallet a paid send is refused, and replies still work', async ({ browser }) => {
  // A number is live in one workspace at a time, so this takes it over.
  await ws.disconnect();
  const broke = await createWorkspace({ funded: false });
  const page = await logIn(browser, broke.ownerEmail);
  try {
    // Outside the window, so a template is the only option and it costs money.
    await customerSays(broke, 'From last week', {
      from: '919812345670',
      name: 'Broke Bina',
      ageHours: 48,
    });
    await openConversation(page, 'Broke Bina');
    await page.getByRole('button', { name: 'Send a template' }).click();
    await page.getByRole('button', { name: /order_update/ }).click();
    await page.getByLabel('Body {{1}}').fill('Bina');
    await page.getByRole('button', { name: 'Send template' }).click();
    await expect(page.getByText('The wallet balance is too low for this send')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('log')).not.toContainText('Hi Bina');

    // The default alert threshold is above zero, so the banner says what happened.
    await expect(page.getByText(/Your wallet is empty/)).toBeVisible();

    // A customer who writes in can still be answered, for free.
    await customerSays(broke, 'Are you open today?', { from: '919812345670', name: 'Broke Bina' });
    await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Yes, until six.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('log')).toContainText('Yes, until six.');
    await expect(page.getByRole('log').getByRole('img', { name: 'Read' })).toBeVisible();
  } finally {
    await page.context().close();
    await broke.disconnect();
  }
});
