/**
 * AI assistant and knowledge base: settings, inputs, DTOs and how usage is priced. Prompts and
 * providers live in packages/ai; this module is what web, API and worker share.
 */
import { z } from 'zod';

// ------------------------------------------------------------------ settings

export const aiSettingsSchema = z.object({
  /** Master switch. Off: no AI feature runs and nothing is charged. */
  enabled: z.boolean(),
  /** Suggested replies, summaries and rewrites in the inbox. */
  inboxAssist: z.boolean(),
  /**
   * The flow AI step may send its answer to the customer. Off (the default), it saves the answer
   * as a note for the team and hands the conversation over instead: nothing is sent automatically.
   */
  autoReply: z.boolean(),
  /** Below this, the flow AI step hands over rather than answering. A step can ask for more. */
  minConfidence: z.number().min(0).max(1),
  /** How the assistant should speak and what it must not do, in the business's words. */
  instructions: z.string().trim().max(4000),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export const updateAiSettingsSchema = aiSettingsSchema.partial();
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: false,
  inboxAssist: true,
  autoReply: false,
  minConfidence: 0.7,
  instructions: '',
};

export interface AiSettingsDto extends AiSettings {
  /** What this installation has configured: a chat provider, and embeddings for the knowledge base. */
  available: { chat: boolean; knowledge: boolean };
  model: string | null;
}

// ------------------------------------------------------------------ knowledge base

export const KNOWLEDGE_DOCUMENT_STATUSES = ['pending', 'indexing', 'ready', 'failed'] as const;
export type KnowledgeDocumentStatus = (typeof KNOWLEDGE_DOCUMENT_STATUSES)[number];

/** Plain-text formats; their text is read as is. PDF and Word are not read yet. */
export const KNOWLEDGE_MIME_TYPES: Record<string, string> = {
  'text/plain': '.txt',
  'text/markdown': '.md',
  'text/csv': '.csv',
  'application/json': '.json',
};
export const KNOWLEDGE_MAX_FILE_BYTES = 5 * 1024 * 1024;
export const KNOWLEDGE_MAX_DOCUMENTS = 500;
/** Passages handed to the model per answer. */
export const KNOWLEDGE_TOP_K = 5;

export const createKnowledgeTextSchema = z.object({
  title: z.string().trim().min(1, 'Give it a title').max(200),
  content: z.string().trim().min(1, 'Add some text').max(500_000),
});
export type CreateKnowledgeTextInput = z.infer<typeof createKnowledgeTextSchema>;

export const searchKnowledgeSchema = z.object({ query: z.string().trim().min(1).max(1000) });

export interface KnowledgeDocumentDto {
  id: string;
  title: string;
  source: 'text' | 'upload';
  mimeType: string | null;
  sizeBytes: number;
  status: KnowledgeDocumentStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeHitDto {
  chunkId: string;
  documentId: string;
  title: string;
  content: string;
  /** Cosine similarity, 0 to 1. */
  score: number;
}

// ------------------------------------------------------------------ inbox assist

export const AI_TONES = ['friendly', 'formal', 'concise', 'empathetic', 'fix_grammar'] as const;
export type AiTone = (typeof AI_TONES)[number];
export const AI_TONE_LABELS: Record<AiTone, string> = {
  friendly: 'Friendlier',
  formal: 'More formal',
  concise: 'Shorter',
  empathetic: 'More empathetic',
  fix_grammar: 'Fix grammar',
};

export const rewriteSchema = z.object({
  text: z.string().trim().min(1).max(4096),
  tone: z.enum(AI_TONES),
});
export type RewriteInput = z.infer<typeof rewriteSchema>;

export interface AiSourceDto {
  documentId: string;
  title: string;
}

export interface AiSuggestionDto {
  text: string;
  confidence: number;
  sources: AiSourceDto[];
  /** Why the assistant is unsure, for the agent. */
  note: string | null;
  logId: string;
}

export interface AiTextDto {
  text: string;
  logId: string;
}

// ------------------------------------------------------------------ the log

export const AI_KINDS = ['suggestion', 'summary', 'rewrite', 'flow_reply', 'indexing'] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const AI_LOG_STATUSES = ['answered', 'handoff', 'refused', 'failed'] as const;
export type AiLogStatus = (typeof AI_LOG_STATUSES)[number];

export interface AiLogDto {
  id: string;
  kind: AiKind;
  status: AiLogStatus;
  model: string;
  conversationId: string | null;
  flowRunId: string | null;
  userId: string | null;
  /** The question or text the AI was given, shortened. */
  input: string;
  output: string;
  confidence: number | null;
  sources: AiSourceDto[];
  sent: boolean;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  error: string | null;
  createdAt: string;
}

export const listAiLogSchema = z.object({
  kind: z.enum(AI_KINDS).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListAiLogQuery = z.infer<typeof listAiLogSchema>;

// ------------------------------------------------------------------ pricing

/**
 * AI usage is priced through rate cards (config, not code), per million tokens, in the wallet's
 * currency: `ai_input`, `ai_output`, `ai_embedding`. Missing rates refuse the call, as for sends.
 */
export const AI_RATE_CATEGORIES = {
  input: 'ai_input',
  output: 'ai_output',
  embedding: 'ai_embedding',
} as const;

/** tokens x micros-per-million, rounded up to a whole micro-unit. */
export function aiCostMicros(tokens: number, rateMicrosPerMillion: number): number {
  if (tokens <= 0 || rateMicrosPerMillion <= 0) return 0;
  return Math.ceil((tokens * rateMicrosPerMillion) / 1_000_000);
}
