/**
 * The assistant, shared by the API (inbox suggestions, summaries, rewrites) and the worker (the
 * flow AI step). It reads, searches and asks; it does not write. The caller writes the log entry
 * and the charge in its own transaction, so a flow step's answer, its message, its log and its
 * charge commit together or not at all.
 */
import {
  assertAiAffordable,
  type DbClient,
  searchKnowledge,
  type TenantTx,
  withTenant,
} from '@wacrm/db';
import { type AiSourceDto, type AiTone, KNOWLEDGE_TOP_K } from '@wacrm/shared';
import { estimateTokens } from './chunk';
import type { AiProviders } from './index';
import {
  type KnowledgeSnippet,
  readReply,
  REPLY_SCHEMA,
  REPLY_SYSTEM,
  replyPrompt,
  REWRITE_SYSTEM,
  rewritePrompt,
  SUMMARY_SYSTEM,
  summaryPrompt,
  type TranscriptLine,
} from './prompts';
import type { TokenUsage } from './types';

/** Messages of a conversation the model sees, newest last. */
export const TRANSCRIPT_MESSAGES = 20;
/** Passages below this similarity are not shown to the model. */
export const MIN_PASSAGE_SCORE = 0.2;
const REPLY_MAX_TOKENS = 2_000;
const TEXT_MAX_TOKENS = 1_500;

export async function loadTranscript(
  tx: TenantTx,
  conversationId: string,
  limit = TRANSCRIPT_MESSAGES,
): Promise<TranscriptLine[]> {
  const rows = await tx.message.findMany({
    where: { conversationId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit,
    select: { direction: true, type: true, body: true },
  });
  return rows.reverse().map((m) => ({
    from: m.direction === 'inbound' ? 'customer' : m.direction === 'internal' ? 'note' : 'business',
    text: m.body?.trim() || `[${m.type}]`,
  }));
}

export interface AssistantResult {
  usage: TokenUsage & { embeddingTokens: number };
  model: string;
  refused: boolean;
}

export interface KnowledgeReply extends AssistantResult {
  answer: string;
  confidence: number;
  sources: AiSourceDto[];
  handoffReason: string | null;
  /** The customer's last words, for the log. */
  question: string;
}

/**
 * Draft the next reply to a conversation from the knowledge base. Throws AppError when the wallet
 * cannot cover it or no price is set, and AiProviderError when the provider fails.
 */
export async function knowledgeReply(
  db: DbClient,
  ai: AiProviders,
  input: { orgId: string; conversationId: string; instructions: string[] },
): Promise<KnowledgeReply> {
  const chat = ai.chat;
  if (!chat) throw new Error('No chat provider');
  const { transcript, businessName } = await withTenant(db, { orgId: input.orgId }, async (tx) => {
    const lines = await loadTranscript(tx, input.conversationId);
    const org = await tx.organization.findUniqueOrThrow({
      where: { id: input.orgId },
      select: { name: true },
    });
    // The most this could cost: everything it may read, a full answer, and the search.
    const words = lines.reduce((s, l) => s + l.text.length, 0) + KNOWLEDGE_TOP_K * 1_700 + 4_000;
    await assertAiAffordable(tx, input.orgId, {
      inputTokens: estimateTokens('x'.repeat(words)),
      outputTokens: REPLY_MAX_TOKENS,
      embeddingTokens: ai.embeddings ? 1_000 : 0,
    });
    return { transcript: lines, businessName: org.name };
  });

  // What to search for: the customer's latest messages, since the last reply from the business.
  const recent: string[] = [];
  for (const l of [...transcript].reverse()) {
    if (l.from === 'business') break;
    if (l.from === 'customer') recent.unshift(l.text);
  }
  const question = (recent.join('\n') || transcript.at(-1)?.text || '').slice(0, 2_000);

  let snippets: KnowledgeSnippet[] = [];
  let embeddingTokens = 0;
  if (ai.embeddings && question) {
    const embedded = await ai.embeddings.embed([question], 'query');
    embeddingTokens = embedded.tokens;
    const hits = await withTenant(db, { orgId: input.orgId }, (tx) =>
      searchKnowledge(tx, {
        orgId: input.orgId,
        vector: embedded.vectors[0]!,
        model: ai.embeddings!.model,
        limit: KNOWLEDGE_TOP_K,
        minScore: MIN_PASSAGE_SCORE,
      }),
    );
    snippets = hits.map((h) => ({ id: h.chunkId, title: h.title, content: h.content }));
  }

  const prompt = replyPrompt({
    businessName,
    instructions: input.instructions,
    snippets,
    conversation: transcript,
  });
  const result = await chat.generate({
    system: REPLY_SYSTEM,
    messages: prompt.messages,
    schema: REPLY_SCHEMA,
    maxTokens: REPLY_MAX_TOKENS,
    effort: 'low',
  });
  const usage = { ...result.usage, embeddingTokens };
  if (result.refused) {
    return {
      answer: '',
      confidence: 0,
      sources: [],
      handoffReason: 'The assistant declined to answer',
      question,
      usage,
      model: result.model,
      refused: true,
    };
  }
  const reply = readReply(result.json, prompt.labels);
  const titles = new Map(snippets.map((s) => [s.id, s.title] as const));
  // Sources are documents; a passage id maps to its document through the search hits.
  const sources = await withTenant(db, { orgId: input.orgId }, (tx) =>
    reply.sources.length
      ? tx.knowledgeChunk.findMany({
          where: { id: { in: reply.sources } },
          select: { id: true, documentId: true },
        })
      : Promise.resolve([]),
  );
  const docs = new Map<string, AiSourceDto>();
  for (const s of sources) {
    docs.set(s.documentId, { documentId: s.documentId, title: titles.get(s.id) ?? 'Document' });
  }
  return {
    answer: reply.answer,
    // An answer that names no passage is not grounded in the knowledge base.
    confidence: snippets.length && docs.size ? reply.confidence : Math.min(reply.confidence, 0.3),
    sources: [...docs.values()],
    handoffReason: reply.handoffReason,
    question,
    usage,
    model: result.model,
    refused: false,
  };
}

export interface TextResult extends AssistantResult {
  text: string;
}

export async function summarizeConversation(
  db: DbClient,
  ai: AiProviders,
  input: { orgId: string; conversationId: string },
): Promise<TextResult & { input: string }> {
  if (!ai.chat) throw new Error('No chat provider');
  const transcript = await withTenant(db, { orgId: input.orgId }, async (tx) => {
    const lines = await loadTranscript(tx, input.conversationId, 60);
    const chars = lines.reduce((s, l) => s + l.text.length, 0) + 2_000;
    await assertAiAffordable(tx, input.orgId, {
      inputTokens: estimateTokens('x'.repeat(chars)),
      outputTokens: TEXT_MAX_TOKENS,
    });
    return lines;
  });
  const r = await ai.chat.generate({
    system: SUMMARY_SYSTEM,
    messages: summaryPrompt(transcript),
    maxTokens: TEXT_MAX_TOKENS,
    effort: 'low',
  });
  return {
    text: r.refused ? '' : r.text,
    input: `${transcript.length} messages`,
    usage: { ...r.usage, embeddingTokens: 0 },
    model: r.model,
    refused: r.refused,
  };
}

export async function rewriteText(
  db: DbClient,
  ai: AiProviders,
  input: { orgId: string; text: string; tone: AiTone },
): Promise<TextResult> {
  if (!ai.chat) throw new Error('No chat provider');
  await withTenant(db, { orgId: input.orgId }, (tx) =>
    assertAiAffordable(tx, input.orgId, {
      inputTokens: estimateTokens(input.text) + 500,
      outputTokens: TEXT_MAX_TOKENS,
    }),
  );
  const r = await ai.chat.generate({
    system: REWRITE_SYSTEM,
    messages: rewritePrompt(input.text, input.tone),
    maxTokens: TEXT_MAX_TOKENS,
    effort: 'low',
  });
  return {
    text: r.refused ? '' : r.text,
    usage: { ...r.usage, embeddingTokens: 0 },
    model: r.model,
    refused: r.refused,
  };
}
