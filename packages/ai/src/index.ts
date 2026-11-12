import { AnthropicChatProvider, DEFAULT_CLAUDE_MODEL } from './anthropic';
import { OpenAiCompatibleEmbeddingProvider, VoyageEmbeddingProvider } from './embeddings';
import { FakeChatProvider, FakeEmbeddingProvider } from './fake';
import type { ChatProvider, EmbeddingProvider } from './types';

export * from './types';
export * from './chunk';
export * from './prompts';
export * from './assistant';
export { AnthropicChatProvider, DEFAULT_CLAUDE_MODEL } from './anthropic';
export { OpenAiCompatibleEmbeddingProvider, VoyageEmbeddingProvider } from './embeddings';
export { FakeChatProvider, FakeEmbeddingProvider, words } from './fake';

export interface AiProviders {
  /** Null: no chat provider is configured, so AI features are unavailable. */
  chat: ChatProvider | null;
  /** Null: the knowledge base cannot index or search. */
  embeddings: EmbeddingProvider | null;
}

type Env = Record<string, string | undefined>;
const set = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/**
 * Providers from configuration. `AI_PROVIDER` is `anthropic` or `fake`; `AI_EMBEDDINGS_PROVIDER`
 * is `voyage`, `openai` (any OpenAI-compatible endpoint) or `fake`. A provider without its key is
 * left out rather than failing later. The fake providers are refused in production.
 */
export function createAiProviders(env: Env): AiProviders {
  const production = env.NODE_ENV === 'production';
  const chatKind = set(env.AI_PROVIDER);
  const embedKind = set(env.AI_EMBEDDINGS_PROVIDER);
  if (production && (chatKind === 'fake' || embedKind === 'fake')) {
    throw new Error('The fake AI providers cannot be used in production');
  }

  let chat: ChatProvider | null = null;
  if (chatKind === 'fake') chat = new FakeChatProvider();
  else if (chatKind === 'anthropic' && set(env.ANTHROPIC_API_KEY)) {
    chat = new AnthropicChatProvider(
      { apiKey: set(env.ANTHROPIC_API_KEY)!, baseURL: set(env.ANTHROPIC_BASE_URL) },
      set(env.AI_MODEL) ?? DEFAULT_CLAUDE_MODEL,
    );
  }

  let embeddings: EmbeddingProvider | null = null;
  if (embedKind === 'fake') embeddings = new FakeEmbeddingProvider();
  else if (embedKind === 'voyage' && set(env.VOYAGE_API_KEY)) {
    embeddings = new VoyageEmbeddingProvider(
      set(env.VOYAGE_API_KEY)!,
      set(env.AI_EMBEDDINGS_MODEL) ?? 'voyage-3.5',
    );
  } else if (embedKind === 'openai' && set(env.OPENAI_API_KEY)) {
    embeddings = new OpenAiCompatibleEmbeddingProvider(
      set(env.OPENAI_API_KEY)!,
      set(env.AI_EMBEDDINGS_MODEL) ?? 'text-embedding-3-small',
      set(env.OPENAI_BASE_URL) ?? 'https://api.openai.com/v1',
    );
  }
  return { chat, embeddings };
}
