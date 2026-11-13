/**
 * Phase 4.1 through the real UI: a platform admin sets a partner up, the partner creates a client
 * workspace, funds it and looks inside it under a banner, and the client's owner sees who manages
 * the workspace and who was in it.
 */
import { execSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { API_URL, DB_NAME } from './support/config.mjs';
import { inviteTokenFromMailpit, logIn, PASSWORD } from './support/helpers';

const tag = randomUUID().slice(0, 8);
const adminEmail = `admin-${tag}@e2e.test`;
const partnerEmail = `partner-${tag}@e2e.test`;
const ownerEmail = `client-${tag}@e2e.test`;
const partnerName = `Acme Resellers ${tag}`;
const clientName = `Bakery ${tag}`;

let adminToken: string;
let partner: Page;

async function call(path: string, method: string, body: unknown, token?: string) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.${randomBytes(3).join('.')}`,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function signUp(email: string, name: string): Promise<string> {
  const res = await call('/auth/signup', 'POST', {
    name,
    email,
    password: PASSWORD,
    orgName: `${name} HQ`,
  });
  expect(res.status, JSON.stringify(res.data)).toBe(201);
  return res.data.accessToken as string;
}

test.beforeAll(async ({ browser }) => {
  adminToken = await signUp(adminEmail, 'Ada Admin');
  await signUp(partnerEmail, 'Pat Partner');
  // The only way to become a platform admin: the operator tool on the owner connection.
  execSync(`pnpm --filter @wacrm/db exec tsx scripts/admin-grant.ts ${adminEmail}`, {
    env: { ...process.env, DIRECT_URL: `postgresql://wacrm:wacrm@127.0.0.1:5433/${DB_NAME}` },
    stdio: 'pipe',
  });
  const price = await call(
    '/admin/plans/growth/wholesale',
    'PUT',
    { currency: 'INR', amount: '1500' },
    adminToken,
  );
  expect(price.status, JSON.stringify(price.data)).toBe(200);
  partner = await logIn(browser, partnerEmail);
});

test.afterAll(async () => {
  await partner?.context().close();
});

test('a platform admin creates a partner from the admin console', async ({ browser }) => {
  const admin = await logIn(browser, adminEmail);
  await admin.getByRole('button', { name: 'Account menu' }).click();
  await admin.getByRole('menuitem', { name: 'Platform admin' }).click();
  await expect(admin.getByRole('heading', { name: 'Platform admin' })).toBeVisible();

  await admin.getByRole('button', { name: 'New partner' }).click();
  await admin.getByLabel('Name', { exact: true }).fill(partnerName);
  await admin.getByLabel("First staff member's email").fill(partnerEmail);
  await admin.getByRole('button', { name: 'Create partner' }).click();
  await expect(admin.getByRole('row', { name: new RegExp(partnerName) })).toBeVisible();

  await admin.getByRole('tab', { name: 'System' }).click();
  await expect(admin.getByText('Database')).toBeVisible();
  await expect(admin.getByText(/Working, \d+ ms/).first()).toBeVisible();
  await expect(admin.getByRole('cell', { name: 'outbound-messages' })).toBeVisible();
  await admin.context().close();
});

test('someone who is neither sees no console', async ({ browser }) => {
  const stranger = `stranger-${tag}@e2e.test`;
  await signUp(stranger, 'Sam Stranger');
  const page = await logIn(browser, stranger);
  await page.getByRole('button', { name: 'Account menu' }).click();
  await expect(page.getByRole('menuitem', { name: 'Partner console' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.goto('/partner');
  await expect(page.getByText('You do not have access to this console.')).toBeVisible();
  await page.context().close();
});

test('the partner creates a client workspace and funds its wallet', async () => {
  await partner.reload();
  await partner.getByRole('button', { name: 'Account menu' }).click();
  await partner.getByRole('menuitem', { name: 'Partner console' }).click();
  await expect(partner.getByRole('heading', { name: partnerName })).toBeVisible();

  await partner.getByRole('button', { name: 'New client' }).click();
  await partner.getByLabel('Workspace name').fill(clientName);
  await partner.getByLabel("Owner's email").fill(ownerEmail);
  await partner.getByLabel('Team members').fill('3');
  await partner.getByRole('button', { name: 'Create and invite' }).click();

  const row = partner.getByTestId(`client-${clientName}`);
  await expect(row).toContainText('Growth');
  await expect(row).toContainText(ownerEmail);
  // Three seats from the partner's cap; numbers and contacts from the plan.
  await expect(row).toContainText('3 / 3 / 25,000');

  await row.getByRole('button', { name: `Actions for ${clientName}` }).click();
  await partner.getByRole('menuitem', { name: 'Add funds' }).click();
  await partner.getByLabel('Amount (INR)').fill('500');
  await partner.getByLabel('Note').fill('Paid by bank transfer');
  await partner.getByRole('button', { name: /^Add ₹500/ }).click();
  await expect(row).toContainText('₹500.00');
});

test('the client’s owner sees who manages the workspace', async ({ browser }) => {
  const accept = await call('/invitations/accept', 'POST', {
    token: await inviteTokenFromMailpit(ownerEmail),
    name: 'Olive Owner',
    password: PASSWORD,
  });
  expect(accept.status, JSON.stringify(accept.data)).toBe(200);

  const owner = await logIn(browser, ownerEmail);
  await owner.goto('/settings/billing');
  await expect(owner.getByTestId('managed-by')).toContainText(`Managed by ${partnerName}`);
  await expect(owner.getByTestId('current-plan')).toHaveText('Growth');
  await expect(owner.getByTestId('usage-seats')).toContainText('3');
  // Nothing to buy here: the partner is billed.
  await expect(owner.getByText('Plans', { exact: true })).toHaveCount(0);

  await owner.goto('/wallet');
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹500.00');
  await expect(owner.getByRole('button', { name: 'Add funds' })).toHaveCount(0);
  await owner.context().close();
});

test('the partner looks inside under a banner, and the owner can see it happened', async ({
  browser,
}) => {
  const row = partner.getByTestId(`client-${clientName}`);
  await row.getByRole('button', { name: `Actions for ${clientName}` }).click();
  await partner.getByRole('menuitem', { name: 'View workspace' }).click();
  await partner.getByLabel('Reason').fill('Setting up their first template');
  await partner.getByRole('button', { name: 'Open workspace' }).click();

  const banner = partner.getByTestId('impersonation-banner');
  await expect(banner).toContainText(`You are viewing ${clientName}`);
  await expect(partner).toHaveURL(/\/inbox/);
  // Inside the client's workspace, as an admin: the wallet is the client's.
  await partner.getByRole('link', { name: 'Wallet' }).click();
  await expect(partner.getByTestId('wallet-balance')).toHaveText('₹500.00');
  await expect(banner).toBeVisible();
  // Keys would outlive the visit, so the settings menu does not offer them. Navigating inside
  // the app, because the view is held in memory and a full page load would end it.
  await partner.getByRole('link', { name: 'Settings' }).click();
  const settings = partner.getByRole('navigation', { name: 'Settings' });
  await expect(settings.getByRole('link', { name: 'Team' })).toBeVisible();
  await expect(settings.getByRole('link', { name: 'API keys' })).toHaveCount(0);
  await expect(settings.getByRole('link', { name: 'Webhooks' })).toHaveCount(0);
  await expect(banner).toBeVisible();

  await partner.getByRole('button', { name: 'Exit workspace' }).click();
  await expect(partner.getByRole('heading', { name: partnerName })).toBeVisible();
  await expect(partner.getByTestId('impersonation-banner')).toHaveCount(0);

  const owner = await logIn(browser, ownerEmail);
  await owner.goto('/settings/audit');
  const log = owner.getByRole('table');
  await expect(log).toContainText('Opened this workspace from outside');
  await expect(log).toContainText('Reason: Setting up their first template');
  await expect(log).toContainText('Left this workspace');
  await expect(log.getByText('Not a member').first()).toBeVisible();
  await owner.context().close();
});

test('a suspended client is shut out and told why', async ({ browser }) => {
  const row = partner.getByTestId(`client-${clientName}`);
  await row.getByRole('button', { name: `Actions for ${clientName}` }).click();
  await partner.getByRole('menuitem', { name: 'Suspend' }).click();
  await expect(row).toContainText('Suspended');

  const context = await browser.newContext();
  const owner = await context.newPage();
  await owner.goto('/login?next=%2Finbox');
  await owner.getByLabel('Email').fill(ownerEmail);
  await owner.getByLabel('Password').fill(PASSWORD);
  await owner.getByRole('button', { name: 'Log in' }).click();
  await expect(owner.getByTestId('suspended-notice')).toContainText('This workspace is suspended');

  await row.getByRole('button', { name: `Actions for ${clientName}` }).click();
  await partner.getByRole('menuitem', { name: 'Restore access' }).click();
  await expect(row).not.toContainText('Suspended');
  await owner.reload();
  await expect(owner.getByText('Live', { exact: true })).toBeVisible();
  await context.close();
});
