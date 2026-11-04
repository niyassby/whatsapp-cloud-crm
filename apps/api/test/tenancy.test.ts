/**
 * Both tenancy layers end to end over HTTP with real tokens:
 *   layer 1: AccessGuard (auth + org requirement + fresh membership check)
 *   layer 2: Postgres RLS via TenantPrismaService (SET LOCAL app.org_id)
 */
import { Controller, Get } from '@nestjs/common';
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Public } from '../src/auth/decorators';
import { requestContext } from '../src/tenancy/request-context';
import { SkipTenant } from '../src/tenancy/skip-tenant.decorator';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';
import { buildApp, Client, type TestApp } from './helpers';

@Controller('probe')
class ProbeController {
  constructor(private readonly db: TenantPrismaService) {}

  @Get('orgs')
  orgs() {
    return this.db.run((tx) => tx.organization.findMany({ select: { id: true } }));
  }

  @Get('raw')
  raw() {
    return this.db.run((tx) => tx.$queryRaw<{ org_id: string }[]>`SELECT org_id FROM memberships`);
  }

  /** Bug simulation: a public route that still calls the tenant service. */
  @Public()
  @Get('unguarded')
  unguarded() {
    return this.db.run((tx) => tx.membership.findMany());
  }

  @SkipTenant()
  @Get('my-orgs')
  myOrgs() {
    return this.db.runAsUser((tx) => tx.organization.findMany({ select: { id: true } }));
  }
}

let t: TestApp;
let a: Client;
let b: Client;
let orgA: string;
let orgB: string;

beforeAll(async () => {
  t = await buildApp({ controllers: [ProbeController] });
  a = new Client(t.app);
  b = new Client(t.app);
  orgA = (await a.signup({ orgName: 'Org A' })).orgId;
  orgB = (await b.signup({ orgName: 'Org B' })).orgId;
});

afterAll(() => t?.close());

describe('health', () => {
  it('GET /health and /health/ready are public', async () => {
    const anon = new Client(t.app);
    expect((await anon.get('/health')).status).toBe(200);
    expect((await anon.get('/health/ready')).status).toBe(200);
  });
});

describe('layer 1: AccessGuard', () => {
  it('rejects tenant routes without a token', async () => {
    const res = await new Client(t.app).get('/probe/orgs');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(ErrorCode.UNAUTHENTICATED);
  });

  it('rejects a forged token', async () => {
    const forged = new Client(t.app);
    forged.accessToken = `${a.accessToken!.slice(0, -4)}AAAA`;
    expect((await forged.get('/probe/orgs')).status).toBe(401);
  });

  it('TenantPrismaService still refuses on a route that skipped the guard', async () => {
    const res = await new Client(t.app).get('/probe/unguarded');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(ErrorCode.TENANT_CONTEXT_MISSING);
  });
});

describe('layer 2: RLS through TenantPrismaService', () => {
  it('each org only sees itself (Prisma)', async () => {
    expect((await a.get('/probe/orgs')).body).toEqual([{ id: orgA }]);
    expect((await b.get('/probe/orgs')).body).toEqual([{ id: orgB }]);
  });

  it('raw SQL is scoped too', async () => {
    expect((await a.get('/probe/raw')).body).toEqual([{ org_id: orgA }]);
  });

  it('switching to an org you do not belong to is refused', async () => {
    const res = await a.post('/auth/switch-org', { orgId: orgB });
    expect(res.status).toBe(403);
    expect((await a.get('/probe/orgs')).body).toEqual([{ id: orgA }]);
  });

  it('user-scoped queries only expose your own orgs', async () => {
    expect((await a.get('/probe/my-orgs')).body).toEqual([{ id: orgA }]);
  });

  it('keeps tenants apart under concurrent requests', async () => {
    const calls = Array.from({ length: 20 }, (_, i) => {
      const [client, org] = i % 2 === 0 ? [a, orgA] : [b, orgB];
      return client.get('/probe/raw').then((r) => ({ org, rows: r.body as { org_id: string }[] }));
    });
    for (const { org, rows } of await Promise.all(calls)) expect(rows).toEqual([{ org_id: org }]);
  });
});

describe('CORS', () => {
  // inject() bypasses the browser, so assert the preflight explicitly: a missing method here
  // silently breaks every PATCH/DELETE from the web app.
  it.each(['PATCH', 'DELETE'])('allows %s from the web origin with credentials', async (method) => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/team/members/x',
      headers: {
        origin: 'http://localhost:3000',
        'access-control-request-method': method,
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-methods'])).toContain(method);
  });

  it('does not allow other origins', async () => {
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/auth/me',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

describe('request context', () => {
  it('is empty outside a request', () => {
    expect(requestContext.get()).toBeUndefined();
  });
});
