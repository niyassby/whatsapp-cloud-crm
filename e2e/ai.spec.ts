/**
 * Phase 3.7 through the real UI, API and worker, with the stack's fake AI providers: turn AI on,
 * add knowledge, watch it get indexed, find it, then get a suggested reply in the inbox that the
 * agent can edit and send. Sample AI prices are in prisma/sample-rate-cards.csv.
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
  // The fake number is live in one workspace at a time; free it for the next spec.
  await ws?.disconnect();
});

test('an owner turns AI on and builds the knowledge base', async () => {
  await owner.goto('/settings/ai');
  await expect(owner.getByText(/Answers come from your knowledge base/)).toBeVisible();
  await owner.getByLabel(/Use AI in this workspace/).check();
  await owner.getByLabel('Instructions').fill('We are Chai House, a tea shop. Be brief.');
  await owner.getByRole('button', { name: 'Save' }).click();
  await expect(owner.getByText('AI settings saved')).toBeVisible();

  await owner.getByRole('button', { name: 'Add text' }).click();
  await owner.getByLabel('Title').fill('Store hours');
  await owner
    .getByLabel('Text', { exact: true })
    .fill('Our Bandra store opens every day from 9 am to 9 pm.');
  await owner.getByRole('button', { name: 'Add', exact: true }).click();
  // The worker reads it; the list updates over the socket.
  const doc = owner.getByTestId('knowledge-document').filter({ hasText: 'Store hours' });
  await expect(doc).toContainText('Ready', { timeout: 30_000 });
  await expect(doc).toContainText('1 passages');

  await owner.getByLabel('Try a question').fill('When does the Bandra store open?');
  await owner.getByRole('button', { name: 'Search' }).click();
  await expect(owner.getByRole('list', { name: 'Matching passages' })).toContainText('Store hours');

  // Reading the document was charged and logged.
  await expect(owner.getByRole('list', { name: 'AI activity' })).toContainText(
    'Reading a document',
  );
});

test('an agent gets a suggested reply, then edits and sends it', async () => {
  await customerSays(ws, 'When does the Bandra store open?', { name: 'Curious Kavya' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Curious Kavya');
  await owner.getByRole('button', { name: 'AI help' }).click();
  await owner.getByRole('menuitem', { name: 'Suggest a reply' }).click();
  const box = owner.getByRole('textbox', { name: 'Message', exact: true });
  await expect(box).toHaveValue('Our Bandra store opens every day from 9 am to 9 pm.');
  await expect(owner.getByText(/Check it before sending/)).toBeVisible();

  // Nothing went out on its own; the agent sends it.
  await expect(owner.getByRole('log')).not.toContainText('opens every day');
  await box.fill('Hi! Our Bandra store opens every day from 9 am to 9 pm.');
  await owner.getByRole('button', { name: 'Send message' }).click();
  await expect(owner.getByRole('log')).toContainText('Hi! Our Bandra store opens every day');

  await owner.getByRole('button', { name: 'AI help' }).click();
  await owner.getByRole('menuitem', { name: 'Summarize conversation' }).click();
  await expect(owner.getByTestId('ai-summary')).not.toBeEmpty();
  await owner.keyboard.press('Escape');

  await owner.goto('/settings/ai');
  await expect(owner.getByRole('list', { name: 'AI activity' })).toContainText('Suggested reply');
  await expect(owner.getByRole('list', { name: 'AI activity' })).toContainText('Summary');
});
