/**
 * The AI interface. Features (suggested replies, summaries, rewrites, the flow AI step, the
 * knowledge base) talk only to these two interfaces; a provider is chosen by configuration, so a
 * model or vendor can change without touching them. Tests use the fake provider in `fake.ts`.
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatRequest {
  /** Stable instructions; providers that can, cache it. */
  system: string;
  messages: ChatMessage[];
  /** A JSON Schema the answer must follow. The parsed object comes back in `json`. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  /** Lower is faster and cheaper; providers without the idea ignore it. */
  effort?: 'low' | 'medium' | 'high';
}

export interface ChatResult {
  text: string;
  /** Present when a schema was given and the answer parsed. */
  json: unknown;
  usage: TokenUsage;
  /** The model that actually answered (it can differ after a provider-side fallback). */
  model: string;
  /** The provider declined to answer. Treated as a handoff, never shown to a customer. */
  refused: boolean;
}

export interface ChatProvider {
  readonly name: string;
  readonly model: string;
  generate(req: ChatRequest): Promise<ChatResult>;
}

export interface EmbeddingResult {
  vectors: number[][];
  tokens: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** Every vector has this many numbers; the database column is sized to it. */
  readonly dimensions: number;
  /** `query` for a question being searched, `document` for text being stored. */
  embed(texts: string[], kind: 'document' | 'query'): Promise<EmbeddingResult>;
}

/** A provider failed. `retryable` errors (rate limits, outages) are worth another attempt. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly opts: { retryable?: boolean; status?: number } = {},
  ) {
    super(message);
    this.name = 'AiProviderError';
  }
}

/** The vector size every embedding provider is asked for, matching `knowledge_chunks.embedding`. */
export const EMBEDDING_DIMENSIONS = 1024;
