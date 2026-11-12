/**
 * AI settings, the knowledge base and inbox help over real HTTP, with the deterministic fake
 * providers. Indexing itself runs in the worker (tested there); here passages are stored the way
 * it stores them.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { FakeChatProvider, FakeEmbeddingProvider } from '@wacrm/ai';
import {
  createPrismaClient,
  creditWallet,
  type DbClient,
  ensureWallet,
  replaceChunks,
  withTenant,
} from '@wacrm/db';
import { ErrorCode } from '@wacrm/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { QueuesService } from '../src/infra/queues.service';
import { buildApp, Client, type TestApp, tokenFromMail, uniqueEmail, urls } from './helpers';

const CURRENCY = 'XAP';
const chat = new FakeChatProvider();
const embeddings = new FakeEmbeddingProvider();
let t: TestApp;
let owner: DbClient;

beforeAll(async () => {
  t = await buildApp({
    env: { WALLET_DEFAULT_CURRENCY: CURRENCY, WALLET_LOW_BALANCE_DEFAULT: '0' },
    ai: { chat, embeddings },
  });
  owner = createPrismaClient({ connectionString: urls.directUrl });
  await owner.rateCard.createMany({
    data: [
      ['ai_input', 1_000_000],
      ['ai_output', 5_000_000],
      ['ai_embedding', 100_000],
    ].map(([category, rate]) => ({
      country: '*',
      category: String(category),
      currency: CURRENCY,
      rateMicros: BigInt(rate as number),
      validFrom: new Date('2026-01-01'),
    })),
    skipDuplicates: true,
  });
});
afterAll(async () => {
  await t?.close();
  await owner?.$disconnect();
});

async function workspace(opts: { funds?: number } = {}) {
  const client = new Client(t.app);
  const { orgId } = await client.signup();
  await withTenant(owner, { orgId }, async (tx) => {
    await ensureWallet(tx, orgId, CURRENCY);
    if (opts.funds !== 0) {
      await creditWallet(tx, {
        orgId,
        amountMicros: opts.funds ?? 10_000_000,
        idempotencyKey: 'seed',
      });
    }
  });
  const join = async () => {
    const email = uniqueEmail();
    await client.post('/team/invitations', { email, role: 'agent' });
    const member = new Client(t.app);
    await member.post('/invitations/accept', {
      token: tokenFromMail(t.mailer, email),
      name: 'Agent',
      password: 'correct-horse-battery',
    });
    return member;
  };
  /** A conversation where the customer asked something. */
  const conversation = (question: string) =>
    withTenant(owner, { orgId }, async (tx) => {
      const waba = await tx.wabaAccount.create({ data: { orgId, wabaId: randomUUID() } });
      const phone = await tx.phoneNumber.create({
        data: {
          orgId,
          wabaAccountId: waba.id,
          phoneNumberId: randomUUID(),
          status: 'connected',
          credentialSource: 'manual',
        },
      });
      const contact = await tx.contact.create({
        data: { orgId, waId: `9198${String(Math.random()).slice(2, 10)}` },
      });
      const c = await tx.conversation.create({
        data: { orgId, phoneId: phone.id, contactId: contact.id },
      });
      await tx.message.create({
        data: {
          orgId,
          conversationId: c.id,
          direction: 'inbound',
          type: 'text',
          status: 'received',
          body: question,
        },
      });
      return c.id;
    });
  /** Store passages the way the worker's indexing does. */
  const indexed = async (documentId: string, text: string) => {
    const { vectors } = await embeddings.embed([text]);
    await withTenant(owner, { orgId }, async (tx) => {
      await replaceChunks(tx, {
        orgId,
        documentId,
        model: embeddings.model,
        chunks: [{ ordinal: 0, content: text, tokens: 20, vector: vectors[0]! }],
      });
      await tx.knowledgeDocument.update({
        where: { id: documentId },
        data: { status: 'ready', chunkCount: 1, embeddingModel: embeddings.model },
      });
    });
  };
  const balance = async () =>
    Number((await owner.wallet.findUniqueOrThrow({ where: { orgId } })).balanceMicros);
  return { client, orgId, join, conversation, indexed, balance };
}

const enable = (c: Client, over: object = {}) =>
  c.req('PATCH', '/ai/settings', { enabled: true, ...over });

describe('settings', () => {
  it('start off, say what is available, and only owners and admins change them', async () => {
    const s = await workspace();
    const res = await s.client.get('/ai/settings');
    expect(res.body).toMatchObject({
      enabled: false,
      autoReply: false,
      inboxAssist: true,
      minConfidence: 0.7,
      available: { chat: true, knowledge: true },
      model: 'fake-chat',
    });
    const agent = await s.join();
    expect((await agent.get('/ai/settings')).status).toBe(200);
    expect((await agent.req('PATCH', '/ai/settings', { enabled: true })).status).toBe(403);
    const changed = await enable(s.client, { instructions: 'Be brief.', minConfidence: 0.8 });
    expect(changed.body).toMatchObject({
      enabled: true,
      minConfidence: 0.8,
      instructions: 'Be brief.',
    });
    const log = await s.client.get('/orgs/current/audit-logs');
    const entry = log.body.items.find((i: { action: string }) => i.action === 'ai.changed');
    expect(entry.metadata).toEqual({ enabled: true, instructions: 'changed', minConfidence: 0.8 });
    expect((await s.client.req('PATCH', '/ai/settings', { minConfidence: 2 })).status).toBe(400);
  });
});

describe('knowledge base', () => {
  it('adds text and files, queues indexing, searches, and deletes', async () => {
    const s = await workspace();
    const spy = vi.spyOn(t.app.get(QueuesService), 'enqueueAiJob');
    const added = await s.client.post('/ai/knowledge', {
      title: 'Store hours',
      content: 'Our Bandra store opens every day from 9 am to 9 pm.',
    });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ title: 'Store hours', source: 'text', status: 'pending' });
    expect(spy).toHaveBeenCalledWith({ kind: 'index', orgId: s.orgId, documentId: added.body.id });
    const stored = await owner.knowledgeDocument.findUniqueOrThrow({
      where: { id: added.body.id },
    });
    expect(stored.fileKey).toBe(`orgs/${s.orgId}/knowledge/${added.body.id}`);

    const upload = (filename: string, type: string, body: string | Buffer) => {
      const boundary = `----test${randomBytes(8).toString('hex')}`;
      return t.app.inject({
        method: 'POST',
        url: '/ai/knowledge/upload',
        payload: Buffer.concat([
          Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`,
          ),
          Buffer.from(body),
          Buffer.from(`\r\n--${boundary}--\r\n`),
        ]),
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
          authorization: `Bearer ${s.client.accessToken}`,
        },
      });
    };
    const md = await upload(
      'returns-policy.md',
      'application/octet-stream',
      '# Returns\nWithin 14 days.',
    );
    expect(md.statusCode).toBe(201);
    expect(JSON.parse(md.body)).toMatchObject({
      title: 'returns-policy',
      mimeType: 'text/markdown',
    });
    const pdf = await upload('menu.pdf', 'application/pdf', '%PDF-1.7 binary');
    expect(pdf.statusCode).toBe(400);
    expect(JSON.parse(pdf.body).code).toBe(ErrorCode.KNOWLEDGE_INVALID);
    spy.mockRestore();

    await s.indexed(added.body.id, 'Our Bandra store opens every day from 9 am to 9 pm.');
    const hits = await s.client.post('/ai/knowledge/search', {
      query: 'When does the Bandra store open?',
    });
    expect(hits.body[0]).toMatchObject({ documentId: added.body.id, title: 'Store hours' });
    expect(hits.body[0].score).toBeGreaterThan(0.3);

    expect((await s.client.req('DELETE', `/ai/knowledge/${added.body.id}`)).status).toBe(204);
    expect(await owner.knowledgeChunk.count({ where: { documentId: added.body.id } })).toBe(0);
    expect((await s.client.post('/ai/knowledge/search', { query: 'Bandra store' })).body).toEqual(
      [],
    );
    const list = await s.client.get('/ai/knowledge');
    expect(list.body.map((d: { title: string }) => d.title)).toEqual(['returns-policy']);
  });

  it('another workspace sees nothing, and agents cannot manage it', async () => {
    const a = await workspace();
    const b = await workspace();
    const doc = await a.client.post('/ai/knowledge', { title: 'Secret', content: 'Bandra hours' });
    await a.indexed(doc.body.id, 'Bandra hours are 9 to 9');
    expect((await b.client.get('/ai/knowledge')).body).toEqual([]);
    expect((await b.client.req('DELETE', `/ai/knowledge/${doc.body.id}`)).status).toBe(404);
    expect((await b.client.post('/ai/knowledge/search', { query: 'Bandra hours' })).body).toEqual(
      [],
    );
    const agent = await a.join();
    expect((await agent.get('/ai/knowledge')).status).toBe(403);
  });
});

describe('inbox help', () => {
  it('suggests a reply from the knowledge base, with sources, charged and logged', async () => {
    const s = await workspace();
    await enable(s.client);
    const doc = await s.client.post('/ai/knowledge', {
      title: 'Store hours',
      content: 'Bandra store hours: 9 am to 9 pm every day.',
    });
    await s.indexed(doc.body.id, 'Bandra store hours: 9 am to 9 pm every day.');
    const conv = await s.conversation('What are the Bandra store hours?');
    const agent = await s.join();
    const before = await s.balance();

    const res = await agent.post(`/ai/conversations/${conv}/suggest`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      text: 'Bandra store hours: 9 am to 9 pm every day.',
      sources: [{ documentId: doc.body.id, title: 'Store hours' }],
    });
    expect(res.body.confidence).toBeGreaterThan(0.7);
    const spent = before - (await s.balance());
    expect(spent).toBeGreaterThan(0);

    const log = await s.client.get('/ai/log');
    expect(log.body.items[0]).toMatchObject({
      id: res.body.logId,
      kind: 'suggestion',
      status: 'answered',
      sent: false,
      input: 'What are the Bandra store hours?',
      costMicros: spent,
    });

    // Nothing in the knowledge base: no answer, and a note on why.
    const other = await s.conversation('Do you deliver to Dubai?');
    const none = await agent.post(`/ai/conversations/${other}/suggest`);
    expect(none.body).toMatchObject({ text: '', confidence: 0, note: 'Not in the knowledge base' });
  });

  it('summarizes and rewrites', async () => {
    const s = await workspace();
    await enable(s.client);
    const conv = await s.conversation('My order #1001 has not arrived');
    const summary = await s.client.post(`/ai/conversations/${conv}/summarize`);
    expect(summary.body.text).toContain('My order #1001 has not arrived');
    const rewrite = await s.client.post('/ai/rewrite', {
      text: 'ur order ships tmrw',
      tone: 'formal',
    });
    expect(rewrite.body.text).toBe('[rewritten] ur order ships tmrw');
    expect(chat.requests.at(-1)!.messages[0]!.content).toContain('polite and professional');
    expect((await s.client.post('/ai/rewrite', { text: 'x', tone: 'angry' })).status).toBe(400);
    const kinds = (await s.client.get('/ai/log')).body.items.map((i: { kind: string }) => i.kind);
    expect(kinds).toEqual(['rewrite', 'summary']);
  });

  it('refuses when AI is off, unpriced, unaffordable, or not on the plan', async () => {
    const s = await workspace();
    const conv = await s.conversation('Hello');
    const off = await s.client.post(`/ai/conversations/${conv}/suggest`);
    expect(off.status).toBe(409);
    expect(off.body.code).toBe(ErrorCode.AI_NOT_AVAILABLE);

    await enable(s.client, { inboxAssist: false });
    expect((await s.client.post('/ai/rewrite', { text: 'hi', tone: 'formal' })).body.code).toBe(
      ErrorCode.AI_NOT_AVAILABLE,
    );

    const broke = await workspace({ funds: 0 });
    await enable(broke.client);
    const poor = await broke.client.post('/ai/rewrite', { text: 'hi', tone: 'formal' });
    expect(poor.status).toBe(402);
    expect(poor.body.code).toBe(ErrorCode.INSUFFICIENT_BALANCE);

    const starter = await workspace();
    await enable(starter.client);
    await owner.$executeRaw`
      UPDATE subscriptions SET plan_id = (SELECT id FROM plans WHERE code = 'starter'),
             status = 'active', trial_ends_at = NULL
      WHERE org_id = ${starter.orgId}::uuid`;
    const noPlan = await starter.client.post('/ai/rewrite', { text: 'hi', tone: 'formal' });
    expect(noPlan.status).toBe(402);
    expect(noPlan.body.code).toBe(ErrorCode.PLAN_FEATURE_UNAVAILABLE);
    // Reading stays open after a downgrade.
    expect((await starter.client.get('/ai/settings')).status).toBe(200);
  });

  it('a provider failure is logged, reported, and charges nothing', async () => {
    const s = await workspace();
    await enable(s.client);
    const before = await s.balance();
    chat.responder = () => {
      throw new Error('boom');
    };
    try {
      const res = await s.client.post('/ai/rewrite', { text: 'hi', tone: 'formal' });
      expect(res.status).toBe(502);
      expect(res.body.code).toBe(ErrorCode.AI_PROVIDER_ERROR);
    } finally {
      chat.responder = null;
    }
    expect(await s.balance()).toBe(before);
    expect((await s.client.get('/ai/log')).body.items[0]).toMatchObject({
      kind: 'rewrite',
      status: 'failed',
      costMicros: 0,
    });
  });
});
