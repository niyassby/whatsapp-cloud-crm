/**
 * Phase 3.1 through the real UI and worker: an auto-reply set up in settings answers a customer,
 * and a new conversation goes to the one available agent, who is told about it.
 */
import { expect, type Page, test } from '@playwright/test';
import { createWorkspace, customerSays, logIn, openConversation } from './support/helpers';

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

test('a keyword auto-reply answers the customer', async () => {
  await owner.goto('/settings/automation');
  await owner.getByRole('button', { name: 'New auto-reply' }).click();
  const dialog = owner.getByRole('dialog');
  await dialog.getByLabel('Name').fill('Pricing');
  await dialog.getByLabel('Keywords, separated by commas').fill('price, cost');
  await dialog.getByLabel('Reply').fill('Our plans start at 999 a month.');
  await dialog.getByRole('button', { name: 'Save rule' }).click();
  await expect(owner.getByText('Pricing')).toBeVisible();

  await customerSays(ws, 'What is the PRICE?', { from: '919811200001', name: 'Asha' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Asha');
  await expect(owner.getByRole('log')).toContainText('Our plans start at 999 a month.');
});

test('a new conversation goes to the available agent, who is told', async ({ browser }) => {
  // The owner steps away, so the agent is the only one taking work.
  await owner.getByRole('button', { name: 'Account menu' }).click();
  await owner.getByRole('menuitemcheckbox', { name: 'Available for new conversations' }).click();
  await owner.keyboard.press('Escape');

  await owner.goto('/settings/automation');
  await owner.getByLabel('Default assignment').click();
  await owner.getByRole('option', { name: /in turn/i }).click();
  await owner.getByRole('button', { name: 'Save settings' }).click();
  await expect(owner.getByText('Saved')).toBeVisible();
  await expect(owner.getByText('Not taking new conversations')).toBeVisible();

  const agent = await logIn(browser, ws.agentEmail);
  await customerSays(ws, 'I need help with an order', { from: '919811200002', name: 'Bilal' });

  await expect(agent.getByTestId('unread-notifications')).toHaveText('1', { timeout: 30_000 });
  await agent.getByRole('button', { name: /Notifications/ }).click();
  await agent.getByText('New conversation with Bilal').click();
  await expect(agent.getByRole('heading', { name: 'Bilal', level: 2 })).toBeVisible();
  await expect(agent.getByTestId('unread-notifications')).toHaveCount(0);
  await agent.context().close();
});

test('agents cannot change automation', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await agent.goto('/settings/automation');
  await expect(agent.getByText('Only owners and admins can change automation.')).toBeVisible();
  await agent.context().close();
});
