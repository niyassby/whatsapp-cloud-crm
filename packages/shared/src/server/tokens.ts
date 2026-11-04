import { createHmac, randomBytes } from 'node:crypto';

/** URL-safe random token with 256 bits of entropy (refresh tokens, email links, invites). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Keyed hash of an opaque token for storage and lookup. A database leak alone is not enough
 * to forge or replay tokens because the pepper lives in the environment.
 */
export function hashOpaqueToken(token: string, pepper: string): string {
  return createHmac('sha256', pepper).update(token).digest('base64url');
}
