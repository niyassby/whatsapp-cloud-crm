/**
 * Embedding providers over HTTP: Voyage AI, and any OpenAI-compatible `/embeddings` endpoint
 * (OpenAI, Azure OpenAI, a local server). Both are asked for EMBEDDING_DIMENSIONS numbers so the
 * stored vectors fit one column. Requests are batched; inputs are never truncated here, the
 * chunker keeps them small.
 */
import {
  AiProviderError,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from './types';

type Fetch = typeof fetch;
const BATCH = 64;

async function postJson(
  fetchFn: Fetch,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new AiProviderError('Could not reach the embedding provider', { retryable: true });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new AiProviderError(`The embedding provider answered ${res.status}`, {
      retryable: res.status === 429 || res.status >= 500,
      status: res.status,
    });
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new AiProviderError('The embedding provider sent something that is not JSON');
  }
}

function readVectors(json: Record<string, unknown>, expected: number): number[][] {
  const data = Array.isArray(json.data)
    ? (json.data as { embedding?: unknown; index?: number }[])
    : [];
  const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const vectors = sorted.map((d) => d.embedding);
  if (
    vectors.length !== expected ||
    !vectors.every(
      (v) => Array.isArray(v) && v.length === EMBEDDING_DIMENSIONS && v.every(Number.isFinite),
    )
  ) {
    throw new AiProviderError(
      `The embedding provider did not return ${expected} vectors of ${EMBEDDING_DIMENSIONS} numbers`,
    );
  }
  return vectors as number[][];
}

const tokensOf = (json: Record<string, unknown>) => {
  const usage = (json.usage ?? {}) as { total_tokens?: number; prompt_tokens?: number };
  return Number(usage.total_tokens ?? usage.prompt_tokens ?? 0);
};

async function inBatches(
  texts: string[],
  run: (batch: string[]) => Promise<EmbeddingResult>,
): Promise<EmbeddingResult> {
  const out: EmbeddingResult = { vectors: [], tokens: 0 };
  for (let i = 0; i < texts.length; i += BATCH) {
    const r = await run(texts.slice(i, i + BATCH));
    out.vectors.push(...r.vectors);
    out.tokens += r.tokens;
  }
  return out;
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'voyage';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly apiKey: string,
    readonly model = 'voyage-3.5',
    private readonly fetchFn: Fetch = fetch,
    private readonly baseUrl = 'https://api.voyageai.com/v1',
  ) {}

  embed(texts: string[], kind: 'document' | 'query'): Promise<EmbeddingResult> {
    return inBatches(texts, async (batch) => {
      const json = await postJson(this.fetchFn, `${this.baseUrl}/embeddings`, this.apiKey, {
        input: batch,
        model: this.model,
        input_type: kind,
        output_dimension: this.dimensions,
      });
      return { vectors: readVectors(json, batch.length), tokens: tokensOf(json) };
    });
  }
}

export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dimensions = EMBEDDING_DIMENSIONS;

  constructor(
    private readonly apiKey: string,
    readonly model = 'text-embedding-3-small',
    private readonly baseUrl = 'https://api.openai.com/v1',
    private readonly fetchFn: Fetch = fetch,
  ) {}

  embed(texts: string[]): Promise<EmbeddingResult> {
    return inBatches(texts, async (batch) => {
      const json = await postJson(
        this.fetchFn,
        `${this.baseUrl.replace(/\/$/, '')}/embeddings`,
        this.apiKey,
        { input: batch, model: this.model, dimensions: this.dimensions },
      );
      return { vectors: readVectors(json, batch.length), tokens: tokensOf(json) };
    });
  }
}
