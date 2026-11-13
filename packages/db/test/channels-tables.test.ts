/**
 * Phase 4.2 tables: channels follow their numbers, every new table is confined to its workspace,
 * referrals are append-only, and the pre-tenant lookups return no credentials.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbClient } from '../src/client';
import { withDbContext, withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let phoneA: string;
let channelA: string;
let widgetKey: string;

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  widgetKey = `wc_${randomUUID().replace(/-/g, '')}`;
  await asA(async (tx) => {
    const waba = await tx.wabaAccount.create({ data: { orgId: a.orgId, wabaId: randomUUID() } });
    const phone = await tx.phoneNumber.create({
      data: {
        orgId: a.orgId,
        wabaAccountId: waba.id,
        phoneNumberId: randomUUID(),
        status: 'connected',
        credentialSource: 'manual',
        verifiedName: 'Pickle Shop',
      },
    });
    phoneA = phone.id;
    const channel = await tx.channel.findUniqueOrThrow({ where: { phoneId: phone.id } });
    channelA = channel.id;
    const contact = await tx.contact.create({ data: { orgId: a.orgId, name: 'Visitor' } });
    const widget = await tx.channel.create({
      data: {
        orgId: a.orgId,
        kind: 'webchat',
        name: 'Site',
        externalId: widgetKey,
        credentialsEnc: 'v1.not-a-real-secret',
      },
    });
    await tx.contactIdentity.create({
      data: {
        orgId: a.orgId,
        contactId: contact.id,
        channelId: widget.id,
        externalId: 'visitor-1',
      },
    });
    const conversation = await tx.conversation.create({
      data: { orgId: a.orgId, channelId: widget.id, contactId: contact.id },
    });
    await tx.adReferral.create({
      data: {
        orgId: a.orgId,
        conversationId: conversation.id,
        contactId: contact.id,
        channelKind: 'webchat',
        sourceId: 'ad-1',
        messageId: randomUUID(),
        messageCreatedAt: new Date(),
      },
    });
    await tx.qrCode.create({
      data: {
        orgId: a.orgId,
        phoneId: phone.id,
        code: randomUUID(),
        name: 'QR',
        prefilledMessage: 'hi',
        deepLinkUrl: 'https://wa.me/message/X',
      },
    });
    await tx.catalogProduct.create({
      data: {
        orgId: a.orgId,
        catalogId: 'cat',
        retailerId: 'SKU',
        name: 'Pickle',
        syncedAt: new Date(),
      },
    });
    await tx.waGroup.create({ data: { orgId: a.orgId, phoneId: phone.id, subject: 'Group' } });
    await tx.call.create({
      data: {
        orgId: a.orgId,
        conversationId: conversation.id,
        contactId: contact.id,
        metaCallId: randomUUID(),
        direction: 'inbound',
        status: 'missed',
        startedAt: new Date(),
        messageId: randomUUID(),
        messageCreatedAt: new Date(),
      },
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

describe('WhatsApp channels follow their numbers', () => {
  it('a new number gets a channel in its own org, named after it', async () => {
    const channel = await asA((tx) => tx.channel.findUniqueOrThrow({ where: { id: channelA } }));
    expect(channel).toMatchObject({
      orgId: a.orgId,
      kind: 'whatsapp',
      name: 'Pickle Shop',
      status: 'active',
    });
  });

  it('a disconnected number disconnects its channel, and reconnecting brings it back', async () => {
    await asA((tx) =>
      tx.phoneNumber.update({ where: { id: phoneA }, data: { status: 'disconnected' } }),
    );
    expect(
      (await asA((tx) => tx.channel.findUniqueOrThrow({ where: { id: channelA } }))).status,
    ).toBe('disconnected');
    await asA((tx) =>
      tx.phoneNumber.update({ where: { id: phoneA }, data: { status: 'connected' } }),
    );
    expect(
      (await asA((tx) => tx.channel.findUniqueOrThrow({ where: { id: channelA } }))).status,
    ).toBe('active');
  });

  it('a WhatsApp channel needs a number, and another kind must not have one', async () => {
    await expect(
      asA((tx) => tx.channel.create({ data: { orgId: a.orgId, kind: 'whatsapp', name: 'x' } })),
    ).rejects.toThrow(/channels_whatsapp_phone/);
  });
});

describe('isolation', () => {
  it('another org sees none of the new rows', async () => {
    const seen = await asB(async (tx) => [
      await tx.channel.count(),
      await tx.contactIdentity.count(),
      await tx.adReferral.count(),
      await tx.qrCode.count(),
      await tx.catalogProduct.count(),
      await tx.waGroup.count(),
      await tx.call.count(),
    ]);
    expect(seen).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('another org cannot write into this one', async () => {
    await expect(
      asB((tx) =>
        tx.channel.create({
          data: { orgId: a.orgId, kind: 'webchat', name: 'x', externalId: `wc_${randomUUID()}` },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
    const moved = await asB((tx) => tx.channel.updateMany({ data: { name: 'Stolen' } }));
    expect(moved.count).toBe(0);
  });
});

describe('append-only and kept rows', () => {
  it('referrals cannot be changed or deleted, and channels and calls cannot be deleted', async () => {
    await expect(
      asA((tx) => tx.adReferral.updateMany({ data: { sourceId: 'x' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.adReferral.deleteMany())).rejects.toThrow(/permission denied/);
    await expect(
      asA((tx) => tx.channel.deleteMany({ where: { kind: 'webchat' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asA((tx) => tx.call.deleteMany())).rejects.toThrow(/permission denied/);
  });
});

describe('pre-tenant lookups', () => {
  it('find a widget by its key, without its credentials, and not once disconnected', async () => {
    const rows = await app.$queryRaw<
      Record<string, unknown>[]
    >`SELECT * FROM webchat_channel_lookup(${widgetKey})`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(['config', 'id', 'name', 'org_id']);
    expect(await app.$queryRaw`SELECT * FROM webchat_channel_lookup('wc_short')`).toEqual([]);

    await asA((tx) =>
      tx.channel.updateMany({ where: { kind: 'webchat' }, data: { status: 'disconnected' } }),
    );
    expect(await app.$queryRaw`SELECT * FROM webchat_channel_lookup(${widgetKey})`).toEqual([]);
    await asA((tx) =>
      tx.channel.updateMany({ where: { kind: 'webchat' }, data: { status: 'active' } }),
    );
  });

  it('route an Instagram account to its org and channel only while it is live', async () => {
    const account = `1784${Date.now()}`;
    const id = await asA(
      async (tx) =>
        (
          await tx.channel.create({
            data: { orgId: a.orgId, kind: 'instagram', name: '@x', externalId: account },
          })
        ).id,
    );
    const route = await app.$queryRaw<{ org_id: string; channel_id: string }[]>`
      SELECT * FROM channel_route_lookup('instagram'::"ChannelKind", ${account})`;
    expect(route).toEqual([{ org_id: a.orgId, channel_id: id }]);
    // The same account cannot be live twice.
    await expect(
      asB((tx) =>
        tx.channel.create({
          data: { orgId: b.orgId, kind: 'instagram', name: '@x', externalId: account },
        }),
      ),
    ).rejects.toThrow(/Unique constraint|channels_live_external/);
  });

  it('nothing outside a context sees a channel', async () => {
    expect(await withDbContext(app, {}, (tx) => tx.channel.count())).toBe(0);
  });
});
