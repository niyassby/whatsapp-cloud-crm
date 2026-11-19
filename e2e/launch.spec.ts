/**
 * Phase 4.5: the launch journey, start to finish in the browser, the way a new business would do
 * it. Sign up, pay to add funds, connect a WhatsApp number, answer a customer, record their
 * consent and send them a broadcast. Unlike the other specs, nothing is set up through the API:
 * every step is the real UI, against the fake Meta and fake Stripe.
 *
 * It also runs against a deployed environment (E2E_EXTERNAL=1, infra/deployment.md), which is
 * how a fresh deployment is accepted.
 */
import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { customerSays, PASSWORD, PHONE_ID } from './support/helpers';

test.describe.configure({ mode: 'serial' });

const tag = randomUUID().slice(0, 8);
const email = `launch-${tag}@e2e.test`;
const wabaId = `${tag.replace(/\D/g, '2').padEnd(12, '2')}777`;
const customer = { from: `9197${String(Date.now()).slice(-8)}`, name: 'Lakshmi Launch' };

let page: Page;
let connected = false;

const choose = async (label: string, option: RegExp | string) => {
  await page.getByLabel(label).click();
  await page.getByRole('option', { name: option }).click();
};

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
});

test.afterAll(async () => {
  // A number is live in one workspace at a time: free it for the other specs.
  if (connected) {
    await page.goto('/settings/whatsapp');
    const disconnect = page.getByRole('button', { name: `Disconnect ${PHONE_ID}` });
    // The list loads after the page: wait for the button rather than checking once.
    await expect(disconnect).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await disconnect.click();
    await expect(disconnect).toHaveCount(0);
  }
  await page?.context().close();
});

test('a new business signs up and lands in its inbox', async () => {
  await page.goto('/signup');
  await page.getByLabel('Your name').fill('Lena Launch');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByLabel('Business name').fill(`Launch Bakery ${tag}`);
  await page.getByRole('button', { name: 'Create workspace' }).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
});

test('it pays for wallet credit, and the payment is credited once', async () => {
  await page.goto('/settings/billing');
  await page.getByLabel('Business name').fill(`Launch Bakery ${tag}`);
  await page.getByLabel('Country (two letters)').fill('IN');
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  await page.goto('/wallet');
  await expect(page.getByTestId('wallet-balance')).toHaveText('₹0.00');
  await page.getByRole('button', { name: 'Add funds' }).click();
  await page.getByLabel(/Amount to add/).fill('500');
  await expect(page.getByTestId('topup-quote')).toContainText('₹590.00');
  await page.getByRole('button', { name: 'Continue to payment' }).click();

  await expect(page.getByRole('heading', { name: 'Fake checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay' }).click();
  await expect(page).toHaveURL(/\/wallet\?payment=done/);
  await expect(page.getByTestId('wallet-balance')).toHaveText('₹500.00');
  // The fake sends each webhook twice; a second credit would show by now.
  await page.waitForTimeout(2_000);
  await page.reload();
  await expect(page.getByTestId('wallet-balance')).toHaveText('₹500.00');
});

test('it connects a WhatsApp number', async () => {
  await page.goto('/settings/whatsapp');
  await page.getByRole('button', { name: 'Connect with a token' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('System user access token').fill('fake-token-for-the-e2e-graph-server');
  await dialog.getByLabel('WhatsApp Business Account ID').fill(wabaId);
  await dialog.getByLabel('Phone number ID').fill(PHONE_ID);
  await dialog.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByText(/is connected/)).toBeVisible();
  connected = true;
  await expect(page.getByText('Connected', { exact: true }).first()).toBeVisible();
});

test('a customer writes in and gets an answer', async () => {
  await page.goto('/inbox');
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await customerSays({ wabaId }, 'Hello, do you deliver on Sundays?', customer);

  await page
    .getByRole('button', { name: new RegExp(customer.name) })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: customer.name, level: 2 })).toBeVisible();
  await expect(page.getByRole('log')).toContainText('do you deliver on Sundays?');

  await page.getByRole('textbox', { name: 'Message', exact: true }).fill('Yes, until 1 pm.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('log')).toContainText('Yes, until 1 pm.');
  // The fake Meta reports delivery and reading through signed webhooks.
  await expect(page.getByRole('log').getByRole('img', { name: 'Read' }).last()).toBeVisible();
});

test('the customer agrees to marketing, and a broadcast reaches them', async () => {
  await page.goto('/contacts');
  await page.getByRole('link', { name: customer.name }).click();
  await page.getByRole('button', { name: 'Record opt-in' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Where consent came from').fill('Asked in chat');
  await dialog.getByLabel('Proof of consent').fill('Customer replied YES on WhatsApp');
  await dialog.getByRole('button', { name: 'Save consent' }).click();
  await expect(page.getByRole('button', { name: 'Record opt-in' })).toHaveCount(0);

  await page.goto('/campaigns');
  await page.getByRole('link', { name: 'New campaign' }).click();
  await page.getByLabel('Campaign name').fill('Sunday sale');
  await choose('WhatsApp number', /\+|\d/);
  await choose('Approved template', /e2e_promo/);
  await page.getByRole('button', { name: 'Save and review' }).click();

  await expect(page.getByTestId('estimate-sendable')).toHaveText('1');
  await page.getByRole('button', { name: 'Start campaign' }).click();
  await expect(page.getByTestId('campaign-status')).toHaveText('Completed', { timeout: 30_000 });
  await expect(page.getByTestId('stat-sent')).toHaveText('1');
  await expect(page.getByTestId('stat-delivered')).toHaveText('1', { timeout: 15_000 });
  // A marketing template to India costs 0.90 in the sample rate cards.
  await expect(page.getByTestId('stat-cost')).toHaveText('₹0.90');

  await page.goto('/wallet');
  await expect(page.getByTestId('wallet-balance')).toHaveText('₹499.10');
});
