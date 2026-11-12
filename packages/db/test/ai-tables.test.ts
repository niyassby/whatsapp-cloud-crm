import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { replaceChunks, searchKnowledge, vectorLiteral, writeAiLog } from '../src/ai';
import type { DbClient } from '../src/client';
import { withTenant } from '../src/tenant';
import { appClient, createTenant, ownerClient, type TenantFixture } from './fixtures';

let owner: DbClient;
let app: DbClient;
let a: TenantFixture;
let b: TenantFixture;
let docB: string;
let logB: string;
const MODEL = 'test-model';

/** A unit vector pointing mostly along one axis. */
const axis = (i: number) => {
  const v = new Array<number>(1024).fill(0.001);
  v[i] = 1;
  return v;
};

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  a = await createTenant(owner);
  b = await createTenant(owner);
  docB = randomUUID();
  logB = randomUUID();
  await withTenant(app, { orgId: b.orgId, userId: b.userId }, async (tx) => {
    await tx.knowledgeDocument.create({
      data: {
        id: docB,
        orgId: b.orgId,
        title: 'Theirs',
        source: 'text',
        fileKey: `orgs/${b.orgId}/knowledge/${docB}`,
        status: 'ready',
      },
    });
    await replaceChunks(tx, {
      orgId: b.orgId,
      documentId: docB,
      model: MODEL,
      chunks: [
        { ordinal: 0, content: 'Shipping takes 3 days', tokens: 5, vector: axis(1) },
        { ordinal: 1, content: 'Open 9 to 9', tokens: 4, vector: axis(2) },
      ],
    });
    await writeAiLog(tx, {
      id: logB,
      orgId: b.orgId,
      kind: 'suggestion',
      status: 'answered',
      model: MODEL,
      input: 'q',
      output: 'a',
      inputTokens: 1,
      outputTokens: 1,
    });
  });
});

afterAll(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const asA = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: a.orgId, userId: a.userId }, fn);
const asB = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(app, { orgId: b.orgId, userId: b.userId }, fn);

describe('knowledge search', () => {
  it('finds the nearest passage first, by cosine similarity', async () => {
    const hits = await asB((tx) =>
      searchKnowledge(tx, { orgId: b.orgId, vector: axis(2), model: MODEL, limit: 5 }),
    );
    expect(hits.map((h) => h.content)).toEqual(['Open 9 to 9', 'Shipping takes 3 days']);
    expect(hits[0]!.score).toBeGreaterThan(0.9);
    expect(hits[0]).toMatchObject({ documentId: docB, title: 'Theirs' });
  });

  it('another workspace finds nothing, even asking for that org by id', async () => {
    const hits = await asA((tx) =>
      searchKnowledge(tx, { orgId: b.orgId, vector: axis(2), model: MODEL, limit: 5 }),
    );
    expect(hits).toEqual([]);
    expect(await asA((tx) => tx.knowledgeChunk.count())).toBe(0);
    expect(await asA((tx) => tx.knowledgeDocument.count())).toBe(0);
    expect(await asA((tx) => tx.aiLog.count())).toBe(0);
  });

  it('passages from another embedding model are not compared', async () => {
    const hits = await asB((tx) =>
      searchKnowledge(tx, { orgId: b.orgId, vector: axis(2), model: 'other', limit: 5 }),
    );
    expect(hits).toEqual([]);
  });

  it('only vectors of the right size are stored, and numbers only reach the cast', async () => {
    await expect(
      asB(
        (tx) =>
          tx.$executeRaw`
          INSERT INTO knowledge_chunks (id, org_id, document_id, ordinal, content, tokens, embedding, embedding_model)
          VALUES (${randomUUID()}::uuid, ${b.orgId}::uuid, ${docB}::uuid, 9, 'x', 1, '[1,2,3]'::vector, ${MODEL})`,
      ),
    ).rejects.toThrow();
    expect(() => vectorLiteral([1, Number.NaN])).toThrow('not finite');
  });

  it('cannot write passages into another workspace', async () => {
    await expect(
      asA((tx) =>
        replaceChunks(tx, {
          orgId: b.orgId,
          documentId: docB,
          model: MODEL,
          chunks: [{ ordinal: 5, content: 'x', tokens: 1, vector: axis(3) }],
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('grants', () => {
  it('the AI log only grows', async () => {
    await expect(
      asB((tx) => tx.aiLog.update({ where: { id: logB }, data: { output: 'changed' } })),
    ).rejects.toThrow(/permission denied/);
    await expect(asB((tx) => tx.aiLog.delete({ where: { id: logB } }))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('documents are soft-deleted; settings are not deleted', async () => {
    await expect(asB((tx) => tx.knowledgeDocument.delete({ where: { id: docB } }))).rejects.toThrow(
      /permission denied/,
    );
    await asB((tx) => tx.aiSettings.create({ data: { orgId: b.orgId, enabled: true } }));
    await expect(asB((tx) => tx.aiSettings.delete({ where: { orgId: b.orgId } }))).rejects.toThrow(
      /permission denied/,
    );
  });
});
