import { randomBytes, randomUUID } from 'node:crypto';
import { createPrismaClient, type DbClient, withDbContext, withTenant } from '@wacrm/db';
import { testDbUrls } from '@wacrm/db/testing';
import {
  DecryptionError,
  phonePinAad,
  phoneTokenAad,
  SecretBox,
  totpAad,
} from '@wacrm/shared/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkerDeps } from '../src/deps';
import { buildDeps } from './support';
import { purgeWebhookEvents, reencryptSecrets } from '../src/processors/maintenance';
import { processMetaAccountJob } from '../src/processors/meta-account';
import { markEventFailed, routeWebhookEvent } from '../src/processors/webhook-events';

const urls = testDbUrls('wacrm_worker_test');
const metaId = () => String(Math.floor(Math.random() * 1e15) + 1e15);
const key = () => randomBytes(32).toString('base64');

let db: DbClient;
let deps: WorkerDeps;
let owner: DbClient;

beforeAll(() => {
  db = createPrismaClient({ connectionString: urls.appUrl });
  deps = buildDeps(db).deps;
  owner = createPrismaClient({ connectionString: urls.directUrl });
});
afterAll(async () => {
  await db.$disconnect();
  await owner.$disconnect();
});

async function createOrg() {
  const orgId = randomUUID();
  await withTenant(db, { orgId }, (tx) =>
    tx.organization.create({ data: { id: orgId, name: 'Org', slug: orgId } }),
  );
  return orgId;
}

async function connect(
  orgId: string,
  opts: { metaUserId?: string; display?: string; box?: SecretBox } = {},
) {
  const wabaId = metaId();
  const phoneNumberId = metaId();
  const id = randomUUID();
  const box = opts.box;
  await withTenant(db, { orgId }, async (tx) => {
    const waba = await tx.wabaAccount.create({
      data: { orgId, wabaId, metaUserId: opts.metaUserId },
    });
    await tx.phoneNumber.create({
      data: {
        id,
        orgId,
        wabaAccountId: waba.id,
        phoneNumberId,
        status: 'connected',
        credentialSource: 'manual',
        displayPhoneNumber: opts.display ?? '+1 555 000 1111',
        messagingTier: 'TIER_250',
        accessTokenEnc: box ? box.encrypt('token-1', phoneTokenAad(id)) : 'ciphertext',
        registrationPinEnc: box ? box.encrypt('123456', phonePinAad(id)) : 'ciphertext',
      },
    });
  });
  return { id, wabaId, phoneNumberId };
}

async function ingest(
  wabaId: string | null,
  phone: string | null,
  field: string,
  value: object,
): Promise<string> {
  const payload = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: wabaId, changes: [{ field, value }] }],
  });
  const [row] = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM webhook_event_ingest(${randomUUID()}, ${wabaId}, ${phone}, ${field}, ${payload}::jsonb)`;
  return row!.id;
}

const eventRow = (id: string) => owner.webhookEvent.findUniqueOrThrow({ where: { id } });
const phoneRow = (id: string) => owner.phoneNumber.findUniqueOrThrow({ where: { id } });

describe('routeWebhookEvent', () => {
  it('assigns the event to the org that owns the number', async () => {
    const orgId = await createOrg();
    const conn = await connect(orgId);
    const id = await ingest(conn.wabaId, conn.phoneNumberId, 'messages', { messages: [] });

    expect(await routeWebhookEvent(deps, id)).toBe('processed');
    expect(await eventRow(id)).toMatchObject({ orgId, status: 'processed', attempts: 1 });
    expect((await eventRow(id)).processedAt).not.toBeNull();
    const seen = await withTenant(db, { orgId }, (tx) =>
      tx.webhookEvent.findUnique({ where: { id } }),
    );
    expect(seen?.id).toBe(id);
  });

  it('never exposes the event to another org', async () => {
    const orgId = await createOrg();
    const other = await createOrg();
    const conn = await connect(orgId);
    const id = await ingest(conn.wabaId, conn.phoneNumberId, 'messages', {});
    await routeWebhookEvent(deps, id);
    const seen = await withTenant(db, { orgId: other }, (tx) =>
      tx.webhookEvent.findUnique({ where: { id } }),
    );
    expect(seen).toBeNull();
  });

  it('ignores events for unknown numbers, keeping them unassigned', async () => {
    const id = await ingest(metaId(), metaId(), 'messages', {});
    expect(await routeWebhookEvent(deps, id)).toBe('ignored');
    expect(await eventRow(id)).toMatchObject({ status: 'ignored', orgId: null });
  });

  it('is idempotent: a duplicate job does nothing', async () => {
    const orgId = await createOrg();
    const conn = await connect(orgId);
    const id = await ingest(conn.wabaId, conn.phoneNumberId, 'messages', {});
    await routeWebhookEvent(deps, id);
    expect(await routeWebhookEvent(deps, id)).toBe('skipped');
    expect((await eventRow(id)).attempts).toBe(1);
  });

  it('handles a job whose event was already purged', async () => {
    expect(await routeWebhookEvent(deps, randomUUID())).toBe('missing');
  });

  it('replay re-runs, and stays with the original org after the number moves', async () => {
    const orgA = await createOrg();
    const conn = await connect(orgA);
    const id = await ingest(conn.wabaId, conn.phoneNumberId, 'messages', {});
    await routeWebhookEvent(deps, id);

    // The number leaves org A, then the event is replayed from org A.
    await withTenant(db, { orgId: orgA }, async (tx) => {
      await tx.phoneNumber.update({ where: { id: conn.id }, data: { status: 'disconnected' } });
      await tx.webhookEvent.update({ where: { id }, data: { status: 'received' } });
    });
    expect(await routeWebhookEvent(deps, id)).toBe('processed');
    expect(await eventRow(id)).toMatchObject({ orgId: orgA, status: 'processed', attempts: 2 });
  });

  it('records a final failure on the row', async () => {
    const id = await ingest(metaId(), metaId(), 'messages', {});
    await markEventFailed(db, id, 'boom');
    expect(await eventRow(id)).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('updates the messaging tier from a quality update, matching on digits', async () => {
    const orgId = await createOrg();
    const conn = await connect(orgId, { display: '+1 555 000 2222' });
    const id = await ingest(conn.wabaId, null, 'phone_number_quality_update', {
      display_phone_number: '15550002222',
      event: 'UPGRADE',
      current_limit: 'TIER_10K',
    });
    expect(await routeWebhookEvent(deps, id)).toBe('processed');
    expect((await phoneRow(conn.id)).messagingTier).toBe('TIER_10K');
  });

  it('does not touch a different number on a quality update', async () => {
    const orgId = await createOrg();
    const conn = await connect(orgId, { display: '+1 555 000 3333' });
    const id = await ingest(conn.wabaId, null, 'phone_number_quality_update', {
      display_phone_number: '15559999999',
      current_limit: 'TIER_10K',
    });
    await routeWebhookEvent(deps, id);
    expect((await phoneRow(conn.id)).messagingTier).toBe('TIER_250');
  });

  it.each(['PARTNER_APP_UNINSTALLED', 'PARTNER_REMOVED'])(
    '%s disconnects the WABA, wipes credentials, and audits',
    async (event) => {
      const orgId = await createOrg();
      const conn = await connect(orgId);
      const id = await ingest(conn.wabaId, null, 'account_update', { event });
      await routeWebhookEvent(deps, id);
      expect(await phoneRow(conn.id)).toMatchObject({
        status: 'disconnected',
        accessTokenEnc: null,
        registrationPinEnc: null,
      });
      const logs = await withTenant(db, { orgId }, (tx) => tx.auditLog.findMany());
      expect(logs.map((l) => l.action)).toContain('whatsapp.disconnected');
    },
  );

  it('other account updates leave the connection alone', async () => {
    const orgId = await createOrg();
    const conn = await connect(orgId);
    const id = await ingest(conn.wabaId, null, 'account_update', { event: 'VERIFIED_ACCOUNT' });
    await routeWebhookEvent(deps, id);
    expect((await phoneRow(conn.id)).status).toBe('connected');
  });
});

describe('processMetaAccountJob', () => {
  it('deauthorize disconnects only that user’s connections', async () => {
    const fbUser = `fb-${randomUUID()}`;
    const orgId = await createOrg();
    const mine = await connect(orgId, { metaUserId: fbUser });
    const other = await connect(orgId, { metaUserId: `fb-${randomUUID()}` });

    const n = await processMetaAccountJob(db, { kind: 'deauthorize', metaUserId: fbUser });
    expect(n).toBe(1);
    expect(await phoneRow(mine.id)).toMatchObject({
      status: 'disconnected',
      accessTokenEnc: null,
      statusReason: 'Deauthorized on Facebook',
    });
    expect((await phoneRow(other.id)).status).toBe('connected');
  });

  it('works across orgs and is safe to run twice', async () => {
    const fbUser = `fb-${randomUUID()}`;
    const a = await connect(await createOrg(), { metaUserId: fbUser });
    const b = await connect(await createOrg(), { metaUserId: fbUser });
    await processMetaAccountJob(db, { kind: 'deauthorize', metaUserId: fbUser });
    await processMetaAccountJob(db, { kind: 'deauthorize', metaUserId: fbUser });
    expect((await phoneRow(a.id)).status).toBe('disconnected');
    expect((await phoneRow(b.id)).status).toBe('disconnected');
  });

  it('data deletion wipes, erases the Facebook id, and completes the request', async () => {
    const fbUser = `fb-${randomUUID()}`;
    const orgId = await createOrg();
    const conn = await connect(orgId, { metaUserId: fbUser });
    const code = randomUUID();
    const [row] = await db.$queryRaw<{ id: string }[]>`
      SELECT data_deletion_create(${fbUser}, ${code}) AS id`;

    await processMetaAccountJob(db, {
      kind: 'data_deletion',
      metaUserId: fbUser,
      requestId: row!.id,
    });

    expect((await phoneRow(conn.id)).accessTokenEnc).toBeNull();
    const waba = await owner.wabaAccount.findFirstOrThrow({ where: { wabaId: conn.wabaId } });
    expect(waba.metaUserId).toBeNull();
    const [status] = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM data_deletion_status(${code})`;
    expect(status?.status).toBe('completed');
  });

  it('completes a deletion request even when nothing matches', async () => {
    const code = randomUUID();
    const fbUser = `fb-${randomUUID()}`;
    const [row] = await db.$queryRaw<{ id: string }[]>`
      SELECT data_deletion_create(${fbUser}, ${code}) AS id`;
    const n = await processMetaAccountJob(db, {
      kind: 'data_deletion',
      metaUserId: fbUser,
      requestId: row!.id,
    });
    expect(n).toBe(0);
    const [status] = await db.$queryRaw<{ status: string }[]>`
      SELECT status FROM data_deletion_status(${code})`;
    expect(status?.status).toBe('completed');
  });
});

describe('purgeWebhookEvents', () => {
  it('removes events past retention and keeps the rest', async () => {
    const oldId = await ingest(metaId(), metaId(), 'messages', {});
    const newId = await ingest(metaId(), metaId(), 'messages', {});
    await owner.webhookEvent.update({
      where: { id: oldId },
      data: { receivedAt: new Date(Date.now() - 40 * 86_400_000) },
    });
    expect(await purgeWebhookEvents(db, 30)).toBeGreaterThanOrEqual(1);
    expect(await owner.webhookEvent.findUnique({ where: { id: oldId } })).toBeNull();
    expect(await owner.webhookEvent.findUnique({ where: { id: newId } })).not.toBeNull();
  });
});

describe('reencryptSecrets (key rotation)', () => {
  it('reports a row it cannot decrypt, and still rotates the others', async () => {
    const box = new SecretBox(key());
    const orgId = await createOrg();
    const bad = await connect(orgId); // holds a placeholder, not real ciphertext
    const good = await connect(orgId, { box: new SecretBox(key()) });
    // `good` was encrypted under a key this box does not hold, so it is reported too.
    const res = await reencryptSecrets(db, box);
    expect(res.failed).toContain(`phone_numbers:${bad.id}`);
    expect(res.failed).toContain(`phone_numbers:${good.id}`);
  });

  it('moves every secret to the new key, keeps values, and is idempotent', async () => {
    const oldKey = key();
    const oldBox = new SecretBox(oldKey);
    const orgId = await createOrg();
    const conn = await connect(orgId, { box: oldBox });

    const userId = randomUUID();
    await withDbContext(db, { userId }, (tx) =>
      tx.user.create({
        data: {
          id: userId,
          email: `${userId}@rotate.test`,
          name: 'U',
          passwordHash: 'x',
          totpSecretEnc: oldBox.encrypt('TOTPSECRET', totpAad(userId)),
        },
      }),
    );

    const newKey = key();
    const rotated = new SecretBox(newKey, [oldKey]);
    const first = await reencryptSecrets(db, rotated);
    expect(first.phoneNumbers).toBeGreaterThanOrEqual(1);
    expect(first.users).toBeGreaterThanOrEqual(1);

    // Readable with only the new key: the old one can now be dropped.
    const onlyNew = new SecretBox(newKey);
    const phone = await phoneRow(conn.id);
    expect(onlyNew.decrypt(phone.accessTokenEnc!, phoneTokenAad(conn.id))).toBe('token-1');
    expect(onlyNew.decrypt(phone.registrationPinEnc!, phonePinAad(conn.id))).toBe('123456');
    const user = await owner.user.findUniqueOrThrow({ where: { id: userId } });
    expect(onlyNew.decrypt(user.totpSecretEnc!, totpAad(userId))).toBe('TOTPSECRET');
    expect(() => oldBox.decrypt(phone.accessTokenEnc!, phoneTokenAad(conn.id))).toThrow(
      DecryptionError,
    );

    // A second run touches nothing for this row.
    const before = await phoneRow(conn.id);
    await reencryptSecrets(db, rotated);
    expect((await phoneRow(conn.id)).accessTokenEnc).toBe(before.accessTokenEnc);
  });
});
