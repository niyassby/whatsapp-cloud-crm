/**
 * Indexing the knowledge base: read a document's text from storage, split it, embed the
 * passages, and replace the document's passages, its status and its charge in one transaction.
 * Reindexing is the same job, so it is safe to run again.
 */
import { randomUUID } from 'node:crypto';
import { AiProviderError, chunkText, MAX_DOCUMENT_CHARS } from '@wacrm/ai';
import {
  assertAiAffordable,
  chargeAi,
  type NewChunk,
  replaceChunks,
  withTenant,
  writeAiLog,
} from '@wacrm/db';
import { AppError, type AiJob } from '@wacrm/shared';
import { RetryableJobError, type WorkerDeps } from '../deps';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

async function fail(deps: WorkerDeps, orgId: string, documentId: string, error: string) {
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.knowledgeDocument.updateMany({
      where: { id: documentId, deletedAt: null },
      data: { status: 'failed', error },
    }),
  );
  deps.publisher.emit(orgId, 'knowledge:updated', { documentId });
}

export async function indexKnowledgeDocument(
  deps: WorkerDeps,
  orgId: string,
  documentId: string,
  opts: { finalAttempt?: boolean } = {},
): Promise<string> {
  const doc = await withTenant(deps.db, { orgId }, (tx) =>
    tx.knowledgeDocument.findFirst({ where: { id: documentId, deletedAt: null } }),
  );
  if (!doc) return 'gone';
  const embeddings = deps.ai.embeddings;
  if (!embeddings) {
    await fail(deps, orgId, documentId, 'The knowledge base is not set up on this installation');
    return 'unavailable';
  }
  await withTenant(deps.db, { orgId }, (tx) =>
    tx.knowledgeDocument.update({
      where: { id: documentId },
      data: { status: 'indexing', error: null },
    }),
  );
  deps.publisher.emit(orgId, 'knowledge:updated', { documentId });

  try {
    const text = (await deps.storage.get(doc.fileKey)).toString('utf8');
    if (text.length > MAX_DOCUMENT_CHARS) {
      await fail(deps, orgId, documentId, 'The document is too long; split it into smaller files');
      return 'too_long';
    }
    const chunks = chunkText(text);
    if (chunks.length === 0) {
      await fail(deps, orgId, documentId, 'The document has no text');
      return 'empty';
    }
    const estimate = chunks.reduce((s, c) => s + c.tokens, 0);
    await withTenant(deps.db, { orgId }, (tx) =>
      assertAiAffordable(tx, orgId, { inputTokens: 0, outputTokens: 0, embeddingTokens: estimate }),
    );
    const embedded = await embeddings.embed(
      chunks.map((c) => c.content),
      'document',
    );
    const rows: NewChunk[] = chunks.map((c, i) => ({ ...c, vector: embedded.vectors[i]! }));
    const logId = randomUUID();
    await withTenant(
      deps.db,
      { orgId },
      async (tx) => {
        // Deleted while it was being embedded: keep nothing.
        const still = await tx.knowledgeDocument.findFirst({
          where: { id: documentId, deletedAt: null },
          select: { id: true },
        });
        if (!still) return;
        const usage = { inputTokens: 0, outputTokens: 0, embeddingTokens: embedded.tokens };
        const cost = await chargeAi(tx, { orgId, logId, usage });
        await replaceChunks(tx, { orgId, documentId, model: embeddings.model, chunks: rows });
        await tx.knowledgeDocument.update({
          where: { id: documentId },
          data: {
            status: 'ready',
            error: null,
            chunkCount: rows.length,
            embeddingModel: embeddings.model,
          },
        });
        await writeAiLog(tx, {
          id: logId,
          orgId,
          kind: 'indexing',
          status: 'answered',
          model: embeddings.model,
          input: doc.title,
          output: `${rows.length} passages`,
          inputTokens: embedded.tokens,
          outputTokens: 0,
          costMicros: cost,
        });
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    deps.publisher.emit(orgId, 'knowledge:updated', { documentId });
    deps.publisher.emit(orgId, 'wallet:updated', {});
    return `indexed ${rows.length}`;
  } catch (err) {
    if (err instanceof AiProviderError && err.opts.retryable && !opts.finalAttempt) {
      throw new RetryableJobError(err.message);
    }
    // Money, prices and refusals need a person; show why on the document.
    if (err instanceof AppError || err instanceof AiProviderError || opts.finalAttempt) {
      await fail(deps, orgId, documentId, message(err));
      return 'failed';
    }
    throw err;
  }
}

export function processAiJob(
  deps: WorkerDeps,
  job: AiJob,
  opts: { finalAttempt?: boolean } = {},
): Promise<string> {
  switch (job.kind) {
    case 'index':
      return indexKnowledgeDocument(deps, job.orgId, job.documentId, opts);
  }
}
