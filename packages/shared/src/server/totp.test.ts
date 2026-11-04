import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  hotp,
  totpStep,
  totpUri,
  verifyTotp,
} from './totp';

describe('TOTP', () => {
  // RFC 6238 Appendix B, SHA1, 8 digits, secret = ASCII "12345678901234567890".
  const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
  it.each([
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ])('matches RFC 6238 vector at t=%i', (t, expected) => {
    expect(hotp(rfcSecret, totpStep(t * 1000), 8)).toBe(expected);
  });

  it('base32 round-trips', () => {
    const buf = Buffer.from('hello world, totp!');
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Encode(rfcSecret)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  });

  it('verifies the current code and returns its step', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 4, 12, 0, 0);
    const code = generateTotp(secret, now);
    expect(verifyTotp(secret, code, { timeMs: now })).toBe(totpStep(now));
  });

  it('accepts one step of drift and rejects more', () => {
    const secret = generateTotpSecret();
    const now = Date.UTC(2026, 10, 4, 12, 0, 0);
    const prev = generateTotp(secret, now - 30_000);
    const old = generateTotp(secret, now - 90_000);
    expect(verifyTotp(secret, prev, { timeMs: now })).toBe(totpStep(now) - 1);
    expect(verifyTotp(secret, old, { timeMs: now })).toBeNull();
  });

  it('rejects malformed codes', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, '12345')).toBeNull();
    expect(verifyTotp(secret, 'abcdef')).toBeNull();
  });

  it('builds an otpauth URI', () => {
    const uri = totpUri({ secret: 'ABC', account: 'a@b.test', issuer: 'WhatsApp CRM' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/WhatsApp%20CRM%3Aa%40b\.test\?/);
    expect(uri).toContain('secret=ABC');
  });
});
