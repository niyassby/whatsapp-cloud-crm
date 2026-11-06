/**
 * Phase 2.1 acceptance: contacts, consent, segments and imports through the real UI, with a real
 * worker processing the import and webhooks.
 */
import { expect, type Page, test } from '@playwright/test';
import { API_URL } from './support/config.mjs';
import { createWorkspace, customerSays, logIn, openConversation } from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;

const apiPost = async (path: string, body: unknown) => {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.token}` },
    body: JSON.stringify(body),
  });
  expect(res.status, path).toBeLessThan(300);
  return res.json();
};

/** Valid Indian mobile numbers, unique across tests in this run. */
let nextNumber = Math.floor(Math.random() * 1e8);
const phone = () => `+9198${String(nextNumber++ % 1e8).padStart(8, '0')}`;

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail, '/inbox');
});

test.afterAll(async () => {
  await owner?.context().close();
  await ws?.disconnect();
});

test('create a contact, edit it, and tag it', async () => {
  await owner.goto('/contacts');
  await owner.getByRole('button', { name: 'New contact' }).click();
  await owner.getByLabel('Phone number').fill('12345');
  await owner.getByRole('button', { name: 'Add contact' }).click();
  await expect(owner.getByText('Enter a valid phone number')).toBeVisible();

  const number = phone();
  await owner.getByLabel('Phone number').fill(number);
  await owner.getByLabel('Name', { exact: true }).fill('Priya Patel');
  await owner.getByRole('button', { name: 'Add contact' }).click();

  await expect(owner.getByRole('heading', { name: 'Priya Patel', level: 1 })).toBeVisible();
  await expect(owner.getByText('No consent')).toBeVisible();

  await owner.getByLabel('Email').fill('priya@example.com');
  await owner.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(owner.getByText('Saved', { exact: true })).toBeVisible();

  await owner.getByLabel('New tag').fill('wholesale');
  await owner.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(owner.getByRole('button', { name: 'wholesale', pressed: true })).toBeVisible();

  await owner.getByLabel('Add a note').fill('Prefers morning calls');
  await owner.getByRole('button', { name: 'Add', exact: true }).last().click();
  await expect(owner.getByText('Prefers morning calls')).toBeVisible();

  await owner.goto('/contacts');
  await owner.getByLabel('Search contacts').fill('priya');
  const row = owner.getByRole('row', { name: /Priya Patel/ });
  await expect(row).toContainText('wholesale');
});

test('recording an opt-in needs proof, and the history keeps it', async () => {
  const contact = await apiPost('/contacts', { phone: phone(), name: 'Consent Carl' });
  await owner.goto(`/contacts/${contact.id}`);

  await owner.getByRole('button', { name: 'Record opt-in' }).click();
  const save = owner.getByRole('button', { name: 'Save consent' });
  await expect(save).toBeDisabled();
  await owner.getByLabel('Where consent came from').fill('In-store form');
  await owner.getByLabel('Proof of consent').fill('Signed form 1042');
  await save.click();

  await expect(owner.getByText('Opted in', { exact: true }).first()).toBeVisible();
  await expect(owner.getByText('Signed form 1042')).toBeVisible();

  await owner.getByRole('button', { name: 'Opt out' }).click();
  await expect(owner.getByText('Opted out', { exact: true }).first()).toBeVisible();
  await expect(owner.getByText('Signed form 1042')).toBeVisible();
});

test('a customer who sends STOP is opted out live, and marketing locks', async () => {
  const from = phone().replace('+', '');
  await customerSays(ws, 'Hello, I have a question', { from, name: 'Stop Stella' });

  await owner.goto('/inbox');
  await openConversation(owner, 'Stop Stella');
  const details = owner.getByRole('complementary', { name: 'Conversation details' });
  await expect(details.getByText('No consent')).toBeVisible();

  await customerSays(ws, 'STOP', { from, name: 'Stop Stella' });
  await expect(details.getByText('Opted out')).toBeVisible();

  await details.getByRole('link', { name: 'View contact' }).click();
  await expect(owner.getByRole('heading', { name: 'Stop Stella', level: 1 })).toBeVisible();
  await expect(owner.getByText(/keyword/)).toBeVisible();

  // Its messages are in the history, with an opening into the inbox.
  await owner.getByRole('button', { name: 'Show messages' }).click();
  await expect(owner.getByText('Hello, I have a question')).toBeVisible();
  await expect(owner.getByRole('link', { name: 'Open in inbox' })).toBeVisible();
});

test('the template picker locks marketing templates without consent', async () => {
  // An old message, so the 24-hour window is closed and templates are offered.
  await customerSays(ws, 'From last week', {
    from: phone().replace('+', ''),
    name: 'Picker Paul',
    ageHours: 48,
  });
  await owner.goto('/inbox');
  await openConversation(owner, 'Picker Paul');
  await owner.getByRole('button', { name: 'Send a template' }).click();
  await expect(owner.getByRole('button', { name: /e2e_promo/ })).toBeDisabled();
  await expect(owner.getByText(/record this contact.s consent first/)).toBeVisible();
  await expect(owner.getByRole('button', { name: /order_update/ })).toBeEnabled();
  await owner.keyboard.press('Escape');
});

test('the server refuses marketing without consent', async () => {
  const from = phone().replace('+', '');
  await customerSays(ws, 'Hi', { from, name: 'Marketing Mia' });
  // The worker saves the message after the webhook returns.
  let conversationId: string | undefined;
  await expect
    .poll(async () => {
      const list = await (
        await fetch(`${API_URL}/inbox/conversations?limit=30`, {
          headers: { authorization: `Bearer ${ws.token}` },
        })
      ).json();
      conversationId = list.items.find(
        (c: { contact: { waId: string } }) => c.contact.waId === from,
      )?.id;
      return conversationId;
    })
    .toBeTruthy();
  const picker = await (
    await fetch(`${API_URL}/inbox/conversations/${conversationId}/templates`, {
      headers: { authorization: `Bearer ${ws.token}` },
    })
  ).json();
  const promo = picker.find((t: { name: string }) => t.name === 'e2e_promo');
  const res = await fetch(`${API_URL}/inbox/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.token}` },
    body: JSON.stringify({
      type: 'template',
      clientMessageId: crypto.randomUUID(),
      templateId: promo.id,
      variables: {},
    }),
  });
  expect(res.status).toBe(409);
  expect((await res.json()).code).toBe('CONTACT_NOT_OPTED_IN');
});

test('segments show a live count that matches the table', async () => {
  const tag = await apiPost('/contact-tags', { name: `seg-${Date.now()}` });
  for (const name of ['Seg One', 'Seg Two']) {
    await apiPost('/contacts', { phone: phone(), name, tagIds: [tag.id] });
  }

  await owner.goto('/contacts/segments');
  await owner.getByRole('button', { name: 'New segment' }).click();
  await owner.getByLabel('Name').fill(`Tagged ${tag.name}`);
  await owner.getByRole('button', { name: 'Add rule' }).click();
  await expect(owner.getByText('Finish the rules to see a count')).toBeVisible();
  await owner.getByRole('combobox', { name: 'Value' }).click();
  await owner.getByRole('option', { name: tag.name }).click();
  await expect(owner.getByText('2 contacts match')).toBeVisible();
  await owner.getByRole('button', { name: 'Save segment' }).click();

  const row = owner.getByRole('listitem').filter({ hasText: `Tagged ${tag.name}` });
  await expect(row).toContainText('2 contacts');

  await owner.goto('/contacts');
  await owner.getByRole('combobox', { name: 'Filter by segment' }).click();
  await owner.getByRole('option', { name: `Tagged ${tag.name}` }).click();
  await expect(owner.getByText('2 contacts', { exact: true })).toBeVisible();
  await expect(owner.getByRole('row', { name: /Seg One/ })).toBeVisible();
  await expect(owner.getByRole('row', { name: /Seg Two/ })).toBeVisible();
});

test('bulk tagging and merging from the table', async () => {
  const tag = await apiPost('/contact-tags', { name: `bulk-${Date.now()}` });
  await apiPost('/contacts', { phone: phone(), name: 'Bulk Primary' });
  await apiPost('/contacts', { phone: phone(), name: 'Bulk Duplicate' });

  await owner.goto('/contacts');
  await owner.getByLabel('Search contacts').fill('Bulk ');
  await expect(owner.getByRole('row', { name: /Bulk Duplicate/ })).toBeVisible();
  await owner.getByRole('checkbox', { name: 'Select Bulk Primary' }).check();
  await owner.getByRole('checkbox', { name: 'Select Bulk Duplicate' }).check();
  await expect(owner.getByText('2 selected')).toBeVisible();

  await owner.getByRole('combobox', { name: 'Add a tag to the selected contacts' }).click();
  await owner.getByRole('option', { name: tag.name }).click();
  await expect(owner.getByRole('row', { name: /Bulk Primary/ })).toContainText(tag.name);

  await owner.getByRole('checkbox', { name: 'Select Bulk Primary' }).check();
  await owner.getByRole('checkbox', { name: 'Select Bulk Duplicate' }).check();
  await owner.getByRole('button', { name: 'Merge', exact: true }).click();
  await owner.getByRole('radio', { name: /Bulk Primary/ }).check();
  await owner.getByRole('button', { name: 'Merge contacts' }).click();
  await expect(owner.getByRole('row', { name: /Bulk Duplicate/ })).toHaveCount(0);
  await expect(owner.getByRole('row', { name: /Bulk Primary/ })).toBeVisible();
});

test('an agent can edit contacts but has no whole-list controls', async ({ browser }) => {
  const agent = await logIn(browser, ws.agentEmail, '/inbox');
  await agent.goto('/contacts');
  await expect(agent.getByRole('button', { name: 'New contact' })).toBeVisible();
  await expect(agent.getByRole('button', { name: 'Import' })).toHaveCount(0);
  await expect(agent.getByRole('button', { name: /^Export/ })).toHaveCount(0);
  await expect(agent.getByRole('checkbox')).toHaveCount(0);
  await agent.context().close();
});

test.describe('import', () => {
  test.skip(Boolean(process.env.CI), 'CI has no S3 service');

  test('imports in the background with an error report, and the table virtualizes', async () => {
    const rows = ['Mobile,Full name,Tags'];
    const total = 400;
    for (let i = 0; i < total; i++) rows.push(`${phone()},Imported ${i},imported`);
    rows.push('not-a-number,Bad Row,');
    const csv = `${rows.join('\n')}\n`;

    await owner.goto('/contacts');
    await owner.getByRole('button', { name: 'Import' }).click();
    await owner.getByLabel('CSV file').setInputFiles({
      name: 'people.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    // Columns are guessed from the header row.
    await expect(owner.getByLabel('Phone column')).toContainText('Mobile');
    await expect(owner.getByLabel('Name column')).toContainText('Full name');

    await owner.getByRole('checkbox', { name: /agreed to receive marketing/ }).check();
    const start = owner.getByRole('button', { name: 'Start import' });
    await expect(start).toBeDisabled();
    await owner.getByLabel('Where consent came from').fill('Website form');
    await owner.getByLabel('Proof of consent').fill('Signup log export, 5 Nov');
    await start.click();

    // The progress arrives over the socket; nothing here reloads the page.
    const jobs = owner.getByRole('list', { name: 'Imports and exports' });
    await expect(jobs).toContainText(`${total} new`, { timeout: 60_000 });
    await expect(jobs).toContainText('1 with errors');
    await expect(jobs.getByRole('button', { name: 'Error report' })).toBeVisible();

    await owner.getByLabel('Search contacts').fill('Imported');
    await expect(owner.getByText(`${total} contacts`, { exact: true })).toBeVisible();
    // Far fewer rows exist in the page than match: the list is virtualized.
    const rendered = await owner.getByRole('row', { name: /Imported \d+/ }).count();
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(100);
    await expect(owner.getByRole('row', { name: /Imported/ }).first()).toContainText('Opted in');

    // Scrolling keeps loading: 400 rows span several 100-row pages, and the list grows to fit.
    const group = owner.getByRole('rowgroup');
    await expect
      .poll(
        () =>
          group.evaluate((el) => {
            el.parentElement?.scrollTo(0, el.parentElement.scrollHeight);
            return el.getBoundingClientRect().height;
          }),
        { timeout: 30_000 },
      )
      .toBe(total * 52);
    expect(await owner.getByRole('row', { name: /Imported \d+/ }).count()).toBeLessThan(100);
  });

  test('exports to a downloadable file', async () => {
    await owner.goto('/contacts');
    await owner.getByRole('button', { name: /^Export/ }).click();
    const jobs = owner.getByRole('list', { name: 'Imports and exports' });
    const download = jobs.getByRole('button', { name: 'Download' }).first();
    await expect(download).toBeVisible({ timeout: 60_000 });
    const [file] = await Promise.all([owner.waitForEvent('download'), download.click()]);
    expect(file.suggestedFilename()).toMatch(/^contacts-.*\.csv$/);
  });
});
