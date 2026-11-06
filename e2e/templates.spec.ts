/**
 * Phase 2.2 acceptance, against the fake Meta: a template made in the UI is submitted, approved
 * by webhook, and sent from the inbox with its variables filled from the contact.
 * The real approval by Meta is checked by hand: see infra/whatsapp-setup.md.
 */
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from './support/config.mjs';
import { createWorkspace, customerSays, logIn, openConversation } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

const unique = () => `e2e_${Math.random().toString(36).slice(2, 10)}`;

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
});

async function fillBasics(name: string, body: string) {
  await owner.goto('/templates/new');
  await owner.getByLabel('Name', { exact: true }).fill(name);
  await owner.getByLabel('Body').fill(body);
}

test('a template goes from the builder to approved, live', async () => {
  const name = unique();
  await fillBasics(name, 'Hi {{1}}, your order is ready to collect today.');

  // Without a sample it cannot be submitted, and the page says why.
  const submit = owner.getByRole('button', { name: 'Submit to Meta' });
  await expect(owner.getByText('Add a sample for Body {{1}}')).toBeVisible();
  await expect(submit).toBeDisabled();

  await owner.getByLabel('Sample for review').fill('Asha');
  await owner.getByLabel('Value when sending').click();
  await owner.getByRole('option', { name: 'Contact first name' }).click();

  // The preview follows what is typed.
  const preview = owner.getByRole('group', { name: 'Message preview' });
  await expect(preview).toContainText('Hi Asha, your order is ready to collect today.');
  await owner.getByLabel('Footer (optional)').fill('Thank you');
  await expect(preview).toContainText('Thank you');
  await owner.getByRole('button', { name: 'Quick reply' }).click();
  await owner.getByLabel('Button 1 text').fill('Got it');
  await expect(preview).toContainText('Got it');

  await submit.click();
  await expect(owner).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);

  // The fake Meta approves by webhook a moment later, with no reload.
  await expect(owner.getByText('Approved', { exact: true })).toBeVisible({ timeout: 15_000 });

  await owner.goto('/templates');
  const row = owner.getByRole('listitem').filter({ hasText: name });
  await expect(row).toContainText('Approved');
});

test('a rejection shows the reason, and the template can be fixed', async () => {
  const name = `${unique()}_rejected`;
  await fillBasics(name, 'Your order is ready to collect today.');
  await owner.getByRole('button', { name: 'Submit to Meta' }).click();
  await expect(owner.getByText('Meta rejected this template')).toBeVisible({ timeout: 15_000 });
  await expect(owner.getByText('reads as promotional')).toBeVisible();

  // Name and language are fixed once submitted.
  await expect(owner.getByLabel('Name', { exact: true })).toBeDisabled();
});

test('a draft can be saved and comes back as it was', async () => {
  const name = unique();
  await fillBasics(name, 'Your booking is confirmed for tomorrow.');
  await owner.getByRole('button', { name: 'Save draft' }).click();
  await expect(owner).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await owner.reload();
  await expect(owner.getByLabel('Body')).toHaveValue('Your booking is confirmed for tomorrow.');
  await expect(owner.getByText('Draft', { exact: true })).toBeVisible();
});

test('it can be sent from the inbox, with the variable filled from the contact', async () => {
  const name = unique();
  await fillBasics(name, 'Hi {{1}}, your table is ready for you now.');
  await owner.getByLabel('Sample for review').fill('Asha');
  await owner.getByLabel('Value when sending').click();
  await owner.getByRole('option', { name: 'Contact first name' }).click();
  await owner.getByRole('button', { name: 'Submit to Meta' }).click();
  await expect(owner.getByText('Approved', { exact: true })).toBeVisible({ timeout: 15_000 });

  await customerSays(ws, 'From last week', { name: 'Maya Nair', ageHours: 48 });
  await owner.goto('/inbox');
  await openConversation(owner, 'Maya Nair');
  await owner.getByRole('button', { name: 'Send a template' }).click();
  await owner.getByRole('button', { name: new RegExp(name) }).click();

  // Filled in from the contact, and still editable.
  const value = owner.getByLabel('Body {{1}}');
  await expect(value).toHaveValue('Maya');
  await expect(owner.getByRole('group', { name: 'Message preview' })).toContainText(
    'Hi Maya, your table is ready for you now.',
  );
  await owner.getByRole('button', { name: 'Send template' }).click();

  const log = owner.getByRole('log');
  await expect(log).toContainText('Hi Maya, your table is ready for you now.');
  await expect(log.getByRole('img', { name: 'Read' })).toBeVisible();
});

test('agents can read templates, but have no controls to change them', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await agent.goto('/templates');
  await expect(agent.getByRole('heading', { name: 'Templates' })).toBeVisible();
  await expect(agent.getByRole('link', { name: 'New template' })).toHaveCount(0);
  await expect(agent.getByRole('button', { name: 'Sync with Meta' })).toHaveCount(0);
  await agent.context().close();
});

test('deleting removes it here and at Meta', async () => {
  const name = unique();
  await fillBasics(name, 'Your parcel is on its way to you now.');
  await owner.getByRole('button', { name: 'Submit to Meta' }).click();
  await expect(owner.getByText('Approved', { exact: true })).toBeVisible({ timeout: 15_000 });
  await owner.goto('/templates');
  await owner.getByRole('button', { name: new RegExp(`Delete ${name}`) }).click();
  await owner.getByRole('button', { name: 'Delete template' }).click();
  await expect(owner.getByText(name)).toHaveCount(0);

  const res = await fetch(`${API_URL}/templates?q=${name}`, {
    headers: { authorization: `Bearer ${ws.token}` },
  });
  expect((await res.json()).items).toEqual([]);
});
