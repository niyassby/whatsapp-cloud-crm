/**
 * Phases 3.2 and 3.3 through the real UI and worker. The acceptance: someone builds an
 * order-status flow with clicks only, tries it in the simulator, publishes it, and a customer's
 * message runs it for real.
 */
import { readFile } from 'node:fs/promises';
import { expect, type Locator, type Page, test } from '@playwright/test';
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

const panel = () => owner.getByLabel('Step settings');

async function choose(scope: Locator | Page, label: string, option: string | RegExp) {
  await scope.getByLabel(label, { exact: true }).click();
  await owner.getByRole('option', { name: option }).click();
}

async function addStep(name: string) {
  await owner.getByRole('button', { name: `Add ${name}`, exact: true }).click();
  await expect(panel().getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function newFlow(name: string) {
  await owner.goto('/flows');
  await owner.getByRole('button', { name: 'New flow' }).click();
  await owner.getByRole('dialog').getByLabel('Name').fill(name);
  await owner.getByRole('dialog').getByRole('button', { name: 'Create flow' }).click();
  await expect(owner.getByLabel('Flow name')).toHaveValue(name);
}

test('builds, tests and publishes an order-status flow, which then answers a customer', async () => {
  test.setTimeout(240_000);
  await newFlow('Order status');

  // Trigger: any message mentioning "order".
  await owner.getByTestId('step-trigger').click();
  const trigger = owner.getByLabel('Trigger settings');
  await choose(trigger, 'Trigger', 'Keyword');
  await trigger.getByLabel('Keywords, separated by commas').fill('order');

  // A menu with two buttons, greeting the customer by name from the variable picker.
  await addStep('Buttons');
  const message = panel().getByLabel('Message', { exact: true });
  await message.fill('Hi , what do you need?');
  await message.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(3, 3));
  await panel().getByRole('button', { name: 'Insert variable into Message' }).click();
  await owner.getByRole('menuitem', { name: /^Name/ }).click();
  await expect(message).toHaveValue('Hi {{contact.name}}, what do you need?');
  await panel().getByLabel('Button 1', { exact: true }).fill('Order status');
  await panel().getByLabel('Button 2', { exact: true }).fill('Talk to us');

  // Added with the menu selected, so it joins the first free exit: "Order status".
  await addStep('Ask a question');
  await panel().getByLabel('Question', { exact: true }).fill('Your order number?');
  await choose(panel(), 'Expected answer', 'A number');
  await panel().getByLabel('Save the answer as', { exact: true }).fill('order');

  await addStep('HTTP request');
  await panel()
    .getByLabel('Address', { exact: true })
    .fill('https://shop.example.com/orders/{{vars.order}}');
  await panel().getByLabel('New variable', { exact: true }).fill('state');
  await panel().getByLabel('Path', { exact: true }).fill('status');
  await panel().getByRole('button', { name: 'Add', exact: true }).click();

  await addStep('Send message');
  await panel()
    .getByLabel('Message', { exact: true })
    .fill('Order {{vars.order}} is {{vars.state}}.');

  // The second button and a failed lookup both go to a person.
  await owner.getByTestId('step-buttons_1').click();
  await addStep('Hand over');
  await owner.getByTestId('step-http_request_1').click();
  await choose(panel(), 'After Failed', /Hand over/);
  await expect(owner.getByTestId('save-status')).toHaveText('Draft saved', { timeout: 15_000 });
  await owner.screenshot({ path: 'test-results/flow-builder.png' });

  // Try it in the simulator: nothing is sent.
  await owner.getByRole('button', { name: 'Test', exact: true }).click();
  const test_ = owner.getByLabel('Test this flow');
  await test_.getByLabel('First message').fill('where is my order');
  await test_.getByRole('button', { name: 'Start test' }).click();
  const chat = test_.getByRole('log', { name: 'Test conversation' });
  await expect(chat).toContainText('Hi Test Customer, what do you need?');
  await test_.getByRole('button', { name: 'Tap Order status' }).click();
  await test_.getByLabel('Reply as the test contact').fill('1042');
  await test_.getByRole('button', { name: 'Send' }).click();
  await expect(test_).toContainText('GET https://shop.example.com/orders/1042');
  await test_.getByRole('button', { name: 'Answer with this' }).click();
  await expect(chat).toContainText('Order 1042 is shipped.');
  await expect(chat).toContainText('The flow ended.');
  await owner.screenshot({ path: 'test-results/flow-simulator.png' });
  await owner.getByRole('button', { name: 'Close test' }).click();

  await owner.getByRole('button', { name: 'Publish' }).click();
  await expect(owner.getByText('v1')).toBeVisible();
  await owner.getByRole('button', { name: 'Turn on' }).click();
  await expect(owner.getByRole('button', { name: 'Turn off' })).toBeVisible();

  // For real: a customer's message starts it, and "Talk to us" hands over to the team.
  await customerSays(ws, 'Hello, about my order', { from: '919811300001', name: 'Divya' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Divya');
  await expect(owner.getByRole('log')).toContainText('Hi Divya, what do you need?', {
    timeout: 30_000,
  });
  await customerSays(ws, 'Talk to us', { from: '919811300001', name: 'Divya' });
  await expect(owner.getByRole('log')).toContainText('Connecting you to our team.', {
    timeout: 30_000,
  });
});

test('a flow with problems shows them and cannot be published', async () => {
  await newFlow('Unfinished');
  await addStep('Send template');
  await expect(panel().getByLabel('Problems with this step')).toContainText('Choose a template');
  await owner.getByRole('button', { name: 'Publish' }).click();
  await expect(owner.getByRole('alert').filter({ hasText: 'Fix these' })).toContainText(
    'Choose a template',
  );
});

test('a flow exports to a file, imports as a new flow, and duplicates', async () => {
  await owner.goto('/flows');
  await owner.getByRole('link', { name: 'Order status' }).click();
  await expect(owner.getByLabel('Flow name')).toHaveValue('Order status');

  const [download] = await Promise.all([
    owner.waitForEvent('download'),
    (async () => {
      await owner.getByRole('button', { name: 'More flow actions' }).click();
      await owner.getByRole('menuitem', { name: 'Export as file' }).click();
    })(),
  ]);
  const file = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(file).toMatchObject({ format: 'wacrm-flow', name: 'Order status' });

  await owner.goto('/flows');
  await owner.getByLabel('Flow file to import').setInputFiles({
    name: 'order-status.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ ...file, name: 'Imported order flow' })),
  });
  await expect(owner.getByLabel('Flow name')).toHaveValue('Imported order flow');
  await expect(owner.getByTestId('step-http_request_1')).toBeVisible();

  await owner.getByRole('button', { name: 'More flow actions' }).click();
  await owner.getByRole('menuitem', { name: 'Duplicate flow' }).click();
  await expect(owner.getByLabel('Flow name')).toHaveValue('Imported order flow (copy)');
});

test('agents do not see flows', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail);
  await expect(agent.getByRole('link', { name: 'Flows' })).toHaveCount(0);
  await agent.context().close();
});
