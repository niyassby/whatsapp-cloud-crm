/** Inbound messages, delivery statuses, outbound sends and media: real Postgres, fake Meta. */
import { randomUUID } from 'node:crypto';
import { type DbClient, withTenant } from '@wacrm/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RetryableJobError } from '../src/deps';
import { ensureMessagePartitions } from '../src/processors/maintenance';
import { downloadInboundMedia } from '../src/processors/media';
import { callbackData, processMessagesChange } from '../src/processors/inbound';
import { sendOutboundMessage } from '../src/processors/outbound';
import {
  buildDeps,
  connectNumber,
  createOrg,
  db as appDb,
  inboundPayload,
  metaError,
  ownerDb,
  statusPayload,
} from './support';

let db: DbClient;
let owner: DbClient;

beforeAll(() => {
  db = appDb();
  owner = ownerDb();
});
afterAll(async () => {
  await db.$disconnect();
  await owner.$disconnect();
});

async function setup() {
  const orgId = await createOrg(db);
  const phone = await connectNumber(db, orgId);
  return { orgId, phone, ...buildDeps(db) };
}

const conversations = (orgId: string) =>
  withTenant(db, { orgId }, (tx) =>
    tx.conversation.findMany({ include: { contact: true, messages: true } }),
  );

/** A queued outbound text in a fresh conversation. */
async function queuedMessage(
  orgId: string,
  phoneId: string,
  over: Record<string, unknown> = { type: 'text', body: 'Hi there' },
) {
  const id = randomUUID();
  const createdAt = new Date();
  await withTenant(db, { orgId }, async (tx) => {
    const contact = await tx.contact.create({
      data: { orgId, waId: `91${Date.now()}${Math.floor(Math.random() * 1000)}` },
    });
    const conversation = await tx.conversation.create({
      data: { orgId, phoneId, contactId: contact.id },
    });
    await tx.message.create({
      data: {
        id,
        createdAt,
        orgId,
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'queued',
        type: 'text',
        ...over,
      },
    });
  });
  return { orgId, messageId: id, createdAt: createdAt.toISOString() };
}

const readMessage = (job: { messageId: string; createdAt: string }) =>
  owner.message.findUniqueOrThrow({
    where: { id_createdAt: { id: job.messageId, createdAt: new Date(job.createdAt) } },
  });

describe('inbound messages', () => {
  it('creates contact, conversation and message, opens the window, and publishes', async () => {
    const { deps, orgId, phone, publisher } = await setup();
    const before = Date.now();
    await processMessagesChange(deps, orgId, inboundPayload(phone.phoneNumberId, {}));

    const [conv] = await conversations(orgId);
    expect(conv).toMatchObject({
      status: 'open',
      unreadCount: 1,
      lastMessagePreview: 'Hello',
      phoneId: phone.id,
    });
    expect(conv!.contact).toMatchObject({ waId: '919800000001', name: 'Asha' });
    expect(conv!.messages[0]).toMatchObject({
      direction: 'inbound',
      type: 'text',
      status: 'received',
      body: 'Hello',
    });
    const window = conv!.windowExpiresAt!.getTime();
    expect(window).toBeGreaterThan(before + 23 * 3600_000);
    expect(window).toBeLessThanOrEqual(before + 24 * 3600_000 + 5000);

    expect(publisher.of('message:new')).toHaveLength(1);
    expect(publisher.of('conversation:updated')).toHaveLength(1);
    expect(publisher.events.every((e) => e.orgId === orgId)).toBe(true);
  });

  it('a redelivery or replay changes nothing', async () => {
    const { deps, orgId, phone, publisher } = await setup();
    const payload = inboundPayload(phone.phoneNumberId, {});
    await processMessagesChange(deps, orgId, payload);
    await processMessagesChange(deps, orgId, payload);
    const [conv] = await conversations(orgId);
    expect(conv!.messages).toHaveLength(1);
    expect(conv!.unreadCount).toBe(1);
    expect(publisher.of('message:new')).toHaveLength(1);
  });

  it('threads by contact, and counts unread', async () => {
    const { deps, orgId, phone } = await setup();
    await processMessagesChange(deps, orgId, inboundPayload(phone.phoneNumberId, {}));
    await processMessagesChange(deps, orgId, inboundPayload(phone.phoneNumberId, {}));
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, {}, { from: '919800000002', name: 'Ben' }),
    );
    const rows = await conversations(orgId);
    expect(rows).toHaveLength(2);
    expect(rows.find((c) => c.contact.waId === '919800000001')?.unreadCount).toBe(2);
  });

  it('a customer writing back reopens a closed conversation', async () => {
    const { deps, orgId, phone } = await setup();
    await processMessagesChange(deps, orgId, inboundPayload(phone.phoneNumberId, {}));
    await withTenant(db, { orgId }, (tx) =>
      tx.conversation.updateMany({ data: { status: 'closed' } }),
    );
    await processMessagesChange(deps, orgId, inboundPayload(phone.phoneNumberId, {}));
    expect((await conversations(orgId))[0]?.status).toBe('open');
  });

  it('an older message arriving late cannot shrink the window or the preview', async () => {
    const { deps, orgId, phone } = await setup();
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, { text: { body: 'newer' } }),
    );
    const [first] = await conversations(orgId);
    const twoHoursAgo = String(Math.floor(Date.now() / 1000) - 7200);
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, { timestamp: twoHoursAgo, text: { body: 'older' } }),
    );
    const [after] = await conversations(orgId);
    expect(after!.windowExpiresAt).toEqual(first!.windowExpiresAt);
    expect(after!.lastMessagePreview).toBe('newer');
    expect(after!.messages).toHaveLength(2);
  });

  it('queues inbound media for download and marks it pending', async () => {
    const { deps, orgId, phone, media } = await setup();
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, {
        type: 'image',
        image: { id: 'meta-media-1', mime_type: 'image/jpeg', sha256: 'x', caption: 'Pic' },
      }),
    );
    const [conv] = await conversations(orgId);
    expect(conv!.messages[0]).toMatchObject({
      type: 'image',
      body: 'Pic',
      mediaStatus: 'pending',
      mediaMetaId: 'meta-media-1',
    });
    expect(media[0]).toMatchObject({ orgId, metaMediaId: 'meta-media-1' });
  });

  it.each([
    ['location', { location: { latitude: 1.5, longitude: 2.5, name: 'Shop' } }, 'Shop'],
    ['button', { button: { text: 'Yes', payload: 'y' } }, 'Yes'],
    [
      'interactive',
      { interactive: { type: 'button_reply', button_reply: { id: 'a', title: 'Choice A' } } },
      'Choice A',
    ],
    ['reaction', { reaction: { message_id: 'wamid.x', emoji: '👍' } }, '👍'],
  ])('stores a %s message', async (type, fields, body) => {
    const { deps, orgId, phone } = await setup();
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, { type, ...fields }),
    );
    expect((await conversations(orgId))[0]!.messages[0]).toMatchObject({ type, body });
  });

  it('an unknown type is kept as unsupported rather than dropped', async () => {
    const { deps, orgId, phone } = await setup();
    await processMessagesChange(
      deps,
      orgId,
      inboundPayload(phone.phoneNumberId, { type: 'brand_new_type' }),
    );
    expect((await conversations(orgId))[0]!.messages[0]!.type).toBe('unsupported');
  });

  it('never touches another org', async () => {
    const a = await setup();
    const other = await createOrg(db);
    await processMessagesChange(a.deps, a.orgId, inboundPayload(a.phone.phoneNumberId, {}));
    expect(await conversations(other)).toEqual([]);
  });
});

describe('delivery statuses', () => {
  async function sent(s: Awaited<ReturnType<typeof setup>>) {
    const job = await queuedMessage(s.orgId, s.phone.id);
    await sendOutboundMessage(s.deps, job, { finalAttempt: false });
    const row = await readMessage(job);
    return { job, wamid: row.waMessageId! };
  }
  const apply = (s: Awaited<ReturnType<typeof setup>>, status: Record<string, unknown>) =>
    processMessagesChange(s.deps, s.orgId, statusPayload(s.phone.phoneNumberId, status));

  it('moves forward through delivered and read', async () => {
    const s = await setup();
    const { job, wamid } = await sent(s);
    await apply(s, { id: wamid, status: 'delivered' });
    expect((await readMessage(job)).status).toBe('delivered');
    await apply(s, { id: wamid, status: 'read' });
    const row = await readMessage(job);
    expect(row.status).toBe('read');
    expect(row.readAt).not.toBeNull();
  });

  it('out-of-order statuses never move ticks backwards', async () => {
    const s = await setup();
    const { job, wamid } = await sent(s);
    await apply(s, { id: wamid, status: 'read' });
    await apply(s, { id: wamid, status: 'delivered' });
    await apply(s, { id: wamid, status: 'sent' });
    expect((await readMessage(job)).status).toBe('read');
  });

  it('shows the mapped error on failure', async () => {
    const s = await setup();
    const { job, wamid } = await sent(s);
    await apply(s, {
      id: wamid,
      status: 'failed',
      errors: [{ code: 131047, title: 'Re-engagement message' }],
    });
    expect(await readMessage(job)).toMatchObject({
      status: 'failed',
      errorCode: 'WA_WINDOW_CLOSED',
      errorMessage: 'Re-engagement message',
    });
  });

  it('finds the message by callback data, even before the send call has returned', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    // Status arrives while the row is still `queued` and has no wamid or ref.
    await apply(s, {
      id: 'wamid.EARLY',
      status: 'delivered',
      biz_opaque_callback_data: callbackData(job.messageId, new Date(job.createdAt)),
    });
    expect(await readMessage(job)).toMatchObject({
      status: 'delivered',
      waMessageId: 'wamid.EARLY',
    });
  });

  it('ignores statuses for messages sent by another tool', async () => {
    const s = await setup();
    await apply(s, { id: 'wamid.NOT_OURS', status: 'delivered' });
    expect(s.publisher.of('message:updated')).toEqual([]);
  });

  it('callback data from another org cannot touch this org', async () => {
    const a = await setup();
    const b = await setup();
    const job = await queuedMessage(a.orgId, a.phone.id);
    await processMessagesChange(
      b.deps,
      b.orgId,
      statusPayload(b.phone.phoneNumberId, {
        id: 'wamid.FORGED',
        status: 'failed',
        biz_opaque_callback_data: callbackData(job.messageId, new Date(job.createdAt)),
      }),
    );
    expect((await readMessage(job)).status).toBe('queued');
  });
});

describe('outbound sending', () => {
  it('sends text with correlation data, saves the wamid and publishes', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('sent');
    const row = await readMessage(job);
    expect(row.status).toBe('sent');
    expect(row.waMessageId).toMatch(/^wamid\.OUT/);
    const [call] = s.fake.calls;
    expect(call!.method).toBe('sendText');
    expect(call!.args[1]).toEqual({ body: 'Hi there' });
    expect(call!.args[2]).toEqual({
      callbackData: callbackData(job.messageId, new Date(job.createdAt)),
    });
    expect(s.publisher.of('message:updated')).toHaveLength(1);
  });

  it('a duplicate job does not send twice', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    await sendOutboundMessage(s.deps, job, { finalAttempt: false });
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('skipped');
    expect(s.fake.calls).toHaveLength(1);
  });

  it('a permanent error fails immediately with the mapped code', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    s.fake.respondWith(() => ({
      data: null,
      error: metaError({ code: 'WA_WINDOW_CLOSED', message: 'Outside the window' }),
    }));
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('failed');
    expect(await readMessage(job)).toMatchObject({
      status: 'failed',
      errorCode: 'WA_WINDOW_CLOSED',
      errorMessage: 'Outside the window',
    });
  });

  it('a retryable error throws so BullMQ retries, and the retry can succeed', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    s.fake.respondWith(() => ({
      data: null,
      error: metaError({ code: 'WA_RATE_LIMITED', retryable: true }),
    }));
    await expect(sendOutboundMessage(s.deps, job, { finalAttempt: false })).rejects.toBeInstanceOf(
      RetryableJobError,
    );
    expect((await readMessage(job)).status).toBe('queued');

    s.fake.respondWith(() => ({ data: { messageId: 'wamid.RETRY', waId: 'x' }, error: null }));
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('sent');
  });

  it('out of attempts, a retryable error becomes a visible failure', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    s.fake.respondWith(() => ({
      data: null,
      error: metaError({ code: 'WA_RATE_LIMITED', retryable: true }),
    }));
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: true })).toBe('failed');
    expect((await readMessage(job)).errorCode).toBe('WA_RATE_LIMITED');
  });

  it('a send interrupted by a crash is failed, not silently resent', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id, { type: 'text', status: 'sending' });
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('failed');
    expect(s.fake.calls).toEqual([]);
    expect((await readMessage(job)).errorMessage).toMatch(/interrupted/);
  });

  it('does not send from a disconnected number', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    await withTenant(db, { orgId: s.orgId }, (tx) =>
      tx.phoneNumber.update({ where: { id: s.phone.id }, data: { status: 'disconnected' } }),
    );
    expect(await sendOutboundMessage(s.deps, job, { finalAttempt: false })).toBe('failed');
    expect(s.fake.calls).toEqual([]);
  });

  it('a status arriving during the send is not overwritten by `sent`', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    s.fake.respondWith(async () => {
      await processMessagesChange(
        s.deps,
        s.orgId,
        statusPayload(s.phone.phoneNumberId, {
          id: 'wamid.RACE',
          status: 'delivered',
          biz_opaque_callback_data: callbackData(job.messageId, new Date(job.createdAt)),
        }),
      );
      return { data: { messageId: 'wamid.RACE', waId: 'x' }, error: null };
    });
    await sendOutboundMessage(s.deps, job, { finalAttempt: false });
    expect((await readMessage(job)).status).toBe('delivered');
  });

  it('sends a template with its parameters', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id, {
      type: 'template',
      body: 'Hi Asha',
      content: {
        templateName: 'welcome',
        language: 'en_US',
        components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
      },
    });
    await sendOutboundMessage(s.deps, job, { finalAttempt: false });
    expect(s.fake.calls[0]!.args[1]).toEqual({
      name: 'welcome',
      language: 'en_US',
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'Asha' }] }],
    });
  });

  it('uploads stored media once, reusing the Meta id on retry', async () => {
    const s = await setup();
    const key = `orgs/${s.orgId}/messages/x`;
    await s.storage.put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    const job = await queuedMessage(s.orgId, s.phone.id, {
      type: 'image',
      body: 'A caption',
      mediaKey: key,
      mediaMime: 'image/jpeg',
      mediaStatus: 'stored',
    });
    s.fake.respondWith(() => ({
      data: null,
      error: metaError({ code: 'WA_META_UNAVAILABLE', retryable: true }),
    }));
    await expect(sendOutboundMessage(s.deps, job, { finalAttempt: false })).rejects.toBeInstanceOf(
      RetryableJobError,
    );
    s.fake.respondWith(() => ({ data: { messageId: 'wamid.M', waId: 'x' }, error: null }));
    await sendOutboundMessage(s.deps, job, { finalAttempt: false });

    expect(s.fake.calls.filter((c) => c.method === 'uploadMedia')).toHaveLength(1);
    expect(s.fake.calls.at(-1)).toMatchObject({
      method: 'sendMedia',
      args: [
        '' + s.fake.calls.at(-1)!.args[0],
        { kind: 'image', mediaId: 'uploaded-media-1', caption: 'A caption' },
        expect.anything(),
      ],
    });
  });
});

describe('inbound media download', () => {
  async function pendingMedia() {
    const s = await setup();
    await processMessagesChange(
      s.deps,
      s.orgId,
      inboundPayload(s.phone.phoneNumberId, {
        type: 'document',
        document: { id: 'meta-doc', mime_type: 'application/pdf', sha256: 'x', filename: 'a.pdf' },
      }),
    );
    return { ...s, job: s.media[0]! };
  }

  it('copies the bytes to storage under the org and marks it stored', async () => {
    const s = await pendingMedia();
    s.fake.respondWith(() => ({
      data: {
        id: 'meta-doc',
        mimeType: 'application/pdf',
        sha256: 'x',
        fileSize: 5,
        bytes: Buffer.from('%PDF-'),
      },
      error: null,
    }));
    await downloadInboundMedia(s.deps, s.job, { finalAttempt: false });
    const row = await readMessage(s.job);
    expect(row).toMatchObject({ mediaStatus: 'stored', mediaSize: 5, mediaFilename: 'a.pdf' });
    expect(row.mediaKey).toBe(`orgs/${s.orgId}/messages/${s.job.messageId}`);
    expect(s.storage.objects.get(row.mediaKey!)?.bytes.toString()).toBe('%PDF-');
  });

  it('retries transient failures, and records the final one', async () => {
    const s = await pendingMedia();
    s.fake.respondWith(() => ({ data: null, error: metaError({ retryable: true }) }));
    await expect(
      downloadInboundMedia(s.deps, s.job, { finalAttempt: false }),
    ).rejects.toBeInstanceOf(RetryableJobError);
    await downloadInboundMedia(s.deps, s.job, { finalAttempt: true });
    expect((await readMessage(s.job)).mediaStatus).toBe('failed');
  });
});

describe('message partitions', () => {
  it('routes rows to the monthly partition, not the default', async () => {
    const s = await setup();
    const job = await queuedMessage(s.orgId, s.phone.id);
    const [row] = await owner.$queryRaw<{ partition: string }[]>`
      SELECT tableoid::regclass::text AS partition FROM messages WHERE id = ${job.messageId}::uuid`;
    const month = new Date(job.createdAt).toISOString().slice(0, 7).replace('-', '_');
    expect(row?.partition).toBe(`message_partitions.messages_${month}`);
  });

  it('the job creates upcoming months and is safe to repeat', async () => {
    const future = new Date(Date.UTC(2031, 5, 15));
    const first = await ensureMessagePartitions(db, future);
    expect(first).toBeGreaterThan(0);
    expect(await ensureMessagePartitions(db, future)).toBe(0);
    const [row] = await owner.$queryRaw<{ name: string | null }[]>`
      SELECT to_regclass('message_partitions.messages_2031_09')::text AS name`;
    expect(row?.name).toBe('message_partitions.messages_2031_09');
  });
});
