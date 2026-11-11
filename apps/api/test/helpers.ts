import type { PaymentProviders } from '@wacrm/billing';
import { PAYMENT_PROVIDERS } from '../src/billing/billing.tokens';
import 'reflect-metadata';
import { buildRegistry, type ConnectorRegistry } from '@wacrm/connectors';
import { CONNECTORS, INTEGRATIONS_FETCH } from '../src/integrations/integrations.tokens';
import { randomBytes, randomUUID } from 'node:crypto';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { testDbUrls } from '@wacrm/db/testing';
import { AppModule } from '../src/app.module';
import { configureApp, createAdapter, NEST_OPTIONS } from '../src/bootstrap';
import { loadApiEnv } from '../src/env';
import { OBJECT_STORAGE } from '../src/infra/infra.tokens';
import { MemoryStorage } from '@wacrm/shared/server';
import { MAILER, MemoryMailer } from '../src/infra/mailer';
import { GRAPH_CONFIG } from '../src/whatsapp/whatsapp.tokens';
import type { GraphConfig } from '@wacrm/whatsapp';

export const urls = testDbUrls('wacrm_api_test');

export interface BuildOptions {
  controllers?: unknown[];
  env?: Record<string, string>;
  graph?: GraphConfig;
  payments?: PaymentProviders;
  /** The connectors the app offers; the default has none but the demo when enabled. */
  connectors?: ConnectorRegistry;
  /** Fetch for OAuth token requests. */
  fetch?: typeof fetch;
}

export interface TestApp {
  app: NestFastifyApplication;
  mailer: MemoryMailer;
  storage: MemoryStorage;
  close: () => Promise<void>;
}

/** The real app (guards, RLS, Redis rate limits) with an in-memory mailer. */
export async function buildApp(extra: BuildOptions = {}): Promise<TestApp> {
  const env = loadApiEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: urls.appUrl,
    REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    // Each suite gets its own queues, so assertions never see another run's jobs.
    QUEUE_PREFIX: `test-${randomUUID()}`,
    ...extra.env,
    WEB_URL: 'http://localhost:3000',
  });
  const mailer = new MemoryMailer();
  const storage = new MemoryStorage();
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Nest controller classes
    controllers: (extra.controllers ?? []) as any[],
  })
    .overrideProvider(MAILER)
    .useValue(mailer)
    .overrideProvider(OBJECT_STORAGE)
    .useValue(storage)
    .overrideProvider(GRAPH_CONFIG)
    .useValue(extra.graph ?? { apiVersion: env.META_GRAPH_API_VERSION })
    .overrideProvider(PAYMENT_PROVIDERS)
    .useValue(extra.payments ?? {})
    .overrideProvider(CONNECTORS)
    .useValue(extra.connectors ?? buildRegistry())
    .overrideProvider(INTEGRATIONS_FETCH)
    .useValue(
      extra.fetch ??
        (async () => {
          throw new Error('No fetch in this test');
        }),
    )
    .compile();
  const app = mod.createNestApplication<NestFastifyApplication>(createAdapter(env), NEST_OPTIONS);
  await configureApp(app, env);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, mailer, storage, close: () => app.close() };
}

/** Unique per call so Redis rate-limit buckets never collide between tests. */
export const uniqueIp = () => `10.${rnd()}.${rnd()}.${rnd()}`;
const rnd = () => Math.floor(Math.random() * 250) + 1;
export const uniqueEmail = (label = 'user') => `${label}-${randomUUID().slice(0, 8)}@api.test`;

/** Minimal HTTP client over fastify.inject with a cookie jar for the refresh token. */
export class Client {
  cookie: string | undefined;
  accessToken: string | undefined;
  readonly ip = uniqueIp();

  constructor(private readonly app: NestFastifyApplication) {}

  async req(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const res = await this.app.inject({
      method,
      url,
      payload: body === undefined ? undefined : (body as object),
      remoteAddress: this.ip,
      headers: {
        ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
    });
    const setCookie = res.headers['set-cookie'];
    for (const c of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      const [pair] = c.split(';');
      if (pair?.startsWith('wacrm_rt=')) this.cookie = pair === 'wacrm_rt=' ? undefined : pair;
    }
    const json = res.body ? safeJson(res.body) : undefined;
    if (json && typeof json === 'object' && 'accessToken' in json) {
      this.accessToken = String((json as { accessToken: string }).accessToken);
    }
    return { status: res.statusCode, body: json as any, headers: res.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any -- test convenience
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown, headers?: Record<string, string>) =>
    this.req('POST', url, body ?? {}, headers);
  patch = (url: string, body: unknown) => this.req('PATCH', url, body);
  delete = (url: string) => this.req('DELETE', url);

  async signup(
    overrides: Partial<{ name: string; email: string; password: string; orgName: string }> = {},
  ) {
    const input = {
      name: 'Test User',
      email: uniqueEmail(),
      password: 'correct-horse-battery',
      orgName: 'Test Org',
      ...overrides,
    };
    const res = await this.post('/auth/signup', input);
    if (res.status !== 201)
      throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const me = await this.get('/auth/me');
    return { ...input, userId: me.body.user.id as string, orgId: me.body.currentOrg.id as string };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Pull the ?token= value out of the most recent email to `to`. */
export function tokenFromMail(mailer: MemoryMailer, to: string): string {
  const mail = mailer.lastTo(to);
  const match = mail?.text.match(/token=([A-Za-z0-9_\-%]+)/);
  if (!match?.[1]) throw new Error(`no token mail for ${to}`);
  return decodeURIComponent(match[1]);
}
