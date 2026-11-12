/**
 * Deterministic providers for tests and for running the app with no AI account
 * (`AI_PROVIDER=fake`). The embeddings are hashed word counts, so passages that share words with
 * a question really are nearest to it; the chat answers from the passages it is shown, or
 * declines with low confidence when none share enough words with the customer's question.
 */
import { createHash } from 'node:crypto';
import { REPLY_SCHEMA } from './prompts';
import {
  type ChatProvider,
  type ChatRequest,
  type ChatResult,
  EMBEDDING_DIMENSIONS,
  type EmbeddingProvider,
  type EmbeddingResult,
} from './types';

const STOP = new Set(
  'a an and are as at be by can do does for from has have how i in is it my of on or our the to was we what when where which who why will with you your'.split(
    ' ',
  ),
);

export const words = (text: string) =>
  (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w));

function bucket(word: string): number {
  return createHash('sha256').update(word).digest().readUInt32BE(0) % EMBEDDING_DIMENSIONS;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model = 'fake-hash-1024';
  readonly dimensions = EMBEDDING_DIMENSIONS;
  calls = 0;

  async embed(texts: string[]): Promise<EmbeddingResult> {
    this.calls++;
    const vectors = texts.map((t) => {
      const v = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
      for (const w of words(t)) v[bucket(w)]! += 1;
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      // A tiny constant keeps an empty text from being the zero vector (undefined cosine).
      return v.map((x) => x / norm + 1e-6);
    });
    return { vectors, tokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0) };
  }
}

export type FakeResponder = (req: ChatRequest) => Partial<ChatResult> | undefined;

export class FakeChatProvider implements ChatProvider {
  readonly name = 'fake';
  readonly model = 'fake-chat';
  readonly requests: ChatRequest[] = [];
  /** Set by tests to script an answer; return undefined to use the default behaviour. */
  responder: FakeResponder | null = null;

  async generate(req: ChatRequest): Promise<ChatResult> {
    this.requests.push(req);
    const usage = {
      inputTokens: Math.ceil(
        (req.system.length + req.messages.reduce((s, m) => s + m.content.length, 0)) / 4,
      ),
      outputTokens: 40,
    };
    const scripted = this.responder?.(req);
    if (scripted) {
      return {
        text: scripted.text ?? JSON.stringify(scripted.json ?? ''),
        json: scripted.json ?? null,
        usage: scripted.usage ?? usage,
        model: this.model,
        refused: scripted.refused ?? false,
      };
    }
    const prompt = req.messages.at(-1)?.content ?? '';
    if (req.schema === REPLY_SCHEMA) {
      const json = answerFromPassages(prompt);
      return { text: JSON.stringify(json), json, usage, model: this.model, refused: false };
    }
    const body =
      /<(?:draft|conversation)>\n([\s\S]*?)\n<\/(?:draft|conversation)>/.exec(prompt)?.[1] ??
      prompt;
    const text = prompt.includes('<draft>')
      ? `[rewritten] ${body}`
      : `- ${body.split('\n').at(-1) ?? ''}`;
    return { text, json: null, usage, model: this.model, refused: false };
  }
}

/** The default fake answer: the passage sharing most words with the customer's last message. */
function answerFromPassages(prompt: string) {
  const lastCustomer = [...prompt.matchAll(/^Customer: (.*)$/gm)].at(-1)?.[1] ?? '';
  const question = new Set(words(lastCustomer));
  let best: { label: string; text: string; score: number } | null = null;
  for (const m of prompt.matchAll(/<passage label="(k\d+)"[^>]*>\n([\s\S]*?)\n<\/passage>/g)) {
    const shared = words(m[2]!).filter((w) => question.has(w));
    const score = new Set(shared).size;
    if (!best || score > best.score) best = { label: m[1]!, text: m[2]!, score };
  }
  if (!best || best.score < 2) {
    return {
      answer: '',
      confidence: 0.1,
      sources: [],
      handoff_reason: 'Not in the knowledge base',
    };
  }
  return {
    answer: best.text.split('\n')[0]!.trim(),
    confidence: Math.min(0.95, 0.5 + best.score * 0.15),
    sources: [best.label],
    handoff_reason: null,
  };
}
