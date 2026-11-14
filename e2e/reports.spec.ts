/**
 * Phase 4.3 through the real UI: a customer writes and the team answers; the rollup turns that
 * into the conversations and team reports; a report downloads as CSV; a scheduled email arrives
 * in the inbox with the report attached.
 */
import { expect, type Page, test } from '@playwright/test';
import {
  createWorkspace,
  customerSays,
  logIn,
  openConversation,
  sendReply,
} from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
});

test.afterAll(async () => {
  await ws?.disconnect();
  await owner?.context().close();
});

test('the conversations and team reports show a customer answered by the team', async () => {
  await customerSays(ws, 'Is the shop open today?', { name: 'Rhea Reports' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Rhea Reports');
  await sendReply(owner, 'Yes, until 8.');

  await owner.goto('/reports');
  await expect(owner.getByRole('heading', { name: 'Reports' })).toBeVisible();
  // The worker recomputes recent hours every few seconds in this stack.
  await expect
    .poll(
      async () => {
        await owner.reload();
        // Both the message and the reply must be rolled up: a pass can land between them.
        const value = (label: string) =>
          owner.getByTestId(`stat-${label}`).getByTestId('stat-value').textContent();
        const answered = (await value('Median first response')) !== '–';
        return `${await value('From customers')} ${answered ? 'answered' : 'waiting'}`;
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe('1 answered');
  await expect(owner.getByTestId('report-totals')).toContainText('Median first response');
  await expect(owner.getByRole('img', { name: /by hour of the day/ })).toBeVisible();

  await owner.getByRole('tab', { name: 'Team performance' }).click();
  const team = owner.getByTestId('report-table-Team performance');
  await expect(team).toContainText('Olivia Owner');
  await expect(
    team
      .getByRole('row', { name: /Olivia Owner/ })
      .getByRole('cell')
      .nth(4),
  ).toHaveText('1');

  const download = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^agents-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv$/);
});

test('a scheduled report is emailed to the owner with the file attached', async () => {
  await owner.goto('/reports');
  await owner.getByLabel('Schedule name').fill('Morning summary');
  await owner.getByLabel('Report', { exact: true }).selectOption('conversations');
  await owner.getByLabel('How often').selectOption('daily');
  await owner.getByLabel('File').selectOption('csv');
  await owner.getByRole('checkbox', { name: /Olivia Owner/ }).check();
  await owner.getByRole('button', { name: 'Add schedule' }).click();
  const row = owner.getByTestId('schedule-Morning summary');
  await expect(row).toContainText('Conversations');

  await row.getByRole('button', { name: 'Send now' }).click();
  const mailpit = 'http://127.0.0.1:8025/api/v1';
  await expect
    .poll(
      async () => {
        const search = (await (
          await fetch(
            `${mailpit}/search?query=${encodeURIComponent(`to:${ws.ownerEmail} subject:Conversations`)}`,
          )
        ).json()) as { messages: { ID: string; Attachments: number }[] };
        return search.messages[0]?.Attachments ?? 0;
      },
      { timeout: 90_000, intervals: [3_000] },
    )
    .toBe(1);
  await owner.reload();
  await expect(owner.getByTestId('schedule-Morning summary')).toContainText('last');
});
