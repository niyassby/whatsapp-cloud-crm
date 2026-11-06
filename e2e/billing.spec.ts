/**
 * Phase 2.5 acceptance through the real UI and worker, against a fake Stripe that sends every
 * signed webhook twice: a payment upgrades the plan and credits the wallet exactly once.
 */
import { expect, type Page, test } from '@playwright/test';
import { createWorkspace, logIn } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
});

const payOnFakeCheckout = async (page: Page) => {
  await expect(page.getByRole('heading', { name: 'Fake checkout' })).toBeVisible();
  await page.getByRole('button', { name: 'Pay' }).click();
};

test('billing shows the trial, usage and plans', async () => {
  await owner.goto('/settings/billing');
  await expect(owner.getByTestId('current-plan')).toHaveText('Growth');
  await expect(owner.getByTestId('plan-status')).toHaveText('Trial');
  await expect(owner.getByText(/days left in your trial/)).toBeVisible();
  // The owner plus the invited agent.
  await expect(owner.getByTestId('usage-seats')).toHaveText('2 of 10');
  await expect(owner.getByTestId('plan-starter')).toContainText('₹2,499.00');
  await expect(owner.getByTestId('plan-scale')).toContainText('Unlimited');
  await owner.getByRole('button', { name: 'Yearly' }).click();
  await expect(owner.getByTestId('plan-starter')).toContainText('₹24,990.00');
});

test('a top-up credits the wallet once, with tax on top and an invoice', async () => {
  await owner.goto('/settings/billing');
  await owner.getByLabel('Business name').fill('Acme Traders');
  await owner.getByLabel('Country (two letters)').fill('in');
  await owner.getByRole('button', { name: 'Save details' }).click();
  await expect(owner.getByText('Saved')).toBeVisible();

  await owner.goto('/wallet');
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹1,000.00');
  await owner.getByRole('button', { name: 'Add funds' }).click();
  await owner.getByLabel(/Amount to add/).fill('500');
  const quote = owner.getByTestId('topup-quote');
  await expect(quote).toContainText('₹590.00');
  await expect(quote).toContainText('GST (18%)');
  await owner.getByRole('button', { name: 'Continue to payment' }).click();

  // Nothing moves until the webhook does. Coming back to the page proves nothing by itself.
  await payOnFakeCheckout(owner);
  await expect(owner).toHaveURL(/\/wallet\?payment=done/);
  await expect(owner.getByText(/payment is being confirmed/)).toBeVisible();
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹1,500.00');

  // Each webhook arrived twice. Give a second credit time to appear, if there were going to be one.
  await owner.waitForTimeout(2_000);
  await owner.reload();
  await expect(owner.getByTestId('wallet-balance')).toHaveText('₹1,500.00');
  await expect(owner.getByRole('table').last()).toContainText('Wallet top-up');

  await owner.goto('/settings/billing');
  const row = owner.getByRole('row', { name: /Wallet top-up/ });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('₹90.00');
  await expect(row).toContainText('₹590.00');

  const download = owner.waitForEvent('download');
  await row.getByRole('button', { name: 'Download PDF' }).click();
  expect((await download).suggestedFilename()).toMatch(/^INV-\d{4}-\d{6}\.pdf$/);
});

test('paying for a plan upgrades it, once, and it can then change and cancel', async () => {
  await owner.goto('/settings/billing');
  await owner.getByTestId('plan-scale').getByRole('button', { name: 'Choose Scale' }).click();
  await payOnFakeCheckout(owner);

  await expect(owner).toHaveURL(/\/settings\/billing\?payment=done/);
  await expect(owner.getByTestId('current-plan')).toHaveText('Scale');
  await expect(owner.getByTestId('plan-status')).toHaveText('Active');
  await expect(owner.getByTestId('usage-seats')).toHaveText('2');
  const invoice = owner.getByRole('row', { name: /Scale subscription/ });
  await expect(invoice).toHaveCount(1);

  // Switching needs no new checkout, and shows once the provider's webhook confirms it.
  await owner
    .getByTestId('plan-starter')
    .getByRole('button', { name: 'Switch to Starter' })
    .click();
  await expect(owner.getByTestId('current-plan')).toHaveText('Starter');
  await expect(owner).not.toHaveURL(/fake-checkout|\/pay\//);

  owner.once('dialog', (dialog) => void dialog.accept());
  await owner.getByRole('button', { name: 'Cancel plan' }).click();
  await expect(owner.getByText(/Cancelled. You keep this plan until/)).toBeVisible();

  await owner.getByRole('button', { name: 'Payment method' }).click();
  await expect(owner.getByRole('heading', { name: 'Fake portal' })).toBeVisible();
});

test('a plan limit stops adding more, and says why', async () => {
  // This workspace is on Starter now, with room for three people.
  await owner.goto('/settings/team');
  const inviteOne = async (email: string) => {
    await owner
      .getByRole('button', { name: /invite/i })
      .first()
      .click();
    const dialog = owner.getByRole('dialog');
    await dialog.getByLabel('Email').fill(email);
    await dialog.getByRole('button', { name: /invit/i }).click();
  };
  const first = `extra-${Date.now()}@e2e.test`;
  await inviteOne(first);
  await expect(owner.getByText(`Invitation sent to ${first}`)).toBeVisible();
  await inviteOne(`more-${Date.now()}@e2e.test`);
  await expect(owner.getByText(/limit on team members has been reached/)).toBeVisible();
});

test('agents do not see billing', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await agent.goto('/settings/billing');
  await expect(agent.getByText('Only owners and admins can see billing.')).toBeVisible();
  await expect(agent.getByRole('link', { name: 'Billing' })).toHaveCount(0);
  await agent.context().close();
});
