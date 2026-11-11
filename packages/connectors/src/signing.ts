import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two strings, false when the lengths differ. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacSha256 = (secret: string, body: Buffer | string, encoding: 'hex' | 'base64') =>
  createHmac('sha256', secret).update(body).digest(encoding);

/** The usual webhook check: an HMAC-SHA256 of the raw body, hex or base64, maybe prefixed. */
export function verifyHmacSha256(
  body: Buffer,
  secret: string,
  header: string | undefined,
  opts: { encoding?: 'hex' | 'base64'; prefix?: string } = {},
): boolean {
  if (!header || !secret) return false;
  const given =
    opts.prefix && header.startsWith(opts.prefix) ? header.slice(opts.prefix.length) : header;
  return safeEqual(given.trim(), hmacSha256(secret, body, opts.encoding ?? 'hex'));
}

export const sha256Hex = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
