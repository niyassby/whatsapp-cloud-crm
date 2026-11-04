/**
 * Both tenancy layers end to end through HTTP:
 *   layer 1: global TenantGuard + request context (Nest)
 *   layer 2: Postgres RLS via TenantPrismaService (SET LOCAL app.org_id)
 * A fake auth hook stands in for the Phase 1.3 AuthGuard.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createPrismaClient, type DbClient, withDbContext, withTenant } from '@wacrm/db';
import { testDbUrls } from '@wacrm/db/testing';
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { loadApiEnv } from '../src/env';
import { requestContext } from '../src/tenancy/request-context';
import { SkipTenant } from '../src/tenancy/skip-tenant.decorator';
import { TenantPrismaService } from '../src/tenancy/tenant-prisma.service';

const urls = testDbUrls('wacrm_api_test');

@Controller('probe')
class ProbeController {
  constructor(private readonly db: TenantPrismaService) {}

  @Get('keys')
  keys() {
    return this.db.run((tx) => tx.apiKey.findMany({ select: { orgId: true, name: true } }));
  }

  @Get('raw')
  raw() {
    return this.db.run((tx) => tx.$queryRaw<{ org_id: string }[]>`SELECT org_id FROM api_keys`);
  }

  @SkipTenant()
  @Get('my-orgs')
  myOrgs() {
    return this.db.runAsUser((tx) => tx.organization.findMany({ select: { id: true } }));
  }

  /** Bug simulation: a route that forgot tenancy but still calls the service. */
  @SkipTenant()
  @Get('unguarded')
  unguarded() {
    return this.db.run((tx) => tx.apiKey.findMany());
  }
}

let app: NestFastifyApplication;
let owner: DbClient;
const orgA = randomUUID();
const orgB = randomUUID();
const userA = randomUUID();
const userB = randomUUID();

async function seedOrg(orgId: string, userId: string, keyName: string) {
  await withDbContext(owner, { userId }, (tx) =>
    tx.user.create({
      data: { id: userId, email: `${userId}@api.test`, name: 'u', passwordHash: 'x' },
    }),
  );
  await withTenant(owner, { orgId, userId }, async (tx) => {
    await tx.organization.create({ data: { id: orgId, name: keyName, slug: orgId } });
    await tx.membership.create({ data: { orgId, userId, role: 'owner' } });
    await tx.apiKey.create({
      data: { orgId, name: keyName, prefix: `pk_${orgId}`, keyHash: `h_${orgId}` },
    });
  });
}

beforeAll(async () => {
  owner = createPrismaClient({ connectionString: urls.directUrl });
  await seedOrg(orgA, userA, 'key-a');
  await seedOrg(orgB, userB, 'key-b');

  const env = loadApiEnv({ DATABASE_URL: urls.appUrl, LOG_LEVEL: 'silent' });
  const mod = await Test.createTestingModule({
    imports: [AppModule.forRoot(env)],
    controllers: [ProbeController],
  }).compile();
  app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

  // Stand-in for the Phase 1.3 AuthGuard: trust test headers.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', async (req) => {
      const userId = req.headers['x-test-user'];
      const orgId = req.headers['x-test-org'];
      if (typeof userId === 'string') {
        req.auth = { userId, orgId: typeof orgId === 'string' ? orgId : undefined, role: 'owner' };
      }
    });

  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  await app?.close();
  await owner?.$disconnect();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

describe('health', () => {
  it('GET /health is public and ok', async () => {
    const res = await get('/health');
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });

  it('GET /health/ready checks the database', async () => {
    const res = await get('/health/ready');
    expect(res.statusCode).toBe(200);
  });
});

describe('layer 1: TenantGuard', () => {
  it('rejects tenant routes without auth', async () => {
    const res = await get('/probe/keys');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(ErrorCode.TENANT_CONTEXT_MISSING);
  });

  it('rejects tenant routes when the user has no org selected', async () => {
    const res = await get('/probe/keys', { 'x-test-user': userA });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(ErrorCode.TENANT_CONTEXT_MISSING);
  });

  it('TenantPrismaService still refuses on a route that skipped the guard', async () => {
    const res = await get('/probe/unguarded');
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe(ErrorCode.TENANT_CONTEXT_MISSING);
  });

  it('rejects a malformed org id', async () => {
    const res = await get('/probe/keys', { 'x-test-user': userA, 'x-test-org': 'nope' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe(ErrorCode.DB_INVALID_CONTEXT);
  });
});

describe('layer 2: RLS through TenantPrismaService', () => {
  it('org A only sees org A (Prisma)', async () => {
    const res = await get('/probe/keys', { 'x-test-user': userA, 'x-test-org': orgA });
    expect(res.json()).toEqual([{ orgId: orgA, name: 'key-a' }]);
  });

  it('org B only sees org B (raw SQL)', async () => {
    const res = await get('/probe/raw', { 'x-test-user': userB, 'x-test-org': orgB });
    expect(res.json()).toEqual([{ org_id: orgB }]);
  });

  it('a user forging another org id sees nothing from it', async () => {
    // Layer 1 would normally reject this (membership check, Phase 1.3). Even if it did not,
    // the user-scoped policies keep org B's users hidden and api_keys stay per org.
    const res = await get('/probe/my-orgs', { 'x-test-user': userA, 'x-test-org': orgB });
    expect(res.json()).toEqual([{ id: orgA }]);
  });

  it('keeps tenants apart under concurrent requests', async () => {
    const calls = Array.from({ length: 20 }, (_, i) => {
      const [user, org] = i % 2 === 0 ? [userA, orgA] : [userB, orgB];
      return get('/probe/raw', { 'x-test-user': user, 'x-test-org': org }).then((r) => ({
        org,
        rows: r.json() as { org_id: string }[],
      }));
    });
    for (const { org, rows } of await Promise.all(calls)) {
      expect(rows).toEqual([{ org_id: org }]);
    }
  });
});

describe('request context', () => {
  it('is empty outside a request', () => {
    expect(requestContext.get()).toBeUndefined();
  });
});
