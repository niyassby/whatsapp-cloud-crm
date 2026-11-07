/** Isolation for WhatsApp tables, and the pre-tenant SECURITY DEFINER functions. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { disconnectWabaTx } from '../src/whatsapp';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;

const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);

async function connect(t: TenantFixture, opts: { metaUserId?: string } = {}) {
  const wabaId = metaId();
  const phoneNumberId = metaId();
  const ids = await withTenant(app, { orgId: t.orgId, userId: t.userId }, async (tx) => {
    const waba = await tx.wabaAccount.create({
      data: { orgId: t.orgId, wabaId, metaUserId: opts.metaUserId },
    });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: t.orgId,
        wabaAccountId: waba.id,
        phoneNumberId,
        status: 'connected',
        credentialSource: 'manual',
        accessTokenEnc: 'ciphertext-token',
        registrationPinEnc: 'ciphertext-pin',
      },
    });
    return { wabaAccountId: waba.id, phoneRowId: phone.id };
  });
  return { wabaId, phoneNumberId, ...ids };
}

const ingest = (dedupe: string, phone: string | null, waba: string | null = null) =>
  app.$queryRaw<{ id: string; status: string; inserted: boolean }[]>`
    SELECT * FROM webhook_event_ingest(${dedupe}, ${waba}, ${phone}, ${'messages'}, ${JSON.stringify({ a: 1 })}::jsonb)`;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('waba_accounts and phone_numbers under RLS', () => {
  it('are visible only to the owning org, and not without context', async () => {
    const conn = await connect(a);
    const asB = await withTenant(app, { orgId: b.orgId }, async (tx) => ({
      waba: await tx.wabaAccount.findFirst({ where: { wabaId: conn.wabaId } }),
      phone: await tx.phoneNumber.findFirst({ where: { phoneNumberId: conn.phoneNumberId } }),
    }));
    expect(asB).toEqual({ waba: null, phone: null });

    const none = await withDbContext(app, {}, (tx) => tx.phoneNumber.count());
    expect(none).toBe(0);

    const asA = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.phoneNumber.findFirst({ where: { phoneNumberId: conn.phoneNumberId } }),
    );
    expect(asA?.id).toBe(conn.phoneRowId);
  });

  it('org B cannot read tokens or update org A numbers, even with raw SQL', async () => {
    const conn = await connect(a);
    const result = await withTenant(app, { orgId: b.orgId }, async (tx) => ({
      tokens: await tx.$queryRaw<unknown[]>`
        SELECT access_token_enc FROM phone_numbers WHERE id = ${conn.phoneRowId}::uuid`,
      updated: await tx.$executeRaw`
        UPDATE phone_numbers SET status = 'disconnected' WHERE id = ${conn.phoneRowId}::uuid`,
    }));
    expect(result).toEqual({ tokens: [], updated: 0 });
  });

  it('cannot insert a number into another org', async () => {
    const conn = await connect(a);
    await expect(
      withTenant(app, { orgId: b.orgId }, (tx) =>
        tx.phoneNumber.create({
          data: {
            orgId: a.orgId,
            wabaAccountId: conn.wabaAccountId,
            phoneNumberId: metaId(),
            credentialSource: 'manual',
          },
        }),
      ),
    ).rejects.toThrow();
  });

  it('a number or WABA can be live in only one org', async () => {
    const conn = await connect(a);
    await expect(
      withTenant(app, { orgId: b.orgId }, (tx) =>
        tx.wabaAccount.create({ data: { orgId: b.orgId, wabaId: conn.wabaId } }),
      ),
    ).rejects.toThrow();
  });

  it('a disconnected WABA and number can be connected by another org', async () => {
    const conn = await connect(a);
    await withTenant(app, { orgId: a.orgId }, (tx) =>
      disconnectWabaTx(tx, conn.wabaAccountId, 'test'),
    );
    const moved = await withTenant(app, { orgId: b.orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({ data: { orgId: b.orgId, wabaId: conn.wabaId } });
      return tx.phoneNumber.create({
        data: {
          orgId: b.orgId,
          wabaAccountId: waba.id,
          phoneNumberId: conn.phoneNumberId,
          status: 'connected',
          credentialSource: 'manual',
        },
      });
    });
    const [route] = await app.$queryRaw<{ org_id: string }[]>`
      SELECT org_id FROM webhook_route_lookup(${conn.phoneNumberId}, ${conn.wabaId})`;
    expect(route?.org_id).toBe(b.orgId);
    expect(moved.orgId).toBe(b.orgId);
  });

  it('disconnect wipes credentials and returns affected numbers', async () => {
    const conn = await connect(a);
    const affected = await withTenant(app, { orgId: a.orgId }, (tx) =>
      disconnectWabaTx(tx, conn.wabaAccountId, 'user request'),
    );
    expect(affected).toEqual([conn.phoneNumberId]);
    const row = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.phoneNumber.findUniqueOrThrow({ where: { id: conn.phoneRowId } }),
    );
    expect(row).toMatchObject({
      status: 'disconnected',
      statusReason: 'user request',
      accessTokenEnc: null,
      registrationPinEnc: null,
    });
  });
});

describe('webhook_events', () => {
  it('app role cannot insert or delete directly', async () => {
    await expect(
      withTenant(app, { orgId: a.orgId }, (tx) =>
        tx.webhookEvent.create({
          data: { orgId: a.orgId, dedupeKey: randomUUID(), payload: {} },
        }),
      ),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      withTenant(app, { orgId: a.orgId }, (tx) => tx.$executeRaw`DELETE FROM webhook_events`),
    ).rejects.toThrow(/permission denied/i);
  });

  it('ingest is idempotent per dedupe key', async () => {
    const key = randomUUID();
    const [first] = await ingest(key, metaId());
    const [second] = await ingest(key, metaId());
    expect(first?.inserted).toBe(true);
    expect(second?.inserted).toBe(false);
    expect(second?.id).toBe(first?.id);
  });

  it('unrouted events are invisible to every tenant', async () => {
    const [event] = await ingest(randomUUID(), metaId());
    const seen = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.webhookEvent.findUnique({ where: { id: event!.id } }),
    );
    expect(seen).toBeNull();
  });

  it('routing assigns the event to exactly one tenant, permanently', async () => {
    const [event] = await ingest(randomUUID(), metaId());
    await app.$executeRaw`SELECT webhook_event_mark(${event!.id}::uuid, 'routed'::"WebhookEventStatus", ${a.orgId}::uuid, NULL)`;
    await app.$executeRaw`SELECT webhook_event_mark(${event!.id}::uuid, 'routed'::"WebhookEventStatus", ${b.orgId}::uuid, NULL)`;

    const asA = await withTenant(app, { orgId: a.orgId }, (tx) =>
      tx.webhookEvent.findUnique({ where: { id: event!.id } }),
    );
    const asB = await withTenant(app, { orgId: b.orgId }, (tx) =>
      tx.webhookEvent.findUnique({ where: { id: event!.id } }),
    );
    expect(asA?.status).toBe('routed');
    expect(asB).toBeNull();
  });

  it('routes by number, falling back to WABA, and ignores unknown or disconnected', async () => {
    const conn = await connect(a);
    const route = (phone: string | null, waba: string | null) =>
      app.$queryRaw<
        { org_id: string }[]
      >`SELECT org_id FROM webhook_route_lookup(${phone}, ${waba})`;
    expect(await route(conn.phoneNumberId, null)).toEqual([{ org_id: a.orgId }]);
    expect(await route(null, conn.wabaId)).toEqual([{ org_id: a.orgId }]);
    expect(await route(metaId(), metaId())).toEqual([]);
    await withTenant(app, { orgId: a.orgId }, (tx) =>
      disconnectWabaTx(tx, conn.wabaAccountId, 'test'),
    );
    expect(await route(conn.phoneNumberId, conn.wabaId)).toEqual([]);
  });

  it('retention never removes events younger than a day', async () => {
    const [event] = await ingest(randomUUID(), metaId());
    const future = new Date(Date.now() + 86_400_000);
    await app.$queryRaw`SELECT webhook_events_purge(${future})`;
    const [still] = await app.$queryRaw<
      unknown[]
    >`SELECT * FROM webhook_event_load(${event!.id}::uuid)`;
    expect(still).toBeDefined();
  });

  it('retention removes old events', async () => {
    const [event] = await ingest(randomUUID(), metaId());
    await owner.$executeRaw`UPDATE webhook_events SET received_at = now() - interval '40 days' WHERE id = ${event!.id}::uuid`;
    const cutoff = new Date(Date.now() - 30 * 86_400_000);
    await app.$queryRaw`SELECT webhook_events_purge(${cutoff})`;
    const rows = await app.$queryRaw<
      unknown[]
    >`SELECT * FROM webhook_event_load(${event!.id}::uuid)`;
    expect(rows).toEqual([]);
  });
});

describe('data_deletion_requests', () => {
  it('is reachable only through functions, by exact code', async () => {
    await expect(withDbContext(app, {}, (tx) => tx.dataDeletionRequest.findMany())).rejects.toThrow(
      /permission denied/i,
    );

    const code = randomUUID();
    const [{ id }] = (await app.$queryRaw<{ id: string }[]>`
      SELECT data_deletion_create(${'fb-user-1'}, ${code}) AS id`) as [{ id: string }];
    const status = () =>
      app.$queryRaw<{ status: string }[]>`SELECT status FROM data_deletion_status(${code})`;
    expect(await status()).toEqual([{ status: 'received' }]);

    await app.$executeRaw`SELECT data_deletion_complete(${id}::uuid)`;
    expect(await status()).toEqual([{ status: 'completed' }]);
    const other = await app.$queryRaw<unknown[]>`SELECT * FROM data_deletion_status(${'nope'})`;
    expect(other).toEqual([]);
  });

  it('completing a request erases the Facebook user id', async () => {
    const code = randomUUID();
    const [{ id }] = (await app.$queryRaw<{ id: string }[]>`
      SELECT data_deletion_create(${'fb-user-2'}, ${code}) AS id`) as [{ id: string }];
    await app.$executeRaw`SELECT data_deletion_complete(${id}::uuid)`;
    const row = await owner.dataDeletionRequest.findUniqueOrThrow({ where: { id } });
    expect(row.metaUserId).toBe('erased');
  });
});

describe('function hygiene', () => {
  it('every pre-tenant function is owned by app_definer with a pinned search_path', async () => {
    const rows = await owner.$queryRaw<
      { proname: string; owner: string; secdef: boolean; config: string[] | null }[]
    >`
      SELECT p.proname, r.rolname AS owner, p.prosecdef AS secdef, p.proconfig AS config
      FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
      WHERE p.proname LIKE 'webhook\_%' OR p.proname LIKE 'data\_deletion\_%'
         OR p.proname LIKE 'secrets\_list\_%' OR p.proname = 'meta_connections_by_user'
         OR p.proname LIKE 'billing\_%' OR p.proname IN ('api_key_lookup', 'next_invoice_number')`;
    expect(rows.length).toBe(20);
    for (const r of rows) {
      expect([r.proname, r.owner, r.secdef]).toEqual([r.proname, 'app_definer', true]);
      expect(r.config).toEqual(['search_path=public, pg_temp']);
    }
  });

  it('none of them return a credential', async () => {
    const rows = await owner.$queryRaw<{ src: string }[]>`
      SELECT pg_get_function_result(p.oid) AS src FROM pg_proc p
      WHERE p.proname LIKE 'webhook\_%' OR p.proname LIKE 'data\_deletion\_%'
         OR p.proname LIKE 'secrets\_list\_%' OR p.proname = 'meta_connections_by_user'
         OR p.proname LIKE 'billing\_%' OR p.proname IN ('api_key_lookup', 'next_invoice_number')`;
    for (const r of rows) expect(r.src).not.toMatch(/token|pin|secret/i);
  });

  it('app_definer keeps no CREATE on the schema after migrating', async () => {
    const [row] = await owner.$queryRaw<{ can: boolean }[]>`
      SELECT has_schema_privilege('app_definer', 'public', 'CREATE') AS can`;
    expect(row?.can).toBe(false);
  });
});
