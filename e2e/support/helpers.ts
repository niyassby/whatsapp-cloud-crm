import { execSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { type Browser, expect, type Page } from '@playwright/test';
import { API_URL, APP_SECRET, DB_NAME } from './config.mjs';

export const WABA_ID = '100000000000777';
export const PHONE_ID = '200000000000888';
export const PASSWORD = 'e2e-test-password-1';

const json = async (res: Response) => (res.status === 204 ? null : res.json());

async function post(
  path: string,
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string> = {},
) {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const data = await json(res);
  return { status: res.status, data };
}

/** Through the operator tool, since payments arrive in a later phase. */
export function creditWallet(orgId: string, amount: string) {
  execSync(
    `pnpm --filter @wacrm/db exec tsx scripts/wallet-credit.ts ${orgId} ${amount} "E2E balance"`,
    {
      env: {
        ...process.env,
        DIRECT_URL: `postgresql://wacrm:wacrm@127.0.0.1:5433/${DB_NAME}`,
      },
      stdio: 'pipe',
    },
  );
}

/** Workspace with a connected (fake) number and an invited agent. */
export async function createWorkspace(opts: { funded?: boolean } = {}) {
  const tag = randomUUID().slice(0, 8);
  const ownerEmail = `owner-${tag}@e2e.test`;
  const agentEmail = `agent-${tag}@e2e.test`;

  // Signups are limited per address, and repeat runs share that limit in Redis.
  const signup = await post(
    '/auth/signup',
    {
      name: 'Olivia Owner',
      email: ownerEmail,
      password: PASSWORD,
      orgName: `E2E ${tag}`,
    },
    undefined,
    { 'x-forwarded-for': `10.${randomBytes(3).join('.')}` },
  );
  expect(signup.status).toBe(201);
  const token = signup.data.accessToken as string;

  const me = await (
    await fetch(`${API_URL}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  ).json();
  if (opts.funded !== false) creditWallet(me.currentOrg.id as string, '1000');

  // A number is live in one org at a time, so free it from any earlier test first.
  const connect = await post(
    '/whatsapp/manual-connect',
    {
      accessToken: 'fake-token-for-the-e2e-graph-server',
      wabaId: `${tag.replace(/\D/g, '1').padEnd(12, '1')}777`,
      phoneNumberId: PHONE_ID,
    },
    token,
  );
  expect(connect.status, JSON.stringify(connect.data)).toBe(201);

  const invite = await post('/team/invitations', { email: agentEmail, role: 'agent' }, token);
  expect(invite.status).toBe(201);
  const inviteToken = await inviteTokenFromMailpit(agentEmail);
  const accept = await post('/invitations/accept', {
    token: inviteToken,
    name: 'Arjun Agent',
    password: PASSWORD,
  });
  expect(accept.status, JSON.stringify(accept.data)).toBe(200);

  return {
    ownerEmail,
    agentEmail,
    token,
    orgId: me.currentOrg.id as string,
    wabaId: connect.data.wabaId as string,
    phoneId: connect.data.id as string,
    disconnect: async () => {
      await fetch(`${API_URL}/whatsapp/phone-numbers/${connect.data.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
      });
    },
  };
}

export async function inviteTokenFromMailpit(email: string): Promise<string> {
  const mailpit = 'http://127.0.0.1:8025/api/v1';
  for (let i = 0; i < 30; i++) {
    const search = await fetch(`${mailpit}/search?query=${encodeURIComponent(`to:${email}`)}`);
    const { messages } = (await search.json()) as { messages: { ID: string }[] };
    if (messages[0]) {
      const full = (await (await fetch(`${mailpit}/message/${messages[0].ID}`)).json()) as {
        Text: string;
      };
      const match = /token=([\w%-]+)/.exec(full.Text);
      if (match?.[1]) return decodeURIComponent(match[1]);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`No invitation email for ${email}`);
}

/** A separate browser context: its own cookies, so a genuinely separate session. */
export async function logIn(browser: Browser, email: string, path = '/inbox'): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  return page;
}

/** Deliver a customer message exactly as Meta would: signed, to the public webhook. */
export async function customerSays(
  ws: { wabaId: string },
  text: string,
  opts: { from?: string; name?: string; ageHours?: number; message?: object } = {},
) {
  const from = opts.from ?? `9198${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: ws.wabaId,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100888', phone_number_id: PHONE_ID },
              contacts: [{ profile: { name: opts.name ?? 'Casey Customer' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: `wamid.IN.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000) - (opts.ageHours ?? 0) * 3600),
                  type: 'text',
                  text: { body: text },
                  ...opts.message,
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const signature = createHmac('sha256', APP_SECRET).update(body).digest('hex');
  const res = await fetch(`${API_URL}/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body,
  });
  expect(res.status).toBe(200);
  return { from };
}

export const openConversation = async (page: Page, name: string) => {
  await page
    .getByRole('button', { name: new RegExp(name) })
    .first()
    .click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
};

export const sendReply = async (page: Page, text: string) => {
  await page.getByRole('textbox', { name: 'Message', exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
};
