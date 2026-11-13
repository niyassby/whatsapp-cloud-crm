/**
 * Phase 4.2 through the real UI: website chat and Instagram in the same inbox as WhatsApp, and
 * each WhatsApp module (QR codes, catalog, ad attribution, groups, calling) behind its plan flag.
 */
import { execSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import {
  API_URL,
  APP_SECRET,
  DB_NAME,
  IG_ACCOUNT_ID,
  IG_APP_SECRET,
  PORTS,
} from './support/config.mjs';
import {
  createWorkspace,
  customerSays,
  logIn,
  openConversation,
  PASSWORD,
  sendReply,
} from './support/helpers';

let ws: Awaited<ReturnType<typeof createWorkspace>>;
let owner: Page;
let adminToken: string;

async function call(path: string, method: string, body?: unknown, token?: string) {
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

/** Plans are set by a platform admin (Phase 4.1), the same way an operator would. */
async function setPlan(orgId: string, planCode: string) {
  const res = await call(`/admin/orgs/${orgId}/plan`, 'PATCH', { planCode }, adminToken);
  expect(res.status, JSON.stringify(res.data)).toBe(204);
}

/** A signed Meta webhook with one change. */
async function metaWebhook(field: string, value: object) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: ws.wabaId, changes: [{ field, value }] }],
  });
  const signature = createHmac('sha256', APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${API_URL}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
  expect(res.status).toBe(200);
}

test.beforeAll(async ({ browser }) => {
  ws = await createWorkspace({ funded: false });
  owner = await logIn(browser, ws.ownerEmail);

  const adminEmail = `admin-${randomUUID().slice(0, 8)}@e2e.test`;
  const signup = await call('/auth/signup', 'POST', {
    name: 'Ada Admin',
    email: adminEmail,
    password: PASSWORD,
    orgName: 'Platform',
  });
  adminToken = signup.data.accessToken;
  execSync(`pnpm --filter @wacrm/db exec tsx scripts/admin-grant.ts ${adminEmail}`, {
    env: { ...process.env, DIRECT_URL: `postgresql://wacrm:wacrm@127.0.0.1:5433/${DB_NAME}` },
    stdio: 'pipe',
  });
});

test.afterAll(async () => {
  await ws?.disconnect();
  await owner?.context().close();
});

test('website chat: a visitor writes from the site and the team answers live', async ({
  browser,
}) => {
  await owner.goto('/settings/channels');
  await owner.getByLabel('Widget name').fill('Main site');
  await owner.getByRole('button', { name: 'Add website chat' }).click();
  const code = owner.getByTestId('embed-code');
  await expect(code).toContainText('data-key="wc_');
  const key = /data-key="(wc_[^"]+)"/.exec((await code.textContent()) ?? '')?.[1];
  expect(key).toBeTruthy();

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/widget/${key}`);
  await expect(visitor.getByText('Hi! How can we help?')).toBeVisible();
  await visitor.getByLabel('Message').fill('Do you bake eggless cakes?');
  await visitor.getByRole('button', { name: 'Send' }).click();
  await expect(visitor.getByText('Do you bake eggless cakes?')).toBeVisible();

  await owner.goto('/inbox');
  await openConversation(owner, 'Visitor');
  await expect(owner.getByRole('log')).toContainText('Do you bake eggless cakes?');
  // No templates or files on website chat, and no 24-hour window to wait for.
  await expect(owner.getByRole('button', { name: 'Attach a file' })).toHaveCount(0);
  await sendReply(owner, 'Yes, all of them can be eggless.');
  await expect(visitor.getByText('Yes, all of them can be eggless.')).toBeVisible();
  await visitor.context().close();
});

test('Instagram: connect an account, receive a DM and reply to it', async () => {
  await owner.goto('/settings/channels');
  await owner.getByText('Connect with a token').click();
  await owner.getByLabel('Long-lived access token').fill('IGQ-e2e-long-lived-token');
  await owner.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(owner.getByTestId('channel-instagram')).toContainText('@e2e.bakery');

  const body = JSON.stringify({
    object: 'instagram',
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: 'igsid-e2e-1' },
            recipient: { id: IG_ACCOUNT_ID },
            timestamp: Date.now(),
            message: { mid: `mid.${randomUUID()}`, text: 'Is the bakery open on Sunday?' },
          },
        ],
      },
    ],
  });
  const signature = createHmac('sha256', IG_APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${API_URL}/webhooks/instagram`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
  expect(res.status).toBe(200);

  await owner.goto('/inbox');
  await openConversation(owner, 'Ivy Instagram');
  await expect(owner.getByRole('log')).toContainText('Is the bakery open on Sunday?');
  await sendReply(owner, 'Yes, from 9 to 1.');
  await expect
    .poll(
      async () =>
        (await (await fetch(`http://127.0.0.1:${PORTS.graph}/__ig-sent`)).json()) as unknown[],
    )
    .toContainEqual({ recipient: { id: 'igsid-e2e-1' }, message: { text: 'Yes, from 9 to 1.' } });
});

test('QR codes: a code opens a chat with its message, and the chat is counted', async () => {
  await owner.goto('/settings/whatsapp-tools');
  await owner.getByLabel('Name').fill('Shop counter');
  await owner.getByLabel('Message it starts with').fill('Hi, I scanned the counter code');
  await owner.getByRole('button', { name: 'Create' }).click();
  const card = owner.getByTestId('qr-Shop counter');
  await expect(card).toContainText('https://wa.me/message/E2E');
  await expect(
    card.getByRole('img', { name: 'QR code for Shop counter' }).locator('svg'),
  ).toBeVisible();
  await expect(card).toContainText('0 chats started');

  await customerSays(ws, 'Hi, I scanned the counter code', { name: 'Quinn Scanner' });
  await expect
    .poll(async () => {
      await owner.reload();
      return owner.getByTestId('qr-Shop counter').textContent();
    })
    .toContain('1 chat started');
});

test('catalog: sync it, send products in a chat, and see an order arrive', async () => {
  await owner.goto('/settings/whatsapp-tools');
  await owner.getByRole('tab', { name: 'Catalog' }).click();
  await owner.getByRole('button', { name: 'Sync catalog' }).click();
  await expect(owner.getByTestId('catalog-summary')).toContainText('2 products');

  const { from } = await customerSays(ws, 'What cakes do you have?', { name: 'Priya Products' });
  await owner.goto('/inbox');
  await openConversation(owner, 'Priya Products');
  await owner.getByRole('button', { name: 'Send products' }).click();
  await owner.getByRole('checkbox', { name: /Chocolate cake/ }).check();
  await owner.getByRole('button', { name: 'Send 1 product' }).click();
  await expect(owner.getByRole('log')).toContainText('Product');

  await customerSays(ws, '', {
    from,
    name: 'Priya Products',
    message: {
      type: 'order',
      text: undefined,
      order: {
        catalog_id: 'cat-e2e',
        text: 'Please deliver by 6',
        product_items: [
          { product_retailer_id: 'CAKE-1', quantity: 2, item_price: 650, currency: 'INR' },
        ],
      },
    },
  });
  await expect(owner.getByTestId('order-detail')).toContainText('Total 1300 INR');
});

test('ad attribution: a click-to-WhatsApp ad shows on the chat and in the report', async () => {
  await customerSays(ws, 'I saw your ad', {
    name: 'Arun Advert',
    message: {
      referral: {
        source_url: 'https://fb.me/e2e-ad',
        source_id: '120200000e2e0001',
        source_type: 'ad',
        headline: 'Fresh cakes daily',
        body: 'Order now',
        media_type: 'image',
        ctwa_clid: 'clid-e2e',
      },
    },
  });
  await owner.goto('/dashboard/ads');
  const row = owner.getByTestId('ad-120200000e2e0001');
  await expect(row).toContainText('Fresh cakes daily');
  await expect(row.getByRole('cell').nth(1)).toHaveText('1');
});

test('groups (Scale): create a group, share its link, approve someone', async () => {
  await setPlan(ws.orgId, 'scale');
  await owner.goto('/settings/whatsapp-tools');
  await owner.getByRole('tab', { name: 'Groups' }).click();
  await owner.getByLabel('Group name').fill('Cake club');
  await owner.getByRole('button', { name: 'Create group' }).click();
  const group = owner.getByTestId('group-Cake club');
  await expect(group).toContainText('https://chat.whatsapp.com/e2e');
  await group.getByRole('button', { name: 'Join requests' }).click();
  await expect(group).toContainText('+919812300001');
  await group.getByRole('button', { name: 'Approve' }).click();
  await expect(group).toContainText('No one is waiting.');
});

test('calling (Scale): turn it on, and a customer’s call rings and can be declined', async () => {
  await setPlan(ws.orgId, 'scale');
  await owner.goto('/settings/whatsapp-tools');
  await owner.getByRole('tab', { name: 'Calling' }).click();
  const toggle = owner.getByRole('checkbox', { name: 'Calling on' });
  await toggle.check();
  await expect(owner.getByText(/WhatsApp can take a while/)).toBeVisible();

  await owner.goto('/inbox');
  // Live events are not replayed: the socket must be connected before the call rings.
  await expect(owner.getByText('Live', { exact: true })).toBeVisible();
  const caller = `9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  await metaWebhook('calls', {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15550100888', phone_number_id: '200000000000888' },
    calls: [
      {
        id: `wacid.${randomUUID()}`,
        event: 'connect',
        direction: 'USER_INITIATED',
        from: caller,
        to: '15550100888',
        timestamp: String(Math.floor(Date.now() / 1000)),
        session: { sdp_type: 'offer', sdp: 'v=0\r\n' },
      },
    ],
  });
  const ringing = owner.getByTestId('incoming-call');
  await expect(ringing).toContainText(`+${caller}`);
  await ringing.getByRole('button', { name: 'Decline' }).click();
  await expect(ringing).toHaveCount(0);
  // A plus sign is not a safe regular expression, so open it by the digits.
  await owner.getByRole('button', { name: caller }).first().click();
  await expect(owner.getByRole('log')).toContainText('Declined call');
});

test('plan flags: a workspace without the feature cannot add website chat', async ({ browser }) => {
  const email = `free-${randomUUID().slice(0, 8)}@e2e.test`;
  const signup = await call('/auth/signup', 'POST', {
    name: 'Fran Free',
    email,
    password: PASSWORD,
    orgName: 'Free Co',
  });
  const me = await call('/auth/me', 'GET', undefined, signup.data.accessToken);
  await setPlan(me.data.currentOrg.id, 'free');
  const page = await logIn(browser, email);
  await page.goto('/settings/channels');
  await page.getByLabel('Widget name').fill('Nope');
  await page.getByRole('button', { name: 'Add website chat' }).click();
  await expect(page.getByText(/not on your plan/)).toBeVisible();
  await page.context().close();
});
