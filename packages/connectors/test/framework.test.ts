import { describe, expect, it } from 'vitest';
import {
  authorizeUrl,
  buildRegistry,
  type ConnectorDefinition,
  connectorProblem,
  demoStore,
  exchangeCode,
  hmacSha256,
  type OAuth2Auth,
  OAuthError,
  oauthClient,
  refreshTokens,
  verifyHmacSha256,
} from '../src';

const minimal: ConnectorDefinition = {
  key: 'minimal',
  name: 'Minimal',
  description: 'x',
  category: 'other',
  auth: { type: 'none' },
};

describe('registry', () => {
  it('refuses bad definitions when they are added', () => {
    expect(connectorProblem({ ...minimal, key: 'Bad Key' })).toMatch('lower-case');
    expect(
      connectorProblem({
        ...minimal,
        actions: [
          { key: 'a', name: 'A', description: '', run: async () => ({}) },
          { key: 'a', name: 'A', description: '', run: async () => ({}) },
        ],
      }),
    ).toMatch('two actions');
    expect(
      connectorProblem({ ...minimal, triggers: [{ key: 'x', name: 'X', description: '' }] }),
    ).toMatch('need a webhook or a sync');
    expect(() => buildRegistry({ extra: [minimal, minimal] })).toThrow('registered twice');
  });

  it('describes connectors for the web, without any code', () => {
    const registry = buildRegistry({ demo: true });
    const dto = registry.toDto(registry.get('demo_store')!);
    expect(dto).toMatchObject({
      key: 'demo_store',
      authType: 'api_key',
      credentials: [{ key: 'apiKey', type: 'secret', required: true }],
      receivesWebhooks: true,
      syncs: true,
      available: true,
    });
    expect(dto.actions[0]).toMatchObject({ key: 'lookup_order', output: ['status', 'total'] });
    expect(JSON.stringify(dto)).not.toContain('function');
  });

  it('an OAuth connector is available only once the app credentials are set', () => {
    const oauth: ConnectorDefinition = {
      ...minimal,
      key: 'oauthy',
      auth: {
        type: 'oauth2',
        authorizeUrl: 'https://p.example.com/authorize',
        tokenUrl: 'https://p.example.com/token',
        scopes: [],
        clientIdEnv: 'OAUTHY_ID',
        clientSecretEnv: 'OAUTHY_SECRET',
      },
    };
    expect(buildRegistry({ extra: [oauth], env: {} }).toDto(oauth).available).toBe(false);
    const env = { OAUTHY_ID: 'id', OAUTHY_SECRET: 's' };
    expect(buildRegistry({ extra: [oauth], env }).toDto(oauth).available).toBe(true);
  });
});

describe('oauth', () => {
  const auth: OAuth2Auth = {
    type: 'oauth2',
    authorizeUrl: 'https://{settings.shop}/admin/oauth/authorize',
    tokenUrl: 'https://{settings.shop}/admin/oauth/token',
    scopes: ['read_orders', 'read_customers'],
    scopeSeparator: ',',
    clientIdEnv: 'X_ID',
    clientSecretEnv: 'X_SECRET',
  };
  const client = oauthClient(auth, { X_ID: 'cid', X_SECRET: 'csecret' })!;

  it('builds the authorize address from settings', () => {
    const url = new URL(
      authorizeUrl(auth, client, {
        redirectUri: 'https://api.example.com/cb',
        state: 'st',
        settings: { shop: 'demo.myshop.test' },
      }),
    );
    expect(url.host).toBe('demo.myshop.test');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'cid',
      redirect_uri: 'https://api.example.com/cb',
      state: 'st',
      scope: 'read_orders,read_customers',
    });
  });

  it('exchanges a code and refreshes, keeping the old refresh token if none comes back', async () => {
    const calls: { url: string; body: string }[] = [];
    const answers = [
      { access_token: 'a1', refresh_token: 'r1', expires_in: 3600 },
      { access_token: 'a2', expires_in: 3600 },
    ];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      return new Response(JSON.stringify(answers.shift()), { status: 200 });
    }) as typeof fetch;
    const settings = { shop: 'demo.myshop.test' };
    const first = await exchangeCode(fakeFetch, auth, client, {
      code: 'c',
      redirectUri: 'https://api.example.com/cb',
      settings,
    });
    expect(first).toMatchObject({ accessToken: 'a1', refreshToken: 'r1' });
    expect(first.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3_500_000);
    expect(calls[0]!.url).toBe('https://demo.myshop.test/admin/oauth/token');
    expect(new URLSearchParams(calls[0]!.body).get('grant_type')).toBe('authorization_code');

    const second = await refreshTokens(fakeFetch, auth, client, { refreshToken: 'r1', settings });
    expect(second).toMatchObject({ accessToken: 'a2', refreshToken: 'r1' });
  });

  it('a revoked grant asks for a reconnect; other failures do not', async () => {
    const answer = (status: number, body: object) =>
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const settings = { shop: 's.test' };
    const revoked = refreshTokens(answer(400, { error: 'invalid_grant' }), auth, client, {
      refreshToken: 'r',
      settings,
    });
    await expect(revoked).rejects.toMatchObject({ reconnect: true });
    const down = refreshTokens(answer(503, {}), auth, client, { refreshToken: 'r', settings });
    await expect(down).rejects.toBeInstanceOf(OAuthError);
    await expect(down).rejects.toMatchObject({ reconnect: false });
  });
});

describe('webhooks', () => {
  it('the demo store checks its signature on the exact bytes', () => {
    const rawBody = Buffer.from('{"type":"order.created","order":{"id":"7"}}');
    const good = `sha256=${hmacSha256('s3cret', rawBody, 'hex')}`;
    const verify = demoStore.webhook!.verify;
    expect(verify({ rawBody, headers: { 'x-demo-signature': good } }, 's3cret', {})).toBe(true);
    expect(verify({ rawBody, headers: { 'x-demo-signature': good } }, 'other', {})).toBe(false);
    expect(
      verify(
        { rawBody: Buffer.from(`${rawBody} `), headers: { 'x-demo-signature': good } },
        's3cret',
        {},
      ),
    ).toBe(false);
    expect(verify({ rawBody, headers: {} }, 's3cret', {})).toBe(false);
    expect(verifyHmacSha256(rawBody, '', good, { prefix: 'sha256=' })).toBe(false);
  });

  it('maps deliveries to events, and ignores what it does not know', () => {
    const map = demoStore.webhook!.map;
    expect(
      map(
        { type: 'order.created', order: { id: '7', customer: { phone: '+91 98000 00001' } } },
        {},
        {},
      ),
    ).toEqual([
      {
        trigger: 'order.created',
        externalId: 'order.created:7',
        contact: { phone: '+91 98000 00001', name: null, email: null },
        data: { order: { id: '7', customer: { phone: '+91 98000 00001' } } },
      },
    ]);
    expect(map({ type: 'refund.created' }, {}, {})).toEqual([]);
  });
});
