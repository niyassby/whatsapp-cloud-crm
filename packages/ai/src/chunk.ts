/**
 * Splitting knowledge into passages small enough to embed and to quote. Paragraphs are kept
 * whole where they fit; long ones are split at sentence ends; neighbouring passages overlap a
 * little so an answer spanning a boundary is still found. Sizes are in characters (about four
 * per token for English), which is close enough for retrieval and needs no tokenizer.
 */

export interface Chunk {
  ordinal: number;
  content: string;
  /** Rough token count, for metering estimates. */
  tokens: number;
}

export const CHUNK_TARGET_CHARS = 1600;
export const CHUNK_OVERLAP_CHARS = 200;
/** A document is refused beyond this, rather than silently cut. */
export const MAX_DOCUMENT_CHARS = 2_000_000;

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

/** Normalize line endings and whitespace without losing paragraph breaks. */
export function cleanText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitLong(paragraph: string, max: number): string[] {
  if (paragraph.length <= max) return [paragraph];
  const sentences = paragraph.match(/[^.!?。！？\n]+(?:[.!?。！？]+|\n|$)/g) ?? [paragraph];
  const out: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (s.length > max) {
      if (current) out.push(current.trim());
      current = '';
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max).trim());
      continue;
    }
    if ((current + s).length > max) {
      out.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

export function chunkText(raw: string, opts: { target?: number; overlap?: number } = {}): Chunk[] {
  const target = opts.target ?? CHUNK_TARGET_CHARS;
  const overlap = opts.overlap ?? CHUNK_OVERLAP_CHARS;
  const pieces = cleanText(raw)
    .split(/\n\n+/)
    .flatMap((p) => splitLong(p.trim(), target))
    .filter(Boolean);

  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length + 2 > target) {
      chunks.push(current);
      // Carry the end of the last passage into the next, at a word boundary.
      const tail = current.slice(-overlap);
      const cut = tail.indexOf(' ');
      current = (cut >= 0 ? tail.slice(cut + 1) : tail) + '\n\n' + piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((content, ordinal) => ({
    ordinal,
    content: content.trim(),
    tokens: estimateTokens(content),
  }));
}
