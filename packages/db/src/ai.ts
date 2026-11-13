/**
 * AI data: settings, knowledge passages with their vectors, search, the log, and charging for
 * usage. Vectors are written and searched with reviewed raw SQL because Prisma has no type for
 * pgvector; every query runs under the tenant's RLS context and also filters by org.
 */
import {
  AI_RATE_CATEGORIES,
  type AiKind,
  type AiLogDto,
  type AiLogStatus,
  type AiSettings,
  type AiSourceDto,
  aiCostMicros,
  AppError,
  DEFAULT_AI_SETTINGS,
  ErrorCode,
  type KnowledgeDocumentDto,
  type KnowledgeDocumentStatus,
  type KnowledgeHitDto,
} from '@wacrm/shared';
import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client';
import type { TenantTx } from './tenant';
import { debitWallet, findRate, type RateQuote } from './wallet';

// ------------------------------------------------------------------ settings

export async function getAiSettings(tx: TenantTx): Promise<AiSettings> {
  const row = await tx.aiSettings.findFirst();
  if (!row) return { ...DEFAULT_AI_SETTINGS };
  return {
    enabled: row.enabled,
    inboxAssist: row.inboxAssist,
    autoReply: row.autoReply,
    minConfidence: row.minConfidence,
    instructions: row.instructions,
  };
}

// ------------------------------------------------------------------ vectors

/** pgvector's text form. Numbers are checked so nothing but digits reaches the cast. */
export function vectorLiteral(v: number[]): string {
  if (!v.every(Number.isFinite)) throw new Error('A vector holds a number that is not finite');
  return `[${v.join(',')}]`;
}

export interface NewChunk {
  ordinal: number;
  content: string;
  tokens: number;
  vector: number[];
}

/** Replace a document's passages. Runs in the transaction that marks the document ready. */
export async function replaceChunks(
  tx: TenantTx,
  input: { orgId: string; documentId: string; model: string; chunks: NewChunk[] },
): Promise<void> {
  await tx.knowledgeChunk.deleteMany({ where: { documentId: input.documentId } });
  // Reviewed raw SQL: bound parameters only; the vector is a checked literal cast by Postgres.
  for (const c of input.chunks) {
    await tx.$executeRaw`
      INSERT INTO knowledge_chunks (id, org_id, document_id, ordinal, content, tokens, embedding, embedding_model)
      VALUES (${randomUUID()}::uuid, ${input.orgId}::uuid, ${input.documentId}::uuid, ${c.ordinal},
              ${c.content}, ${c.tokens}, ${vectorLiteral(c.vector)}::vector, ${input.model})`;
  }
}

/**
 * The passages nearest a question, by cosine similarity, among ready documents embedded with
 * the same model. Exact search: one workspace's passages are few enough to scan.
 */
export async function searchKnowledge(
  tx: TenantTx,
  input: { orgId: string; vector: number[]; model: string; limit: number; minScore?: number },
): Promise<KnowledgeHitDto[]> {
  const v = vectorLiteral(input.vector);
  // Reviewed raw SQL: bound parameters; RLS and the org filter both confine it to one workspace.
  const rows = await tx.$queryRaw<
    { id: string; document_id: string; title: string; content: string; score: number }[]
  >`
    SELECT c.id, c.document_id, d.title, c.content, 1 - (c.embedding <=> ${v}::vector) AS score
    FROM knowledge_chunks c
    JOIN knowledge_documents d ON d.id = c.document_id
    WHERE c.org_id = ${input.orgId}::uuid
      AND c.embedding_model = ${input.model}
      AND d.deleted_at IS NULL AND d.status = 'ready'
    ORDER BY c.embedding <=> ${v}::vector
    LIMIT ${input.limit}`;
  return rows
    .map((r) => ({
      chunkId: r.id,
      documentId: r.document_id,
      title: r.title,
      content: r.content,
      score: Math.max(0, Math.min(1, Number(r.score))),
    }))
    .filter((r) => r.score >= (input.minScore ?? 0));
}

export function knowledgeDocumentToDto(
  d: Prisma.KnowledgeDocumentGetPayload<object>,
): KnowledgeDocumentDto {
  return {
    id: d.id,
    title: d.title,
    source: d.source === 'upload' ? 'upload' : 'text',
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    status: d.status as KnowledgeDocumentStatus,
    error: d.error,
    chunkCount: d.chunkCount,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

// ------------------------------------------------------------------ charging

export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Embedding tokens, priced separately. */
  embeddingTokens?: number;
}

interface AiRates {
  currency: string;
  input: RateQuote | null;
  output: RateQuote | null;
  embedding: RateQuote | null;
}

async function aiRates(tx: TenantTx, orgId: string): Promise<AiRates> {
  const wallet = await tx.wallet.findUnique({ where: { orgId }, select: { currency: true } });
  if (!wallet) {
    throw new AppError(ErrorCode.INSUFFICIENT_BALANCE, 'Add funds to the wallet to use AI');
  }
  const rate = (category: string) =>
    findRate(tx, { currency: wallet.currency, category, country: null });
  return {
    currency: wallet.currency,
    input: await rate(AI_RATE_CATEGORIES.input),
    output: await rate(AI_RATE_CATEGORIES.output),
    embedding: await rate(AI_RATE_CATEGORIES.embedding),
  };
}

function costOf(rates: AiRates, usage: AiUsage) {
  const need = (q: RateQuote | null, tokens: number) => {
    if (tokens <= 0) return 0;
    if (!q) {
      throw new AppError(
        ErrorCode.RATE_NOT_CONFIGURED,
        'No price is set for AI usage, so it is not available yet. Contact support.',
      );
    }
    return aiCostMicros(tokens, q.rateMicros);
  };
  return {
    input: need(rates.input, usage.inputTokens),
    output: need(rates.output, usage.outputTokens),
    embedding: need(rates.embedding, usage.embeddingTokens ?? 0),
  };
}

/**
 * Before calling a provider: rates exist and the wallet can cover the most this call could cost.
 * Nothing is held; a concurrent spend can still win, and then the charge below fails visibly.
 */
export async function assertAiAffordable(
  tx: TenantTx,
  orgId: string,
  estimate: AiUsage,
): Promise<void> {
  const rates = await aiRates(tx, orgId);
  const c = costOf(rates, estimate);
  const total = c.input + c.output + c.embedding;
  const wallet = await tx.wallet.findUniqueOrThrow({
    where: { orgId },
    select: { balanceMicros: true, reservedMicros: true },
  });
  if (wallet.balanceMicros - wallet.reservedMicros < BigInt(total)) {
    throw new AppError(ErrorCode.INSUFFICIENT_BALANCE, 'The wallet balance is too low to use AI', {
      neededMicros: total,
    });
  }
}

/**
 * Charge for one AI call, once (keys `ai:<logId>:<part>`), with the rate copied onto each
 * ledger entry. Returns what was charged.
 */
export async function chargeAi(
  tx: TenantTx,
  input: { orgId: string; logId: string; usage: AiUsage },
): Promise<number> {
  const rates = await aiRates(tx, input.orgId);
  const c = costOf(rates, input.usage);
  const parts: [keyof typeof c, RateQuote | null, number][] = [
    ['input', rates.input, input.usage.inputTokens],
    ['output', rates.output, input.usage.outputTokens],
    ['embedding', rates.embedding, input.usage.embeddingTokens ?? 0],
  ];
  let total = 0;
  for (const [part, quote, tokens] of parts) {
    const amount = c[part];
    if (amount <= 0 || !quote) continue;
    await debitWallet(tx, {
      orgId: input.orgId,
      amountMicros: amount,
      referenceType: 'ai',
      referenceId: input.logId,
      idempotencyKey: `ai:${input.logId}:${part}`,
      wholesale: quote.partnerId
        ? { partnerId: quote.partnerId, amountMicros: aiCostMicros(tokens, quote.wholesaleMicros) }
        : null,
      description: `AI ${part}: ${tokens.toLocaleString('en')} tokens`,
      rate: {
        rateCardId: quote.rateCardId,
        rateMicros: quote.rateMicros,
        country: null,
        category: quote.category,
      },
    });
    total += amount;
  }
  return total;
}

// ------------------------------------------------------------------ the log

export interface AiLogInput {
  id?: string;
  orgId: string;
  kind: AiKind;
  status: AiLogStatus;
  model: string;
  conversationId?: string | null;
  flowRunId?: string | null;
  userId?: string | null;
  input: string;
  output: string;
  confidence?: number | null;
  sources?: AiSourceDto[];
  sent?: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
  error?: string | null;
}

export function writeAiLog(tx: TenantTx, l: AiLogInput) {
  return tx.aiLog.create({
    data: {
      id: l.id ?? randomUUID(),
      orgId: l.orgId,
      kind: l.kind,
      status: l.status,
      model: l.model,
      conversationId: l.conversationId ?? null,
      flowRunId: l.flowRunId ?? null,
      userId: l.userId ?? null,
      input: l.input.slice(0, 4000),
      output: l.output.slice(0, 8000),
      confidence: l.confidence ?? null,
      sources: (l.sources ?? []) as unknown as Prisma.InputJsonValue,
      sent: l.sent ?? false,
      inputTokens: l.inputTokens,
      outputTokens: l.outputTokens,
      costMicros: BigInt(l.costMicros ?? 0),
      error: l.error ?? null,
    },
  });
}

export function aiLogToDto(l: Prisma.AiLogGetPayload<object>): AiLogDto {
  return {
    id: l.id,
    kind: l.kind as AiKind,
    status: l.status as AiLogStatus,
    model: l.model,
    conversationId: l.conversationId,
    flowRunId: l.flowRunId,
    userId: l.userId,
    input: l.input,
    output: l.output,
    confidence: l.confidence,
    sources: Array.isArray(l.sources) ? (l.sources as unknown as AiSourceDto[]) : [],
    sent: l.sent,
    inputTokens: l.inputTokens,
    outputTokens: l.outputTokens,
    costMicros: Number(l.costMicros),
    error: l.error,
    createdAt: l.createdAt.toISOString(),
  };
}
