/**
 * Phase 1.5 acceptance: two separate browser sessions see messages live, failed sends show the
 * error, and the 24-hour window is enforced in the UI and on the server.
 */
import { expect, type Page, test } from '@playwright/test';
import { API_URL, FAILING_RECIPIENT, FAILURE_TEXT } from './support/config.mjs';
import {
  createWorkspace,
  customerSays,
  logIn,
  openConversation,
  sendReply,
} from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;
let agent: Page;

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace();
  owner = await logIn(browser, ws.ownerEmail);
  agent = await logIn(browser, ws.agentEmail);
});

test.afterAll(async () => {
  await owner?.context().close();
  await agent?.context().close();
  await ws?.disconnect();
});

test('a customer message appears live in both sessions, with an unread count', async () => {
  await customerSays(ws, 'Is my cake ready?', { name: 'Live Lena' });
  for (const page of [owner, agent]) {
    const row = page.getByRole('button', { name: /Live Lena/ });
    await expect(row).toContainText('Is my cake ready?');
    await expect(row).toContainText('Unread messages');
  }
});

test('a reply shows live in the other session, and ticks reach read', async () => {
  await openConversation(owner, 'Live Lena');
  await openConversation(agent, 'Live Lena');
  await expect(agent.getByRole('log')).toContainText('Is my cake ready?');

  await sendReply(owner, 'Yes, come by at 4');

  await expect(agent.getByRole('log')).toContainText('Yes, come by at 4');
  await expect(agent.getByRole('log')).toContainText('Olivia Owner');
  // Statuses come back through signed webhooks and the worker.
  await expect(owner.getByRole('img', { name: 'Read' }).last()).toBeVisible();
  await expect(agent.getByRole('img', { name: 'Read' }).last()).toBeVisible();
});

test('a new message in an open conversation appears without a reload', async () => {
  const { from } = await customerSays(ws, 'First', { name: 'Follow Up Fay' });
  await openConversation(agent, 'Follow Up Fay');
  await customerSays(ws, 'And another thing', { from, name: 'Follow Up Fay' });
  await expect(agent.getByRole('log')).toContainText('And another thing');
});

test('typing shows in the other session', async () => {
  await openConversation(owner, 'Live Lena');
  await openConversation(agent, 'Live Lena');
  await agent.getByRole('textbox', { name: 'Message', exact: true }).pressSequentially('Hel');
  await expect(owner.getByRole('log')).toContainText('Arjun Agent is typing');
  await agent.getByRole('textbox', { name: 'Message', exact: true }).fill('');
});

test('a note reaches the team but is marked internal', async () => {
  await owner.getByRole('button', { name: 'Note' }).click();
  await owner.getByRole('textbox', { name: 'Internal note' }).fill('She is a regular');
  await owner.getByRole('button', { name: 'Add note' }).click();
  await expect(agent.getByRole('log')).toContainText('She is a regular');
  await expect(agent.getByRole('log')).toContainText('Internal note');
  await owner.getByRole('button', { name: 'Reply' }).click();
});

test('assignment and closing update live', async () => {
  await owner.getByLabel('Assigned to').click();
  await owner.getByRole('option', { name: /Arjun Agent/ }).click();
  await expect(agent.getByLabel('Conversation details')).toContainText('Arjun Agent');

  await agent.getByRole('button', { name: 'Mine', exact: true }).click();
  await expect(agent.getByRole('button', { name: /Live Lena/ })).toBeVisible();
  await agent.getByRole('button', { name: 'All', exact: true }).click();

  await owner.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(agent.getByLabel('Conversation details').getByText('closed')).toBeVisible();
  await owner.getByRole('button', { name: 'Reopen', exact: true }).click();
});

test('a failed send shows the error, in both sessions', async () => {
  await customerSays(ws, 'Can you reach me?', { from: FAILING_RECIPIENT, name: 'Failing Finn' });
  await openConversation(owner, 'Failing Finn');
  await openConversation(agent, 'Failing Finn');
  await sendReply(owner, 'This will not arrive');

  for (const page of [owner, agent]) {
    await expect(page.getByRole('log').getByRole('alert')).toContainText(FAILURE_TEXT);
    await expect(page.getByRole('log').getByRole('img', { name: 'Failed' })).toBeVisible();
  }
});

test('outside the 24-hour window free text is blocked, but a template goes through', async () => {
  await customerSays(ws, 'Message from two days ago', { name: 'Old Olga', ageHours: 48 });
  await openConversation(owner, 'Old Olga');

  await expect(owner.getByText('The 24-hour window has closed')).toBeVisible();
  await expect(owner.getByRole('textbox', { name: 'Message', exact: true })).toBeDisabled();
  await expect(owner.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await expect(owner.getByRole('button', { name: 'Attach a file' })).toBeDisabled();

  // The server enforces it too: the UI is not the only check.
  const conversationId = new URL(owner.url()).searchParams.get('c');
  const token = await owner.evaluate(async (api) => {
    const res = await fetch(`${api}/auth/refresh`, { method: 'POST', credentials: 'include' });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }, API_URL);
  const direct = await fetch(`${API_URL}/inbox/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      type: 'text',
      clientMessageId: crypto.randomUUID(),
      body: 'Sneaking past the UI',
    }),
  });
  expect(direct.status).toBe(409);
  expect(((await direct.json()) as { code: string }).code).toBe('WINDOW_CLOSED');

  await owner.reload();
  await expect(owner.getByText('Live', { exact: true })).toBeVisible();

  await owner.getByRole('button', { name: 'Send a template' }).click();
  await owner.getByRole('button', { name: /order_update/ }).click();
  await owner.getByLabel('Value for {{1}}').fill('Olga');
  await owner.getByRole('button', { name: 'Send template' }).click();
  await expect(owner.getByRole('log')).toContainText('Hi Olga, your order is ready.');
  await expect(owner.getByRole('log').getByRole('img', { name: 'Read' })).toBeVisible();
});

test('a canned reply is inserted with a slash shortcut', async () => {
  const add = await fetch(`${API_URL}/inbox/canned-replies`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ws.token}` },
    body: JSON.stringify({ shortcut: 'hours', body: 'We are open 9 to 5.' }),
  });
  expect(add.status).toBe(201);
  await owner.reload();
  await customerSays(ws, 'When are you open?', { name: 'Canned Carla' });
  await openConversation(owner, 'Canned Carla');
  await owner.getByRole('textbox', { name: 'Message', exact: true }).fill('/ho');
  await owner.getByRole('button', { name: /\/hours/ }).click();
  await expect(owner.getByRole('textbox', { name: 'Message', exact: true })).toHaveValue(
    'We are open 9 to 5.',
  );
  await owner.getByRole('button', { name: 'Send message' }).click();
  await expect(owner.getByRole('log')).toContainText('We are open 9 to 5.');
});

test.describe('media (needs real object storage, so local only)', () => {
  test.skip(Boolean(process.env.CI), 'CI has no S3 service');

  const imageLoaded = (page: Page) =>
    expect
      .poll(() =>
        page
          .getByRole('log')
          .locator('img')
          .last()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
          .catch(() => false),
      )
      .toBe(true);

  test('an inbound image is stored and renders in both sessions', async () => {
    await customerSays(ws, 'unused', {
      name: 'Photo Priya',
      message: {
        type: 'image',
        text: undefined,
        image: { id: 'inbound-media-1', mime_type: 'image/png', sha256: 'x', caption: 'My cake' },
      },
    });
    await openConversation(owner, 'Photo Priya');
    await openConversation(agent, 'Photo Priya');
    await expect(owner.getByRole('log')).toContainText('My cake');
    await imageLoaded(owner);
    await imageLoaded(agent);
  });

  test('an uploaded image goes out and shows in the other session', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    await owner.locator('input[type="file"]').setInputFiles({
      name: 'reply.png',
      mimeType: 'image/png',
      buffer: png,
    });
    await expect(owner.getByRole('log').getByRole('img', { name: 'Read' }).last()).toBeVisible();
    await expect.poll(() => agent.getByRole('log').locator('img').count()).toBe(2);
    await imageLoaded(agent);
  });

  test('a file type WhatsApp rejects is refused', async () => {
    await owner.locator('input[type="file"]').setInputFiles({
      name: 'evil.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await expect(owner.getByText('WhatsApp does not accept this file type')).toBeVisible();
  });
});

test('two tabs in one browser keep the session through token refreshes', async () => {
  // Agents keep several tabs open, and every tab refreshes on load. Reuse detection must not
  // mistake that for a stolen token.
  const context = owner.context();
  const tabs = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
  await Promise.all(tabs.map((tab) => tab.goto('/inbox')));
  for (const tab of tabs) await expect(tab.getByText('Live', { exact: true })).toBeVisible();
  await Promise.all(tabs.map((tab) => tab.reload()));
  for (const tab of tabs) {
    await expect(tab.getByText('Live', { exact: true })).toBeVisible();
    await tab.close();
  }
});

test('removing a member cuts them off', async () => {
  const members = await fetch(`${API_URL}/team/members`, {
    headers: { authorization: `Bearer ${ws.token}` },
  });
  const list = (await members.json()) as { id: string; email: string }[];
  const member = list.find((m) => m.email === ws.agentEmail)!;
  const res = await fetch(`${API_URL}/team/members/${member.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${ws.token}` },
  });
  expect(res.status).toBe(204);
  await expect(agent.getByText('You are not in a workspace')).toBeVisible();
});
