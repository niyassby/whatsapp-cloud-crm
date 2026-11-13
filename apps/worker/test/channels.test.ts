/**
 * Phase 4.2 in the worker: Instagram and website chat on the same pipeline as WhatsApp, ad and QR
 * attribution, call events and group webhooks. Real Postgres; Meta and Instagram are faked.
 */
import { randomUUID } from 'node:crypto';
import { type DbClient, messageInclude, messageToDto, withTenant } from '@wacrm/db';
import { channelCredentialsAad } from '@wacrm/shared/server';
import { InstagramClient } from '@wacrm/whatsapp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  processCallsChange,
  processGroupChange,
  processInstagramEvent,
} from '../src/processors/channels';
import { processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import { buildDeps, connectNumber, createOrg, db, inboundPayload } from './support';

let client: DbClient;
beforeAll(() => {
  client = db();
});
afterAll(async () => {
  await client.$disconnect();
});

/** A fake Instagram Graph: records sends, answers profiles. */
function fakeInstagram() {
  const sent: { url: string; body: unknown; auth: string | null }[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    if (url.includes('/messages')) {
      sent.push({
        url,
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get('authorization'),
      });
      return json({ recipient_id: 'x', message_id: `mid.${randomUUID()}` });
    }
    if (url.includes('fields=name')) return json({ name: 'Insta Ira', username: 'ira.shop' });
    return json({ error: { message: 'unknown', code: 100 } }, 400);
  }) as typeof globalThis.fetch;
  return {
    sent,
    client: new InstagramClient({
      appId: 'a',
      appSecret: 's',
      apiVersion: 'v25.0',
      baseUrl: 'https://ig.test',
      fetch,
    }),
  };
}

async function instagramChannel(orgId: string, deps: ReturnType<typeof buildDeps>['deps']) {
  const id = randomUUID();
  const accountId = `1784${Math.floor(Math.random() * 1e10)}`;
  await withTenant(client, { orgId }, (tx) =>
    tx.channel.create({
      data: {
        id,
        orgId,
        kind: 'instagram',
        name: '@shop',
        externalId: accountId,
        credentialsEnc: deps.secrets.encrypt(
          JSON.stringify({ accessToken: 'ig-token-1234567890' }),
          channelCredentialsAad(id),
        ),
      },
    }),
  );
  return { id, accountId };
}

const igPayload = (accountId: string, messaging: Record<string, unknown>) => ({
  object: 'instagram',
  entry: [{ id: accountId, time: Date.now(), messaging: [messaging] }],
});

describe('Instagram', () => {
  it('saves a DM as a contact, conversation and message, once', async () => {
    const ctx = buildDeps(client);
    const ig = fakeInstagram();
    ctx.deps.instagram = ig.client;
    const orgId = await createOrg(client);
    const channel = await instagramChannel(orgId, ctx.deps);
    const payload = igPayload(channel.accountId, {
      sender: { id: 'igsid-1' },
      recipient: { id: channel.accountId },
      timestamp: Date.now(),
      message: { mid: 'mid.1', text: 'Is this in stock?' },
    });
    await processInstagramEvent(ctx.deps, orgId, channel.id, payload);
    await processInstagramEvent(ctx.deps, orgId, channel.id, payload); // a redelivery

    const state = await withTenant(client, { orgId }, async (tx) => ({
      contacts: await tx.contact.findMany({ include: { identities: true } }),
      conversations: await tx.conversation.findMany({ include: { channel: true } }),
      messages: await tx.message.count(),
    }));
    expect(state.contacts).toHaveLength(1);
    expect(state.contacts[0]).toMatchObject({ name: 'Insta Ira', waId: null });
    expect(state.contacts[0]?.identities[0]).toMatchObject({
      externalId: 'igsid-1',
      handle: 'ira.shop',
    });
    expect(state.conversations[0]).toMatchObject({ phoneId: null, channel: { kind: 'instagram' } });
    expect(state.conversations[0]?.windowExpiresAt).not.toBeNull();
    expect(state.messages).toBe(1);
    // The rules and flows run for Instagram too.
    expect(ctx.automation).toHaveLength(2);
  });

  it('turns a tapped quick reply into a button reply flows can branch on, and skips echoes', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const channel = await instagramChannel(orgId, ctx.deps);
    await processInstagramEvent(
      ctx.deps,
      orgId,
      channel.id,
      igPayload(channel.accountId, {
        sender: { id: 'igsid-2' },
        recipient: { id: channel.accountId },
        timestamp: Date.now(),
        message: { mid: 'mid.2', text: 'Track order', quick_reply: { payload: 'track' } },
      }),
    );
    await processInstagramEvent(
      ctx.deps,
      orgId,
      channel.id,
      igPayload(channel.accountId, {
        sender: { id: channel.accountId },
        recipient: { id: 'igsid-2' },
        timestamp: Date.now(),
        message: { mid: 'mid.echo', text: 'Sent from the Instagram app', is_echo: true },
      }),
    );
    const messages = await withTenant(client, { orgId }, (tx) => tx.message.findMany());
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'interactive', body: 'Track order' });
    expect((messages[0]?.content as { reply: { id: string } }).reply.id).toBe('track');
  });

  it('sends a reply with the channel token, buttons as quick replies', async () => {
    const ctx = buildDeps(client);
    const ig = fakeInstagram();
    ctx.deps.instagram = ig.client;
    const orgId = await createOrg(client);
    const channel = await instagramChannel(orgId, ctx.deps);
    await processInstagramEvent(
      ctx.deps,
      orgId,
      channel.id,
      igPayload(channel.accountId, {
        sender: { id: 'igsid-3' },
        recipient: { id: channel.accountId },
        timestamp: Date.now(),
        message: { mid: 'mid.3', text: 'Hi' },
      }),
    );
    const { conversationId } = await withTenant(client, { orgId }, async (tx) => ({
      conversationId: (await tx.conversation.findFirstOrThrow()).id,
    }));
    const id = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId }, (tx) =>
      tx.message.create({
        data: {
          id,
          createdAt,
          orgId,
          conversationId,
          direction: 'outbound',
          type: 'interactive',
          status: 'queued',
          body: 'Pick one',
          content: {
            interactive: {
              type: 'button',
              body: 'Pick one',
              buttons: [
                { id: 'a', title: 'Sizes' },
                { id: 'b', title: 'Prices' },
              ],
            },
          },
        },
      }),
    );
    const outcome = await sendOutboundMessage(
      ctx.deps,
      { orgId, messageId: id, createdAt: createdAt.toISOString() },
      { finalAttempt: false },
    );
    expect(outcome).toBe('sent');
    expect(ig.sent).toHaveLength(1);
    expect(ig.sent[0]?.url).toContain(`/${channel.accountId}/messages`);
    expect(ig.sent[0]?.auth).toBe('Bearer ig-token-1234567890');
    expect(ig.sent[0]?.body).toEqual({
      recipient: { id: 'igsid-3' },
      message: {
        text: 'Pick one',
        quick_replies: [
          { content_type: 'text', title: 'Sizes', payload: 'a' },
          { content_type: 'text', title: 'Prices', payload: 'b' },
        ],
      },
    });
    const row = await withTenant(client, { orgId }, (tx) =>
      tx.message.findUniqueOrThrow({ where: { id_createdAt: { id, createdAt } } }),
    );
    expect(row.status).toBe('sent');
  });

  it('refuses media on Instagram, visibly', async () => {
    const ctx = buildDeps(client);
    ctx.deps.instagram = fakeInstagram().client;
    const orgId = await createOrg(client);
    const channel = await instagramChannel(orgId, ctx.deps);
    await processInstagramEvent(
      ctx.deps,
      orgId,
      channel.id,
      igPayload(channel.accountId, {
        sender: { id: 'igsid-4' },
        recipient: { id: channel.accountId },
        timestamp: Date.now(),
        message: { mid: 'mid.4', text: 'Hi' },
      }),
    );
    const conversationId = await withTenant(
      client,
      { orgId },
      async (tx) => (await tx.conversation.findFirstOrThrow()).id,
    );
    const id = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId }, (tx) =>
      tx.message.create({
        data: {
          id,
          createdAt,
          orgId,
          conversationId,
          direction: 'outbound',
          type: 'image',
          status: 'queued',
        },
      }),
    );
    expect(
      await sendOutboundMessage(
        ctx.deps,
        { orgId, messageId: id, createdAt: createdAt.toISOString() },
        { finalAttempt: false },
      ),
    ).toBe('failed');
  });
});

describe('website chat', () => {
  it('delivers a reply to the visitor, and never a note', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const { conversationId } = await withTenant(client, { orgId }, async (tx) => {
      const channel = await tx.channel.create({
        data: {
          orgId,
          kind: 'webchat',
          name: 'Site',
          externalId: `wc_${randomUUID().replace(/-/g, '')}`,
        },
      });
      const contact = await tx.contact.create({ data: { orgId, name: 'Visitor' } });
      const conversation = await tx.conversation.create({
        data: { orgId, channelId: channel.id, contactId: contact.id },
      });
      return { conversationId: conversation.id };
    });
    const id = randomUUID();
    const createdAt = new Date();
    await withTenant(client, { orgId }, (tx) =>
      tx.message.create({
        data: {
          id,
          createdAt,
          orgId,
          conversationId,
          direction: 'outbound',
          type: 'text',
          status: 'queued',
          body: 'Hello there',
        },
      }),
    );
    expect(
      await sendOutboundMessage(
        ctx.deps,
        { orgId, messageId: id, createdAt: createdAt.toISOString() },
        { finalAttempt: false },
      ),
    ).toBe('sent');
    expect(ctx.publisher.visitor).toEqual([
      {
        conversationId,
        message: expect.objectContaining({ id, from: 'agent', body: 'Hello there' }),
      },
    ]);
    const row = await withTenant(client, { orgId }, (tx) =>
      tx.message.findUniqueOrThrow({
        where: { id_createdAt: { id, createdAt } },
        include: messageInclude,
      }),
    );
    expect(row.status).toBe('delivered');
  });
});

describe('catalog orders', () => {
  it('stores an order in Meta’s shape and shows its total', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    await processMessagesChange(
      ctx.deps,
      orgId,
      inboundPayload(phone.phoneNumberId, {
        type: 'order',
        text: undefined,
        order: {
          catalog_id: 'cat-1',
          text: 'By 6 please',
          product_items: [
            { product_retailer_id: 'CAKE-1', quantity: 2, item_price: 650, currency: 'INR' },
            { product_retailer_id: 'BREAD-1', quantity: 1, item_price: 220.5, currency: 'INR' },
          ],
        },
      }),
    );
    const message = await withTenant(client, { orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { type: 'order' }, include: messageInclude }),
    );
    expect(message.content).toMatchObject({
      catalog_id: 'cat-1',
      product_items: [
        expect.objectContaining({ product_retailer_id: 'CAKE-1', item_price: 650 }),
        expect.objectContaining({ product_retailer_id: 'BREAD-1', item_price: 220.5 }),
      ],
    });
    expect(messageToDto(message).detail).toEqual({
      kind: 'order',
      items: [
        { retailerId: 'CAKE-1', quantity: 2, price: 650, currency: 'INR' },
        { retailerId: 'BREAD-1', quantity: 1, price: 220.5, currency: 'INR' },
      ],
      total: 1520.5,
      currency: 'INR',
    });
  });
});

describe('attribution', () => {
  it('records a click-to-WhatsApp ad on the message and the conversation', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    await processMessagesChange(
      ctx.deps,
      orgId,
      inboundPayload(phone.phoneNumberId, {
        referral: {
          source_url: 'https://fb.me/ad1',
          source_id: '120200000000001',
          source_type: 'ad',
          headline: 'Diwali sale',
          body: '50% off',
          media_type: 'image',
          ctwa_clid: 'clid-1',
        },
      }),
    );
    const state = await withTenant(client, { orgId }, async (tx) => ({
      referrals: await tx.adReferral.findMany(),
      conversation: await tx.conversation.findFirstOrThrow(),
    }));
    expect(state.referrals).toEqual([
      expect.objectContaining({
        sourceId: '120200000000001',
        headline: 'Diwali sale',
        clickId: 'clid-1',
        channelKind: 'whatsapp',
        newContact: true,
      }),
    ]);
    expect(state.conversation).toMatchObject({
      adSourceId: '120200000000001',
      adHeadline: 'Diwali sale',
    });
  });

  it('counts a chat opened from a QR code by its exact message', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    const qr = await withTenant(client, { orgId }, (tx) =>
      tx.qrCode.create({
        data: {
          orgId,
          phoneId: phone.id,
          code: randomUUID(),
          name: 'Counter',
          prefilledMessage: 'I want to order',
          deepLinkUrl: 'https://wa.me/message/X',
        },
      }),
    );
    for (const body of ['I want to order', 'I want to order something else']) {
      await processMessagesChange(
        ctx.deps,
        orgId,
        inboundPayload(phone.phoneNumberId, { text: { body } }),
      );
    }
    const referrals = await withTenant(client, { orgId }, (tx) => tx.adReferral.findMany());
    expect(referrals).toEqual([
      expect.objectContaining({ sourceType: 'qr', sourceId: qr.id, headline: 'Counter' }),
    ]);
  });
});

const callsPayload = (phoneNumberId: string, call: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba',
      changes: [
        {
          field: 'calls',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
            calls: [{ timestamp: String(Math.floor(Date.now() / 1000)), ...call }],
          },
        },
      ],
    },
  ],
});

describe('calls', () => {
  it('rings the team with the offer, and logs a missed call when it ends unanswered', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    const callId = `wacid.${randomUUID()}`;
    const ring = callsPayload(phone.phoneNumberId, {
      id: callId,
      event: 'connect',
      direction: 'USER_INITIATED',
      from: '919800000077',
      to: '15550001111',
      session: { sdp_type: 'offer', sdp: 'v=0 fake offer' },
    });
    await processCallsChange(ctx.deps, orgId, ring);
    await processCallsChange(ctx.deps, orgId, ring); // a redelivery rings once

    const updates = ctx.publisher.of('call:updated');
    expect(updates).toHaveLength(1);
    expect(updates[0]?.payload).toMatchObject({
      offer: 'v=0 fake offer',
      call: { status: 'ringing', direction: 'inbound' },
    });

    await processCallsChange(
      ctx.deps,
      orgId,
      callsPayload(phone.phoneNumberId, { id: callId, event: 'terminate', status: 'FAILED' }),
    );
    const state = await withTenant(client, { orgId }, async (tx) => ({
      calls: await tx.call.findMany(),
      messages: await tx.message.findMany({ where: { type: 'call' } }),
    }));
    expect(state.calls).toEqual([
      expect.objectContaining({ status: 'missed', metaCallId: callId }),
    ]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.body).toBe('Missed call');
  });

  it('logs the duration of an answered call', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    const callId = `wacid.${randomUUID()}`;
    await processCallsChange(
      ctx.deps,
      orgId,
      callsPayload(phone.phoneNumberId, {
        id: callId,
        event: 'connect',
        direction: 'USER_INITIATED',
        from: '919800000078',
        session: { sdp_type: 'offer', sdp: 'v=0' },
      }),
    );
    await withTenant(client, { orgId }, (tx) =>
      tx.call.updateMany({ data: { status: 'connected', connectedAt: new Date() } }),
    );
    await processCallsChange(
      ctx.deps,
      orgId,
      callsPayload(phone.phoneNumberId, {
        id: callId,
        event: 'terminate',
        status: 'COMPLETED',
        duration: 151,
      }),
    );
    const call = await withTenant(client, { orgId }, (tx) => tx.call.findFirstOrThrow());
    expect(call).toMatchObject({ status: 'ended', durationSec: 151 });
    const message = await withTenant(client, { orgId }, (tx) =>
      tx.message.findFirstOrThrow({ where: { type: 'call' } }),
    );
    expect(message.body).toBe('Call, 2:31');
  });
});

describe('groups', () => {
  it('gives a pending group its id and invite link from the lifecycle webhook', async () => {
    const ctx = buildDeps(client);
    const orgId = await createOrg(client);
    const phone = await connectNumber(client, orgId);
    await withTenant(client, { orgId }, (tx) =>
      tx.waGroup.create({ data: { orgId, phoneId: phone.id, subject: 'VIP customers' } }),
    );
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba',
          changes: [
            {
              field: 'group_lifecycle_update',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: phone.phoneNumberId },
                groups: [
                  {
                    group_id: 'grp-1',
                    type: 'group_create',
                    subject: 'VIP customers',
                    invite_link: 'https://chat.whatsapp.com/abc',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    await processGroupChange(ctx.deps, orgId, 'group_lifecycle_update', payload);
    const group = await withTenant(client, { orgId }, (tx) => tx.waGroup.findFirstOrThrow());
    expect(group).toMatchObject({
      groupId: 'grp-1',
      status: 'active',
      inviteLink: 'https://chat.whatsapp.com/abc',
    });
  });
});
