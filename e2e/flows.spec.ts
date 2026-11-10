/**
 * Phase 3.2 through the real UI and worker: a flow written as JSON is published and turned on,
 * a customer's keyword starts it, their button tap moves it on, and the run history shows it.
 * The visual builder (3.3) replaces the JSON editor.
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

const DEFINITION = {
  trigger: { type: 'keyword', matchType: 'exact', keywords: ['menu'] },
  startNodeId: 'pick',
  nodes: [
    {
      id: 'pick',
      type: 'buttons',
      data: {
        body: 'Hi {{contact.name}}, what can we do?',
        buttons: [
          { id: 'hours', title: 'Opening hours' },
          { id: 'human', title: 'Talk to us' },
        ],
      },
    },
    {
      id: 'hours',
      type: 'send_message',
      data: { text: 'We are open 9 to 6, Monday to Saturday.' },
    },
    { id: 'human', type: 'human_handoff', data: { message: 'Connecting you to the team.' } },
  ],
  edges: [
    { id: 'e1', source: 'pick', sourceHandle: 'hours', target: 'hours' },
    { id: 'e2', source: 'pick', sourceHandle: 'human', target: 'human' },
  ],
};

test('a published flow answers a keyword and follows the button the customer chose', async () => {
  await owner.goto('/flows');
  await owner.getByRole('button', { name: 'New flow' }).click();
  await owner.getByRole('dialog').getByLabel('Name').fill('Main menu');
  await owner.getByRole('dialog').getByRole('button', { name: 'Create flow' }).click();
  await expect(owner.getByRole('heading', { name: 'Main menu' })).toBeVisible();

  await owner.getByLabel('Definition').fill(JSON.stringify(DEFINITION, null, 2));
  await owner.getByRole('button', { name: 'Save draft' }).click();
  await expect(owner.getByText('No problems found.')).toBeVisible();
  await owner.getByRole('button', { name: 'Publish' }).click();
  await expect(owner.getByText('v1')).toBeVisible();
  await owner.getByRole('button', { name: 'Turn on' }).click();
  await expect(owner.getByRole('button', { name: 'Turn off' })).toBeVisible();

  await customerSays(ws, 'Menu', { from: '919811300001', name: 'Divya' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Divya');
  await expect(owner.getByRole('log')).toContainText('Hi Divya, what can we do?');

  await customerSays(ws, 'opening hours', { from: '919811300001', name: 'Divya' });
  await expect(owner.getByRole('log')).toContainText('We are open 9 to 6, Monday to Saturday.', {
    timeout: 30_000,
  });

  await owner.goto('/flows');
  await owner.getByRole('link', { name: 'Main menu' }).click();
  await owner.getByRole('tab', { name: 'Runs' }).click();
  await expect(owner.getByText('Completed')).toBeVisible({ timeout: 30_000 });
  await owner.getByRole('button', { name: 'Divya' }).click();
  const history = owner.getByRole('list', { name: 'Run history' });
  await expect(history).toContainText('hours');
});

test('publishing refuses a broken flow and says why', async () => {
  await owner.goto('/flows');
  await owner.getByRole('button', { name: 'New flow' }).click();
  await owner.getByRole('dialog').getByLabel('Name').fill('Broken');
  await owner.getByRole('dialog').getByRole('button', { name: 'Create flow' }).click();
  await expect(owner.getByRole('heading', { name: 'Broken' })).toBeVisible();
  await owner
    .getByLabel('Definition')
    .fill(JSON.stringify({ ...DEFINITION, startNodeId: 'missing' }, null, 2));
  await owner.getByRole('button', { name: 'Save draft' }).click();
  await expect(owner.getByText('Choose the first step')).toBeVisible();
  await expect(owner.getByRole('button', { name: 'Publish' })).toBeDisabled();
});

test('agents do not see flows', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await expect(agent.getByRole('link', { name: 'Flows' })).toHaveCount(0);
  await agent.context().close();
});
