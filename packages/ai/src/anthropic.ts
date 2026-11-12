/**
 * Claude through the official Anthropic SDK. The system prompt is cached (it is the same for
 * every request of a kind), answers that must be JSON use structured outputs, and a policy
 * refusal is retried server-side on a fallback model before it counts as a refusal.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AiProviderError, type ChatProvider, type ChatRequest, type ChatResult } from './types';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export class AnthropicChatProvider implements ChatProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    opts: { apiKey: string; baseURL?: string; timeoutMs?: number },
    readonly model: string = DEFAULT_CLAUDE_MODEL,
  ) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      timeout: opts.timeoutMs ?? 60_000,
      // BullMQ and the callers own retries; one SDK retry covers a dropped connection.
      maxRetries: 1,
    });
  }

  async generate(req: ChatRequest): Promise<ChatResult> {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: req.maxTokens,
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
        system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        output_config: {
          ...(req.effort ? { effort: req.effort } : {}),
          ...(req.schema ? { format: { type: 'json_schema', schema: req.schema } } : {}),
        },
      });
    } catch (err) {
      throw toProviderError(err);
    }

    const usage = {
      inputTokens:
        response.usage.input_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0),
      outputTokens: response.usage.output_tokens,
    };
    if (response.stop_reason === 'refusal') {
      return { text: '', json: null, usage, model: response.model, refused: true };
    }
    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('')
      .trim();
    let json: unknown = null;
    if (req.schema) {
      try {
        json = JSON.parse(text);
      } catch {
        throw new AiProviderError('The model did not return valid JSON');
      }
    }
    if (response.stop_reason === 'max_tokens' && req.schema) {
      throw new AiProviderError('The answer was cut off');
    }
    return { text, json, usage, model: response.model, refused: false };
  }
}

function toProviderError(err: unknown): AiProviderError {
  if (err instanceof Anthropic.RateLimitError) {
    return new AiProviderError('The AI provider is busy; try again shortly', {
      retryable: true,
      status: 429,
    });
  }
  if (
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError
  ) {
    return new AiProviderError('The AI provider refused the API key', { status: err.status });
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new AiProviderError(`The AI provider refused the request: ${err.message}`, {
      status: 400,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AiProviderError('Could not reach the AI provider', { retryable: true });
  }
  if (err instanceof Anthropic.APIError) {
    return new AiProviderError(`The AI provider answered ${err.status ?? 'an error'}`, {
      retryable: (err.status ?? 500) >= 500,
      status: err.status,
    });
  }
  return new AiProviderError(err instanceof Error ? err.message : 'AI request failed');
}
